/**
 * Render a RebuildManifest as a brand-matched, self-contained HTML summary
 * report. Produces the consultant-facing before/after compliance overview:
 * header card, compliance scoreboard, standards-met chips, triage breakdown,
 * deferred findings table, optional regression banner, and method note.
 *
 * The output is deterministic: same manifest in → byte-identical HTML out.
 * No `Date.now()`, no random ids — `manifest.createdAt` and manifest fields
 * are the only data sources. All iterables that are order-sensitive are
 * sorted alphabetically before rendering.
 *
 * Visual primitives (palette, typography, pill/section-header conventions)
 * are copied from `src/reporter/rebuild-diff.js` per the chunk-06 spec;
 * this file is intentionally self-contained and does not import the diff
 * renderer or the v3 reporter.
 *
 * @typedef {import('../rebuild/types').RebuildManifest} RebuildManifest
 * @typedef {import('../rebuild/types').Patch} Patch
 * @typedef {import('../rebuild/types').DeferredFinding} DeferredFinding
 */

'use strict';

const fs = require('fs');

/**
 * Render the summary report and write it to disk.
 *
 * @param {RebuildManifest} manifest
 * @param {Object|null} brandConfig - same shape as config/brand.json
 * @param {string} outputPath - absolute path to write the HTML file
 * @returns {Promise<string>} the HTML string (also written to outputPath)
 */
async function renderRebuildSummary(manifest, brandConfig, outputPath) {
  const brand = brandConfig || defaultBrand();
  const html = buildHtml(manifest, brand);
  await fs.promises.writeFile(outputPath, html, 'utf8');
  return html;
}

/**
 * Build the HTML string. Pure function of (manifest, brand).
 *
 * @param {RebuildManifest} manifest
 * @param {Object} brand
 * @returns {string}
 */
