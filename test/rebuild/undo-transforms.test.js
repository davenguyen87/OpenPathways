/**
 * undo-transforms.test.js — Atomic transform revert + back-compat tests for
 * src/rebuild/undo.js.
 *
 * Tests build a finalized rebuilt state by hand: a `rebuilt.zip` plus a
 * `rebuild-manifest.json` containing applied transforms + patches. The
 * orchestrator → real transformer integration carries an existing
 * transformId-naming mismatch (see chunk 08 report) so we synthesize state
 * directly. The verify() seam is stubbed to avoid Playwright.
 */

import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';

const require = createRequire(import.meta.url);

const transformer = require('../../src/transformers/landmark-insertion.js');
const { rebuild } = require('../../src/rebuild/index.js');
const { undo } = require('../../src/rebuild/undo.js');
const { unpack, sha256 } = require('../../src/rebuild/packager.js');
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
  const dir = makeTmp('undo-tx-read');
  await unpack(zipPath, dir);
  return fs.readFileSync(path.join(dir, fileName), 'utf8');
}

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
 * Build a finalized rebuilt state with one applied landmark-insertion transform.
 * The result is a `rebuilt.zip` + `rebuild-manifest.json` at the package root,
 * each transform `status: 'applied'`. Used to drive `undo()`'s transform path.
 */
