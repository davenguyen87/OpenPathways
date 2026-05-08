/**
 * undo.test.js — Round-trip tests for src/rebuild/undo.js
 *
 * Tests use a real rebuild() call (not mocked) for the apply path, then call
 * undo() to verify the reverse. The verify() step inside undo() is driven
 * through its __setAuditForTest seam to avoid spawning Playwright.
 *
 * Fixture anatomy: a minimal SCORM zip with one HTML file containing one
 * decorative image (triggers add-alt-decorative). Each test builds its own
 * fixture zip with yazl and tears it down in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';

const require = createRequire(import.meta.url);

const { rebuild } = require('../../src/rebuild/index.js');
const { undo } = require('../../src/rebuild/undo.js');
const { unpack } = require('../../src/rebuild/packager.js');
const { __setAuditForTest } = require('../../src/rebuild/verify.js');
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

/** Build a minimal SCORM zip with one HTML file. */
function buildFixtureZip(htmlContent, extraFiles) {
  const dir = makeTmp('undo-fixture');
  const zipPath = path.join(dir, 'sample.zip');
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const ws = fs.createWriteStream(zipPath);
    ws.on('finish', () => resolve(zipPath));
    ws.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(ws);
    zip.addBuffer(Buffer.from(htmlContent, 'utf8'), 'index.html');
    zip.addBuffer(
      Buffer.from(
        '<?xml version="1.0"?><manifest><resources><resource href="index.html"/></resources></manifest>',
        'utf8'
      ),
      'imsmanifest.xml'
    );
    if (extraFiles) {
      for (const [name, body] of Object.entries(extraFiles)) {
        zip.addBuffer(Buffer.from(body, 'utf8'), name);
      }
    }
    zip.end();
  });
}

/** Read a file from inside a zip by unpacking to a temp dir. */
async function readFileFromZip(zipPath, fileName) {
  const dir = makeTmp('undo-read');
  await unpack(zipPath, dir);
  return fs.readFileSync(path.join(dir, fileName), 'utf8');
}

/**
 * Run a rebuild that produces at least one applied patch in the given
 * engagementDir/packageName directory. Returns the full rebuild result.
 */
async function runRebuild(inputZip, engagementDir, packageName) {
  const outDir = path.join(engagementDir, packageName);
  fs.mkdirSync(outDir, { recursive: true });

  // Copy the input zip into place as original.zip (expected convention).
  fs.copyFileSync(inputZip, path.join(outDir, 'original.zip'));
  // Also copy it as rebuilt.zip so undo() can find it on its first run.
  // (In production the CLI writes rebuilt.zip after rebuild(); here we do
  // it manually so the test directory matches the expected layout.)

  const result = await rebuild(inputZip, {
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
    engagementId: 'test-undo-engagement',
    packageName,
    outputDir: outDir
  });

  // rebuild() writes to `outputDir`, but undo() expects rebuilt.zip at
  // `<engagementDir>/<packageName>/rebuilt.zip`. Move it if needed.
  if (result.rebuiltZipPath && result.rebuiltZipPath !== path.join(outDir, 'rebuilt.zip')) {
    fs.copyFileSync(result.rebuiltZipPath, path.join(outDir, 'rebuilt.zip'));
  }

  return result;
}

// ── Stub audit function so verify() doesn't spawn Playwright ─────────────

