/**
 * Orchestrator tests. The shape of these is deliberately small —
 * end-to-end audit -> rebuild integration is chunk 09's job. Here we just
 * confirm the contract:
 *
 *   - Safe-tier path: writes a zip and emits at least one patch.
 *   - Tier dispatch: assisted + full short-circuit; no zip on disk; every
 *     finding lands in `deferred`.
 *   - Unclaimed finding: deferred with reason matching /no fixer registered/i.
 *   - Validity gate: a fixer that emits broken HTML has its patches dropped
 *     and a deferred entry recorded with the documented reason.
 *
 * We build the input zip in-memory with yazl rather than depending on an
 * existing fixture that happens to trigger a specific safe-tier fixer —
 * keeps the test independent of changes elsewhere.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';

const require = createRequire(import.meta.url);
const { rebuild } = require('../../src/rebuild/index.js');
const { sha256 } = require('../../src/rebuild/packager.js');
const { buildPatch } = require('../../src/rebuild/types.js');
const yazl = require('yazl');

const tmpDirs = [];
function makeTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch (_) {
      // best-effort
    }
  }
});

/** Build a minimal SCORM-shaped zip on disk and return its path. */
function buildFixtureZip({ htmlContent, extraFiles }) {
  const dir = makeTmp('rb-orch-fixture');
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

const HTML_WITH_DECORATIVE_IMG =
  '<html><head><title>x</title></head><body>\n  <img src="spacer.gif">\n</body></html>\n';

describe('rebuild() — safe tier', () => {
  it('produces a manifest with patches, writes a rebuilt .zip, and changes the SHA', async () => {
    const inputZip = await buildFixtureZip({ htmlContent: HTML_WITH_DECORATIVE_IMG });
    const outDir = makeTmp('rb-orch-out');

    const auditResults = {
      violations: [
        {
          criterion: '1.1.1',
          message: 'decorative spacer image missing alt',
          snippet: '<img src="spacer.gif">',
          file: 'index.html',
          line: 1,
          triage: 'auto-fix safe'
        }
      ]
    };

    const result = await rebuild(inputZip, auditResults, {
      mode: 'safe',
      engagementId: 'test',
      packageName: 'sample.zip',
      outputDir: outDir
    });

    expect(result.rebuiltZipPath).toBeTruthy();
    expect(fs.existsSync(result.rebuiltZipPath)).toBe(true);
    expect(path.basename(result.rebuiltZipPath)).toBe('sample.rebuilt.zip');

    expect(result.manifest.patches.length).toBeGreaterThanOrEqual(1);
    expect(result.manifest.patches[0].fixer).toBe('add-alt-decorative');
    expect(result.manifest.mode).toBe('safe');
    expect(result.manifest.standard).toBe('wcag22');

    const inputSha = await sha256(inputZip);
    const outputSha = await sha256(result.rebuiltZipPath);
    expect(outputSha).not.toBe(inputSha);
    expect(result.manifest.inputZipSha256).toBe(inputSha);
    expect(result.manifest.outputZipSha256).toBe(outputSha);
  });
});

describe('rebuild() — tier dispatch', () => {
  it('mode=assisted skips fixers, defers every finding, writes no zip', async () => {
    const inputZip = await buildFixtureZip({ htmlContent: HTML_WITH_DECORATIVE_IMG });
    const outDir = makeTmp('rb-orch-assisted-out');

    const auditResults = {
      violations: [
        { criterion: '1.1.1', message: 'spacer', file: 'index.html', line: 1, triage: 'auto-fix safe' },
        { criterion: '1.3.1', message: 'heading', file: 'index.html', line: 5, triage: 'auto-fix safe' }
      ]
    };

    const result = await rebuild(inputZip, auditResults, {
      mode: 'assisted',
      engagementId: 'test',
      packageName: 'sample.zip',
      outputDir: outDir
    });

    expect(result.rebuiltZipPath).toBeNull();
    expect(result.manifest.patches).toHaveLength(0);
    expect(result.manifest.deferred).toHaveLength(2);
    expect(result.manifest.deferred[0].reason).toMatch(/tier=assisted/);
    // outDir exists but should be empty (we didn't write the zip).
    const outFiles = fs.readdirSync(outDir);
    expect(outFiles).toHaveLength(0);
  });

  it('mode=full behaves the same way', async () => {
    const inputZip = await buildFixtureZip({ htmlContent: HTML_WITH_DECORATIVE_IMG });
    const outDir = makeTmp('rb-orch-full-out');
    const auditResults = {
      violations: [{ criterion: '2.4.7', message: 'focus', file: 'index.html', line: 9, triage: 'auto-fix safe' }]
    };

    const result = await rebuild(inputZip, auditResults, {
      mode: 'full',
      engagementId: 'test',
      packageName: 'sample.zip',
      outputDir: outDir
    });

    expect(result.rebuiltZipPath).toBeNull();
    expect(result.manifest.patches).toHaveLength(0);
    expect(result.manifest.deferred).toHaveLength(1);
    expect(result.manifest.deferred[0].reason).toMatch(/tier=full/);
  });
});

describe('rebuild() — unclaimed findings', () => {
  it('routes findings whose criterion no fixer claims to manifest.deferred', async () => {
    // Target a `.txt` file. None of the safe-tier fixers register against
    // plain text, so the violation is guaranteed to fall through to the
    // unclaimed path. (Several existing fixers ignore the violation
    // entirely and claim any HTML file missing <lang>, <title>, etc., so
    // an HTML target wouldn't isolate the unclaimed-finding behavior.)
    const inputZip = await buildFixtureZip({
      htmlContent: '<!doctype html><html lang="en"><head><title>x</title></head><body></body></html>',
      extraFiles: { 'notes.txt': 'plain text content\n' }
    });
    const outDir = makeTmp('rb-orch-unclaimed-out');

    const auditResults = {
      violations: [
        { criterion: '9.9.9', message: 'made up criterion', file: 'notes.txt', line: 1, triage: 'auto-fix safe' }
      ]
    };

    const result = await rebuild(inputZip, auditResults, {
      mode: 'safe',
      engagementId: 'test',
      packageName: 'sample.zip',
      outputDir: outDir
    });

    expect(result.manifest.patches).toHaveLength(0);
    expect(result.manifest.deferred).toHaveLength(1);
    expect(result.manifest.deferred[0].reason).toMatch(/no fixer registered/i);
    expect(result.manifest.deferred[0].criterion).toBe('9.9.9');
  });
});

describe('rebuild() — validity gate', () => {
  it('drops patches from a fixer that produces unparseable output', async () => {
    // Mock-fixer directory so we can swap in a known-broken fixer without
    // touching src/fixers/. The orchestrator's `fixersDir` opt exists for
    // exactly this case.
    //
    // We target a `.json` file rather than `.html` because cheerio is
    // intentionally permissive — almost no string makes cheerio.load()
    // throw, so an HTML-target test would need pathological non-string
    // input, which a fixer would never realistically emit. JSON.parse()'s
    // strictness gives us a clean, realistic failure mode.
    const fixersDir = makeTmp('rb-orch-mock-fixers');
    const mockFixerSource = `
const { buildPatch } = require(${JSON.stringify(
  path.resolve(__dirname, '../../src/rebuild/types.js')
)});
const FIXER_ID = 'mock-broken-fixer';
const CRITERION = '9.9.1';
module.exports = {
  id: FIXER_ID,
  name: 'mock broken fixer',
  supported: ['scorm12'],
  confidence: 'definitive',
  criterion: CRITERION,
  triage: 'auto-fix safe',
  tier: 'safe',
  provenance: 'deterministic',
  canFix(file, violation) {
    return violation && violation.criterion === CRITERION;
  },
  async apply(file, violations) {
    const patch = buildPatch({
      fixer: FIXER_ID,
      criterion: CRITERION,
      confidence: 'definitive',
      file: file.path,
      content: file.content,
      originalOffset: 0,
      originalText: file.content.slice(0, 1),
      replacementText: '{',
      rationale: 'mock — intentionally produces invalid JSON'
    });
    return {
      changed: true,
      newContent: '{"unterminated":',
      patches: [patch],
      log: []
    };
  },
  async revert(file, patch) {
    return { newContent: file.content, log: [] };
  },
  async fix(file, violations) {
    const r = await this.apply(file, violations);
    return { changed: r.changed, newContent: r.newContent, log: r.log };
  }
};
`;
    fs.writeFileSync(path.join(fixersDir, 'mock-broken.js'), mockFixerSource, 'utf8');

    const inputZip = await buildFixtureZip({
      htmlContent: HTML_WITH_DECORATIVE_IMG,
      extraFiles: { 'data.json': '{"a":1}' }
    });
    const outDir = makeTmp('rb-orch-validity-out');

    const auditResults = {
      violations: [
        { criterion: '9.9.1', message: 'data is broken', file: 'data.json', line: 1, triage: 'auto-fix safe' }
      ]
    };

    const result = await rebuild(inputZip, auditResults, {
      mode: 'safe',
      engagementId: 'test',
      packageName: 'sample.zip',
      outputDir: outDir,
      fixersDir
    });

    expect(result.manifest.patches).toHaveLength(0);
    expect(result.manifest.deferred.length).toBeGreaterThanOrEqual(1);
    const reasons = result.manifest.deferred.map((d) => d.reason);
    expect(reasons.some((r) => /fixer produced invalid output/.test(r))).toBe(true);
  });
});
