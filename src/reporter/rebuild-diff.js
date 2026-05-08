/**
 * Render a RebuildManifest as a brand-matched, self-contained HTML diff
 * report. Produces the consultant's review surface: header card, summary
 * strip, filter chips, and per-patch rows with before/after, sign-off
 * checkboxes, and a reject affordance.
 *
 * The output is deterministic: same manifest in -> byte-identical HTML out.
 * No `Date.now()`, no random ids — `manifest.createdAt` and `patch.id` are
 * the only timestamps and identifiers used in the DOM.
 *
 * Visual primitives (palette, typography, pill/section-header conventions)
 * are copied from `src/reporter/html.js` block-for-block per the chunk-05
 * spec; this file is intentionally self-contained and does not import the
 * v3 reporter.
 *
 * @typedef {import('../rebuild/types').RebuildManifest} RebuildManifest
 * @typedef {import('../rebuild/types').Patch} Patch
 * @typedef {import('../rebuild/types').DeferredFinding} DeferredFinding
 */

const fs = require('fs');
const crypto = require('crypto');

/**
 * Render the diff report and write it to disk.
 *
 * @param {RebuildManifest} manifest
 * @param {Object} brandConfig - same shape as config/brand.json
 * @param {string} outputPath - absolute path to write the HTML file
 * @returns {Promise<string>} the HTML string (also written to outputPath)
 */