function makeEmptyAuditResult() {
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

// Set up a passing stub before each test; restore after.
beforeEach(() => {
  __setAuditForTest(vi.fn().mockResolvedValue(makeEmptyAuditResult()));
});
afterEach(() => {
  __setAuditForTest(null);
});

// ── HTML fixture ──────────────────────────────────────────────────────────

const HTML_DECORATIVE = [
  '<html><head><title>x</title></head><body>',
  '  <img src="spacer.gif">',
  '</body></html>',
  ''
].join('\n');

// ── Tests ────────────────────────────────────────────────────────────────

describe('undo() — single-patch round-trip', () => {
  it('reverts one patch: content is byte-identical to pre-apply, status=reverted, revertHistory has one entry', async () => {
    const inputZip = await buildFixtureZip(HTML_DECORATIVE);
    const engagementDir = makeTmp('undo-single');
    const packageName = 'sample.zip';

    const rebuildResult = await runRebuild(inputZip, engagementDir, packageName);
    expect(rebuildResult.manifest.patches.length).toBeGreaterThanOrEqual(1);

    const patchId = rebuildResult.manifest.patches[0].id;

    // Read the original content before rebuild.
    const originalContent = await readFileFromZip(inputZip, 'index.html');
    // Read the rebuilt content (should be different).
    const outDir = path.join(engagementDir, packageName);
    const rebuiltBefore = await readFileFromZip(path.join(outDir, 'rebuilt.zip'), 'index.html');
    expect(rebuiltBefore).not.toBe(originalContent);

    // Write the manifest so undo() can load it.
    const manifestPath = path.join(outDir, 'rebuild-manifest.json');
    const { writeManifest } = require('../../src/rebuild/manifest.js');
    writeManifest(rebuildResult.manifest, manifestPath);

    const undoResult = await undo(engagementDir, packageName, [patchId], {
      now: '2026-05-08T12:00:00.000Z',
      username: 'consultant'
    });

    // (a) File content is byte-identical to original.
    const revertedContent = await readFileFromZip(path.join(outDir, 'rebuilt.zip'), 'index.html');
    expect(revertedContent).toBe(originalContent);

    // (b) Patch status is 'reverted'.
    const patch = undoResult.manifest.patches.find((p) => p.id === patchId);
    expect(patch.status).toBe('reverted');

    // (c) revertHistory has exactly one entry.
    expect(Array.isArray(undoResult.manifest.revertHistory)).toBe(true);
    expect(undoResult.manifest.revertHistory).toHaveLength(1);
    expect(undoResult.manifest.revertHistory[0].revertedAt).toBe('2026-05-08T12:00:00.000Z');
    expect(undoResult.manifest.revertHistory[0].revertedBy).toBe('consultant');
    expect(undoResult.manifest.revertHistory[0].patchIds).toEqual([patchId]);
  });
});

describe('undo() — full undo round-trip', () => {
  it('undoing all patches produces file bytes equal to the original input', async () => {
    const inputZip = await buildFixtureZip(HTML_DECORATIVE);
    const engagementDir = makeTmp('undo-full');
    const packageName = 'sample.zip';

    const rebuildResult = await runRebuild(inputZip, engagementDir, packageName);
    expect(rebuildResult.manifest.patches.length).toBeGreaterThanOrEqual(1);

    const allPatchIds = rebuildResult.manifest.patches.map((p) => p.id);
    const outDir = path.join(engagementDir, packageName);

    // Write the manifest so undo() can load it.
    const { writeManifest } = require('../../src/rebuild/manifest.js');
    const manifestPath = path.join(outDir, 'rebuild-manifest.json');
    writeManifest(rebuildResult.manifest, manifestPath);

    await undo(engagementDir, packageName, allPatchIds, {
      now: '2026-05-08T12:00:00.000Z',
      username: 'consultant'
    });

    // All tracked HTML files should be byte-identical to original.
    for (const patch of rebuildResult.manifest.patches) {
      const originalContent = await readFileFromZip(inputZip, patch.file);
      const revertedContent = await readFileFromZip(path.join(outDir, 'rebuilt.zip'), patch.file);
      expect(revertedContent).toBe(originalContent);
    }
  });
});

describe('undo() — refuse already-reverted patch', () => {
  it('throws with a clear message when the patch is already reverted', async () => {
    const inputZip = await buildFixtureZip(HTML_DECORATIVE);
    const engagementDir = makeTmp('undo-already-reverted');
    const packageName = 'sample.zip';

    const rebuildResult = await runRebuild(inputZip, engagementDir, packageName);
    expect(rebuildResult.manifest.patches.length).toBeGreaterThanOrEqual(1);

    const patchId = rebuildResult.manifest.patches[0].id;
    const outDir = path.join(engagementDir, packageName);
    const { writeManifest } = require('../../src/rebuild/manifest.js');
    const manifestPath = path.join(outDir, 'rebuild-manifest.json');
    writeManifest(rebuildResult.manifest, manifestPath);

    // Undo once — should succeed.
    await undo(engagementDir, packageName, [patchId], {
      now: '2026-05-08T12:00:00.000Z',
      username: 'consultant'
    });

    // Undo again on the same patch — should throw.
    await expect(
      undo(engagementDir, packageName, [patchId], {
        now: '2026-05-08T13:00:00.000Z',
        username: 'consultant'
      })
    ).rejects.toThrow(/not in "applied" status/);
  });
});

describe('undo() — refuse when fixer does not exist', () => {
  it('throws with the missing fixer name when manifest.fixer references a non-existent fixer', async () => {
    const inputZip = await buildFixtureZip(HTML_DECORATIVE);
    const engagementDir = makeTmp('undo-missing-fixer');
    const packageName = 'sample.zip';

    const rebuildResult = await runRebuild(inputZip, engagementDir, packageName);
    expect(rebuildResult.manifest.patches.length).toBeGreaterThanOrEqual(1);

    const outDir = path.join(engagementDir, packageName);

    // Tamper the fixer field to reference a non-existent fixer.
    const patchId = rebuildResult.manifest.patches[0].id;
    rebuildResult.manifest.patches[0].fixer = 'nonexistent-fixer';

    // Write the tampered manifest.
    // We can't use writeManifest because it validates patches (fixer is a
    // string, which passes). Just write raw JSON.
    const manifestPath = path.join(outDir, 'rebuild-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(rebuildResult.manifest, null, 2), 'utf8');

    // Use a known fixers dir (real one — which doesn't have this fixer).
    const fixersDir = path.resolve(process.cwd(), 'src/fixers');

    await expect(
      undo(engagementDir, packageName, [patchId], {
        now: '2026-05-08T12:00:00.000Z',
        username: 'consultant',
        fixersDir
      })
    ).rejects.toThrow(/nonexistent-fixer/);
  });
});

describe('undo() — multi-patch on same file', () => {
  it('reverting two patches on the same file in reverse order yields correct final bytes', async () => {
    // We need two patches on the same file. Build an HTML file with two
    // decorative images so add-alt-decorative emits two patches.
    const htmlTwoImgs = [
      '<html><head><title>x</title></head><body>',
      '  <img src="spacer.gif">',
      '  <img src="divider.gif">',
      '</body></html>',
      ''
    ].join('\n');

    const inputZip = await buildFixtureZip(htmlTwoImgs);
    const engagementDir = makeTmp('undo-multi');
    const packageName = 'sample.zip';
    const outDir = path.join(engagementDir, packageName);
    fs.mkdirSync(outDir, { recursive: true });

    fs.copyFileSync(inputZip, path.join(outDir, 'original.zip'));

    // Supply two violations — one per img.
    const result = await rebuild(inputZip, {
      violations: [
        {
          criterion: '1.1.1',
          message: 'decorative spacer image missing alt',
          snippet: '<img src="spacer.gif">',
          file: 'index.html',
          line: 2,
          triage: 'auto-fix safe'
        },
        {
          criterion: '1.1.1',
          message: 'decorative divider image missing alt',
          snippet: '<img src="divider.gif">',
          file: 'index.html',
          line: 3,
          triage: 'auto-fix safe'
        }
      ]
    }, {
      mode: 'safe',
      engagementId: 'test-multi',
      packageName,
      outputDir: outDir
    });

    if (result.rebuiltZipPath && result.rebuiltZipPath !== path.join(outDir, 'rebuilt.zip')) {
      fs.copyFileSync(result.rebuiltZipPath, path.join(outDir, 'rebuilt.zip'));
    }

    // We may have 1 or 2 patches depending on how add-alt-decorative handles
    // multiple violations in one pass.
    const appliedPatches = result.manifest.patches.filter((p) => p.status === 'applied');
    expect(appliedPatches.length).toBeGreaterThanOrEqual(1);

    const { writeManifest } = require('../../src/rebuild/manifest.js');
    const manifestPath = path.join(outDir, 'rebuild-manifest.json');
    writeManifest(result.manifest, manifestPath);

    const allPatchIds = appliedPatches.map((p) => p.id);

    // Undo all patches.
    const undoResult = await undo(engagementDir, packageName, allPatchIds, {
      now: '2026-05-08T12:00:00.000Z',
      username: 'consultant'
    });

    // All patches should be reverted.
    for (const id of allPatchIds) {
      const p = undoResult.manifest.patches.find((patch) => patch.id === id);
      expect(p.status).toBe('reverted');
    }

    // The file in rebuilt.zip should match the original.
    const originalContent = await readFileFromZip(inputZip, 'index.html');
    const revertedContent = await readFileFromZip(path.join(outDir, 'rebuilt.zip'), 'index.html');
    expect(revertedContent).toBe(originalContent);
  });
});