function buildHtml(manifest, brand) {
  const patches = Array.isArray(manifest.patches) ? manifest.patches : [];
  const deferred = Array.isArray(manifest.deferred) ? manifest.deferred : [];
  const verification = manifest.verification || {
    before: { violations: 0, criteriaFailed: 0, section508Failed: 0 },
    after: { violations: 0, criteriaFailed: 0, section508Failed: 0 },
    resolved: 0,
    introduced: 0,
    remaining: 0
  };

  const introduced = typeof verification.introduced === 'number' ? verification.introduced : 0;

  const cssVars = buildCssVars(brand);
  const styles = buildStyles();
  const fontsLink =
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600;700&display=swap">';

  const titleClient = escapeHtml(manifest.engagementId || '');
  const titlePackage = escapeHtml(manifest.packageName || '');

  const regressionBanner = introduced > 0 ? renderRegressionBanner(introduced) : '';
  const headerCard = renderHeaderCard(manifest);
  const scoreboard = renderScoreboard(verification);
  const standardsChips = renderStandardsChips(verification, manifest.standard);
  const triageBreakdown = renderTriageBreakdown(patches);
  const deferredTable = renderDeferredTable(deferred);
  const methodNote = renderMethodNote(patches, manifest.standard);

  // v5: transform stats line — additive only. When `manifest.transforms` is
  // empty/undefined this returns null and the section is omitted entirely so
  // the document stays byte-identical to the v4 baseline (no extra newline).
  const transformStats = renderTransformStats(manifest.transforms);

  const sections = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${titleClient} — ${titlePackage} — Rebuild summary</title>`,
    fontsLink,
    '<style>',
    cssVars,
    styles,
    '</style>',
    '</head>',
    '<body>',
    '<article class="page">',
    regressionBanner,
    headerCard,
    scoreboard,
    standardsChips,
    triageBreakdown
  ];
  if (transformStats !== null) sections.push(transformStats);
  sections.push(
    deferredTable,
    methodNote,
    '</article>',
    '</body>',
    '</html>',
    ''
  );

  return sections.join('\n');
}

/* ------------------------------------------------------------------ */
/* sections                                                            */
/* ------------------------------------------------------------------ */

function renderRegressionBanner(introduced) {
  return [
    '<div class="regression-banner" role="alert">',
    `<span class="rb-icon" aria-hidden="true">⚠</span>`,
    `<span class="rb-msg">Rebuild introduced <strong>${escapeHtml(String(introduced))}</strong> new findings — DO NOT SHIP.</span>`,
    `<span class="rb-detail">See <a href="rebuild-diff.html" class="rb-link">rebuild-diff.html</a> for details. Verification reported ${escapeHtml(String(introduced))} finding${introduced === 1 ? '' : 's'} not present in the original audit.</span>`,
    '</div>'
  ].join('');
}

function renderHeaderCard(manifest) {
  return [
    '<header class="header-card">',
    '<div class="hc-mark" aria-hidden="true">SL</div>',
    '<div class="hc-title">',
    '<div class="kicker">Rebuild summary report</div>',
    `<h1>${escapeHtml(manifest.engagementId || '')} <span class="hc-sep">•</span> ${escapeHtml(manifest.packageName || '')}</h1>`,
    '</div>',
    '<dl class="hc-meta">',
    `<div><dt>Mode</dt><dd>${escapeHtml(manifest.mode || '')}</dd></div>`,
    `<div><dt>Standard</dt><dd>${escapeHtml(manifest.standard || '')}</dd></div>`,
    `<div><dt>Generated</dt><dd>${escapeHtml(manifest.createdAt || '')}</dd></div>`,
    `<div><dt>Package</dt><dd>${escapeHtml(manifest.packageName || '')}</dd></div>`,
    '</dl>',
    '</header>'
  ].join('');
}

function renderScoreboard(verification) {
  const before = verification.before || { violations: 0, criteriaFailed: 0, section508Failed: 0 };
  const after = verification.after || { violations: 0, criteriaFailed: 0, section508Failed: 0 };
  const resolved = typeof verification.resolved === 'number' ? verification.resolved : 0;

  return [
    '<section class="scoreboard" aria-label="Compliance scoreboard">',
    '<h2 class="section-heading">Compliance scoreboard</h2>',
    '<table class="score-table">',
    '<thead>',
    '<tr>',
    '<th scope="col" class="st-metric">Metric</th>',
    '<th scope="col" class="st-before">Before rebuild</th>',
    '<th scope="col" class="st-after">After rebuild</th>',
    '</tr>',
    '</thead>',
    '<tbody>',
    '<tr>',
    '<td class="st-metric">Total violations</td>',
    `<td class="st-before" data-scoreboard-before-violations="${escapeHtml(String(before.violations))}">${escapeHtml(String(before.violations))}</td>`,
    `<td class="st-after" data-scoreboard-after-violations="${escapeHtml(String(after.violations))}">${escapeHtml(String(after.violations))}</td>`,
    '</tr>',
    '<tr>',
    '<td class="st-metric">Criteria failed</td>',
    `<td class="st-before">${escapeHtml(String(before.criteriaFailed))}</td>`,
    `<td class="st-after">${escapeHtml(String(after.criteriaFailed))}</td>`,
    '</tr>',
    '<tr>',
    '<td class="st-metric">Section 508 mappings failed</td>',
    `<td class="st-before">${escapeHtml(String(before.section508Failed))}</td>`,
    `<td class="st-after">${escapeHtml(String(after.section508Failed))}</td>`,
    '</tr>',
    '</tbody>',
    '</table>',
    '<div class="delta-badge">',
    `<span class="delta-num">${escapeHtml(String(resolved))}</span>`,
    '<span class="delta-label">findings resolved</span>',
    '</div>',
    '</section>'
  ].join('');
}

function renderStandardsChips(verification, standard) {
  const after = verification.after || { criteriaFailed: 1, section508Failed: 1 };
  const wcagMet = after.criteriaFailed === 0;
  const s508Met = after.section508Failed === 0;

  const wcagGlyph = wcagMet ? '☑' : '☐';
  const s508Glyph = s508Met ? '☑' : '☐';

  // Label reflects the audit standard the verify step actually ran against.
  // Defaults to wcag22 (the rebuild target) per PRD § "CLI surface".
  const wcagLabel = standard === 'wcag21' ? 'WCAG 2.1 AA met' : 'WCAG 2.2 AA met';

  return [
    '<section class="standards-chips" aria-label="Standards compliance status">',
    '<h2 class="section-heading">Standards met</h2>',
    '<div class="chips-row">',
    `<span class="std-chip" data-met="${wcagMet ? 'true' : 'false'}">`,
    `<span class="std-chip-glyph" aria-hidden="true">${wcagGlyph}</span>`,
    `<span class="std-chip-label">${escapeHtml(wcagLabel)}</span>`,
    '</span>',
    `<span class="std-chip" data-met="${s508Met ? 'true' : 'false'}">`,
    `<span class="std-chip-glyph" aria-hidden="true">${s508Glyph}</span>`,
    `<span class="std-chip-label">Section 508 met</span>`,
    '</span>',
    '</div>',
    '</section>'
  ].join('');
}

/**
 * All v3 triage categories — shown even when count is 0 for forward compat.
 */
const TRIAGE_CATEGORIES = [
  'auto-fix safe',
  'auto-fix assisted',
  'author rework',
  'content rework',
  'recommend retire'
];

function renderTriageBreakdown(patches) {
  // Count resolved (applied) patches by triage category.
  const counts = {};
  for (const cat of TRIAGE_CATEGORIES) {
    counts[cat] = 0;
  }
  const appliedPatches = patches.filter((p) => p.status === 'applied');
  for (const p of appliedPatches) {
    const cat = p.triage || 'auto-fix safe';
    if (counts[cat] !== undefined) {
      counts[cat] += 1;
    }
  }

  const total = appliedPatches.length;

  // Build stacked bar segments. Only render segments with count > 0.
  const CATEGORY_CLASSES = {
    'auto-fix safe': 'tbar-safe',
    'auto-fix assisted': 'tbar-assisted',
    'author rework': 'tbar-author',
    'content rework': 'tbar-content',
    'recommend retire': 'tbar-retire'
  };

  let barSegments = '';
  if (total === 0) {
    barSegments = '<div class="tbar-segment tbar-empty" style="flex:1" aria-label="No resolved patches">0</div>';
  } else {
    for (const cat of TRIAGE_CATEGORIES) {
      const n = counts[cat];
      if (n === 0) continue;
      const pct = ((n / total) * 100).toFixed(1);
      const cls = CATEGORY_CLASSES[cat] || 'tbar-safe';
      barSegments += `<div class="tbar-segment ${cls}" style="flex:${n}" aria-label="${escapeHtml(cat)}: ${n}">${n}</div>`;
    }
  }

  const legendRows = TRIAGE_CATEGORIES.map((cat) => {
    const cls = CATEGORY_CLASSES[cat] || 'tbar-safe';
    return [
      '<div class="tl-row">',
      `<span class="tl-swatch ${cls}"></span>`,
      `<span class="tl-label">${escapeHtml(cat)}</span>`,
      `<span class="tl-count">${counts[cat]}</span>`,
      '</div>'
    ].join('');
  }).join('');

  return [
    '<section class="triage-breakdown" aria-label="Triage breakdown">',
    '<h2 class="section-heading">Triage breakdown</h2>',
    '<div class="tbar" aria-label="Resolved patches by triage category">',
    barSegments,
    '</div>',
    '<div class="tbar-legend">',
    legendRows,
    '</div>',
    '</section>'
  ].join('');
}

/**
 * Render the v5 transform stats section. Returns `null` when `transforms` is
 * empty/undefined so the surrounding template can omit the line entirely
 * (preserving v4 byte-identical output for manifests without transforms).
 *
 * @param {import('../rebuild/types').Transform[]|undefined} transforms
 * @returns {string|null}
 */
function renderTransformStats(transforms) {
  if (!Array.isArray(transforms) || transforms.length === 0) return null;
  const applied = transforms.filter((t) => t && t.status === 'applied').length;
  const pending = transforms.filter((t) => t && t.status === 'pending-checkpoint').length;
  const rejected = transforms.filter((t) => t && t.status === 'rejected').length;

  // Styles are inlined inside the section so the global <style> block stays
  // byte-identical to the v4 baseline for manifests without transforms.
  const inlineStyle =
    '<style>' +
    '.transform-stats{break-inside:avoid;}' +
    '.ts-row{display:grid;grid-template-columns:repeat(3,minmax(120px,1fr));gap:12px 24px;margin:0 0 10px;padding:14px 18px;background:var(--paper-2);border:1.5px solid var(--ink);border-radius:6px;}' +
    '.ts-row>div{margin:0;display:grid;gap:4px;}' +
    '.ts-row dt{font:600 10px var(--font-mono);letter-spacing:0.14em;text-transform:uppercase;color:var(--ink-3);}' +
    '.ts-row dd{margin:0;font-family:var(--font-jersey);font-size:26px;line-height:1;letter-spacing:-0.02em;color:var(--ink);}' +
    '.ts-pointer{margin:0;font:500 13px var(--font-sans);color:var(--ink-2);}' +
    '.ts-pointer a{color:var(--accent-deep);}' +
    '</style>';

  return [
    '<section class="transform-stats" aria-label="Transform statistics">',
    inlineStyle,
    '<h2 class="section-heading">Transforms</h2>',
    '<dl class="ts-row">',
    `<div><dt>Applied</dt><dd data-transform-stat="applied">${escapeHtml(String(applied))}</dd></div>`,
    `<div><dt>Pending</dt><dd data-transform-stat="pending">${escapeHtml(String(pending))}</dd></div>`,
    `<div><dt>Rejected</dt><dd data-transform-stat="rejected">${escapeHtml(String(rejected))}</dd></div>`,
    '</dl>',
    '<p class="ts-pointer">See <a href="rebuild-preview.html">rebuild-preview.html</a> for per-transform side-by-side review.</p>',
    '</section>'
  ].join('');
}

function renderDeferredTable(deferred) {
  if (deferred.length === 0) {
    return [
      '<section class="deferred-section" aria-label="Deferred findings">',
      '<h2 class="section-heading">Deferred findings</h2>',
      '<p class="empty-deferred">No deferred findings.</p>',
      '</section>'
    ].join('');
  }

  // Group by reason, deterministically (alphabetical by reason).
  const groups = {};
  for (const d of deferred) {
    const reason = d.reason || '';
    if (!groups[reason]) groups[reason] = [];
    groups[reason].push(d);
  }
  const sortedReasons = Object.keys(groups).sort();

  let tbodiesHtml = '';
  for (const reason of sortedReasons) {
    const rows = groups[reason];
    // Group heading row
    tbodiesHtml += [
      '<tbody>',
      `<tr class="df-group-heading"><td colspan="4" class="df-reason">${escapeHtml(reason)}</td></tr>`,
      rows.map((d) =>
        [
          '<tr class="df-row">',
          `<td class="df-criterion">${escapeHtml(d.criterion || '')}</td>`,
          `<td class="df-file">${escapeHtml(d.file || '')}</td>`,
          `<td class="df-line">${escapeHtml(String(d.line))}</td>`,
          `<td class="df-reason-cell">${escapeHtml(d.reason || '')}</td>`,
          '</tr>'
        ].join('')
      ).join(''),
      '</tbody>'
    ].join('');
  }

  return [
    '<section class="deferred-section" aria-label="Deferred findings">',
    '<h2 class="section-heading">Deferred findings</h2>',
    '<table class="deferred-table">',
    '<thead>',
    '<tr>',
    '<th scope="col">Criterion</th>',
    '<th scope="col">File</th>',
    '<th scope="col">Line</th>',
    '<th scope="col">Reason</th>',
    '</tr>',
    '</thead>',
    tbodiesHtml,
    '</table>',
    '</section>'
  ].join('');
}

function renderMethodNote(patches, standard) {
  // Distinct fixer names, alphabetically sorted.
  const fixerNames = distinctSorted(patches.map((p) => p.fixer).filter(Boolean));
  const fixerList =
    fixerNames.length > 0
      ? fixerNames.join(', ')
      : 'No fixers ran in this rebuild.';

  const standardLabel = escapeHtml(standard || 'wcag22');

  const sentence1 =
    fixerNames.length > 0
      ? `Fixers applied in this rebuild: ${escapeHtml(fixerList)}.`
      : 'No fixers ran in this rebuild.';
  const sentence2 = `Verification re-audit used standard: ${standardLabel}.`;
  const sentence3 = `See <a href="rebuild-diff.html">rebuild-diff.html</a> for per-patch detail.`;

  return [
    '<section class="method-note" aria-label="Method note">',
    '<h2 class="section-heading">Method note</h2>',
    `<p>${sentence1} ${sentence2} ${sentence3}</p>`,
    '</section>'
  ].join('');
}

/* ------------------------------------------------------------------ */
/* css                                                                 */
/* ------------------------------------------------------------------ */

function buildCssVars(brand) {
  return `
:root {
  --paper:   ${brand.paper};
  --paper-2: ${brand['paper-2']};
  --paper-3: ${brand['paper-3']};
  --ink:     ${brand.ink};
  --ink-2:   ${brand['ink-2']};
  --ink-3:   ${brand['ink-3']};
  --rule:    ${brand.rule};
  --rule-2:  ${brand['rule-2']};
  --accent:  ${brand.accent};
  --accent-deep: ${brand['accent-deep']};
  --accent-soft: ${brand['accent-soft']};
  --cta:     ${brand.cta};
  --ok:      ${brand.ok};
  --sev-critical: ${brand['sev-critical']};
  --sev-serious:  ${brand['sev-serious']};
  --sev-moderate: ${brand['sev-moderate']};
  --sev-minor:    ${brand['sev-minor']};

  --font-jersey:  'Archivo Black', 'Arial Black', sans-serif;
  --font-display: 'Space Grotesk', system-ui, sans-serif;
  --font-sans:    'Inter', system-ui, sans-serif;
  --font-mono:    'JetBrains Mono', ui-monospace, Menlo, monospace;
}
`;
}

function buildStyles() {
  return `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}