async function renderRebuildDiff(manifest, brandConfig, outputPath) {
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

  const appliedCount = patches.filter((p) => p.status === 'applied').length;
  const rejectedCount = patches.filter((p) => p.status === 'rejected').length;

  // sha256 of canonical pretty-printed manifest JSON (per chunk-05 spec).
  const manifestHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(manifest, null, 2))
    .digest('hex');

  // Distinct chip values, sorted alphabetically for determinism.
  const tiers = distinctSorted(patches.map((p) => p.tier));
  const triages = distinctSorted(patches.map((p) => p.triage));
  const criteria = distinctSorted(patches.map((p) => p.criterion));

  const cssVars = buildCssVars(brand);
  const styles = buildStyles();
  const fontsLink =
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600;700&display=swap">';

  const headerCard = renderHeaderCard(manifest, manifestHash);
  const summaryStrip = renderSummaryStrip(appliedCount, rejectedCount, deferred.length, verification);
  const filterBar = renderFilterBar(tiers, triages, criteria);
  const patchList =
    patches.length === 0
      ? renderEmptyState(deferred.length)
      : `<section class="patch-list">${patches.map((p) => renderPatchRow(p)).join('')}</section>`;

  const script = buildScript();

  const titleClient = escapeHtml(manifest.engagementId || '');
  const titlePackage = escapeHtml(manifest.packageName || '');

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${titleClient} — ${titlePackage} — Rebuild diff</title>`,
    fontsLink,
    '<style>',
    cssVars,
    styles,
    '</style>',
    '</head>',
    '<body>',
    '<article class="page">',
    headerCard,
    summaryStrip,
    filterBar,
    patchList,
    '</article>',
    script,
    '</body>',
    '</html>',
    ''
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* sections                                                            */
/* ------------------------------------------------------------------ */

function renderHeaderCard(manifest, manifestHash) {
  const tool = manifest.tool || { name: '', version: '' };
  return [
    '<header class="header-card">',
    '<div class="hc-mark" aria-hidden="true">DX</div>',
    '<div class="hc-title">',
    '<div class="kicker">Rebuild diff report</div>',
    `<h1>${escapeHtml(manifest.engagementId)} <span class="hc-sep">•</span> ${escapeHtml(manifest.packageName)}</h1>`,
    '</div>',
    '<dl class="hc-meta">',
    `<div><dt>Mode</dt><dd>${escapeHtml(manifest.mode)}</dd></div>`,
    `<div><dt>Standard</dt><dd>${escapeHtml(manifest.standard)}</dd></div>`,
    `<div><dt>Tool</dt><dd>${escapeHtml(tool.name)} ${escapeHtml(tool.version)}</dd></div>`,
    `<div><dt>Generated</dt><dd>${escapeHtml(manifest.createdAt)}</dd></div>`,
    `<div class="hc-hash"><dt>Manifest hash</dt><dd><code>${escapeHtml(manifestHash)}</code></dd></div>`,
    '</dl>',
    '</header>'
  ].join('');
}

function renderSummaryStrip(applied, rejected, deferredCount, verification) {
  const before = verification.before || { violations: 0 };
  const after = verification.after || { violations: 0 };
  const resolved = typeof verification.resolved === 'number' ? verification.resolved : 0;
  const introduced = typeof verification.introduced === 'number' ? verification.introduced : 0;
  return [
    '<section class="summary-strip" aria-label="Rebuild summary">',
    '<div class="ss-cell">',
    `<div class="num">${applied}</div>`,
    '<div class="label">Patches applied</div>',
    '</div>',
    '<div class="ss-cell">',
    `<div class="num${rejected > 0 ? ' warn' : ''}">${rejected}</div>`,
    '<div class="label">Patches rejected</div>',
    '</div>',
    '<div class="ss-cell">',
    `<div class="num">${deferredCount}</div>`,
    '<div class="label">Deferred findings</div>',
    '</div>',
    '<div class="ss-cell ss-verify">',
    `<div class="num"><span class="v-before">${escapeHtml(String(before.violations))}</span> <span class="v-arrow">→</span> <span class="v-after">${escapeHtml(String(after.violations))}</span></div>`,
    `<div class="label">Violations before → after</div>`,
    `<div class="sub">Resolved ${resolved} • Introduced ${introduced}</div>`,
    '</div>',
    '</section>'
  ].join('');
}

function renderFilterBar(tiers, triages, criteria) {
  const tierChips = tiers
    .map(
      (t) =>
        `<button type="button" class="chip" data-filter="tier" data-value="${escapeHtml(t)}">${escapeHtml(t)}</button>`
    )
    .join('');
  const triageChips = triages
    .map(
      (t) =>
        `<button type="button" class="chip" data-filter="triage" data-value="${escapeHtml(t)}">${escapeHtml(t)}</button>`
    )
    .join('');
  const criterionChips = criteria
    .map(
      (c) =>
        `<button type="button" class="chip" data-filter="criterion" data-value="${escapeHtml(c)}">${escapeHtml(c)}</button>`
    )
    .join('');

  return [
    '<section class="filters" aria-label="Patch filters">',
    '<div class="filter-group">',
    '<span class="fg-label">Tier</span>',
    tierChips || '<span class="fg-empty">none</span>',
    '</div>',
    '<div class="filter-group">',
    '<span class="fg-label">Triage</span>',
    triageChips || '<span class="fg-empty">none</span>',
    '</div>',
    '<div class="filter-group">',
    '<span class="fg-label">Criterion</span>',
    criterionChips || '<span class="fg-empty">none</span>',
    '</div>',
    '<div class="filter-group">',
    '<button type="button" class="chip chip-flag" data-filter="needs-signoff" data-value="true">Needs sign-off only</button>',
    '<button type="button" class="chip chip-clear" data-filter="clear">Clear filters</button>',
    '</div>',
    '</section>'
  ].join('');
}

function renderEmptyState(deferredCount) {
  const msg =
    deferredCount > 0
      ? `No patches were emitted in this rebuild. ${deferredCount} finding${deferredCount === 1 ? '' : 's'} ${deferredCount === 1 ? 'was' : 'were'} deferred (assisted or full tier not enabled in this mode).`
      : 'No patches were emitted in this rebuild and no findings were deferred. The audit found nothing to remediate at the safe tier.';
  return [
    '<section class="empty-state">',
    '<div class="es-mark" aria-hidden="true">✓</div>',
    '<h2>No patches in this rebuild</h2>',
    `<p>${escapeHtml(msg)}</p>`,
    '</section>'
  ].join('');
}

function renderPatchRow(patch) {
  const id = patch.id || '';
  const fileLine =
    `${escapeHtml(patch.file)}` +
    `<span class="row-sep">•</span>` +
    `line ${escapeHtml(String(patch.range && patch.range.startLine))}`;

  const provenance = patch.provenance || { source: '' };
  const provText =
    provenance.model && (patch.tier === 'assisted' || provenance.source === 'llm')
      ? `${escapeHtml(provenance.source)} • ${escapeHtml(provenance.model)}`
      : escapeHtml(provenance.source);

  const needsSignoff =
    patch.confidence !== 'definitive' || patch.tier !== 'safe' ? 'true' : 'false';

  const rowAttrs = [
    `data-patch-id="${escapeHtml(id)}"`,
    `data-tier="${escapeHtml(patch.tier)}"`,
    `data-triage="${escapeHtml(patch.triage)}"`,
    `data-criterion="${escapeHtml(patch.criterion)}"`,
    `data-confidence="${escapeHtml(patch.confidence)}"`,
    `data-needs-signoff="${needsSignoff}"`
  ].join(' ');

  const approveName = `approve-${id}`;
  const initialsName = `initials-${id}`;

  return [
    `<article class="patch-row" ${rowAttrs}>`,
    '<header class="pr-head">',
    `<div class="pr-loc">${fileLine}</div>`,
    '<div class="pr-chips">',
    `<span class="chip-static chip-criterion">${escapeHtml(patch.criterion)}</span>`,
    `<span class="chip-static chip-triage">${escapeHtml(patch.triage)}</span>`,
    `<span class="chip-static chip-confidence chip-confidence-${escapeHtml(patch.confidence)}">${escapeHtml(patch.confidence)}</span>`,
    `<span class="chip-static chip-provenance">${provText}</span>`,
    needsSignoff === 'true' ? '<span class="chip-static chip-flag-signoff">needs sign-off</span>' : '',
    '</div>',
    '</header>',
    '<div class="pr-body">',
    '<div class="pr-side pr-before">',
    '<div class="pr-side-label">Before</div>',
    `<pre><code>${escapeHtml(patch.before || '')}</code></pre>`,
    '</div>',
    '<div class="pr-side pr-after">',
    '<div class="pr-side-label">After</div>',
    `<pre><code>${escapeHtml(patch.after || '')}</code></pre>`,
    '</div>',
    '</div>',
    `<p class="pr-rationale">${escapeHtml(patch.rationale || '')}</p>`,
    '<div class="pr-controls">',
    '<label class="pr-approve">',
    `<input type="checkbox" name="approve-${escapeHtml(id)}" id="approve-${escapeHtml(id)}">`,
    `<span>Approved by</span>`,
    `<input type="text" name="initials-${escapeHtml(id)}" placeholder="initials" class="pr-initials">`,
    '</label>',
    `<button type="button" class="pr-reject" data-patch-id="${escapeHtml(id)}">Reject</button>`,
    `<input type="hidden" class="pr-rejected-state" name="rejected" value="${escapeHtml(id)}" disabled>`,
    '</div>',
    '</article>'
  ].join('');
}

/* ------------------------------------------------------------------ */
/* css + script                                                        */
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

.page { max-width: 1080px; margin: 0 auto; padding: 48px 56px 80px; }

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
.hc-meta .hc-hash { grid-column: 1 / -1; }
.hc-meta .hc-hash dd code {
  font: 500 11px var(--font-mono);
  color: var(--ink-2);
  word-break: break-all;
}

/* ---- summary strip ---- */
.summary-strip {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border: 2px solid var(--ink);
  background: var(--paper-2);
  border-radius: 6px;
  margin: 28px 0 24px;
  break-inside: avoid;
}
.summary-strip .ss-cell {
  padding: 18px 20px;
  border-right: 1.5px solid var(--ink);
  display: grid; gap: 4px; align-content: start;
}
.summary-strip .ss-cell:last-child { border-right: 0; }
.summary-strip .num {
  font-family: var(--font-jersey);
  font-size: 30px; line-height: 1; letter-spacing: -0.02em;
  color: var(--ink);
}
.summary-strip .num.warn { color: var(--sev-critical); }
.summary-strip .ss-verify .num {
  font-size: 22px;
}
.summary-strip .v-arrow { color: var(--ink-3); margin: 0 6px; font-size: 18px; }
.summary-strip .label {
  font: 600 10px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--ink-3);
}
.summary-strip .sub {
  font: 500 12px var(--font-mono);
  color: var(--ink-2);
  margin-top: 4px;
}

/* ---- filter bar ---- */
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  align-items: center;
  margin: 0 0 22px;
  padding: 14px 16px;
  background: var(--paper-2);
  border: 1.5px solid var(--rule);
  border-radius: 8px;
  break-inside: avoid;
}
.filter-group {
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
}
.filter-group .fg-label {
  font: 600 10px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--ink-3);
  margin-right: 4px;
}
.filter-group .fg-empty {
  font: 500 12px var(--font-mono); color: var(--ink-3);
}
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 11px;
  border-radius: 999px;
  background: var(--paper);
  border: 1.5px solid var(--ink);
  color: var(--ink);
  font: 600 10px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  cursor: pointer;
}
.chip:hover { background: var(--accent-soft); }
.chip.is-active { background: var(--ink); color: var(--paper); }
.chip-flag.is-active { background: var(--cta); color: #fff; border-color: var(--ink); }
.chip-clear {
  background: transparent;
  border-style: dashed;
  color: var(--ink-3);
}

/* ---- patch list ---- */
.patch-list { display: grid; gap: 16px; }
.patch-row {
  background: var(--paper);
  border: 2px solid var(--ink);
  border-radius: 10px;
  overflow: hidden;
  break-inside: avoid;
  display: grid;
}
.pr-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px 18px;
  background: var(--paper-2);
  border-bottom: 1.5px solid var(--ink);
}
.pr-loc {
  font: 600 12px var(--font-mono);
  color: var(--ink);
  word-break: break-word;
}
.pr-loc .row-sep { margin: 0 8px; color: var(--ink-3); }
.pr-chips {
  display: flex; flex-wrap: wrap; gap: 6px;
}
.chip-static {
  display: inline-flex; align-items: center;
  padding: 4px 9px;
  border-radius: 999px;
  border: 1.5px solid var(--ink);
  background: var(--paper);
  font: 600 10px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--ink);
}
.chip-criterion {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-deep);
}
.chip-triage { background: var(--paper-2); }
.chip-confidence-definitive { background: var(--ok); color: #fff; border-color: var(--ink); }
.chip-confidence-likely { background: var(--sev-moderate); color: #fff; border-color: var(--ink); }
.chip-confidence-needs-review { background: var(--cta); color: #fff; border-color: var(--ink); }
.chip-provenance { background: var(--ink); color: var(--paper); }
.chip-flag-signoff {
  background: var(--cta); color: #fff; border-color: var(--ink);
}

.pr-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
}
.pr-side {
  padding: 14px 16px;
  border-right: 1px dashed var(--rule);
}
.pr-side:last-child { border-right: 0; }
.pr-after { background: var(--accent-soft); }
.pr-side-label {
  font: 600 10px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--ink-3);
  margin-bottom: 6px;
}
.pr-side pre {
  margin: 0;
  padding: 10px 12px;
  background: var(--paper);
  border: 1px solid var(--rule);
  border-radius: 4px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.pr-side code {
  font: 500 12px var(--font-mono);
  color: var(--ink);
}

.pr-rationale {
  margin: 0;
  padding: 10px 18px 0;
  font-size: 13px; color: var(--ink-2);
}
.pr-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  padding: 14px 18px 16px;
  border-top: 1px dashed var(--rule);
  margin-top: 12px;
}
.pr-approve {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font: 600 12px var(--font-mono);
  color: var(--ink);
}
.pr-approve input[type="checkbox"] {
  width: 16px; height: 16px;
  accent-color: var(--accent);
}
.pr-initials {
  border: 1.5px solid var(--ink);
  background: var(--paper);
  padding: 4px 8px;
  font: 500 12px var(--font-mono);
  width: 6em;
  border-radius: 4px;
}
.pr-reject {
  border: 1.5px solid var(--ink);
  background: var(--paper);
  color: var(--ink);
  font: 600 11px var(--font-mono);
  letter-spacing: 0.12em; text-transform: uppercase;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
}
.pr-reject:hover { background: var(--ink); color: var(--paper); }

.patch-row.is-rejected {
  background: var(--paper-2);
  opacity: 0.66;
}
.patch-row.is-rejected .pr-after { text-decoration: line-through; }
.patch-row.is-rejected .pr-reject {
  background: var(--cta); color: #fff; border-color: var(--ink);
}

/* ---- empty state ---- */
.empty-state {
  border: 2px dashed var(--ink);
  background: var(--paper-2);
  border-radius: 10px;
  padding: 32px 28px;
  text-align: center;
  break-inside: avoid;
}
.empty-state .es-mark {
  display: inline-grid; place-items: center;
  width: 44px; height: 44px;
  background: var(--ok); color: #fff;
  border-radius: 50%;
  font-family: var(--font-jersey); font-size: 22px;
  margin-bottom: 10px;
}
.empty-state h2 {
  font-family: var(--font-jersey); font-weight: 400;
  font-size: 22px; letter-spacing: -0.02em;
  margin: 0 0 6px; color: var(--ink);
}
.empty-state p {
  margin: 0; font-size: 14px; color: var(--ink-2);
  max-width: 60ch; margin: 0 auto;
}

/* ---- filtering rules (driven by body classes) ---- */
body.filter-tier-safe .patch-row:not([data-tier="safe"]) { display: none; }
body.filter-tier-assisted .patch-row:not([data-tier="assisted"]) { display: none; }
body.filter-tier-full .patch-row:not([data-tier="full"]) { display: none; }
body.filter-needs-signoff .patch-row[data-needs-signoff="false"] { display: none; }
/* triage and criterion filters are applied via inline data-attribute matching */
body.has-triage-filter .patch-row[data-triage]:not(.match-triage) { display: none; }
body.has-criterion-filter .patch-row[data-criterion]:not(.match-criterion) { display: none; }

/* ---- print ---- */
@page { size: Letter; margin: 0.5in; }
@media print {
  body { background: #fff; }
  .page { padding: 24px 36px; max-width: none; }
  .patch-row, .summary-strip, .header-card, .filters, .empty-state { break-inside: avoid; }
  .filters { display: none; }
  .pr-reject { display: none; }
}
@media (max-width: 880px) {
  .page { padding: 32px 22px; }
  .summary-strip { grid-template-columns: 1fr 1fr; }
  .summary-strip .ss-cell { border-right: 0; border-bottom: 1.5px solid var(--ink); }
  .summary-strip .ss-cell:nth-last-child(-n+2) { border-bottom: 0; }
  .pr-body { grid-template-columns: 1fr; }
  .pr-side { border-right: 0; border-bottom: 1px dashed var(--rule); }
  .pr-side:last-child { border-bottom: 0; }
  .hc-meta { grid-template-columns: 1fr 1fr; }
}
`;
}

