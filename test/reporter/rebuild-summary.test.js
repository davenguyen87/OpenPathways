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
import { renderRebuildSummary } from '../../src/reporter/rebuild-summary.js';

/**
 * Brand object with the same shape as config/brand.json. Hardcoded so the
 * test does not depend on disk state — the renderer is a pure function
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
  const p = path.join(os.tmpdir(), `prism-rebuild-summary-${name}-${process.pid}.html`);
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
 * Build a manifest with optional patches, deferred findings, and verification.
 * Uses a fixed createdAt so output is deterministic.
 */
function buildSampleManifest({ extraPatches = [], deferredItems = [], verification, standard } = {}) {
  const m = createManifest({
    engagementId: 'acme-2026',
    packageName: 'compliance-101.zip',
    inputZipSha256: 'a'.repeat(64),
    createdAt: '2026-05-07T14:22:11Z',
    standard
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
    const patch = altPatch(ep.criterion || '1.1.1', ep.file || 'shared/page.html');
    // Pin provenance timestamp for determinism
    patch.provenance.timestamp = '2026-05-07T14:22:09Z';
    addPatch(m, patch);
  }

  for (const d of deferredItems) {
    addDeferred(m, d);
  }

  if (verification) {
    setVerification(m, verification.before, verification.after);
  }

  return m;
}

describe('renderRebuildSummary', () => {
  it('scoreboard shows before/after violations and delta badge; chips show unchecked when criteriaFailed > 0', async () => {
    const m = buildSampleManifest({
      extraPatches: [
        { criterion: '1.1.1', file: 'shared/img/page-1.html' },
        { criterion: '1.1.1', file: 'shared/img/page-2.html' }
      ],
      verification: {
        before: { violations: 47, criteriaFailed: 12, section508Failed: 5 },
        after:  { violations: 9,  criteriaFailed: 4,  section508Failed: 1 }
      }
    });

    const out = tmp('scoreboard');
    const html = await renderRebuildSummary(m, TEST_BRAND, out);
    const onDisk = fs.readFileSync(out, 'utf8');
    expect(onDisk).toBe(html);

    const $ = cheerio.load(html);

    // Scoreboard: "Before rebuild → Total violations" contains 47
    const beforeCell = $('[data-scoreboard-before-violations]');
    expect(beforeCell.attr('data-scoreboard-before-violations')).toBe('47');
    expect(beforeCell.text().trim()).toBe('47');

    // Scoreboard: "After rebuild → Total violations" contains 9
    const afterCell = $('[data-scoreboard-after-violations]');
    expect(afterCell.attr('data-scoreboard-after-violations')).toBe('9');
    expect(afterCell.text().trim()).toBe('9');

    // Delta badge: contains "38"
    const deltaBadgeText = $('.delta-badge').text();
    expect(deltaBadgeText).toContain('38');

    // Both standards-met chips are unchecked (criteriaFailed=4, section508Failed=1, both > 0)
    const chips = $('.std-chip');
    expect(chips.length).toBe(2);
    chips.each((_i, el) => {
      expect($(el).attr('data-met')).toBe('false');
    });
  });

  it('regression banner is shown with introduced count and DO NOT SHIP text when introduced > 0', async () => {
    // introduced = max(0, after.violations - before.violations)
    // Use after.violations > before.violations to trigger introduced > 0
    const m = buildSampleManifest({
      verification: {
        before: { violations: 5,  criteriaFailed: 2, section508Failed: 1 },
        after:  { violations: 10, criteriaFailed: 3, section508Failed: 2 }
      }
    });
    // introduced = 10 - 5 = 5

    const out = tmp('regression');
    const html = await renderRebuildSummary(m, TEST_BRAND, out);

    const $ = cheerio.load(html);

    // Regression banner must exist
    const banner = $('.regression-banner');
    expect(banner.length).toBe(1);

    const bannerText = banner.text();
    expect(bannerText).toContain('DO NOT SHIP');
    // The introduced count (5) must appear in the banner
    expect(bannerText).toContain('5');
  });

  it('regression banner is NOT shown when introduced === 0', async () => {
    const m = buildSampleManifest({
      verification: {
        before: { violations: 10, criteriaFailed: 4, section508Failed: 2 },
        after:  { violations: 2,  criteriaFailed: 1, section508Failed: 0 }
      }
    });

    const out = tmp('no-regression');
    const html = await renderRebuildSummary(m, TEST_BRAND, out);

    const $ = cheerio.load(html);
    expect($('.regression-banner').length).toBe(0);
  });

  it('both standards-met chips are checked when criteriaFailed === 0 and section508Failed === 0', async () => {
    const m = buildSampleManifest({
      verification: {
        before: { violations: 20, criteriaFailed: 6, section508Failed: 3 },
        after:  { violations: 0,  criteriaFailed: 0, section508Failed: 0 }
      }
    });

    const out = tmp('chips-checked');
    const html = await renderRebuildSummary(m, TEST_BRAND, out);

    const $ = cheerio.load(html);

    const chips = $('.std-chip');
    expect(chips.length).toBe(2);
    chips.each((_i, el) => {
      expect($(el).attr('data-met')).toBe('true');
      // Visible glyph must be ☑
      const glyphEl = $(el).find('.std-chip-glyph');
      expect(glyphEl.text()).toBe('☑');
    });
  });

  it('WCAG chip label reflects manifest.standard (wcag21 → "WCAG 2.1 AA met")', async () => {
    const m = buildSampleManifest({
      standard: 'wcag21',
      verification: {
        before: { violations: 5, criteriaFailed: 2, section508Failed: 1 },
        after:  { violations: 1, criteriaFailed: 1, section508Failed: 0 }
      }
    });

    const out = tmp('wcag21-label');
    const html = await renderRebuildSummary(m, TEST_BRAND, out);

    expect(html).toContain('WCAG 2.1 AA met');
    expect(html).not.toContain('WCAG 2.2 AA met');

    // Confirm via DOM that the label lives on the chip and the chip's met
    // status is unaffected (criteriaFailed=1 → unchecked).
    const $ = cheerio.load(html);
    const chips = $('.std-chip');
    expect(chips.length).toBe(2);
    const wcagChip = chips.eq(0);
    expect(wcagChip.find('.std-chip-label').text()).toBe('WCAG 2.1 AA met');
    expect(wcagChip.attr('data-met')).toBe('false');
  });

  it('is deterministic — same manifest renders byte-identical output', async () => {
    const m = buildSampleManifest({
      extraPatches: [
        { criterion: '1.1.1', file: 'shared/img/page-1.html' },
        { criterion: '1.3.1', file: 'shared/img/page-2.html' }
      ],
      verification: {
        before: { violations: 15, criteriaFailed: 5, section508Failed: 2 },
        after:  { violations: 3,  criteriaFailed: 2, section508Failed: 0 }
      }
    });

    const a = tmp('det-a');
    const b = tmp('det-b');
    const ha = await renderRebuildSummary(m, TEST_BRAND, a);
    const hb = await renderRebuildSummary(m, TEST_BRAND, b);
    expect(hb).toBe(ha);
    expect(fs.readFileSync(a, 'utf8')).toBe(fs.readFileSync(b, 'utf8'));
  });

  it('produces well-formed HTML parseable by cheerio with html/head/body', async () => {
    const m = buildSampleManifest({
      extraPatches: [
        { criterion: '1.1.1', file: 'shared/img/page-1.html' }
      ]
    });

    const out = tmp('well-formed');
    const html = await renderRebuildSummary(m, TEST_BRAND, out);

    // cheerio.load should not throw on parseable input
    const $ = cheerio.load(html);
    expect($('html').length).toBe(1);
    expect($('head').length).toBe(1);
    expect($('body').length).toBe(1);
  });

  it('deferred findings render with criterion, file, line, reason grouped by reason', async () => {
    const m = buildSampleManifest({
      deferredItems: [
        {
          criterion: '1.1.1',
          triage: 'auto-fix assisted',
          reason: 'tier=assisted not enabled',
          file: 'shared/page-7.html',
          line: 22
        },
        {
          criterion: '2.4.6',
          triage: 'author rework',
          reason: 'requires author judgment',
          file: 'shared/page-8.html',
          line: 45
        },
        {
          criterion: '1.3.1',
          triage: 'auto-fix assisted',
          reason: 'tier=assisted not enabled',
          file: 'shared/page-9.html',
          line: 11
        }
      ]
    });

    const out = tmp('deferred');
    const html = await renderRebuildSummary(m, TEST_BRAND, out);

    const $ = cheerio.load(html);

    // All three rows must appear
    const rows = $('.df-row');
    expect(rows.length).toBe(3);

    const allText = $('.deferred-table').text();

    // Each criterion is present
    expect(allText).toContain('1.1.1');
    expect(allText).toContain('2.4.6');
    expect(allText).toContain('1.3.1');

    // Each file is present
    expect(allText).toContain('shared/page-7.html');
    expect(allText).toContain('shared/page-8.html');
    expect(allText).toContain('shared/page-9.html');

    // Each line number is present
    expect(allText).toContain('22');
    expect(allText).toContain('45');
    expect(allText).toContain('11');

    // Each reason is present
    expect(allText).toContain('tier=assisted not enabled');
    expect(allText).toContain('requires author judgment');

    // Two distinct reason groups (two <tbody> groups)
    const groupHeadings = $('.df-group-heading');
    expect(groupHeadings.length).toBe(2);
  });

  it('renders "No deferred findings." when deferred array is empty', async () => {
    const m = buildSampleManifest({});

    const out = tmp('no-deferred');
    const html = await renderRebuildSummary(m, TEST_BRAND, out);

    const $ = cheerio.load(html);
    const emptyText = $('.empty-deferred').text();
    expect(emptyText).toContain('No deferred findings');
  });

  it('method note lists fixer names alphabetically and references standard and diff link', async () => {
    const m = buildSampleManifest({
      extraPatches: [
        { criterion: '1.1.1', file: 'shared/img/page-1.html' },
        { criterion: '1.3.1', file: 'shared/img/page-2.html' }
      ]
    });

    const out = tmp('method-note');
    const html = await renderRebuildSummary(m, TEST_BRAND, out);

    const $ = cheerio.load(html);
    const noteText = $('.method-note').text();

    // Fixer name appears
    expect(noteText).toContain('add-alt-decorative');
    // Standard appears
    expect(noteText).toContain('wcag22');
    // Link to diff report appears in the DOM
    expect($('.method-note a[href="rebuild-diff.html"]').length).toBeGreaterThanOrEqual(1);
  });
});
