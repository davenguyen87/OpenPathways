import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import * as cheerio from 'cheerio';

import {
  createManifest,
  addPatch,
  addTransform,
  addDeferred,
  setVerification
} from '../../src/rebuild/manifest.js';
import { buildPatch } from '../../src/rebuild/types.js';
import { renderRebuildPreview } from '../../src/reporter/rebuild-preview.js';

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
  const p = path.join(os.tmpdir(), `prism-rebuild-preview-${name}-${process.pid}.html`);
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
 * Build a small `<div>` → `<main>` style patch that round-trips through
 * `buildPatch`. Pinned provenance timestamp for determinism.
 */
function landmarkPatch(file) {
  const content =
    '<html>\n  <body>\n    <div class="main-content">hello</div>\n  </body>\n</html>\n';
  const original = '<div class="main-content">';
  const replacement = '<main class="main-content">';
  const offset = content.indexOf(original);
  const p = buildPatch({
    fixer: 'landmark-insertion',
    criterion: '1.3.1',
    triage: 'author rework',
    tier: 'full',
    confidence: 'likely',
    provenanceSource: 'rule-based',
    file,
    content,
    originalOffset: offset,
    originalText: original,
    replacementText: replacement,
    rationale: 'promoted main content wrapper to <main> based on layout signals'
  });
  p.provenance.timestamp = '2026-05-07T14:22:09Z';
  return p;
}

function widgetPatch(file) {
  const content =
    '<html>\n  <body>\n    <div class="tabs">a</div>\n  </body>\n</html>\n';
  const original = '<div class="tabs">';
  const replacement = '<div class="tabs" role="tablist">';
  const offset = content.indexOf(original);
  const p = buildPatch({
    fixer: 'widget-replacement-tabs',
    criterion: '4.1.2',
    triage: 'author rework',
    tier: 'full',
    confidence: 'likely',
    provenanceSource: 'rule-based',
    file,
    content,
    originalOffset: offset,
    originalText: original,
    replacementText: replacement,
    rationale: 'replaced div-soup tabs with ARIA-compliant pattern'
  });
  p.provenance.timestamp = '2026-05-07T14:22:09Z';
  return p;
}

function pageSplitPatch(file) {
  const content =
    '<html>\n  <body>\n    <h1>Module 1</h1>\n  </body>\n</html>\n';
  const original = '<h1>Module 1</h1>';
  const replacement = '<h1 id="module-1">Module 1</h1>';
  const offset = content.indexOf(original);
  const p = buildPatch({
    fixer: 'page-split',
    criterion: '2.4.1',
    triage: 'author rework',
    tier: 'full',
    confidence: 'likely',
    provenanceSource: 'llm',
    file,
    content,
    originalOffset: offset,
    originalText: original,
    replacementText: replacement,
    rationale: 'identified module boundary for SCO split'
  });
  p.provenance.timestamp = '2026-05-07T14:22:09Z';
  p.provenance.model = 'claude-opus-4-7';
  p.provenance.promptHash = 'h'.repeat(64);
  p.provenance.modelConfidence = 0.84;
  return p;
}

/**
 * Manifest with one transform per family (3 total). Pinned createdAt so the
 * renderer output is deterministic.
 *
 * @param {Object} opts
 * @param {'pending-checkpoint'|'applied'|'rejected'} [opts.status='pending-checkpoint']
 * @param {boolean} [opts.includeVerification=false]
 */