function buildScript() {
  // Inline filtering + reject toggle. Pure vanilla, no external deps.
  return `<script>
(function () {
  var body = document.body;
  var triageActive = null;
  var criterionActive = null;

  function applyTriageMatch() {
    var rows = document.querySelectorAll('.patch-row');
    rows.forEach(function (r) { r.classList.remove('match-triage'); });
    if (triageActive) {
      body.classList.add('has-triage-filter');
      rows.forEach(function (r) {
        if (r.getAttribute('data-triage') === triageActive) {
          r.classList.add('match-triage');
        }
      });
    } else {
      body.classList.remove('has-triage-filter');
    }
  }

  function applyCriterionMatch() {
    var rows = document.querySelectorAll('.patch-row');
    rows.forEach(function (r) { r.classList.remove('match-criterion'); });
    if (criterionActive) {
      body.classList.add('has-criterion-filter');
      rows.forEach(function (r) {
        if (r.getAttribute('data-criterion') === criterionActive) {
          r.classList.add('match-criterion');
        }
      });
    } else {
      body.classList.remove('has-criterion-filter');
    }
  }

  function clearTierFilters() {
    body.classList.remove('filter-tier-safe', 'filter-tier-assisted', 'filter-tier-full');
  }

  document.querySelectorAll('.chip[data-filter]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      var filter = chip.getAttribute('data-filter');
      var value = chip.getAttribute('data-value');
      var group = chip.parentElement;

      if (filter === 'clear') {
        clearTierFilters();
        body.classList.remove('filter-needs-signoff');
        triageActive = null;
        criterionActive = null;
        applyTriageMatch();
        applyCriterionMatch();
        document.querySelectorAll('.chip.is-active').forEach(function (c) { c.classList.remove('is-active'); });
        return;
      }

      if (filter === 'tier') {
        var cls = 'filter-tier-' + value;
        var was = body.classList.contains(cls);
        clearTierFilters();
        group.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('is-active'); });
        if (!was) { body.classList.add(cls); chip.classList.add('is-active'); }
      } else if (filter === 'triage') {
        var wasActive = chip.classList.contains('is-active');
        group.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('is-active'); });
        triageActive = wasActive ? null : value;
        if (!wasActive) chip.classList.add('is-active');
        applyTriageMatch();
      } else if (filter === 'criterion') {
        var wasActiveC = chip.classList.contains('is-active');
        group.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('is-active'); });
        criterionActive = wasActiveC ? null : value;
        if (!wasActiveC) chip.classList.add('is-active');
        applyCriterionMatch();
      } else if (filter === 'needs-signoff') {
        var was2 = body.classList.contains('filter-needs-signoff');
        body.classList.toggle('filter-needs-signoff', !was2);
        chip.classList.toggle('is-active', !was2);
      }
    });
  });

  document.querySelectorAll('.pr-reject').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var row = btn.closest('.patch-row');
      if (!row) return;
      var hidden = row.querySelector('.pr-rejected-state');
      var rejected = row.classList.toggle('is-rejected');
      if (hidden) {
        if (rejected) {
          hidden.removeAttribute('disabled');
        } else {
          hidden.setAttribute('disabled', '');
        }
      }
      btn.textContent = rejected ? 'Restore' : 'Reject';
    });
  });
})();
</script>`;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * HTML escape covering &, <, >, ", '.
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
 * Brand fallback (mirrors src/reporter/html.js's defaults).
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

module.exports = { renderRebuildDiff };