.page { max-width: 960px; margin: 0 auto; padding: 48px 56px 80px; }

/* ---- regression banner ---- */
.regression-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 16px;
  padding: 16px 20px;
  background: #c0392b;
  color: #fff;
  border-radius: 6px;
  margin-bottom: 28px;
  break-inside: avoid;
}
.rb-icon { font-size: 20px; flex-shrink: 0; }
.rb-msg {
  font: 700 15px var(--font-sans);
  flex-shrink: 0;
}
.rb-detail {
  font: 500 13px var(--font-sans);
  opacity: 0.92;
}
.rb-link { color: #fff; text-underline-offset: 3px; }

/* ---- header card ---- */
.header-card {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-rows: auto auto;
  gap: 18px 24px;
  padding-bottom: 28px;
  border-bottom: 2px solid var(--ink);
  break-inside: avoid;
}
.hc-mark {
  width: 56px; height: 56px;
  background: var(--accent); color: #fff;
  display: grid; place-items: center;
  font-family: var(--font-jersey); font-size: 18px;
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
}
.hc-title .kicker {
  font: 600 10px var(--font-mono);
  letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--ink-3); margin-bottom: 4px;
}
.hc-title h1 {
  font-family: var(--font-jersey); font-weight: 400;
  font-size: clamp(28px, 3.4vw, 40px);
  line-height: 1.02; letter-spacing: -0.02em;
  margin: 0; color: var(--ink); text-wrap: balance;
}
.hc-sep { color: var(--ink-3); margin: 0 6px; font-weight: 400; }
.hc-meta {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px 24px;
  margin: 0;
  padding-top: 16px;
  border-top: 1px dashed var(--rule);
}
.hc-meta > div { margin: 0; display: grid; gap: 4px; }
.hc-meta dt {
  font: 600 10px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--ink-3);
}
.hc-meta dd {
  margin: 0;
  font: 600 13px var(--font-mono);
  color: var(--ink);
  word-break: break-word;
}

