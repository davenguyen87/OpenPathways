/**
 * checkpoint.test.js — Round-trip tests for src/rebuild/checkpoint.js.
 *
 * Tests build a staged rebuild state by hand (zip + rebuild-manifest-staged.json)
 * rather than driving the real orchestrator. The orchestrator → real transformer
 * integration carries an existing transformId-naming mismatch (see "Contract
 * clarifications needed" in the chunk 08 report) that's out of scope here. By
 * synthesizing the staged state directly we exercise checkpoint promotion
 * without depending on that integration.
 *
 * The verify() step inside promote() is steered through `__setAuditForTest`
 * to avoid spawning Playwright.
 */

import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';

const require = createRequire(import.meta.url);

const transformer = require('../../src/transformers/landmark-insertion.js');
const {
  promote,
  discard,
  listPending,
  readCheckpointState,
  STAGING_DIR_NAME,
  STAGED_MANIFEST_NAME,
  STAGED_ZIP_NAME,
  STATE_FILE_NAME,
  STATE_VERSION,
  _internals
} = require('../../src/rebuild/checkpoint.js');
const { unpack, pack, sha256 } = require('../../src/rebuild/packager.js');
const { __setAuditForTest } = require('../../src/rebuild/verify.js');
const {
  createManifest,
  addPatch,
  addTransform,
  setVerification,
  writeManifest
} = require('../../src/rebuild/manifest.js');
const yazl = require('yazl');

// ── Helpers ─────────────────────────────────────────────────────────────────

const tmpDirs = [];
function makeTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
});

const ORIGINAL_HTML = [
  '<!doctype html>',
  '<html><head><title>x</title></head><body>',
  '  <div class="main-content">',
  '    <h1>Lesson 1</h1>',
  '    <p>Body</p>',
  '  </div>',
  '</body></html>',
  ''
].join('\n');

const SCORM_MANIFEST_XML =
  '<?xml version="1.0"?><manifest identifier="m1" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2">' +
  '<organizations default="o1"><organization identifier="o1"><title>Course</title>' +
  '<item identifier="i1" identifierref="r1"><title>Lesson</title></item></organization></organizations>' +
  '<resources><resource identifier="r1" type="webcontent" href="index.html">' +
  '<file href="index.html"/></resource></resources></manifest>';

/** Pack an arbitrary file map into a `.zip`. */
function buildZipFromFiles(zipPath, files) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const ws = fs.createWriteStream(zipPath);
    ws.on('finish', resolve);
    ws.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(ws);
    for (const [name, content] of Object.entries(files)) {
      zip.addBuffer(Buffer.from(content, 'utf8'), name);
    }
    zip.end();
  });
}

async function readFileFromZip(zipPath, fileName) {
  const dir = makeTmp('checkpoint-read');
  await unpack(zipPath, dir);
  return fs.readFileSync(path.join(dir, fileName), 'utf8');
}

/** Repack a directory into a zip without using the entry-order sidecar. */
function repackDir(srcDir, zipPath) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const ws = fs.createWriteStream(zipPath);
    ws.on('finish', resolve);
    ws.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(ws);
    function walk(d, rel) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.name === '.prism-entry-order.json') continue;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else zip.addBuffer(fs.readFileSync(path.join(d, e.name)), r);
      }
    }
    walk(srcDir, '');
    zip.end();
  });
}

/**
 * Build a staged rebuild state by:
 *
 *   1. Running the landmark-insertion transformer over ORIGINAL_HTML in
 *      memory to get a real Transform + Patch[] pair.
 *   2. Writing the post-apply HTML into a staged zip.
 *   3. Building a manifest with createManifest + addPatch + addTransform so
 *      the patch ids and transform ids end up real (patch-NNNN /
 *      transform-NNNN), satisfying the manifest validator.
 *   4. Persisting the manifest under .rebuild-staging/.
 *
 * Returns { engagementDir, packageName, packageDir, stagingDir, stagedZipPath,
 * stagedManifestPath, manifestStaged, originalZipPath }.
 */
