import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import * as cheerio from 'cheerio';

import {
  createManifest,
  addPatch,
  addDeferred,
  setVerification
} from '../../src/rebuild/manifest.js';
import { buildPatch } from '../../src/rebuild/types.js';
import { renderRebuildDiff } from '../../src/reporter/rebuild-diff.js';

/**
 * Brand object with the same shape as config/brand.json. Hardcoded here so
 * the test does not depend on disk state — the renderer is a pure function
 * of (manifest, brand).
 */
const TEST_BRAND = {
  mark: 'SL',
  name: 'Skill Loop',
  tagline: 'Cornerstone OnDemand specialists',
  paper: '#f3efe6',
  'paper-2': '#ebe5d6',
  'paper-3': '#e3dcc8',
  ink: '#111633',
  'ink-2': '#2a3158',
  'ink-3': '#55597a',
  rule: '#c8bfa8',
  'rule-2': '#948a74',
  accent: '#2f7d72',
  'accent-deep': '#1d4f48',
  'accent-soft': 'rgba(47,125,114,0.14)',
  cta: '#f28619',
  ok: '#1b7a3d',
  'sev-critical': '#c46a14',
  'sev-serious': '#de8a2e',
  'sev-moderate': '#55597a',
  'sev-minor': '#948a74'
};

const tmpFiles = [];
function tmp(name) {
  const p = path.join(os.tmpdir(), `prism-rebuild-diff-${name}-${process.pid}.html`);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  while (tmpFiles.length) {
    const f = tmpFiles.pop();
    try { fs.unlinkSync(f); } catch (_) { /* ignore */ }
  }
});

/**
 * Build a manifest with `n` `1.1.1` patches plus optional extra patches.
 * Uses a fixed createdAt so the renderer output is deterministic.
 */
function buildSampleManifest({ extraPatches = [], deferredCount = 0, verification } = {}) {
  const m = createManifest({
    engagementId: 'acme-2026',
    packageName: 'compliance-101.zip',
    inputZipSha256: 'a'.repeat(64),
    createdAt: '2026-05-07T14:22:11Z'
  });
  m.outputZipSha256 = 'b'.repeat(64);

  function altPatch(criterion, file) {
    const content = '<html>\n  <body>\n    <img src="x.gif">\n  </body>\n</html>\n';
    const original = '<img src="x.gif">';
    const replacement = '<img src="x.gif" alt="">';
    const offset = content.indexOf(original);
    return buildPatch({
      fixer: 'add-alt-decorative',
      criterion,
      confidence: 'definitive',
      file,
      content,
      originalOffset: offset,
      originalText: original,
      replacementText: replacement,
      rationale: 'decorative image'
    });
  }

  for (const ep of extraPatches) {
    addPatch(m, altPatch(ep.criterion, ep.file));
  }

  for (let i = 0; i < deferredCount; i++) {
    addDeferred(m, {
      criterion: '1.1.1',
      triage: 'auto-fix assisted',
      reason: 'tier=assisted not enabled',
      file: `shared/page-${i}.html`,
      line: 10 + i
    });
  }

  if (verification) {
    setVerification(m, verification.before, verification.after);
  }

  return m;
}