/* ---- section headings ---- */
.section-heading {
  font-family: var(--font-display); font-weight: 600;
  font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--ink-3);
  margin: 32px 0 14px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--rule);
}

/* ---- compliance scoreboard ---- */
.scoreboard { break-inside: avoid; }
.score-table {
  width: 100%;
  border-collapse: collapse;
  border: 2px solid var(--ink);
  border-radius: 6px;
  overflow: hidden;
  font-size: 14px;
}
.score-table thead tr {
  background: var(--ink);
  color: var(--paper);
}
.score-table th {
  font: 600 10px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  padding: 10px 14px;
  text-align: left;
}
.score-table td {
  padding: 10px 14px;
  border-top: 1px solid var(--rule);
}
.score-table .st-metric { font-weight: 500; color: var(--ink-2); }
.score-table .st-before {
  font: 600 14px var(--font-mono);
  color: var(--sev-critical);
  background: rgba(196,106,20,0.06);
}
.score-table .st-after {
  font: 600 14px var(--font-mono);
  color: var(--ok);
  background: rgba(27,122,61,0.06);
}

.delta-badge {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 16px;
  padding: 10px 20px;
  background: var(--accent-soft);
  border: 2px solid var(--accent);
  border-radius: 6px;
  break-inside: avoid;
}
.delta-num {
  font-family: var(--font-jersey);
  font-size: 40px; line-height: 1; letter-spacing: -0.02em;
  color: var(--accent);
}
.delta-label {
  font: 600 14px var(--font-display);
  color: var(--accent-deep);
}