async function buildStagedFixture() {
  const engagementDir = makeTmp('checkpoint-engagement');
  const packageName = 'sample.zip';
  const packageDir = path.join(engagementDir, packageName);
  fs.mkdirSync(packageDir, { recursive: true });
  const stagingDir = path.join(packageDir, STAGING_DIR_NAME);
  fs.mkdirSync(stagingDir, { recursive: true });

  // Build the original input zip.
  const originalDir = makeTmp('checkpoint-orig');
  const originalZipPath = path.join(originalDir, packageName);
  await buildZipFromFiles(originalZipPath, {
    'index.html': ORIGINAL_HTML,
    'imsmanifest.xml': SCORM_MANIFEST_XML
  });
  const inputZipSha256 = await sha256(originalZipPath);

  // Run the transformer in-memory to get authentic Patch shapes.
  const applyResult = await transformer.apply({
    files: [
      { path: 'index.html', content: ORIGINAL_HTML, isHtml: true },
      { path: 'imsmanifest.xml', content: SCORM_MANIFEST_XML, isHtml: false }
    ]
  });

  // Build the post-apply staged tree on disk.
  const stagedTreeDir = makeTmp('checkpoint-staged-tree');
  const updatedByPath = new Map();
  for (const u of applyResult.updatedFiles) updatedByPath.set(u.path, u.newContent);
  fs.writeFileSync(
    path.join(stagedTreeDir, 'index.html'),
    updatedByPath.has('index.html') ? updatedByPath.get('index.html') : ORIGINAL_HTML,
    'utf8'
  );
  fs.writeFileSync(path.join(stagedTreeDir, 'imsmanifest.xml'), SCORM_MANIFEST_XML, 'utf8');

  // Pack into the staged zip.
  const stagedZipPath = path.join(stagingDir, STAGED_ZIP_NAME);
  await repackDir(stagedTreeDir, stagedZipPath);
  const stagedSha = await sha256(stagedZipPath);

  // Build the manifest.
  const manifest = createManifest({
    engagementId: 'test-engagement',
    packageName,
    inputZipSha256,
    mode: 'full',
    standard: 'wcag22',
    schemaVersion: '2.0.0'
  });
  manifest.outputZipSha256 = stagedSha;
  setVerification(
    manifest,
    { violations: 0, criteriaFailed: 0, section508Failed: 0 },
    { violations: 0, criteriaFailed: 0, section508Failed: 0 }
  );

  // Add each patch (rewrites transformId on append; we'll re-link via
  // addTransform). Strip transformer-set fields the validator rejects.
  const appendedIds = [];
  for (const rawPatch of applyResult.patches) {
    const clean = { ...rawPatch };
    delete clean._localPatchId;
    delete clean.transformId; // addTransform re-links to the new transform-NNNN id
    const appended = addPatch(manifest, clean);
    appendedIds.push(appended.id);
  }

  // Add the transform with `pending-checkpoint` status — that's the gate
  // promote() expects. Strip transformer-emitted fields the validator
  // doesn't recognize.
  const transformShape = { ...applyResult.transform };
  delete transformShape.id;
  transformShape.patchIds = appendedIds;
  transformShape.status = 'pending-checkpoint';
  addTransform(manifest, transformShape);

  // Persist staged manifest.
  const stagedManifestPath = path.join(stagingDir, STAGED_MANIFEST_NAME);
  writeManifest(manifest, stagedManifestPath);

  return {
    engagementDir,
    packageName,
    packageDir,
    stagingDir,
    stagedZipPath,
    stagedManifestPath,
    manifestStaged: JSON.parse(fs.readFileSync(stagedManifestPath, 'utf8')),
    originalZipPath
  };
}

function passingAuditStub() {
  return {
    packageType: 'scorm12',
    complete: true,
    incompleteReason: null,
    scorecard: {
      wcagVersion: 'WCAG22',
      passed: true,
      score: 100,
      totalCriteria: 50,
      passedCriteria: 50,
      failedCriteria: 0,
      totalViolations: 0,
      criteriaResults: []
    },
    violations: [],
    scos: [],
    manualReview: [],
    dynamicReport: { skipped: false, reason: null, iframeWarnings: [], dynamicViolationsCount: 0 },
    fixesApplied: null
  };
}