function buildThreeFamilyManifest(opts = {}) {
  const status = opts.status || 'pending-checkpoint';

  const m = createManifest({
    engagementId: 'acme-2026',
    packageName: 'compliance-101.zip',
    inputZipSha256: 'a'.repeat(64),
    createdAt: '2026-05-07T14:22:11Z'
  });
  m.outputZipSha256 = 'b'.repeat(64);

  // Patches first.
  const lp = addPatch(m, landmarkPatch('shared/page-3.html'));
  const wp = addPatch(m, widgetPatch('shared/widgets.html'));
  const sp = addPatch(m, pageSplitPatch('shared/long-page.html'));

  // Three transforms, one per family.
  addTransform(m, {
    transformer: 'landmark-insertion',
    family: 'landmark',
    criteria: ['1.3.1', '2.4.1', '4.1.2'],
    tier: 'full',
    scope: { files: ['shared/page-3.html'], manifestEdited: false },
    patchIds: [lp.id],
    provenance: { source: 'rule-based', timestamp: '2026-05-07T14:22:09Z' },
    rationale: 'Promoted main wrapper to <main>.',
    previewPath: 'rebuild-preview.html#transform-0001',
    requiresCheckpointApproval: true,
    status
  });
  addTransform(m, {
    transformer: 'widget-replacement-tabs',
    family: 'widget',
    criteria: ['4.1.2', '2.1.1'],
    tier: 'full',
    scope: { files: ['shared/widgets.html'], manifestEdited: false },
    patchIds: [wp.id],
    provenance: { source: 'rule-based', timestamp: '2026-05-07T14:22:09Z' },
    rationale: 'Replaced div-soup tabs with ARIA-compliant tab pattern.',
    previewPath: 'rebuild-preview.html#transform-0002',
    requiresCheckpointApproval: true,
    status
  });
  addTransform(m, {
    transformer: 'page-split',
    family: 'page-split',
    criteria: ['2.4.1', '3.3.1'],
    tier: 'full',
    scope: { files: ['shared/long-page.html', 'imsmanifest.xml'], manifestEdited: true },
    patchIds: [sp.id],
    provenance: {
      source: 'llm',
      timestamp: '2026-05-07T14:22:09Z',
      model: 'claude-opus-4-7',
      promptHash: 'h'.repeat(64),
      modelConfidence: 0.84
    },
    rationale: 'Split overflowing SCO at module boundary.',
    previewPath: 'rebuild-preview.html#transform-0003',
    requiresCheckpointApproval: true,
    status
  });

  if (opts.includeVerification) {
    setVerification(
      m,
      { violations: 12, criteriaFailed: 4, section508Failed: 2 },
      { violations: 2, criteriaFailed: 1, section508Failed: 0 }
    );
  }

  return m;
}