/* ---- standards chips ---- */
.standards-chips { break-inside: avoid; }
.chips-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.std-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 16px;
  border-radius: 999px;
  border: 2px solid var(--ink);
  background: var(--paper-2);
  font: 600 13px var(--font-mono);
  color: var(--ink);
}
.std-chip[data-met="true"] {
  background: var(--ok);
  color: #fff;
  border-color: var(--ok);
}
.std-chip[data-met="false"] {
  background: var(--paper-2);
  color: var(--ink-2);
}
.std-chip-glyph { font-size: 16px; }

/* ---- triage breakdown ---- */
.triage-breakdown { break-inside: avoid; }
.tbar {
  display: flex;
  height: 28px;
  border-radius: 4px;
  overflow: hidden;
  border: 1.5px solid var(--ink);
  margin-bottom: 14px;
}
.tbar-segment {
  display: flex;
  align-items: center;
  justify-content: center;
  font: 700 11px var(--font-mono);
  color: #fff;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.tbar-safe    { background: var(--accent); }
.tbar-assisted { background: var(--cta); }
.tbar-author  { background: var(--sev-moderate); }
.tbar-content { background: var(--sev-serious); }
.tbar-retire  { background: var(--sev-critical); }
.tbar-empty   { background: var(--rule); color: var(--ink-3); }

.tbar-legend {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 6px 20px;
}
.tl-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font: 500 12px var(--font-mono);
  color: var(--ink-2);
}
.tl-swatch {
  width: 12px; height: 12px;
  border-radius: 3px;
  flex-shrink: 0;
}
.tl-label { flex: 1; }
.tl-count {
  font-weight: 700;
  color: var(--ink);
  min-width: 2ch;
  text-align: right;
}