beforeEach(() => {
  __setAuditForTest(vi.fn().mockResolvedValue(passingAuditStub()));
});
afterEach(() => {
  __setAuditForTest(null);
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('promote() — all approve', () => {
  it('flips every pending transform to applied, writes manifest at package root, removes staging', async () => {
    const ctx = await buildStagedFixture();
    expect(ctx.manifestStaged.transforms.length).toBeGreaterThan(0);
    for (const t of ctx.manifestStaged.transforms) {
      expect(t.status).toBe('pending-checkpoint');
    }

    const decisions = {};
    for (const t of ctx.manifestStaged.transforms) decisions[t.id] = 'approve';

    const result = await promote(ctx.engagementDir, ctx.packageName, decisions, {
      now: '2026-05-08T12:00:00.000Z',
      username: 'consultant'
    });

    expect(result.promoted).toBe(true);
    expect(result.approvedTransforms).toEqual(ctx.manifestStaged.transforms.map((t) => t.id));
    expect(result.rejectedTransforms).toEqual([]);

    const finalManifest = JSON.parse(
      fs.readFileSync(path.join(ctx.packageDir, 'rebuild-manifest.json'), 'utf8')
    );
    for (const t of finalManifest.transforms) {
      expect(t.status).toBe('applied');
      expect(t.checkpointApprovedBy).toBe('consultant');
      expect(t.checkpointApprovedAt).toBe('2026-05-08T12:00:00.000Z');
    }
    for (const p of finalManifest.patches) {
      if (p.transformId) expect(p.status).toBe('applied');
    }

    expect(fs.existsSync(path.join(ctx.packageDir, 'rebuilt.zip'))).toBe(true);
    expect(fs.existsSync(ctx.stagingDir)).toBe(false);
  });
});

describe('promote() — mixed approve / reject', () => {
  it('reverts rejected transforms and applies approved ones; reverted-file bytes match the original', async () => {
    const ctx = await buildStagedFixture();
    // Single transform; reject it. Approved-set is empty.
    const transforms = ctx.manifestStaged.transforms;
    expect(transforms.length).toBe(1);
    const decisions = { [transforms[0].id]: 'reject' };

    const originalIndex = await readFileFromZip(ctx.originalZipPath, 'index.html');

    const result = await promote(ctx.engagementDir, ctx.packageName, decisions, {
      now: '2026-05-08T12:00:00.000Z',
      username: 'consultant'
    });

    expect(result.promoted).toBe(true);
    expect(result.rejectedTransforms).toEqual([transforms[0].id]);
    expect(result.approvedTransforms).toEqual([]);

    const finalManifest = JSON.parse(
      fs.readFileSync(path.join(ctx.packageDir, 'rebuild-manifest.json'), 'utf8')
    );
    const rejected = finalManifest.transforms.find((t) => t.id === transforms[0].id);
    expect(rejected.status).toBe('rejected');
    expect(rejected.checkpointApprovedBy).toBe('consultant');
    for (const p of finalManifest.patches) {
      if (p.transformId === transforms[0].id) expect(p.status).toBe('rejected');
    }

    // Reverting all transforms means the file bytes equal the original.
    const finalIndex = await readFileFromZip(
      path.join(ctx.packageDir, 'rebuilt.zip'),
      'index.html'
    );
    expect(finalIndex).toBe(originalIndex);
  });
});

describe('promote() — verification failure preserves staging', () => {
  it('returns { promoted: false, reason } and leaves staging intact', async () => {
    const ctx = await buildStagedFixture();
    const decisions = {};
    for (const t of ctx.manifestStaged.transforms) decisions[t.id] = 'approve';

    // Inject a regression: more violations after than before.
    __setAuditForTest(
      vi.fn().mockResolvedValue({
        packageType: 'scorm12',
        complete: true,
        scorecard: {
          wcagVersion: 'WCAG22',
          passed: false,
          score: 90,
          totalCriteria: 50,
          passedCriteria: 49,
          failedCriteria: 1,
          totalViolations: 1,
          criteriaResults: []
        },
        violations: [{ criterion: '4.1.2', file: 'index.html', line: 1 }],
        scos: [],
        manualReview: [],
        dynamicReport: { skipped: false, reason: null, iframeWarnings: [], dynamicViolationsCount: 0 }
      })
    );

    const result = await promote(ctx.engagementDir, ctx.packageName, decisions, {
      now: '2026-05-08T12:00:00.000Z',
      username: 'consultant'
    });
    expect(result.promoted).toBe(false);
    expect(result.reason).toMatch(/regression|verification/i);

    expect(fs.existsSync(ctx.stagingDir)).toBe(true);
    expect(fs.existsSync(path.join(ctx.packageDir, 'rebuilt.zip'))).toBe(false);
    expect(fs.existsSync(path.join(ctx.packageDir, 'rebuild-manifest.json'))).toBe(false);
  });
});

describe('promote() — manifest-XML check failure preserves staging', () => {
  it('returns failure reason when imsmanifest.xml is malformed for a manifest-edited transform', async () => {
    const ctx = await buildStagedFixture();
    const transformId = ctx.manifestStaged.transforms[0].id;

    // Edit the staged manifest in-place to mark this transform as
    // manifestEdited. We bypass the writeManifest validator since we want the
    // wide-open shape; also include imsmanifest.xml in scope.files to satisfy
    // the v5 cross-reference rule.
    const persisted = JSON.parse(fs.readFileSync(ctx.stagedManifestPath, 'utf8'));
    persisted.transforms[0].scope.manifestEdited = true;
    if (!persisted.transforms[0].scope.files.some((f) => f.toLowerCase().endsWith('imsmanifest.xml'))) {
      persisted.transforms[0].scope.files = [
        ...persisted.transforms[0].scope.files,
        'imsmanifest.xml'
      ];
    }
    fs.writeFileSync(ctx.stagedManifestPath, JSON.stringify(persisted, null, 2), 'utf8');

    // Corrupt imsmanifest.xml inside the staged zip.
    const tmpUnpack = makeTmp('checkpoint-corrupt');
    await unpack(ctx.stagedZipPath, tmpUnpack);
    fs.writeFileSync(path.join(tmpUnpack, 'imsmanifest.xml'), '<<<not-valid-xml', 'utf8');
    await repackDir(tmpUnpack, ctx.stagedZipPath);

    const decisions = { [transformId]: 'approve' };
    const result = await promote(ctx.engagementDir, ctx.packageName, decisions, {
      now: '2026-05-08T12:00:00.000Z',
      username: 'consultant'
    });
    expect(result.promoted).toBe(false);
    expect(result.reason).toMatch(/manifest xml/i);

    expect(fs.existsSync(ctx.stagingDir)).toBe(true);
    expect(fs.existsSync(path.join(ctx.packageDir, 'rebuilt.zip'))).toBe(false);
  });
});

describe('discard()', () => {
  it('removes staging without touching the package root and is idempotent', async () => {
    const ctx = await buildStagedFixture();
    const sentinel = path.join(ctx.packageDir, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'untouched', 'utf8');

    expect(fs.existsSync(ctx.stagingDir)).toBe(true);
    const r1 = await discard(ctx.engagementDir, ctx.packageName);
    expect(r1.discarded).toBe(true);
    expect(fs.existsSync(ctx.stagingDir)).toBe(false);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('untouched');

    const r2 = await discard(ctx.engagementDir, ctx.packageName);
    expect(r2.discarded).toBe(false);
  });
});

describe('listPending()', () => {
  it('returns one entry per package with a staging directory under the engagement', async () => {
    const ctx = await buildStagedFixture();
    const out = await listPending(ctx.engagementDir);
    expect(out).toHaveLength(1);
    expect(out[0].packageName).toBe(ctx.packageName);
    expect(out[0].stagingPath).toBe(ctx.stagingDir);
    expect(out[0].pendingCount).toBe(ctx.manifestStaged.transforms.length);

    await discard(ctx.engagementDir, ctx.packageName);
    expect(await listPending(ctx.engagementDir)).toHaveLength(0);
  });
});

describe('readCheckpointState()', () => {
  it('returns parsed decisions for a fresh, hash-matching state file', async () => {
    const ctx = await buildStagedFixture();
    const stagedManifestRaw = fs.readFileSync(ctx.stagedManifestPath, 'utf8');
    const hash = _internals.hashString(stagedManifestRaw);
    const decisions = {};
    for (const t of ctx.manifestStaged.transforms) decisions[t.id] = 'approve';
    fs.writeFileSync(
      path.join(ctx.stagingDir, STATE_FILE_NAME),
      JSON.stringify({
        stateVersion: STATE_VERSION,
        manifestHash: hash,
        decisions,
        decidedBy: 'consultant',
        decidedAt: '2026-05-08T12:00:00.000Z'
      }),
      'utf8'
    );
    const out = await readCheckpointState(ctx.stagingDir);
    expect(out).toEqual(decisions);
  });

  it('returns null for a stale state file (manifestHash mismatch)', async () => {
    const ctx = await buildStagedFixture();
    const decisions = {};
    for (const t of ctx.manifestStaged.transforms) decisions[t.id] = 'approve';
    fs.writeFileSync(
      path.join(ctx.stagingDir, STATE_FILE_NAME),
      JSON.stringify({
        stateVersion: STATE_VERSION,
        manifestHash: 'deadbeef'.repeat(8),
        decisions,
        decidedBy: 'consultant',
        decidedAt: '2026-05-08T12:00:00.000Z'
      }),
      'utf8'
    );
    expect(await readCheckpointState(ctx.stagingDir)).toBeNull();
  });

  it('returns null when no state file exists', async () => {
    const ctx = await buildStagedFixture();
    expect(await readCheckpointState(ctx.stagingDir)).toBeNull();
  });
});

describe('promote() — error cases', () => {
  it('throws when a pending transform is missing from decisions', async () => {
    const ctx = await buildStagedFixture();
    expect(ctx.manifestStaged.transforms.length).toBeGreaterThan(0);
    await expect(
      promote(ctx.engagementDir, ctx.packageName, {}, {})
    ).rejects.toThrow(/missing/i);
  });

  it('throws when a decision targets an unknown transform', async () => {
    const ctx = await buildStagedFixture();
    const decisions = {};
    for (const t of ctx.manifestStaged.transforms) decisions[t.id] = 'approve';
    decisions['transform-9999'] = 'approve';
    await expect(
      promote(ctx.engagementDir, ctx.packageName, decisions, {})
    ).rejects.toThrow(/unknown|non-pending/i);
  });
});
