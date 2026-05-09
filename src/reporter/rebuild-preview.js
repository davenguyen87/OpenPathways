/**
 * Render a RebuildManifest's transforms[] block as a brand-matched, self-
 * contained HTML preview report. This is the consultant's review surface for
 * full-tier (v5) coordinated rewrites: header card, summary strip, filter
 * chips, and one transform card per transform with a side-by-side rendered
 * before/after, the underlying patch list, the rationale, and an
 * approve / reject / pending form.
 *
 * Patches that don't carry a `transformId` are not rendered here — they live
 * in `rebuild-diff.html`. The preview is for full-tier transforms only.
 *
 * The output is deterministic: same manifest in -> byte-identical HTML out.
 * No `Date.now()`, no random ids — `manifest.createdAt`, `transform.id`, and
 * `patch.id` are the only timestamps and identifiers used in the DOM. The
 * manifest hash is a sha256 of the canonical pretty-printed manifest JSON
 * (matches the convention used by `src/reporter/rebuild-diff.js`).
 *
 * Visual primitives (palette, typography, pill/section-header conventions)
 * are copied from `src/reporter/rebuild-diff.js` per the chunk-06 spec; this
 * file is intentionally self-contained and does not import the diff renderer
 * or the v3 reporter.
 *
 * @typedef {import('../rebuild/types').RebuildManifest} RebuildManifest
 * @typedef {import('../rebuild/types').Patch} Patch
 * @typedef {import('../rebuild/types').Transform} Transform
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');

/**
 * Render the preview report and write it to disk.
 *
 * @param {RebuildManifest} manifest
 * @param {Object|null} brandConfig - same shape as config/brand.json
 * @param {string} outputPath - absolute path to write the HTML file
 * @param {Object} [opts] - reserved for future hooks; currently unused
 * @returns {Promise<string>} the HTML string (also written to outputPath)
 */