describe('renderRebuildDiff', () => {
  it('renders three patches across two criteria with correct chips and counts', async () => {
    const m = buildSampleManifest({
      extraPatches: [
        { criterion: '1.1.1', file: 'shared/img/page-1.html' },
        { criterion: '1.1.1', file: 'shared/img/page-2.html' },
        { criterion: '1.3.1', file: 'shared/img/page-3.html' }
      ],
      verification: {
        before: { violations: 5, criteriaFailed: 2, section508Failed: 1 },
        after: { violations: 2, criteriaFailed: 1, section508Failed: 0 }
      }
    });

    const out = tmp('three-patches');
    const html = await renderRebuildDiff(m, TEST_BRAND, out);
    const onDisk = fs.readFileSync(out, 'utf8');
    expect(onDisk).toBe(html);

    const $ = cheerio.load(html);
    expect($('.patch-row').length).toBe(3);

    // Both criteria appear in chip text (filter bar + per-row).
    const allChipText = $('.chip, .chip-static').toArray().map((el) => $(el).text()).join(' ');
    expect(allChipText).toContain('1.1.1');
    expect(allChipText).toContain('1.3.1');

    // Summary strip "patches applied" = 3 (first .ss-cell).
    const firstNum = $('.summary-strip .ss-cell').first().find('.num').text().trim();
    expect(firstNum).toBe('3');

    // Verification cell renders before -> after.
    const verifyText = $('.summary-strip .ss-verify').text();
    expect(verifyText).toContain('5');
    expect(verifyText).toContain('2');
    expect(verifyText).toContain('Resolved 3');
    expect(verifyText).toContain('Introduced 0');
  });

  it('renders an empty state when there are no patches and surfaces deferred count', async () => {
    const m = buildSampleManifest({ deferredCount: 5 });
    const out = tmp('empty');
    const html = await renderRebuildDiff(m, TEST_BRAND, out);

    const $ = cheerio.load(html);
    expect($('.patch-row').length).toBe(0);
    expect($('.empty-state').length).toBe(1);

    // Summary strip "deferred findings" = 5 (third .ss-cell).
    const cells = $('.summary-strip .ss-cell');
    expect(cells.eq(2).find('.num').text().trim()).toBe('5');

    // Empty state body mentions the deferred count.
    expect($('.empty-state').text()).toContain('5');
  });

  it('is deterministic — same manifest renders byte-identical output', async () => {
    const m = buildSampleManifest({
      extraPatches: [
        { criterion: '1.1.1', file: 'shared/img/page-1.html' },
        { criterion: '1.3.1', file: 'shared/img/page-2.html' }
      ]
    });
    // Pin the per-patch provenance timestamps too — buildPatch stamps Date.now().
    for (const p of m.patches) {
      p.provenance.timestamp = '2026-05-07T14:22:09Z';
    }

    const a = tmp('det-a');
    const b = tmp('det-b');
    const ha = await renderRebuildDiff(m, TEST_BRAND, a);
    const hb = await renderRebuildDiff(m, TEST_BRAND, b);
    expect(hb).toBe(ha);
    expect(fs.readFileSync(a, 'utf8')).toBe(fs.readFileSync(b, 'utf8'));
  });

  it('produces well-formed HTML parseable by cheerio with html/head/body and patch rows', async () => {
    const m = buildSampleManifest({
      extraPatches: [
        { criterion: '1.1.1', file: 'shared/img/page-1.html' },
        { criterion: '1.1.1', file: 'shared/img/page-2.html' },
        { criterion: '1.3.1', file: 'shared/img/page-3.html' }
      ]
    });
    const out = tmp('well-formed');
    const html = await renderRebuildDiff(m, TEST_BRAND, out);

    // cheerio.load throws on unparseable input.
    const $ = cheerio.load(html);
    expect($('html').length).toBe(1);
    expect($('head').length).toBe(1);
    expect($('body').length).toBe(1);
    expect($('.patch-row').length).toBeGreaterThanOrEqual(1);
  });

  it('emits one approve checkbox per patch', async () => {
    const m = buildSampleManifest({
      extraPatches: [
        { criterion: '1.1.1', file: 'shared/img/page-1.html' },
        { criterion: '1.1.1', file: 'shared/img/page-2.html' },
        { criterion: '1.3.1', file: 'shared/img/page-3.html' }
      ]
    });
    const out = tmp('checkboxes');
    const html = await renderRebuildDiff(m, TEST_BRAND, out);

    const $ = cheerio.load(html);
    const approveBoxes = $('input[type="checkbox"][name^="approve-patch-"]');
    expect(approveBoxes.length).toBe(m.patches.length);

    // Each row should also expose the rejected hidden input + reject button.
    expect($('button.pr-reject').length).toBe(m.patches.length);
    expect($('input[type="hidden"][name="rejected"]').length).toBe(m.patches.length);
  });
});