describe('renderRebuildPreview', () => {
  it('renders all 3 transform cards with family chips and side-by-side preview elements', async () => {
    const m = buildThreeFamilyManifest();
    const out = tmp('three-families');
    const html = await renderRebuildPreview(m, TEST_BRAND, out);
    const onDisk = fs.readFileSync(out, 'utf8');
    expect(onDisk).toBe(html);

    const $ = cheerio.load(html);

    const cards = $('.transform-card');
    expect(cards.length).toBe(3);

    // Each transform card carries its expected family chip
    const families = cards
      .map((_i, el) => $(el).attr('data-family'))
      .get()
      .sort();
    expect(families).toEqual(['landmark', 'page-split', 'widget']);

    // Family chip is a chip-static with class chip-family-<family>
    expect($('.chip-family-landmark').length).toBeGreaterThanOrEqual(1);
    expect($('.chip-family-widget').length).toBeGreaterThanOrEqual(1);
    expect($('.chip-family-page-split').length).toBeGreaterThanOrEqual(1);

    // Side-by-side preview sections present (one per card)
    const previews = $('.tc-preview');
    expect(previews.length).toBe(3);

    // Each card has both a Before and After side
    cards.each((_i, el) => {
      const $el = $(el);
      expect($el.find('.tc-before').length).toBeGreaterThanOrEqual(1);
      expect($el.find('.tc-after').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('all pending-checkpoint -> review banner present and approval form enabled', async () => {
    const m = buildThreeFamilyManifest({ status: 'pending-checkpoint' });
    const out = tmp('all-pending');
    const html = await renderRebuildPreview(m, TEST_BRAND, out);
    const $ = cheerio.load(html);

    // Review banner present, archive banner absent
    expect($('.banner-review').length).toBe(1);
    expect($('.banner-archive').length).toBe(0);

    // Banner mentions the next-step CLI command
    const bannerText = $('.banner-review').text();
    expect(bannerText).toContain('rebuild-checkpoint approve');
    expect(bannerText).toContain('--engagement acme-2026');
    expect(bannerText).toContain('--package compliance-101.zip');

    // body has mode-review class
    expect($('body').hasClass('mode-review')).toBe(true);

    // Approval form present, with NO disabled inputs (review mode + pending)
    const forms = $('.approval-form');
    expect(forms.length).toBe(3);
    forms.each((_i, el) => {
      const $el = $(el);
      // Must contain three radios
      expect($el.find('input[type="radio"]').length).toBe(3);
      // None should be disabled
      $el.find('input[type="radio"]').each((_j, r) => {
        expect($(r).attr('disabled')).toBeUndefined();
      });
      $el.find('input[type="text"]').each((_j, t) => {
        expect($(t).attr('disabled')).toBeUndefined();
      });
      // The "undecided" radio is the default-checked option
      const checked = $el.find('input[type="radio"][checked]');
      expect(checked.length).toBe(1);
      expect(checked.attr('value')).toBe('undecided');
    });
  });

  it('all applied -> archive banner present and forms disabled', async () => {
    const m = buildThreeFamilyManifest({ status: 'applied' });
    // Mark approver metadata so the manifest is well-formed for archive view
    for (const t of m.transforms) {
      t.checkpointApprovedBy = 'dnguyen';
      t.checkpointApprovedAt = '2026-05-07T15:11:02Z';
    }
    const out = tmp('all-applied');
    const html = await renderRebuildPreview(m, TEST_BRAND, out);
    const $ = cheerio.load(html);

    expect($('.banner-archive').length).toBe(1);
    expect($('.banner-review').length).toBe(0);
    expect($('body').hasClass('mode-archive')).toBe(true);

    // Forms exist but every input is disabled
    const forms = $('.approval-form');
    expect(forms.length).toBe(3);
    forms.each((_i, el) => {
      const $el = $(el);
      // form gets the is-disabled class
      expect($el.hasClass('is-disabled')).toBe(true);
      // Every radio carries the disabled attr
      $el.find('input[type="radio"]').each((_j, r) => {
        expect($(r).attr('disabled')).toBeDefined();
      });
      // Text input is also disabled
      $el.find('input[type="text"]').each((_j, t) => {
        expect($(t).attr('disabled')).toBeDefined();
      });
      // The "approve" radio is the one checked (mirrors `applied` status)
      const checked = $el.find('input[type="radio"][checked]');
      expect(checked.length).toBe(1);
      expect(checked.attr('value')).toBe('approve');
    });
  });

  it('v4-shape manifest with empty transforms[] renders cleanly with empty state', async () => {
    const m = createManifest({
      engagementId: 'acme-2026',
      packageName: 'compliance-101.zip',
      inputZipSha256: 'a'.repeat(64),
      createdAt: '2026-05-07T14:22:11Z'
    });
    m.outputZipSha256 = 'b'.repeat(64);
    // Empty transforms array
    m.transforms = [];

    const out = tmp('empty-state');
    const html = await renderRebuildPreview(m, TEST_BRAND, out);
    const $ = cheerio.load(html);

    // Empty state present
    expect($('[data-empty-state]').length).toBe(1);
    // No transform cards
    expect($('.transform-card').length).toBe(0);
    // No banner (neither review nor archive)
    expect($('.banner-review').length).toBe(0);
    expect($('.banner-archive').length).toBe(0);
    // body has mode-empty
    expect($('body').hasClass('mode-empty')).toBe(true);
  });

  it('manifest without a transforms field at all renders cleanly with empty state', async () => {
    const m = createManifest({
      engagementId: 'acme-2026',
      packageName: 'compliance-101.zip',
      inputZipSha256: 'a'.repeat(64),
      createdAt: '2026-05-07T14:22:11Z'
    });
    m.outputZipSha256 = 'b'.repeat(64);
    // No `transforms` property at all (v4 shape)
    expect('transforms' in m).toBe(false);

    const out = tmp('no-transforms-field');
    const html = await renderRebuildPreview(m, TEST_BRAND, out);
    const $ = cheerio.load(html);

    expect($('[data-empty-state]').length).toBe(1);
    expect($('.transform-card').length).toBe(0);
  });

  it('is deterministic — same manifest renders byte-identical output', async () => {
    const m = buildThreeFamilyManifest({ includeVerification: true });
    const a = tmp('det-a');
    const b = tmp('det-b');
    const ha = await renderRebuildPreview(m, TEST_BRAND, a);
    const hb = await renderRebuildPreview(m, TEST_BRAND, b);
    expect(hb).toBe(ha);
    expect(fs.readFileSync(a, 'utf8')).toBe(fs.readFileSync(b, 'utf8'));
  });

  it('produces well-formed HTML parseable by cheerio with html/head/body', async () => {
    const m = buildThreeFamilyManifest();
    const out = tmp('well-formed');
    const html = await renderRebuildPreview(m, TEST_BRAND, out);

    const $ = cheerio.load(html);
    expect($('html').length).toBe(1);
    expect($('head').length).toBe(1);
    expect($('body').length).toBe(1);
    expect($('article.page').length).toBe(1);
  });

  it('approval form: count of radio groups equals transform count, each group has 3 unique values', async () => {
    const m = buildThreeFamilyManifest();
    const out = tmp('radio-groups');
    const html = await renderRebuildPreview(m, TEST_BRAND, out);
    const $ = cheerio.load(html);

    const forms = $('.approval-form');
    expect(forms.length).toBe(3);

    forms.each((_i, el) => {
      const $el = $(el);
      const radios = $el.find('input[type="radio"]');
      expect(radios.length).toBe(3);

      // All radios in the form share the same `name`.
      const names = new Set(radios.map((_j, r) => $(r).attr('name')).get());
      expect(names.size).toBe(1);

      // Three distinct values.
      const values = radios.map((_j, r) => $(r).attr('value')).get();
      expect(new Set(values).size).toBe(3);
      expect(new Set(values)).toEqual(new Set(['approve', 'reject', 'undecided']));
    });
  });

  it('header card surfaces engagement, package, mode, standard, tool, hash, and checkpoint state', async () => {
    const m = buildThreeFamilyManifest();
    const out = tmp('header');
    const html = await renderRebuildPreview(m, TEST_BRAND, out);
    const $ = cheerio.load(html);

    const headerText = $('.header-card').text();
    expect(headerText).toContain('acme-2026');
    expect(headerText).toContain('compliance-101.zip');
    expect(headerText).toContain('safe'); // default mode from createManifest
    expect(headerText).toContain('wcag22');

    // Manifest hash present (sha256 hex string, 64 chars)
    const hashCode = $('.hc-hash code').text();
    expect(hashCode).toMatch(/^[a-f0-9]{64}$/);

    // Checkpoint state field is populated
    const stateDd = $('[data-checkpoint-state]');
    expect(stateDd.length).toBe(1);
    // In review mode it should read "Pending review"
    expect(stateDd.text()).toBe('Pending review');
  });

  it('summary strip shows verification placeholder pre-promotion (review mode)', async () => {
    const m = buildThreeFamilyManifest({ includeVerification: true });
    // Even though verification is set, review mode shows the placeholder.
    const out = tmp('summary-placeholder');
    const html = await renderRebuildPreview(m, TEST_BRAND, out);
    const $ = cheerio.load(html);

    const verifyCell = $('.ss-verify');
    expect(verifyCell.length).toBe(1);
    expect(verifyCell.find('.placeholder').length).toBe(1);
    expect(verifyCell.text()).toContain('Runs at promotion');
  });

  it('summary strip shows numbers post-promotion (archive mode)', async () => {
    const m = buildThreeFamilyManifest({ status: 'applied', includeVerification: true });
    for (const t of m.transforms) {
      t.checkpointApprovedBy = 'dnguyen';
      t.checkpointApprovedAt = '2026-05-07T15:11:02Z';
    }
    const out = tmp('summary-numbers');
    const html = await renderRebuildPreview(m, TEST_BRAND, out);
    const $ = cheerio.load(html);

    const verifyCell = $('.ss-verify');
    expect(verifyCell.length).toBe(1);
    expect(verifyCell.find('.placeholder').length).toBe(0);
    // Before/after numbers visible
    expect(verifyCell.find('.v-before').text()).toBe('12');
    expect(verifyCell.find('.v-after').text()).toBe('2');
  });

  it('filter bar contains chips for every distinct family and criterion in the manifest', async () => {
    const m = buildThreeFamilyManifest();
    const out = tmp('filter-bar');
    const html = await renderRebuildPreview(m, TEST_BRAND, out);
    const $ = cheerio.load(html);

    // Family chips: one per distinct family, alphabetically ordered.
    const familyChips = $('.chip[data-filter="family"]')
      .map((_i, el) => $(el).attr('data-value'))
      .get();
    expect(familyChips).toEqual(['landmark', 'page-split', 'widget']);

    // Criterion chips: union of all criteria across transforms, alpha sorted.
    const criterionChips = $('.chip[data-filter="criterion"]')
      .map((_i, el) => $(el).attr('data-value'))
      .get();
    // landmark: 1.3.1, 2.4.1, 4.1.2
    // widget: 4.1.2, 2.1.1
    // page-split: 2.4.1, 3.3.1
    expect(criterionChips).toEqual(['1.3.1', '2.1.1', '2.4.1', '3.3.1', '4.1.2']);

    // "Needs review only" chip is active by default in review mode.
    const needsReview = $('.chip[data-filter="needs-review"]');
    expect(needsReview.length).toBe(1);
    expect(needsReview.hasClass('is-active')).toBe(true);
    expect(needsReview.attr('aria-pressed')).toBe('true');
  });

  it('side-by-side fragments come from patch before/after only (no source files referenced)', async () => {
    const m = buildThreeFamilyManifest();
    const out = tmp('content-source');
    const html = await renderRebuildPreview(m, TEST_BRAND, out);
    const $ = cheerio.load(html);

    // Before fragments contain the patch's `before` text (escaped).
    // The landmark patch's before is "<div class=\"main-content\">" plus
    // small surrounding context — so the unescaped text "main-content" must
    // appear inside a tc-before block.
    let foundBefore = false;
    $('.tc-before code').each((_i, el) => {
      if ($(el).text().includes('main-content')) foundBefore = true;
    });
    expect(foundBefore).toBe(true);

    // After fragments contain the replacement.
    let foundAfter = false;
    $('.tc-after code').each((_i, el) => {
      if ($(el).text().includes('<main')) foundAfter = true;
    });
    expect(foundAfter).toBe(true);
  });

  it('manifest-edited transform shows manifest-edited tag', async () => {
    const m = buildThreeFamilyManifest();
    const out = tmp('manifest-edited');
    const html = await renderRebuildPreview(m, TEST_BRAND, out);
    const $ = cheerio.load(html);

    const tags = $('.chip-manifest');
    // Only the page-split transform has manifestEdited: true
    expect(tags.length).toBe(1);
    expect(tags.text().toLowerCase()).toContain('manifest');
  });

  it('llm provenance pill shows model name', async () => {
    const m = buildThreeFamilyManifest();
    const out = tmp('llm-provenance');
    const html = await renderRebuildPreview(m, TEST_BRAND, out);

    // The page-split transform's provenance pill should include the model name.
    expect(html).toContain('claude-opus-4-7');
  });

  it('patch list under each card is collapsible (uses <details>) and references patch ids', async () => {
    const m = buildThreeFamilyManifest();
    const out = tmp('patch-list');
    const html = await renderRebuildPreview(m, TEST_BRAND, out);
    const $ = cheerio.load(html);

    const cards = $('.transform-card');
    expect(cards.length).toBe(3);

    cards.each((_i, el) => {
      const $el = $(el);
      const patchRows = $el.find('.tc-patch-row');
      expect(patchRows.length).toBeGreaterThanOrEqual(1);
      // Each row is a <details>
      patchRows.each((_j, r) => {
        expect(r.tagName.toLowerCase()).toBe('details');
      });
      // patch ids appear in the rows
      const ids = $el.find('.pr-id').map((_j, e) => $(e).text()).get();
      ids.forEach((id) => expect(id).toMatch(/^patch-\d{4}$/));
    });
  });
});