async function renderRebuildPreview(manifest, brandConfig, outputPath, opts) {
  void opts; // reserved
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
  const transforms = Array.isArray(manifest.transforms) ? manifest.transforms : [];
  const patches = Array.isArray(manifest.patches) ? manifest.patches : [];
  const deferred = Array.isArray(manifest.deferred) ? manifest.deferred : [];
  const verification = manifest.verification || {
    before: { violations: 0, criteriaFailed: 0, section508Failed: 0 },
    after: { violations: 0, criteriaFailed: 0, section508Failed: 0 },
    resolved: 0,
    introduced: 0,
    remaining: 0
  };

  // Patches indexed by id so each transform card can pull its child rows.
  const patchById = new Map();
  for (const p of patches) {
    if (p && typeof p.id === 'string') patchById.set(p.id, p);
  }

  const stagedCount = transforms.length;
  const appliedCount = transforms.filter((t) => t.status === 'applied').length;
  const rejectedCount = transforms.filter((t) => t.status === 'rejected').length;
  const pendingCount = transforms.filter((t) => t.status === 'pending-checkpoint').length;

  // Mode flags: review when at least one transform pending; archive when all
  // decisions are recorded (every transform is applied or rejected). Neither
  // banner is shown when transforms is empty.
  const isReview = pendingCount > 0;
  const isArchive = stagedCount > 0 && pendingCount === 0;

  // sha256 of canonical pretty-printed manifest JSON. Same convention as
  // rebuild-diff.js so two reports referencing the same manifest agree on
  // the hash they print.
  const manifestHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(manifest, null, 2))
    .digest('hex');

  // Distinct chip values, sorted alphabetically for determinism.
  const families = distinctSorted(transforms.map((t) => t.family));
  const criteria = distinctSorted(
    transforms.flatMap((t) => (Array.isArray(t.criteria) ? t.criteria : []))
  );

  const cssVars = buildCssVars(brand);
  const styles = buildStyles();
  const fontsLink =
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600;700&display=swap">';

  const checkpointState = isReview
    ? 'Pending review'
    : isArchive
      ? 'Decisions recorded'
      : 'No transforms staged';

  const banner = renderBanner(manifest, isReview, isArchive, pendingCount, appliedCount, rejectedCount);
  const headerCard = renderHeaderCard(manifest, manifestHash, checkpointState);
  const summaryStrip = renderSummaryStrip(
    stagedCount,
    appliedCount,
    rejectedCount,
    pendingCount,
    deferred.length,
    verification,
    isReview
  );
  const filterBar =
    transforms.length === 0
      ? ''
      : renderFilterBar(families, criteria, isReview);
  const transformList =
    transforms.length === 0
      ? renderEmptyState()
      : `<section class="transform-list">${transforms
          .map((t) => renderTransformCard(t, patchById, isReview))
          .join('')}</section>`;

  const script = buildScript(manifestHash);

  const titleClient = escapeHtml(manifest.engagementId || '');
  const titlePackage = escapeHtml(manifest.packageName || '');

  const bodyClasses = [];
  if (isReview) bodyClasses.push('mode-review', 'filter-needs-review');
  if (isArchive) bodyClasses.push('mode-archive');
  if (transforms.length === 0) bodyClasses.push('mode-empty');
  const bodyClassAttr = bodyClasses.length ? ` class="${bodyClasses.join(' ')}"` : '';

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${titleClient} — ${titlePackage} — Rebuild preview</title>`,
    fontsLink,
    '<style>',
    cssVars,
    styles,
    '</style>',
    '</head>',
    `<body${bodyClassAttr}>`,
    '<article class="page">',
    banner,
    headerCard,
    summaryStrip,
    filterBar,
    transformList,
    renderMethodNote(transforms),
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

function renderBanner(manifest, isReview, isArchive, pendingCount, appliedCount, rejectedCount) {
  if (isReview) {
    const cmd =
      `prism rebuild-checkpoint approve --engagement ${escapeHtml(manifest.engagementId || '<id>')} ` +
      `--package ${escapeHtml(manifest.packageName || '<name>')}`;
    return [
      '<div class="banner banner-review" role="status">',
      '<span class="b-icon" aria-hidden="true">●</span>',
      `<span class="b-msg"><strong>${escapeHtml(String(pendingCount))}</strong> transform${pendingCount === 1 ? '' : 's'} awaiting review.</span>`,
      '<span class="b-detail">Decide each card below, then promote with:</span>',
      `<code class="b-cmd">${cmd}</code>`,
      '</div>'
    ].join('');
  }
  if (isArchive) {
    return [
      '<div class="banner banner-archive" role="status">',
      '<span class="b-icon" aria-hidden="true">✓</span>',
      `<span class="b-msg">All transforms decided — <strong>${escapeHtml(String(appliedCount))}</strong> applied, <strong>${escapeHtml(String(rejectedCount))}</strong> rejected.</span>`,
      '<span class="b-detail">This page is an archive of recorded decisions; the approval form is disabled.</span>',
      '</div>'
    ].join('');
  }
  return '';
}

function renderHeaderCard(manifest, manifestHash, checkpointState) {
  const tool = manifest.tool || { name: '', version: '' };
  return [
    '<header class="header-card">',
    '<div class="hc-mark" aria-hidden="true">SL</div>',
    '<div class="hc-title">',
    '<div class="kicker">Rebuild preview report</div>',
    `<h1>${escapeHtml(manifest.engagementId || '')} <span class="hc-sep">•</span> ${escapeHtml(manifest.packageName || '')}</h1>`,
    '</div>',
    '<dl class="hc-meta">',
    `<div><dt>Mode</dt><dd>${escapeHtml(manifest.mode || '')}</dd></div>`,
    `<div><dt>Standard</dt><dd>${escapeHtml(manifest.standard || '')}</dd></div>`,
    `<div><dt>Tool</dt><dd>${escapeHtml(tool.name || '')} ${escapeHtml(tool.version || '')}</dd></div>`,
    `<div><dt>Generated</dt><dd>${escapeHtml(manifest.createdAt || '')}</dd></div>`,
    `<div><dt>Checkpoint</dt><dd data-checkpoint-state>${escapeHtml(checkpointState)}</dd></div>`,
    `<div class="hc-hash"><dt>Manifest hash</dt><dd><code>${escapeHtml(manifestHash)}</code></dd></div>`,
    '</dl>',
    '</header>'
  ].join('');
}

function renderSummaryStrip(staged, applied, rejected, pending, deferredCount, verification, isReview) {
  const before = verification.before || { violations: 0 };
  const after = verification.after || { violations: 0 };
  const verifyCell = isReview
    ? [
        '<div class="ss-cell ss-verify">',
        '<div class="num placeholder">—</div>',
        '<div class="label">Verification</div>',
        '<div class="sub">Runs at promotion</div>',
        '</div>'
      ].join('')
    : [
        '<div class="ss-cell ss-verify">',
        `<div class="num"><span class="v-before">${escapeHtml(String(before.violations))}</span> <span class="v-arrow">→</span> <span class="v-after">${escapeHtml(String(after.violations))}</span></div>`,
        '<div class="label">Violations before → after</div>',
        `<div class="sub">Resolved ${escapeHtml(String(verification.resolved || 0))} • Introduced ${escapeHtml(String(verification.introduced || 0))}</div>`,
        '</div>'
      ].join('');

  return [
    '<section class="summary-strip" aria-label="Preview summary">',
    '<div class="ss-cell">',
    `<div class="num">${escapeHtml(String(staged))}</div>`,
    '<div class="label">Transforms staged</div>',
    `<div class="sub">Pending ${escapeHtml(String(pending))}</div>`,
    '</div>',
    '<div class="ss-cell">',
    `<div class="num">${escapeHtml(String(applied))}</div>`,
    '<div class="label">Approved</div>',
    '</div>',
    '<div class="ss-cell">',
    `<div class="num${rejected > 0 ? ' warn' : ''}">${escapeHtml(String(rejected))}</div>`,
    '<div class="label">Rejected</div>',
    '</div>',
    '<div class="ss-cell">',
    `<div class="num">${escapeHtml(String(deferredCount))}</div>`,
    '<div class="label">Deferred findings</div>',
    '</div>',
    verifyCell,
    '</section>'
  ].join('');
}

function renderFilterBar(families, criteria, isReview) {
  const familyChips = families
    .map(
      (f) =>
        `<button type="button" class="chip" data-filter="family" data-value="${escapeHtml(f)}">${escapeHtml(f)}</button>`
    )
    .join('');
  const criterionChips = criteria
    .map(
      (c) =>
        `<button type="button" class="chip" data-filter="criterion" data-value="${escapeHtml(c)}">${escapeHtml(c)}</button>`
    )
    .join('');
  const needsReviewActive = isReview ? ' is-active' : '';
  const needsReviewPressed = isReview ? 'true' : 'false';

  return [
    '<section class="filters" aria-label="Transform filters">',
    '<div class="filter-group">',
    '<span class="fg-label">Family</span>',
    familyChips || '<span class="fg-empty">none</span>',
    '</div>',
    '<div class="filter-group">',
    '<span class="fg-label">Criterion</span>',
    criterionChips || '<span class="fg-empty">none</span>',
    '</div>',
    '<div class="filter-group">',
    `<button type="button" class="chip chip-flag${needsReviewActive}" data-filter="needs-review" data-value="true" aria-pressed="${needsReviewPressed}">Needs review only</button>`,
    '<button type="button" class="chip chip-clear" data-filter="clear">Clear filters</button>',
    '</div>',
    '</section>'
  ].join('');
}

function renderEmptyState() {
  return [
    '<section class="empty-state" data-empty-state>',
    '<div class="es-mark" aria-hidden="true">✓</div>',
    '<h2>No transforms in this rebuild</h2>',
    '<p>This rebuild produced no full-tier transforms. Per-patch detail is available in <a href="rebuild-diff.html">rebuild-diff.html</a>.</p>',
    '</section>'
  ].join('');
}

function renderTransformCard(transform, patchById, isReview) {
  const id = transform.id || '';
  const family = transform.family || '';
  const criteria = Array.isArray(transform.criteria) ? transform.criteria : [];
  const scope = transform.scope || { files: [], manifestEdited: false };
  const files = Array.isArray(scope.files) ? scope.files : [];
  const provenance = transform.provenance || { source: '' };
  const status = transform.status || '';
  const isPending = status === 'pending-checkpoint';
  const needsReview = isPending ? 'true' : 'false';

  // Provenance pill: rule-based vs llm; include model name when llm.
  const provLabel =
    provenance.source === 'llm' && provenance.model
      ? `${escapeHtml(provenance.source)} • ${escapeHtml(provenance.model)}`
      : escapeHtml(provenance.source || '');

  // AI verdict pill (v5.1): present only when transform.judgment is set.
  const judgment = transform.judgment;
  let aiVerdictPill = '';
  if (judgment && typeof judgment === 'object') {
    const pct = Math.round((judgment.confidence || 0) * 100);
    const model = escapeHtml(judgment.model || '');
    const ratTitle = escapeHtml(judgment.rationale || '');
    if (judgment.verdict === 'match') {
      aiVerdictPill = `<span class="ai-verdict-pill ai-verdict-match" title="${ratTitle}">AI-CONFIRMED · ${model} · ${pct}%</span>`;
    } else if (judgment.verdict === 'uncertain') {
      aiVerdictPill = `<span class="ai-verdict-pill ai-verdict-uncertain" title="${ratTitle}">AI-UNCERTAIN · ${model} · ${pct}%</span>`;
    }
  }

  const criteriaChips = criteria
    .map((c) => `<span class="chip-static chip-criterion">${escapeHtml(c)}</span>`)
    .join('');

  const fileTags = files
    .map((f) => `<span class="scope-file"><code>${escapeHtml(f)}</code></span>`)
    .join('');
  const manifestTag = scope.manifestEdited
    ? '<span class="chip-static chip-manifest">manifest edited</span>'
    : '';

  // Side-by-side preview from the patches' before/after fields. NEVER from
  // source files. Multi-file transforms render the first patch as the headline
  // diff and the rest as collapsed accordion entries.
  const childPatches = (Array.isArray(transform.patchIds) ? transform.patchIds : [])
    .map((pid) => patchById.get(pid))
    .filter((p) => p && typeof p === 'object');

  const sideBySide = renderSideBySide(childPatches, transform.id || '');
  const patchList = renderPatchList(childPatches);

  const cardAttrs = [
    `id="${escapeHtml(id)}"`,
    `data-transform-id="${escapeHtml(id)}"`,
    `data-family="${escapeHtml(family)}"`,
    `data-criteria="${escapeHtml(criteria.join(','))}"`,
    `data-status="${escapeHtml(status)}"`,
    `data-needs-review="${needsReview}"`
  ].join(' ');

  return [
    `<article class="transform-card" ${cardAttrs}>`,
    '<header class="tc-head">',
    '<div class="tc-headline">',
    `<span class="chip-static chip-family chip-family-${escapeHtml(family)}">${escapeHtml(family)}</span>`,
    criteriaChips,
    `<span class="chip-static chip-transformer"><code>${escapeHtml(transform.transformer || '')}</code></span>`,
    `<span class="chip-static chip-status chip-status-${escapeHtml(status)}">${escapeHtml(status)}</span>`,
    provLabel
      ? `<span class="chip-static chip-provenance">${provLabel}</span>`
      : '',
    aiVerdictPill,
    '</div>',
    `<div class="tc-id"><code>${escapeHtml(id)}</code></div>`,
    '</header>',

    '<section class="tc-scope" aria-label="Transform scope">',
    '<span class="tc-scope-label">Scope</span>',
    fileTags || '<span class="scope-empty">no files</span>',
    manifestTag,
    '</section>',

    sideBySide,

    patchList,

    `<p class="tc-rationale">${escapeHtml(transform.rationale || '')}</p>`,

    judgment && typeof judgment === 'object' && judgment.rationale
      ? `<p class="ai-rationale"><strong>AI rationale:</strong> ${escapeHtml(judgment.rationale)}</p>`
      : '',

    renderApprovalForm(transform, isReview),

    '</article>'
  ].join('');
}

function renderSideBySide(patches, transformId) {
  if (!patches || patches.length === 0) {
    return [
      '<section class="tc-preview" aria-label="Side-by-side preview">',
      '<div class="tc-preview-empty">No patch content available for this transform.</div>',
      '</section>'
    ].join('');
  }

  const head = patches[0];
  const tail = patches.slice(1);

  const tailAccordion =
    tail.length === 0
      ? ''
      : [
          '<details class="tc-preview-extras">',
          `<summary>${escapeHtml(String(tail.length))} additional file${tail.length === 1 ? '' : 's'} in this transform</summary>`,
          '<div class="tc-preview-extras-body">',
          tail.map((p) => renderSideBySidePair(p)).join(''),
          '</div>',
          '</details>'
        ].join('');

  return [
    `<section class="tc-preview" aria-label="Side-by-side preview" data-transform-id="${escapeHtml(transformId)}">`,
    renderSideBySidePair(head),
    tailAccordion,
    '</section>'
  ].join('');
}

function renderSideBySidePair(patch) {
  const file = escapeHtml(patch.file || '');
  const line = escapeHtml(String((patch.range && patch.range.startLine) || ''));
  return [
    '<div class="tc-pair">',
    `<div class="tc-pair-loc"><code>${file}</code><span class="row-sep">•</span>line ${line}</div>`,
    '<div class="tc-pair-cols">',
    '<section class="tc-side tc-before">',
    '<div class="tc-side-label">Before</div>',
    `<pre><code>${escapeHtml(patch.before || '')}</code></pre>`,
    '</section>',
    '<section class="tc-side tc-after">',
    '<div class="tc-side-label">After</div>',
    `<pre><code>${escapeHtml(patch.after || '')}</code></pre>`,
    '</section>',
    '</div>',
    '</div>'
  ].join('');
}

function renderPatchList(patches) {
  if (!patches || patches.length === 0) {
    return '';
  }
  const rows = patches
    .map((p) => {
      const id = escapeHtml(p.id || '');
      const file = escapeHtml(p.file || '');
      const line = escapeHtml(String((p.range && p.range.startLine) || ''));
      const fixer = escapeHtml(p.fixer || '');
      const criterion = escapeHtml(p.criterion || '');
      const before = escapeHtml(p.before || '');
      const after = escapeHtml(p.after || '');
      const rationale = escapeHtml(p.rationale || '');
      return [
        '<details class="tc-patch-row">',
        '<summary>',
        `<code class="pr-id">${id}</code>`,
        `<code class="pr-loc">${file}<span class="row-sep">•</span>line ${line}</code>`,
        `<span class="pr-fixer">${fixer}</span>`,
        `<span class="chip-static chip-criterion">${criterion}</span>`,
        '</summary>',
        '<div class="tc-patch-row-body">',
        '<div class="tc-patch-row-cols">',
        '<div class="tc-patch-row-col"><div class="tc-side-label">Before</div>',
        `<pre><code>${before}</code></pre></div>`,
        '<div class="tc-patch-row-col"><div class="tc-side-label">After</div>',
        `<pre><code>${after}</code></pre></div>`,
        '</div>',
        rationale ? `<p class="tc-patch-row-rationale">${rationale}</p>` : '',
        '</div>',
        '</details>'
      ].join('');
    })
    .join('');

  return [
    '<section class="tc-patches" aria-label="Underlying patches">',
    `<div class="tc-patches-head">${escapeHtml(String(patches.length))} patch${patches.length === 1 ? '' : 'es'} in this transform</div>`,
    rows,
    '</section>'
  ].join('');
}

function renderApprovalForm(transform, isReview) {
  const id = transform.id || '';
  const status = transform.status || '';
  const isPending = status === 'pending-checkpoint';
  // Forms are only fully interactive in review mode for pending transforms.
  // For applied/rejected/reverted transforms, we mirror the recorded state
  // and disable the form so the archive view shows what happened without
  // letting the operator change history.
  const formDisabled = !isReview || !isPending;

  // Initial radio + hidden state. For pending transforms, "undecided" is
  // checked. For applied/rejected, the matching radio reflects the recorded
  // state.
  const stateValue =
    status === 'applied' ? 'approve' : status === 'rejected' ? 'reject' : 'undecided';

  const groupName = `transform-${escapeHtml(id)}`;
  const approverName = `approver-${escapeHtml(id)}`;
  const stateName = `state-${escapeHtml(id)}`;

  const disabledAttr = formDisabled ? ' disabled' : '';

  function radio(value, label) {
    const checked = stateValue === value ? ' checked' : '';
    return [
      '<label class="ap-radio">',
      `<input type="radio" name="${groupName}" value="${value}"${checked}${disabledAttr}>`,
      `<span>${label}</span>`,
      '</label>'
    ].join('');
  }

  return [
    `<form class="approval-form${formDisabled ? ' is-disabled' : ''}" data-transform-id="${escapeHtml(id)}" onsubmit="return false;">`,
    '<fieldset class="ap-decision">',
    `<legend class="ap-legend">Decision</legend>`,
    radio('approve', 'Approve'),
    radio('reject', 'Reject'),
    radio('undecided', 'Pending'),
    '</fieldset>',
    '<label class="ap-initials">',
    '<span>Initials</span>',
    `<input type="text" name="${approverName}" placeholder="Initials" maxlength="6"${disabledAttr}>`,
    '</label>',
    `<input type="hidden" name="${stateName}" value="${escapeHtml(stateValue)}" data-mirror-for="${groupName}">`,
    '</form>'
  ].join('');
}

function renderMethodNote(transforms) {
  const transformerNames = distinctSorted(
    transforms.map((t) => t.transformer).filter((s) => typeof s === 'string')
  );
  const list =
    transformerNames.length > 0
      ? transformerNames.join(', ')
      : 'No transformers ran in this rebuild.';
  const sentence1 =
    transformerNames.length > 0
      ? `Transformers applied in this rebuild: ${escapeHtml(list)}.`
      : 'No transformers ran in this rebuild.';
  const sentence2 = 'Verification re-runs at checkpoint promotion against the audit standard.';
  const sentence3 =
    'See <a href="rebuild-diff.html">rebuild-diff.html</a> for per-patch detail (including safe / assisted patches not shown here).';
  return [
    '<section class="method-note" aria-label="Method note">',
    '<h2 class="section-heading">Method note</h2>',
    `<p>${sentence1} ${sentence2} ${sentence3}</p>`,
    '</section>'
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

/* ---- banner ---- */
.banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  padding: 14px 18px;
  border-radius: 6px;
  margin-bottom: 22px;
  break-inside: avoid;
}
.banner-review {
  background: var(--cta); color: #fff;
}
.banner-archive {
  background: var(--ok); color: #fff;
}
.banner .b-icon { font-size: 16px; flex-shrink: 0; }
.banner .b-msg {
  font: 700 14px var(--font-sans);
}
.banner .b-detail {
  font: 500 13px var(--font-sans);
  opacity: 0.92;
}
.banner .b-cmd {
  font: 500 12px var(--font-mono);
  background: rgba(0,0,0,0.18);
  padding: 6px 10px; border-radius: 4px;
  word-break: break-all;
}

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
  grid-template-columns: repeat(5, 1fr);
  border: 2px solid var(--ink);
  background: var(--paper-2);
  border-radius: 6px;
  margin: 28px 0 24px;
  break-inside: avoid;
}
.summary-strip .ss-cell {
  padding: 16px 18px;
  border-right: 1.5px solid var(--ink);
  display: grid; gap: 4px; align-content: start;
}
.summary-strip .ss-cell:last-child { border-right: 0; }
.summary-strip .num {
  font-family: var(--font-jersey);
  font-size: 28px; line-height: 1; letter-spacing: -0.02em;
  color: var(--ink);
}
.summary-strip .num.warn { color: var(--sev-critical); }
.summary-strip .num.placeholder { color: var(--ink-3); }
.summary-strip .ss-verify .num { font-size: 20px; }
.summary-strip .v-arrow { color: var(--ink-3); margin: 0 6px; font-size: 16px; }
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

/* ---- transform card list ---- */
.transform-list { display: grid; gap: 18px; }
.transform-card {
  background: var(--paper);
  border: 2px solid var(--ink);
  border-radius: 10px;
  overflow: hidden;
  break-inside: avoid;
  display: grid;
}
.tc-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px 18px;
  background: var(--paper-2);
  border-bottom: 1.5px solid var(--ink);
}
.tc-headline {
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
}
.tc-id code {
  font: 600 11px var(--font-mono);
  color: var(--ink-2);
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
.chip-family-landmark { background: var(--accent); color: #fff; border-color: var(--ink); }
.chip-family-widget   { background: var(--cta); color: #fff; border-color: var(--ink); }
.chip-family-page-split { background: var(--sev-moderate); color: #fff; border-color: var(--ink); }
.chip-transformer { background: var(--paper-3); }
.chip-transformer code { font: 600 10px var(--font-mono); color: var(--ink); }
.chip-status-pending-checkpoint { background: var(--cta); color: #fff; border-color: var(--ink); }
.chip-status-applied { background: var(--ok); color: #fff; border-color: var(--ink); }
.chip-status-rejected { background: var(--sev-critical); color: #fff; border-color: var(--ink); }
.chip-status-reverted { background: var(--ink); color: var(--paper); }
.chip-provenance { background: var(--ink); color: var(--paper); }
.chip-manifest { background: var(--sev-serious); color: #fff; border-color: var(--ink); }

.ai-verdict-pill {
  display: inline-flex; align-items: center;
  padding: 4px 9px;
  border-radius: 999px;
  border: 1.5px solid var(--ink);
  font: 600 10px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
}
.ai-verdict-match    { background: rgba(27,122,61,0.15); color: var(--ok); border-color: var(--ok); }
.ai-verdict-uncertain { background: rgba(242,134,25,0.15); color: #b85d00; border-color: var(--cta); }

.ai-rationale {
  margin: 6px 0 0;
  padding: 0 18px;
  font: 500 13px var(--font-sans);
  color: var(--ink-3);
}

.tc-scope {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px;
  padding: 10px 18px;
  background: var(--paper);
  border-bottom: 1px dashed var(--rule);
}
.tc-scope-label {
  font: 600 10px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--ink-3);
}
.tc-scope .scope-file code {
  font: 500 12px var(--font-mono);
  color: var(--ink-2);
  background: var(--paper-2);
  padding: 2px 6px;
  border-radius: 3px;
}
.tc-scope .scope-empty {
  font: 500 12px var(--font-mono);
  color: var(--ink-3);
  font-style: italic;
}

.tc-preview { padding: 14px 18px 4px; }
.tc-pair { margin-bottom: 12px; }
.tc-pair-loc {
  font: 600 12px var(--font-mono);
  color: var(--ink-2);
  margin-bottom: 6px;
}
.tc-pair-loc .row-sep { margin: 0 8px; color: var(--ink-3); }
.tc-pair-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.tc-side {
  border: 1px solid var(--rule);
  border-radius: 4px;
  background: var(--paper);
}
.tc-after { background: var(--accent-soft); }
.tc-side-label {
  font: 600 10px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--ink-3);
  padding: 6px 10px 0;
}
.tc-side pre {
  margin: 6px 0 0;
  padding: 10px 12px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.tc-side code {
  font: 500 12px var(--font-mono);
  color: var(--ink);
}
.tc-preview-empty {
  font: 500 13px var(--font-sans);
  color: var(--ink-3);
  font-style: italic;
  padding: 10px 0;
}
.tc-preview-extras { margin-top: 6px; }
.tc-preview-extras > summary {
  font: 600 11px var(--font-mono);
  color: var(--ink-2);
  cursor: pointer;
  padding: 6px 0;
}
.tc-preview-extras-body { margin-top: 8px; }

.tc-patches {
  border-top: 1px dashed var(--rule);
  padding: 12px 18px;
  background: var(--paper-2);
}
.tc-patches-head {
  font: 600 10px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--ink-3);
  margin-bottom: 8px;
}
.tc-patch-row {
  border-top: 1px solid var(--rule);
  padding: 6px 0;
}
.tc-patch-row:first-of-type { border-top: 0; }
.tc-patch-row > summary {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  cursor: pointer;
  padding: 4px 0;
}
.tc-patch-row .pr-id {
  font: 700 11px var(--font-mono);
  color: var(--accent-deep);
}
.tc-patch-row .pr-loc {
  font: 500 11px var(--font-mono);
  color: var(--ink-2);
}
.tc-patch-row .pr-loc .row-sep { margin: 0 6px; color: var(--ink-3); }
.tc-patch-row .pr-fixer {
  font: 600 10px var(--font-mono);
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--ink-3);
}
.tc-patch-row-body {
  padding: 8px 0 4px;
}
.tc-patch-row-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.tc-patch-row-col pre {
  margin: 0;
  padding: 8px 10px;
  background: var(--paper);
  border: 1px solid var(--rule);
  border-radius: 3px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.tc-patch-row-col code {
  font: 500 11px var(--font-mono);
  color: var(--ink);
}
.tc-patch-row-rationale {
  margin: 8px 0 0;
  font: 500 12px var(--font-sans);
  color: var(--ink-3);
}

.tc-rationale {
  margin: 0;
  padding: 10px 18px 0;
  font: 500 13px var(--font-sans);
  color: var(--ink-2);
}

/* ---- approval form ---- */
.approval-form {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 18px;
  align-items: center;
  padding: 14px 18px 16px;
  border-top: 1px dashed var(--rule);
  margin-top: 12px;
}
.approval-form.is-disabled {
  opacity: 0.7;
}
.approval-form .ap-decision {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  border: 1.5px solid var(--ink);
  border-radius: 6px;
  padding: 6px 12px;
  margin: 0;
  background: var(--paper);
}
.approval-form .ap-legend {
  font: 600 10px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--ink-3);
  padding: 0 6px 0 0;
}
.approval-form .ap-radio {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: 600 12px var(--font-mono);
  color: var(--ink);
}
.approval-form .ap-radio input[type="radio"] {
  width: 16px; height: 16px;
  accent-color: var(--accent);
}
.approval-form .ap-initials {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font: 600 12px var(--font-mono);
  color: var(--ink);
}
.approval-form .ap-initials input[type="text"] {
  border: 1.5px solid var(--ink);
  background: var(--paper);
  padding: 4px 8px;
  font: 500 12px var(--font-mono);
  width: 6em;
  border-radius: 4px;
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
  margin: 0 auto;
  font-size: 14px; color: var(--ink-2);
  max-width: 60ch;
}
.empty-state a { color: var(--accent-deep); }

/* ---- method note ---- */
.section-heading {
  font-family: var(--font-display); font-weight: 600;
  font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--ink-3);
  margin: 32px 0 14px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--rule);
}
.method-note { break-inside: avoid; margin-top: 32px; }
.method-note p {
  font-size: 13px; color: var(--ink-2);
  margin: 0; line-height: 1.65;
}
.method-note a { color: var(--accent-deep); }

/* ---- filter rules (driven by body classes) ---- */
body.has-family-filter .transform-card[data-family]:not(.match-family) { display: none; }
body.has-criterion-filter .transform-card[data-criteria]:not(.match-criterion) { display: none; }
body.filter-needs-review .transform-card[data-needs-review="false"] { display: none; }

/* ---- print ---- */
@page { size: Letter; margin: 0.5in; }
@media print {
  body { background: #fff; }
  .page { padding: 24px 36px; max-width: none; }
  .transform-card, .summary-strip, .header-card, .filters, .empty-state, .method-note, .banner {
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .filters { display: none; }
  /* Approval form must remain present and fillable in PDF print. */
  .approval-form { display: flex; }
  .approval-form input { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .banner .b-cmd { background: rgba(0,0,0,0.08); color: var(--ink); }
}
@media (max-width: 880px) {
  .page { padding: 32px 22px; }
  .summary-strip { grid-template-columns: 1fr 1fr; }
  .summary-strip .ss-cell { border-right: 0; border-bottom: 1.5px solid var(--ink); }
  .summary-strip .ss-cell:nth-last-child(-n+1) { border-bottom: 0; }
  .tc-pair-cols, .tc-patch-row-cols { grid-template-columns: 1fr; }
  .hc-meta { grid-template-columns: 1fr 1fr; }
}
`;
}