/* ---- deferred findings table ---- */
.deferred-section { break-inside: avoid; }
.empty-deferred {
  font-size: 14px; color: var(--ink-3);
  font-style: italic; margin: 0;
}
.deferred-table {
  width: 100%;
  border-collapse: collapse;
  border: 1.5px solid var(--ink);
  font-size: 13px;
}
.deferred-table th {
  font: 600 10px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  padding: 8px 12px;
  background: var(--ink);
  color: var(--paper);
  text-align: left;
}
.deferred-table .df-group-heading td {
  font: 700 11px var(--font-mono);
  letter-spacing: 0.12em; text-transform: uppercase;
  background: var(--paper-3);
  color: var(--ink-2);
  padding: 6px 12px;
  border-top: 1.5px solid var(--rule-2);
}
.deferred-table .df-row td {
  padding: 7px 12px;
  border-top: 1px solid var(--rule);
  vertical-align: top;
}
.df-criterion {
  font: 600 12px var(--font-mono);
  color: var(--accent-deep);
  white-space: nowrap;
}
.df-file {
  font: 500 12px var(--font-mono);
  color: var(--ink-2);
  word-break: break-word;
}
.df-line {
  font: 500 12px var(--font-mono);
  color: var(--ink-3);
  white-space: nowrap;
}
.df-reason-cell {
  font-size: 12px;
  color: var(--ink-3);
}

/* ---- method note ---- */
.method-note { break-inside: avoid; margin-top: 32px; }
.method-note p {
  font-size: 13px;
  color: var(--ink-2);
  margin: 0;
  line-height: 1.65;
}
.method-note a { color: var(--accent-deep); }

/* ---- print ---- */
@page { size: Letter; margin: 0.5in; }
@media print {
  body { background: #fff; }
  .page { padding: 24px 36px; max-width: none; }
  .regression-banner { break-inside: avoid; }
  .scoreboard, .standards-chips, .triage-breakdown,
  .deferred-section, .method-note, .header-card { break-inside: avoid; }
  .score-table .st-before { background: none !important; }
  .score-table .st-after  { background: none !important; }
}
@media (max-width: 760px) {
  .page { padding: 28px 18px; }
  .hc-meta { grid-template-columns: 1fr 1fr; }
  .score-table th, .score-table td { padding: 8px 10px; }
  .chips-row { flex-direction: column; }
  .tbar-legend { grid-template-columns: 1fr; }
}
`;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * HTML escape covering &, <, >, ", `.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/`/g, '&#96;')
    .replace(/'/g, '&#39;');
}

/**
 * Distinct values from an array, alphabetically sorted (deterministic).
 *
 * @param {Array<string>} arr
 * @returns {Array<string>}
 */
function distinctSorted(arr) {
  const seen = new Set();
  for (const v of arr) {
    if (typeof v === 'string' && v.length > 0) seen.add(v);
  }
  return Array.from(seen).sort();
}

/**
 * Brand fallback (mirrors src/reporter/rebuild-diff.js's defaults).
 */
function defaultBrand() {
  return {
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
}

module.exports = { renderRebuildSummary };