async function buildFinalizedFixture() {
  const engagementDir = makeTmp('undo-tx-engagement');
  const packageName = 'sample.zip';
  const packageDir = path.join(engagementDir, packageName);
  fs.mkdirSync(packageDir, { recursive: true });

  // Original input zip (preserved for byte comparison after undo).
  const originalDir = makeTmp('undo-tx-orig');
  const originalZipPath = path.join(originalDir, packageName);
  await buildZipFromFiles(originalZipPath, {
    'index.html': ORIGINAL_HTML,
    'imsmanifest.xml': SCORM_MANIFEST_XML
  });
  const inputZipSha256 = await sha256(originalZipPath);

  // Run the transformer in-memory.
  const applyResult = await transformer.apply({
    files: [
      { path: 'index.html', content: ORIGINAL_HTML, isHtml: true },
      { path: 'imsmanifest.xml', content: SCORM_MANIFEST_XML, isHtml: false }
    ]
  });

  // Build the post-apply tree on disk.
  const treeDir = makeTmp('undo-tx-tree');
  const updatedByPath = new Map();
  for (const u of applyResult.updatedFiles) updatedByPath.set(u.path, u.newContent);
  fs.writeFileSync(
    path.join(treeDir, 'index.html'),
    updatedByPath.has('index.html') ? updatedByPath.get('index.html') : ORIGINAL_HTML,
    'utf8'
  );
  fs.writeFileSync(path.join(treeDir, 'imsmanifest.xml'), SCORM_MANIFEST_XML, 'utf8');

  const rebuiltZipPath = path.join(packageDir, 'rebuilt.zip');
  await repackDir(treeDir, rebuiltZipPath);
  const outputZipSha256 = await sha256(rebuiltZipPath);

  // Build manifest with patches + transform in 'applied' status.
  const manifest = createManifest({
    engagementId: 'test-engagement',
    packageName,
    inputZipSha256,
    mode: 'full',
    standard: 'wcag22',
    schemaVersion: '2.0.0'
  });
  manifest.outputZipSha256 = outputZipSha256;
  setVerification(
    manifest,
    { violations: 1, criteriaFailed: 1, section508Failed: 0 },
    { violations: 0, criteriaFailed: 0, section508Failed: 0 }
  );

  const appendedIds = [];
  for (const rawPatch of applyResult.patches) {
    const clean = { ...rawPatch };
    delete clean._localPatchId;
    delete clean.transformId;
    const appended = addPatch(manifest, clean);
    appendedIds.push(appended.id);
  }
  const transformShape = { ...applyResult.transform };
  delete transformShape.id;
  transformShape.patchIds = appendedIds;
  transformShape.status = 'applied';
  addTransform(manifest, transformShape);

  const manifestPath = path.join(packageDir, 'rebuild-manifest.json');
  writeManifest(manifest, manifestPath);

  return {
    engagementDir,
    packageName,
    packageDir,
    rebuiltZipPath,
    manifestPath,
    originalZipPath,
    manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
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

describe('undo() — atomic transform revert', () => {
  it('reverts every patch in a transform together; transformed-file bytes equal original', async () => {
    const ctx = await buildFinalizedFixture();
    expect(Array.isArray(ctx.manifest.transforms)).toBe(true);
    expect(ctx.manifest.transforms.length).toBeGreaterThan(0);
    const transformId = ctx.manifest.transforms[0].id;
    const transformPatchIds = ctx.manifest.patches
      .filter((p) => p.transformId === transformId)
      .map((p) => p.id);
    expect(transformPatchIds.length).toBeGreaterThan(0);

    const result = await undo(
      ctx.engagementDir,
      ctx.packageName,
      { transforms: [transformId] },
      { now: '2026-05-08T12:00:00.000Z', username: 'consultant' }
    );

    for (const pid of transformPatchIds) {
      const p = result.manifest.patches.find((q) => q.id === pid);
      expect(p.status).toBe('reverted');
    }
    const t = result.manifest.transforms.find((q) => q.id === transformId);
    expect(t.status).toBe('reverted');

    const original = await readFileFromZip(ctx.originalZipPath, 'index.html');
    const reverted = await readFileFromZip(ctx.rebuiltZipPath, 'index.html');
    expect(reverted).toBe(original);

    // Persisted manifest carries revertedTransforms in the new history entry.
    const persistedManifest = JSON.parse(fs.readFileSync(ctx.manifestPath, 'utf8'));
    expect(Array.isArray(persistedManifest.revertHistory)).toBe(true);
    const last = persistedManifest.revertHistory[persistedManifest.revertHistory.length - 1];
    expect(last.revertedTransforms).toEqual([transformId]);
    expect(last.patchIds).toEqual(expect.arrayContaining(transformPatchIds));
  });
});

describe('undo() — refuses single-patch undo of a transform-owned patch', () => {
  it('throws with a clear message when a patch belongs to a transform not in the request', async () => {
    const ctx = await buildFinalizedFixture();
    const transformId = ctx.manifest.transforms[0].id;
    const transformOwnedPatch = ctx.manifest.patches.find((p) => p.transformId === transformId);
    expect(transformOwnedPatch).toBeDefined();

    await expect(
      undo(
        ctx.engagementDir,
        ctx.packageName,
        { patches: [transformOwnedPatch.id] },
        { now: '2026-05-08T12:00:00.000Z', username: 'consultant' }
      )
    ).rejects.toThrow(/belongs to transform/i);
  });
});

describe('undo() — mixed patches + transforms in one call', () => {
  it('reverts both atomic transforms AND standalone safe-tier patches together', async () => {
    // Build a finalized fixture, then ALSO run a safe-mode rebuild on a
    // separate zip and merge in one of those patches as a "standalone"
    // patch (no transformId). This avoids the orchestrator-transformer
    // integration bug while still exercising the mixed undo path.
    const ctx = await buildFinalizedFixture();

    // Add a fake standalone safe-tier patch in the manifest. We need a real
    // before/after pair the fixer can revert. We'll add one through a fake
    // "fixer" — but undo resolves fixers from disk by id. Use a real fixer
    // (add-alt-decorative) since it's present in src/fixers/.
    //
    // Build a tiny transformation we can revert: replace a unique 4-char
    // string in index.html with another, capture before/after with context.
    // We hand-craft a patch matching the `add-alt-decorative` fixer's revert
    // behavior — its revert finds patch.after and replaces it with patch.before.
    const tmpRebuiltUnpack = makeTmp('undo-tx-mixed-unpack');
    await unpack(ctx.rebuiltZipPath, tmpRebuiltUnpack);
    const indexPath = path.join(tmpRebuiltUnpack, 'index.html');
    let content = fs.readFileSync(indexPath, 'utf8');
    // Inject a marker we can later target with our standalone patch's `after`.
    const marker = '<!-- prism-test-marker -->';
    content = content.replace('<body>', `<body>\n${marker}`);
    fs.writeFileSync(indexPath, content, 'utf8');
    await repackDir(tmpRebuiltUnpack, ctx.rebuiltZipPath);

    // Update manifest: add a patch whose revert removes the marker.
    const persisted = JSON.parse(fs.readFileSync(ctx.manifestPath, 'utf8'));
    const now = new Date().toISOString();
    const standalonePatch = {
      id: `patch-${String(persisted.patches.length + 1).padStart(4, '0')}`,
      fixer: 'add-alt-decorative', // any real fixer; we override revert below
      criterion: '1.1.1',
      triage: 'auto-fix safe',
      tier: 'safe',
      confidence: 'definitive',
      provenance: { source: 'deterministic', timestamp: now },
      file: 'index.html',
      range: { startLine: 2, startCol: 1, endLine: 2, endCol: 1 },
      before: '<body>',
      after: `<body>\n${marker}`,
      rationale: 'test-marker injection',
      reversible: true,
      status: 'applied'
    };
    persisted.patches.push(standalonePatch);
    fs.writeFileSync(ctx.manifestPath, JSON.stringify(persisted, null, 2), 'utf8');

    // Stub the fixer so undo()'s revert call works without depending on the
    // real fixer's logic.
    const fakeFixersDir = makeTmp('undo-tx-mixed-fixers');
    const fakeFixerSrc = `
      module.exports = {
        id: 'add-alt-decorative',
        tier: 'safe',
        canFix: () => false,
        apply: () => ({ changed: false, newContent: '', patches: [] }),
        async revert(file, patch) {
          const idx = file.content.indexOf(patch.after);
          if (idx === -1) return { newContent: file.content, log: [] };
          return {
            newContent: file.content.slice(0, idx) + patch.before + file.content.slice(idx + patch.after.length),
            log: []
          };
        }
      };
    `;
    fs.writeFileSync(path.join(fakeFixersDir, 'add-alt-decorative.js'), fakeFixerSrc, 'utf8');

    const transformId = ctx.manifest.transforms[0].id;
    const result = await undo(
      ctx.engagementDir,
      ctx.packageName,
      { patches: [standalonePatch.id], transforms: [transformId] },
      {
        now: '2026-05-08T12:00:00.000Z',
        username: 'consultant',
        fixersDir: fakeFixersDir
      }
    );

    const t = result.manifest.transforms.find((q) => q.id === transformId);
    expect(t.status).toBe('reverted');
    const standaloneAfter = result.manifest.patches.find((p) => p.id === standalonePatch.id);
    expect(standaloneAfter.status).toBe('reverted');
    for (const p of result.manifest.patches) {
      if (p.transformId === transformId) expect(p.status).toBe('reverted');
    }
    expect(result.revertedTransforms).toEqual([transformId]);
    expect(result.reverted).toEqual(expect.arrayContaining([standalonePatch.id]));

    // After undo, the marker is gone too (standalone patch reverted).
    const finalIndex = await readFileFromZip(ctx.rebuiltZipPath, 'index.html');
    expect(finalIndex).not.toContain(marker);
  });
});

describe('undo() — verification re-runs and manifest reflects state', () => {
  it('verify() is invoked on the reverted zip and the new counts land in the manifest', async () => {
    const ctx = await buildFinalizedFixture();
    const transformId = ctx.manifest.transforms[0].id;

    const auditStub = vi.fn().mockResolvedValue({
      packageType: 'scorm12',
      complete: true,
      scorecard: {
        wcagVersion: 'WCAG22',
        passed: false,
        score: 80,
        totalCriteria: 50,
        passedCriteria: 47,
        failedCriteria: 3,
        totalViolations: 3,
        criteriaResults: []
      },
      violations: [
        { criterion: '1.3.1', file: 'index.html', line: 1 },
        { criterion: '1.3.1', file: 'index.html', line: 2 },
        { criterion: '2.4.1', file: 'index.html', line: 3 }
      ],
      scos: [],
      manualReview: [],
      dynamicReport: { skipped: false, reason: null, iframeWarnings: [], dynamicViolationsCount: 0 }
    });
    __setAuditForTest(auditStub);

    const result = await undo(
      ctx.engagementDir,
      ctx.packageName,
      { transforms: [transformId] },
      { now: '2026-05-08T12:00:00.000Z', username: 'consultant' }
    );
    expect(auditStub).toHaveBeenCalled();
    expect(result.manifest.verification.after.violations).toBe(3);
    expect(result.manifest.verification.remaining).toBe(3);
  });
});

describe('undo() — v4 legacy positional form', () => {
  it('accepts an array of patch ids (the v4 calling convention) and undoes them', async () => {
    // Run a real safe-mode rebuild (no transformer involvement). This is the
    // exact path the v4 tests cover and ensures back-compat.
    const inputZip = (() => {
      const dir = makeTmp('undo-tx-legacy-input');
      const p = path.join(dir, 'sample.zip');
      return buildZipFromFiles(p, {
        'index.html':
          '<html><head><title>x</title></head><body>\n  <img src="spacer.gif">\n</body></html>\n',
        'imsmanifest.xml':
          '<?xml version="1.0"?><manifest><resources><resource href="index.html"/></resources></manifest>'
      }).then(() => p);
    })();
    const zipPath = await inputZip;
    const engagementDir = makeTmp('undo-tx-legacy');
    const packageName = 'sample.zip';
    const packageDir = path.join(engagementDir, packageName);
    fs.mkdirSync(packageDir, { recursive: true });

    const result = await rebuild(zipPath, {
      violations: [
        {
          criterion: '1.1.1',
          message: 'decorative spacer image missing alt',
          snippet: '<img src="spacer.gif">',
          file: 'index.html',
          line: 2,
          triage: 'auto-fix safe'
        }
      ]
    }, {
      mode: 'safe',
      engagementId: 'test-legacy',
      packageName,
      outputDir: packageDir
    });
    expect(result.manifest.patches.length).toBeGreaterThanOrEqual(1);
    const patchId = result.manifest.patches[0].id;

    if (result.rebuiltZipPath && result.rebuiltZipPath !== path.join(packageDir, 'rebuilt.zip')) {
      fs.copyFileSync(result.rebuiltZipPath, path.join(packageDir, 'rebuilt.zip'));
    }
    const manifestPath = path.join(packageDir, 'rebuild-manifest.json');
    writeManifest(result.manifest, manifestPath);

    const undoResult = await undo(
      engagementDir,
      packageName,
      [patchId],
      { now: '2026-05-08T12:00:00.000Z', username: 'consultant' }
    );

    const patch = undoResult.manifest.patches.find((p) => p.id === patchId);
    expect(patch.status).toBe('reverted');
    expect(undoResult.reverted).toContain(patchId);
    expect(undoResult.revertedTransforms).toEqual([]);
  });
});

describe('undo() — refuses missing transformer', () => {
  it('throws with a clear message when the transformer module no longer exists', async () => {
    const ctx = await buildFinalizedFixture();
    const transformId = ctx.manifest.transforms[0].id;

    // Tamper the transformer name to reference a non-existent module.
    const persisted = JSON.parse(fs.readFileSync(ctx.manifestPath, 'utf8'));
    persisted.transforms[0].transformer = 'nonexistent-transformer';
    fs.writeFileSync(ctx.manifestPath, JSON.stringify(persisted, null, 2), 'utf8');

    await expect(
      undo(
        ctx.engagementDir,
        ctx.packageName,
        { transforms: [transformId] },
        { now: '2026-05-08T12:00:00.000Z', username: 'consultant' }
      )
    ).rejects.toThrow(/nonexistent-transformer/);
  });
});