function buildScript(manifestHash) {
  // Inline filter chip + form mirroring + localStorage persistence. Pure
  // vanilla, no external deps. Storage key is namespaced by manifest hash so
  // a "Save Page As" replay against a stale manifest doesn't bleed state.
  const safeHash = JSON.stringify(manifestHash);
  return `<script>
(function () {
  var body = document.body;
  var STORAGE_KEY = 'prism.rebuild-preview.' + ${safeHash};

  var familyActive = null;
  var criterionActive = null;

  function applyFamilyMatch() {
    var cards = document.querySelectorAll('.transform-card');
    cards.forEach(function (c) { c.classList.remove('match-family'); });
    if (familyActive) {
      body.classList.add('has-family-filter');
      cards.forEach(function (c) {
        if (c.getAttribute('data-family') === familyActive) {
          c.classList.add('match-family');
        }
      });
    } else {
      body.classList.remove('has-family-filter');
    }
  }

  function applyCriterionMatch() {
    var cards = document.querySelectorAll('.transform-card');
    cards.forEach(function (c) { c.classList.remove('match-criterion'); });
    if (criterionActive) {
      body.classList.add('has-criterion-filter');
      cards.forEach(function (c) {
        var raw = c.getAttribute('data-criteria') || '';
        var parts = raw.split(',').map(function (s) { return s.trim(); });
        if (parts.indexOf(criterionActive) !== -1) {
          c.classList.add('match-criterion');
        }
      });
    } else {
      body.classList.remove('has-criterion-filter');
    }
  }

  document.querySelectorAll('.chip[data-filter]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      var filter = chip.getAttribute('data-filter');
      var value = chip.getAttribute('data-value');
      var group = chip.parentElement;

      if (filter === 'clear') {
        familyActive = null;
        criterionActive = null;
        body.classList.remove('filter-needs-review');
        applyFamilyMatch();
        applyCriterionMatch();
        document.querySelectorAll('.chip.is-active').forEach(function (c) {
          if (c.getAttribute('data-filter') !== 'needs-review') c.classList.remove('is-active');
          if (c.getAttribute('data-filter') === 'needs-review') {
            c.classList.remove('is-active');
            c.setAttribute('aria-pressed', 'false');
          }
        });
        return;
      }

      if (filter === 'family') {
        var wasActive = chip.classList.contains('is-active');
        group.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('is-active'); });
        familyActive = wasActive ? null : value;
        if (!wasActive) chip.classList.add('is-active');
        applyFamilyMatch();
      } else if (filter === 'criterion') {
        var wasActiveC = chip.classList.contains('is-active');
        group.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('is-active'); });
        criterionActive = wasActiveC ? null : value;
        if (!wasActiveC) chip.classList.add('is-active');
        applyCriterionMatch();
      } else if (filter === 'needs-review') {
        var was = body.classList.contains('filter-needs-review');
        body.classList.toggle('filter-needs-review', !was);
        chip.classList.toggle('is-active', !was);
        chip.setAttribute('aria-pressed', !was ? 'true' : 'false');
      }
    });
  });

  // Approval form mirroring + localStorage persistence.
  function loadState() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) { return {}; }
  }
  function saveState(state) {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* best-effort */ }
  }

  var state = loadState();

  document.querySelectorAll('.approval-form').forEach(function (form) {
    var tid = form.getAttribute('data-transform-id');
    if (!tid) return;
    var hidden = form.querySelector('input[type="hidden"][data-mirror-for]');
    var radios = form.querySelectorAll('input[type="radio"]');
    var initials = form.querySelector('input[type="text"]');

    // Replay saved state for this transform if present and the form is
    // interactive (i.e., the radios are not disabled).
    if (state[tid] && radios.length && !radios[0].disabled) {
      if (typeof state[tid].decision === 'string') {
        radios.forEach(function (r) {
          if (r.value === state[tid].decision) r.checked = true;
        });
        if (hidden) hidden.value = state[tid].decision;
      }
      if (initials && typeof state[tid].initials === 'string') {
        initials.value = state[tid].initials;
      }
    }

    radios.forEach(function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        if (hidden) hidden.value = r.value;
        state[tid] = state[tid] || {};
        state[tid].decision = r.value;
        saveState(state);
      });
    });
    if (initials) {
      initials.addEventListener('input', function () {
        state[tid] = state[tid] || {};
        state[tid].initials = initials.value;
        saveState(state);
      });
    }
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

module.exports = { renderRebuildPreview };
