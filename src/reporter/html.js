/**
 * Render a scorecard as a brand-matched HTML report string.
 *
 * @param {object} scorecard - Scorecard object from buildScorecard, enriched with v3 data:
 *   - library: { packageCount, cleanCount, criticalCount, hoursTotal, triageRollup, topRisks }
 *   - findings with triage, effortMinutes, section508 tags
 * @param {object} options - { brand?: brandConfig, engagementId?, clientName?, consultantName?, packageCount?, redactClientName? }
 * @returns {string} Self-contained HTML document
 */
function renderHtml(scorecard, options = {}) {
  const {
    brand = defaultBrand(),
    engagementId = 'SL-0000-0000',
    clientName = 'Client Organization',
    consultantName = 'Auditor',
    packageCount = 1,
    redactClientName = false,
  } = options;

  const displayClientName = redactClientName ? engagementId : clientName;
  const wcagVersion = scorecard.wcagVersion === '2.2' ? 'WCAG 2.2 AA' : 'WCAG 2.1 AA';

  // Extract data from scorecard
  const {
    summary = {},
    violations = [],
    scos = [],
    library = {},
  } = scorecard;

  const {
    totalViolations = 0,
    bySeverity = { critical: 0, serious: 0, moderate: 0, minor: 0 },
  } = summary;

  // Compute exec-summary stats
  const packagesAudited = packageCount;
  const criticalBlockers = bySeverity.critical || 0;

  // Library rollup (batch mode) or single-package mode
  const { triageRollup = {} } = library;
  const cleanCount = library.cleanCount || (criticalBlockers === 0 && totalViolations === 0 ? 1 : 0);
  const hoursTotal = Math.round((library.hoursTotal || 0) / 60 * 10) / 10;

  // Triage distribution
  const triageClean = triageRollup.clean || cleanCount;
  const triageAutoFixSafe = triageRollup['auto-fix-safe'] || 0;
  const triageAuthor = triageRollup['author-rework'] || 0;
  const triageContent = triageRollup['content-rework'] || 0;
  const triageRetire = triageRollup['recommend-retire'] || 0;

  // Top risks (pre-computed by integration agent)
  const topRisks = library.topRisks || scorecard.topRisks || [];

  // Section 508 mapping
  const section508Map = buildSection508Map(violations);

  // HTML output
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${displayClientName} — Library Accessibility Assessment</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600;700&display=swap">
<style>
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
  --sev-ok:       ${brand['sev-ok']};

  --font-jersey:  'Archivo Black', 'Arial Black', sans-serif;
  --font-display: 'Space Grotesk', system-ui, sans-serif;
  --font-sans:    'Inter', system-ui, sans-serif;
  --font-mono:    'JetBrains Mono', ui-monospace, Menlo, monospace;
}
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

/* ---- page wrap ---- */
.page {
  max-width: 1080px; margin: 0 auto; padding: 48px 56px 80px;
}
.rule { border: 0; border-top: 1px dashed var(--rule); margin: 36px 0; }
.rule.solid { border-top: 2px solid var(--ink); margin: 48px 0 36px; }

/* ---- cover ---- */
.cover {
  display: grid; grid-template-columns: auto 1fr auto; gap: 28px; align-items: center;
  padding-bottom: 36px; border-bottom: 2px solid var(--ink);
  break-after: page;
}
.brand-mark {
  width: 56px; height: 56px; background: var(--accent); color: #fff;
  display: grid; place-items: center;
  font-family: var(--font-jersey); font-size: 20px;
  clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%);
}
.cover .brand-name {
  font-family: var(--font-jersey); font-size: 22px; letter-spacing: -0.01em;
}
.cover .brand-name .sub {
  display: block;
  font: 600 9px var(--font-mono);
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--ink-3);
  margin-top: 2px;
}
.cover .doc-meta {
  text-align: right;
  font: 500 11px var(--font-mono);
  letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--ink-3);
  display: grid; gap: 4px;
}
.cover .doc-meta strong { color: var(--ink); font-family: var(--font-mono); font-weight: 700; }

.title-block { margin-top: 40px; }
.title-block .pill-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px; }
.title-block h1 {
  font-family: var(--font-jersey); font-weight: 400;
  font-size: clamp(40px, 5vw, 60px);
  line-height: 0.98; letter-spacing: -0.025em;
  margin: 0; color: var(--ink); text-wrap: balance;
}
.title-block .lede {
  margin-top: 16px; max-width: 70ch;
  font-size: 17px; line-height: 1.6; color: var(--ink-2);
}

/* ---- pills ---- */
.pill {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 5px 11px; border-radius: 999px;
  background: var(--paper-2);
  border: 1.5px solid var(--ink);
  font: 600 10px var(--font-mono);
  letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--ink);
}
.pill.dark { background: var(--ink); color: var(--paper); }
.pill.accent { background: var(--accent); color: #fff; border-color: var(--ink); }
.pill::before {
  content: ''; width: 7px; height: 7px; border-radius: 50%;
  background: var(--accent);
}
.pill.dark::before { background: var(--cta); }
.pill.accent::before { background: #fff; }

/* ---- section header ---- */
.sec-hd { display: grid; gap: 10px; margin-bottom: 24px; }
.sec-hd h2 {
  font-family: var(--font-jersey); font-weight: 400;
  font-size: clamp(26px, 3vw, 34px);
  line-height: 1.05; letter-spacing: -0.02em;
  margin: 0; color: var(--ink);
  display: flex; align-items: center; gap: 14px;
}
.sec-hd h2::before {
  content: ''; flex: none;
  width: 10px; height: 30px;
  background: var(--accent); border-radius: 2px;
}
.sec-hd .kicker {
  font: 600 10px var(--font-mono);
  letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--ink-3);
}

/* ---- exec stats ---- */
.exec-grid {
  display: grid; grid-template-columns: repeat(4, 1fr);
  gap: 0; border: 2px solid var(--ink);
  background: var(--paper-2); border-radius: 6px;
  margin: 8px 0 28px;
  break-inside: avoid;
}
.exec-grid > div {
  padding: 22px 22px;
  border-right: 1.5px solid var(--ink);
  display: grid; gap: 6px;
}
.exec-grid > div:last-child { border-right: 0; }
.exec-grid .num {
  font-family: var(--font-jersey); font-size: 38px; line-height: 1;
  letter-spacing: -0.02em; color: var(--ink);
}
.exec-grid .num.warn { color: var(--sev-critical); }
.exec-grid .label {
  font: 600 10px var(--font-mono);
  letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--ink-3);
}
.exec-grid .sub { font-size: 13px; color: var(--ink-2); line-height: 1.4; }

.exec-prose { font-size: 16px; line-height: 1.65; color: var(--ink-2); max-width: 75ch; }
.exec-prose strong { color: var(--ink); }

/* ---- rollup stacked bar ---- */
.rollup-bar {
  display: flex; height: 56px; border: 2px solid var(--ink);
  border-radius: 6px; overflow: hidden; margin: 8px 0 14px;
}
.rollup-bar > div {
  display: grid; place-items: center;
  font: 700 13px var(--font-display);
  color: #fff; padding: 0 8px;
  border-right: 1.5px solid var(--ink);
}
.rollup-bar > div:last-child { border-right: 0; }
.r-clean    { background: var(--accent-deep); }
.r-autofix  { background: var(--accent); }
.r-author   { background: var(--ink-3); }
.r-content  { background: var(--cta); color: #fff; }
.r-retire   { background: var(--ink); }

.rollup-legend {
  display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px;
  margin-bottom: 8px;
}
.rollup-legend .lg {
  display: grid; gap: 4px;
  font: 600 10px var(--font-mono);
  letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--ink-3);
}
.rollup-legend .lg .swatch {
  display: flex; align-items: center; gap: 8px;
  color: var(--ink); font-size: 13px;
  font-family: var(--font-display); font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
}
.rollup-legend .lg .swatch i {
  width: 12px; height: 12px; border: 1.5px solid var(--ink); border-radius: 2px;
  flex: none;
}

/* ---- scope card ---- */
.scope-grid {
  display: grid; grid-template-columns: 1.5fr 1fr; gap: 24px; margin-top: 4px;
}
.scope-card {
  background: var(--ink); color: var(--paper);
  border: 2px solid var(--ink); border-radius: 10px;
  padding: 28px 28px 26px;
  position: relative; overflow: hidden;
  break-inside: avoid;
}
.scope-card::before {
  content: ''; position: absolute; inset: 0;
  background-image: repeating-linear-gradient(
    -20deg,
    rgba(255,255,255,0.03) 0 8px,
    transparent 8px 22px
  );
  pointer-events: none;
}
.scope-card .label {
  font: 600 10px var(--font-mono);
  letter-spacing: 0.18em; text-transform: uppercase;
  color: rgba(255,255,255,0.55);
  margin-bottom: 10px;
}
.scope-card .hours {
  font-family: var(--font-jersey); font-size: 64px; line-height: 1;
  letter-spacing: -0.025em; color: #fff;
}
.scope-card .hours-sub {
  font: 600 11px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  color: rgba(255,255,255,0.7);
  margin-top: 6px;
}
.scope-card .recommend {
  margin-top: 22px; padding-top: 18px;
  border-top: 1px dashed rgba(255,255,255,0.25);
  font-size: 14px; line-height: 1.55; color: rgba(255,255,255,0.85);
}
.scope-card .recommend strong { color: #fff; }
.scope-breakdown {
  background: var(--paper-2);
  border: 2px solid var(--ink); border-radius: 10px;
  padding: 22px 24px;
}
.scope-breakdown table { width: 100%; border-collapse: collapse; }
.scope-breakdown th {
  padding: 9px 0 14px; text-align: left; border-bottom: 2px solid var(--ink);
  font: 600 10px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--ink-3);
}
.scope-breakdown th:last-child { text-align: right; }
.scope-breakdown td {
  padding: 9px 0;
  border-bottom: 1px dashed var(--rule);
  font-size: 14px;
}
.scope-breakdown tr:last-child td { border-bottom: 0; padding-top: 14px; }
.scope-breakdown tr:last-child td:first-child {
  font-family: var(--font-jersey); font-size: 14px; letter-spacing: 0.02em;
}
.scope-breakdown td:last-child {
  font: 600 14px var(--font-mono); text-align: right; color: var(--ink);
}
.scope-breakdown .cat {
  font: 600 10px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3);
  display: block; margin-bottom: 2px;
}
.scope-breakdown .desc { font-size: 13px; color: var(--ink-2); }

/* ---- top risks ---- */
.risk-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;
  margin-top: 4px;
}
.risk-card {
  background: var(--paper); border: 2px solid var(--ink);
  border-radius: 10px; overflow: hidden;
  box-shadow: 4px 4px 0 -1px var(--ink);
  display: grid; grid-template-rows: auto 1fr auto;
  break-inside: avoid;
}
.risk-card .ch {
  padding: 14px 18px;
  background: var(--sev-critical); color: #fff;
  border-bottom: 2px solid var(--ink);
  display: flex; justify-content: space-between; align-items: center;
}
.risk-card .ch .num {
  font-family: var(--font-jersey); font-size: 32px; line-height: 1; letter-spacing: -0.02em;
}
.risk-card .ch .tag {
  font: 600 9px var(--font-mono);
  letter-spacing: 0.18em; text-transform: uppercase;
  background: rgba(255,255,255,0.18); padding: 4px 8px; border-radius: 4px;
}
.risk-card .body { padding: 16px 18px 14px; display: grid; gap: 8px; }
.risk-card h3 {
  font-family: var(--font-display); font-weight: 700;
  font-size: 17px; line-height: 1.25; margin: 0;
  letter-spacing: -0.01em;
}
.risk-card p { margin: 0; font-size: 14px; color: var(--ink-2); line-height: 1.5; }
.risk-card .foot {
  padding: 12px 18px;
  background: var(--paper-2);
  border-top: 1px dashed var(--rule);
  font: 600 10px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--ink-3);
  display: flex; justify-content: space-between; gap: 10px;
}

/* ---- findings by severity ---- */
.sev-row {
  display: grid; grid-template-columns: 80px 1fr auto; gap: 18px;
  align-items: stretch;
  border: 2px solid var(--ink); border-radius: 8px;
  background: var(--paper);
  margin-bottom: 14px;
  overflow: hidden;
  break-inside: avoid;
}
.sev-row .badge {
  background: var(--sev-minor); color: #fff;
  display: grid; place-items: center;
  font-family: var(--font-jersey); font-size: 28px;
  letter-spacing: -0.02em;
  border-right: 2px solid var(--ink);
}
.sev-row.is-critical .badge { background: var(--sev-critical); }
.sev-row.is-serious  .badge { background: var(--sev-serious); color: var(--ink); }
.sev-row.is-moderate .badge { background: var(--sev-moderate); }
.sev-row.is-minor    .badge { background: var(--sev-minor); color: var(--ink); }
.sev-row .meat { padding: 16px 18px; display: grid; gap: 6px; }
.sev-row h3 {
  font-family: var(--font-display); font-weight: 700;
  font-size: 17px; margin: 0;
}
.sev-row .summary { font-size: 14px; color: var(--ink-2); line-height: 1.5; }
.sev-row .stat-block {
  display: grid; align-content: center; padding: 16px 22px;
  border-left: 1.5px solid var(--ink);
  background: var(--paper-2);
  text-align: right; min-width: 130px;
}
.sev-row .stat-block .num {
  font-family: var(--font-jersey); font-size: 26px;
  line-height: 1; color: var(--ink);
}
.sev-row .stat-block .lbl {
  font: 600 10px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--ink-3); margin-top: 4px;
}

.examples {
  margin: 16px 0 0; padding: 16px 18px;
  background: var(--paper-2);
  border: 1.5px solid var(--rule);
  border-radius: 6px;
}
.examples .ex-hd {
  font: 600 10px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--ink-3); margin-bottom: 10px;
}
.example {
  display: grid; grid-template-columns: auto 1fr auto; gap: 14px;
  padding: 10px 0; border-top: 1px dashed var(--rule);
  align-items: start;
}
.example:first-of-type { border-top: 0; padding-top: 4px; }
.example .ref {
  font: 700 10px var(--font-mono);
  letter-spacing: 0.06em; color: var(--accent-deep);
  background: var(--accent-soft); padding: 4px 8px; border-radius: 3px;
  border: 1px solid var(--accent);
  white-space: nowrap;
}
.example .body p { margin: 0; font-size: 14px; line-height: 1.5; }
.example .body p.where {
  margin-top: 4px; font: 500 12px var(--font-mono);
  color: var(--ink-3);
}
.example .triage {
  font: 600 10px var(--font-mono);
  letter-spacing: 0.12em; text-transform: uppercase;
  padding: 4px 9px; border-radius: 999px;
  border: 1.5px solid var(--ink); white-space: nowrap;
  align-self: start;
}
.triage.t-safe   { background: var(--sev-ok); color: #fff; }
.triage.t-author { background: var(--sev-moderate); color: #fff; }
.triage.t-content { background: var(--sev-serious); color: var(--ink); }
.triage.t-retire { background: var(--sev-minor); color: var(--ink); }
.triage.t-assist { background: var(--paper-2); color: var(--ink); border-color: var(--ink-3); }

/* ---- per-package detail ---- */
.pkg-card {
  background: var(--paper); border: 2px solid var(--ink);
  border-radius: 10px; overflow: hidden;
  margin-top: 14px;
  break-inside: avoid;
}
.pkg-head {
  display: grid; grid-template-columns: 1fr auto auto; gap: 16px;
  align-items: center;
  padding: 16px 22px;
  background: var(--paper-2); border-bottom: 1.5px solid var(--ink);
}
.pkg-head h3 {
  font-family: var(--font-display); font-weight: 700;
  font-size: 17px; margin: 0; letter-spacing: -0.005em;
}
.pkg-head .meta {
  font: 600 11px var(--font-mono);
  letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--ink-3);
}
.pkg-verdict {
  font: 700 11px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  padding: 6px 10px; border-radius: 999px;
  border: 1.5px solid var(--ink);
  background: var(--sev-moderate); color: #fff;
}
.pkg-body {
  padding: 18px 22px;
  display: grid; gap: 14px;
}
.pkg-body .row {
  display: grid; grid-template-columns: 70px 1fr auto;
  gap: 14px; align-items: start;
  padding-bottom: 12px;
  border-bottom: 1px dashed var(--rule);
}
.pkg-body .row:last-child { border-bottom: 0; padding-bottom: 0; }
.pkg-body .row .ref {
  font: 700 10px var(--font-mono);
  color: var(--accent-deep); background: var(--accent-soft);
  border: 1px solid var(--accent); border-radius: 3px;
  padding: 4px 6px; text-align: center;
}
.pkg-body .row p { margin: 0; font-size: 14px; line-height: 1.5; }
.pkg-body .row p.where {
  margin-top: 3px; font: 500 12px var(--font-mono); color: var(--ink-3);
}
.pkg-foot {
  padding: 14px 22px;
  background: var(--ink); color: var(--paper);
  display: grid; grid-template-columns: 1fr auto; gap: 14px;
  align-items: center;
}
.pkg-foot .est {
  font: 600 10px var(--font-mono);
  letter-spacing: 0.16em; text-transform: uppercase;
  color: rgba(255,255,255,0.7);
}
.pkg-foot .hours {
  font-family: var(--font-jersey); font-size: 22px;
  color: #fff; letter-spacing: -0.01em;
}
.pkg-foot .next {
  font: 500 13px var(--font-mono); color: rgba(255,255,255,0.85);
}

/* ---- 508 mapping table ---- */
.map-table {
  width: 100%; border-collapse: collapse; margin-top: 4px;
  border: 2px solid var(--ink); border-radius: 6px; overflow: hidden;
}
.map-table th, .map-table td {
  padding: 11px 14px; text-align: left; vertical-align: top;
  border-bottom: 1px dashed var(--rule);
  font-size: 14px;
}
.map-table th {
  background: var(--ink); color: var(--paper);
  font: 600 10px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  border-bottom: 2px solid var(--ink);
}
.map-table tr:last-child td { border-bottom: 0; }
.map-table td.ref {
  font: 700 12px var(--font-mono); color: var(--accent-deep);
  white-space: nowrap;
}
.map-table td.count {
  font-family: var(--font-jersey); font-size: 18px; color: var(--ink);
  text-align: right;
}
.map-table tr.row-clean td.count { color: var(--sev-ok); }
.map-table tr.row-bad td.count   { color: var(--sev-critical); }

/* ---- method note ---- */
.method-note {
  background: var(--paper-2);
  border: 1.5px solid var(--rule);
  border-radius: 8px;
  padding: 18px 22px;
  font-size: 14px; line-height: 1.6; color: var(--ink-2);
}
.method-note h4 {
  margin: 0 0 8px; font-family: var(--font-display); font-weight: 700;
  font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--ink);
}
.method-note ul { margin: 6px 0 0; padding-left: 20px; }
.method-note li { margin: 3px 0; }

/* ---- footer ---- */
footer.report-foot {
  margin-top: 56px; padding-top: 22px;
  border-top: 2px solid var(--ink);
  display: flex; justify-content: space-between; align-items: center;
  font: 600 10px var(--font-mono);
  letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--ink-3);
  flex-wrap: wrap; gap: 10px;
}

/* ---- print ---- */
@page { size: Letter; margin: 0.5in; }
@media print {
  body { background: #fff; }
  .page { padding: 24px 36px; max-width: none; }
  .scope-card, .risk-card, .sev-row, .pkg-card, .exec-grid { break-inside: avoid; }
}
@media (max-width: 880px) {
  .page { padding: 32px 22px; }
  .exec-grid { grid-template-columns: 1fr 1fr; }
  .exec-grid > div:nth-child(2) { border-right: 0; }
  .exec-grid > div:nth-child(1), .exec-grid > div:nth-child(2) { border-bottom: 1.5px solid var(--ink); }
  .scope-grid { grid-template-columns: 1fr; }
  .risk-grid { grid-template-columns: 1fr; }
  .rollup-legend { grid-template-columns: 1fr 1fr; }
  .cover { grid-template-columns: 1fr; gap: 14px; }
  .cover .doc-meta { text-align: left; }
}
</style>
</head>
<body>

<article class="page">

  <!-- COVER -->
  <header class="cover">
    <div class="brand-mark" aria-hidden="true">${brand.mark}</div>
    <div>
      <div class="brand-name">${brand.name}<span class="sub">${brand.tagline}</span></div>
    </div>
    <div class="doc-meta">
      <div>Engagement <strong>${engagementId}</strong></div>
      <div>Assessor <strong>${consultantName}</strong></div>
      <div>Issued <strong>${formatDate(new Date())}</strong></div>
      <div>Audit version <strong>${scorecard.version || 'OP 3.0'}</strong></div>
    </div>
  </header>

  <div class="title-block">
    <div class="pill-row">
      <span class="pill accent">Section 508</span>
      <span class="pill accent">${wcagVersion}</span>
      <span class="pill dark">Cornerstone Galaxy migration</span>
      <span class="pill">${packageCount > 1 ? 'Library scoping' : 'Package audit'}</span>
    </div>
    <h1>${displayClientName}<br>Library accessibility assessment</h1>
    <p class="lede">${packageCount > 1 ? `An audit of ${packagesAudited} SCORM packages` : 'Package accessibility assessment'} scoped against ${wcagVersion} and Section 508. This document accompanies the broader engagement assessment and feeds the remediation plan.</p>
  </div>

  <!-- SECTION 01: EXECUTIVE SUMMARY -->
  <hr class="rule solid">
  <section>
    <header class="sec-hd">
      <span class="kicker">01 — Executive summary</span>
      <h2>The headline</h2>
    </header>

    <div class="exec-grid">
      <div>
        <div class="num">${packagesAudited}</div>
        <div class="label">Packages audited</div>
        <div class="sub">${packageCount > 1 ? 'Mixed vintage; vendor and internal authorship.' : 'Single package audit.'}</div>
      </div>
      <div>
        <div class="num">${cleanCount}</div>
        <div class="label">Already conformant</div>
        <div class="sub">Pass at ${wcagVersion} with no remediation required.</div>
      </div>
      <div>
        <div class="num${criticalBlockers > 0 ? ' warn' : ''}">${criticalBlockers}</div>
        <div class="label">Critical blockers</div>
        <div class="sub">Failures that prevent regulated learners from completing required training.</div>
      </div>
      <div>
        <div class="num">~${Math.round(hoursTotal)}</div>
        <div class="label">Hours to remediate</div>
        <div class="sub">Senior consultant time, including QA re-audit and migration handoff.</div>
      </div>
    </div>

    <p class="exec-prose">The library is in <strong>${cleanCount === packagesAudited ? 'excellent condition' : criticalBlockers === 0 ? 'good condition' : 'moderate condition'}</strong> for conformance assessment. ${
      criticalBlockers === 0
        ? 'No critical accessibility blockers prevent learner completion.'
        : `${criticalBlockers} critical issue${criticalBlockers !== 1 ? 's' : ''} must be resolved before packages ship into production.`
    } Most packages can be brought to conformance with targeted author rework rather than ground-up rebuilds. Recommended engagement shape sits inside the standard monthly retainer range.</p>
  </section>

  <!-- SECTION 02: LIBRARY HEALTH ROLLUP -->
  <hr class="rule">
  <section>
    <header class="sec-hd">
      <span class="kicker">02 — Library health</span>
      <h2>Where the ${packagesAudited} package${packagesAudited !== 1 ? 's' : ''} sit${packagesAudited !== 1 ? '' : 's'}</h2>
    </header>

    <div class="rollup-legend" aria-hidden="true">
      <div class="lg"><span class="swatch"><i style="background:var(--accent-deep)"></i>Clean</span><span>${triageClean} package${triageClean !== 1 ? 's' : ''}</span></div>
      <div class="lg"><span class="swatch"><i style="background:var(--accent)"></i>Auto-fix safe</span><span>${triageAutoFixSafe} package${triageAutoFixSafe !== 1 ? 's' : ''}</span></div>
      <div class="lg"><span class="swatch"><i style="background:var(--ink-3)"></i>Author rework</span><span>${triageAuthor} package${triageAuthor !== 1 ? 's' : ''}</span></div>
      <div class="lg"><span class="swatch"><i style="background:var(--cta)"></i>Content rework</span><span>${triageContent} package${triageContent !== 1 ? 's' : ''}</span></div>
      <div class="lg"><span class="swatch"><i style="background:var(--ink)"></i>Recommend retire</span><span>${triageRetire} package${triageRetire !== 1 ? 's' : ''}</span></div>
    </div>
    <div class="rollup-bar" role="img" aria-label="Library health distribution: ${triageClean} clean, ${triageAutoFixSafe} auto-fix, ${triageAuthor} author rework, ${triageContent} content rework, ${triageRetire} retire">
      ${triageClean > 0 ? `<div class="r-clean"   style="flex: ${triageClean};">${triageClean}</div>` : ''}
      ${triageAutoFixSafe > 0 ? `<div class="r-autofix" style="flex: ${triageAutoFixSafe};">${triageAutoFixSafe}</div>` : ''}
      ${triageAuthor > 0 ? `<div class="r-author"  style="flex: ${triageAuthor};">${triageAuthor}</div>` : ''}
      ${triageContent > 0 ? `<div class="r-content" style="flex: ${triageContent};">${triageContent}</div>` : ''}
      ${triageRetire > 0 ? `<div class="r-retire"  style="flex: ${triageRetire};">${triageRetire}</div>` : ''}
    </div>
    <p class="exec-prose" style="margin-top: 18px;">The library shows a clear distribution across triage categories. ${triageClean > 0 ? `${triageClean} package${triageClean !== 1 ? 's' : ''} require${triageClean !== 1 ? '' : 's'} no remediation. ` : ''}${triageAutoFixSafe + triageAuthor > 0 ? `${triageAutoFixSafe + triageAuthor} package${triageAutoFixSafe + triageAuthor !== 1 ? 's' : ''} can be fixed without involving external vendors. ` : ''}${triageContent + triageRetire > 0 ? `${triageContent + triageRetire} package${triageContent + triageRetire !== 1 ? 's' : ''} require content investment or retirement consideration.` : ''}</p>
  </section>

  <!-- SECTION 03: SCOPE RECOMMENDATION -->
  <hr class="rule">
  <section>
    <header class="sec-hd">
      <span class="kicker">03 — Scope recommendation</span>
      <h2>What this costs in consultant hours</h2>
    </header>

    <div class="scope-grid">
      <div class="scope-card">
        <div class="label">Estimated effort</div>
        <div class="hours">${Math.round(hoursTotal)} hrs</div>
        <div class="hours-sub">Senior consultant, all-in</div>
        <div class="recommend">
          <strong>Recommended shape:</strong> engagement scaled to ${Math.round(hoursTotal) > 40 ? 'multi-month' : 'single-month'} remediation. Sequence critical blockers first; clear migration content gate before handoff. Fits inside the standard retainer range.
        </div>
      </div>

      <div class="scope-breakdown">
        <table>
          <tr>
            <th scope="col">Category</th>
            <th scope="col" style="text-align:right">Hours</th>
          </tr>
          <tr>
            <td>
              <span class="cat">Auto-fix safe tier</span>
              <span class="desc">${triageAutoFixSafe} package${triageAutoFixSafe !== 1 ? 's' : ''}, applied by audit tool with consultant review.</span>
            </td>
            <td>${Math.round(triageAutoFixSafe * 10 / 60 * 10) / 10} hrs</td>
          </tr>
          <tr>
            <td>
              <span class="cat">Author rework</span>
              <span class="desc">${triageAuthor} package${triageAuthor !== 1 ? 's' : ''}, ARIA labels, headings, alt text decisions.</span>
            </td>
            <td>${Math.round(triageAuthor * 60 / 60 * 10) / 10} hrs</td>
          </tr>
          <tr>
            <td>
              <span class="cat">Content rework</span>
              <span class="desc">${triageContent} package${triageContent !== 1 ? 's' : ''} with captioning, transcripts, or re-record.</span>
            </td>
            <td>${Math.round(triageContent * 240 / 60 * 10) / 10} hrs</td>
          </tr>
          <tr>
            <td>
              <span class="cat">QA re-audit</span>
              <span class="desc">Verification pass and conformance evidence.</span>
            </td>
            <td>${Math.round((totalViolations > 0 ? 6 : 2) * 10) / 10} hrs</td>
          </tr>
          <tr>
            <td>
              <span class="cat">Galaxy migration handoff</span>
              <span class="desc">Repackaging, identifier preservation, deployment notes.</span>
            </td>
            <td>${Math.round(4 * 10) / 10} hrs</td>
          </tr>
          <tr>
            <td>Total</td>
            <td>${Math.round(hoursTotal * 10) / 10} hrs</td>
          </tr>
        </table>
      </div>
    </div>
  </section>

  <!-- SECTION 04: TOP THREE RISKS -->
  <hr class="rule">
  <section>
    <header class="sec-hd">
      <span class="kicker">04 — Top three risks (promote to engagement assessment)</span>
      <h2>What to lead the conversation with</h2>
    </header>

    <div class="risk-grid">
      ${renderTopRisks(topRisks, criticalBlockers)}
    </div>
  </section>

  <!-- SECTION 05: FINDINGS BY SEVERITY -->
  <hr class="rule">
  <section>
    <header class="sec-hd">
      <span class="kicker">05 — Findings by severity</span>
      <h2>What's in the audit, ranked</h2>
    </header>

    ${renderFindingsBySeverity(bySeverity, violations)}
  </section>

  <!-- SECTION 06: PER-PACKAGE DETAIL -->
  <hr class="rule">
  <section>
    <header class="sec-hd">
      <span class="kicker">06 — Per-package detail</span>
      <h2>Package findings summary</h2>
    </header>

    <p style="font-size: 14px; color: var(--ink-2); max-width: 70ch;">
      Detailed breakdown of violations per package, organized by severity and triage category. This section is expanded in the full deliverable to show all non-conformant packages.
    </p>
  </section>

  <!-- SECTION 07: SECTION 508 MAPPING -->
  <hr class="rule">
  <section>
    <header class="sec-hd">
      <span class="kicker">07 — Section 508 mapping</span>
      <h2>Conformance evidence by 508 reference</h2>
    </header>

    <table class="map-table">
      <thead>
        <tr>
          <th>508 reference</th>
          <th>Description</th>
          <th>WCAG mapping</th>
          <th style="text-align:right">Findings</th>
        </tr>
      </thead>
      <tbody>
        ${renderSection508Map(section508Map)}
      </tbody>
    </table>
  </section>

  <!-- SECTION 08: METHOD & SCOPE -->
  <hr class="rule">
  <section>
    <header class="sec-hd">
      <span class="kicker">08 — Method &amp; scope</span>
      <h2>What was audited and how</h2>
    </header>

    <div class="method-note">
      <h3>What this audit covers</h3>
      <p>${packagesAudited} SCORM package${packagesAudited !== 1 ? 's' : ''} provided by ${displayClientName}. Each package was extracted and its HTML, CSS, and JavaScript assets analyzed against ${wcagVersion} and Section 508 (refresh, 2018). Dynamic checks were run via headless Chromium to capture screen-reader name/role/value and focus order.</p>

      <h3>What this audit does not cover</h3>
      <ul>
        <li>Cornerstone-side configuration: course catalog metadata, role permissions, and learner record layout are addressed in the broader engagement assessment.</li>
        <li>Learner-side hardware and assistive-technology compatibility beyond standard NVDA, JAWS, and VoiceOver name/role/value reporting.</li>
        <li>Translations and localization. Packages were authored in English; multilingual coverage is a separate workstream.</li>
        ${wcagVersion === 'WCAG 2.1 AA' ? '<li>WCAG 2.2 conformance. Assessment uses 2.1 AA per current standards practice; 2.2 available on request.</li>' : '<li>WCAG 2.1 backports. Assessment uses 2.2 AA per forward-looking guidance; 2.1 evaluation available on request.</li>'}
      </ul>

      <h3>How to read severities</h3>
      <ul>
        <li><strong>Critical</strong> — a class of learners cannot complete required training. Blocks conformance.</li>
        <li><strong>Serious</strong> — the experience is materially worse for an identifiable group; conformance is at risk.</li>
        <li><strong>Moderate</strong> — degrades use or assistive-tech compatibility; below the conformance line individually but cumulative.</li>
        <li><strong>Minor</strong> — polish; ships with the auto-fix tier and is included for completeness.</li>
      </ul>

      <h3>Triage tags</h3>
      <ul>
        <li><strong>Auto-fix safe</strong> — deterministic patch applied by the audit tool; consultant reviews the diff before deployment.</li>
        <li><strong>Auto-fix assisted</strong> — tool generates a candidate (alt text, label, etc.); consultant or content author confirms before deployment.</li>
        <li><strong>Author rework</strong> — change requires authoring-tool access or judgment a tool shouldn't make alone.</li>
        <li><strong>Content rework</strong> — net-new content (captions, transcripts, re-record) is required.</li>
        <li><strong>Recommend retire</strong> — remediation cost exceeds rebuild-in-Galaxy cost; flagged for the migration plan.</li>
      </ul>
    </div>
  </section>

  <footer class="report-foot">
    <span>Skill Loop · Engagement ${engagementId}</span>
    <span>Assessment report · accompanies the engagement assessment</span>
  </footer>

</article>

</body>
</html>`;

  return html;
}

/**
 * Default brand configuration
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
    'sev-minor': '#948a74',
    'sev-ok': '#1b7a3d',
  };
}

/**
 * Format date for display
 */
function formatDate(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()]} ${year}`;
}

/**
 * Render top risks section
 */
function renderTopRisks(risks, criticalCount) {
  if (!risks || risks.length === 0) {
    return `
      <div style="grid-column: 1 / -1; padding: 20px; background: var(--paper-2); border: 1.5px solid var(--rule); border-radius: 8px; color: var(--ink-2);">
        ${criticalCount === 0
          ? 'No critical-tier findings identified. Package meets accessibility conformance requirements.'
          : 'Top risks will be extracted based on critical finding patterns.'}
      </div>
    `;
  }

  return risks.slice(0, 3).map((risk, idx) => {
    const packageCount = risk.packageCount || 1;
    return `
      <article class="risk-card">
        <div class="ch">
          <span class="num">${String(idx + 1).padStart(2, '0')}</span>
          <span class="tag">${packageCount} package${packageCount !== 1 ? 's' : ''}</span>
        </div>
        <div class="body">
          <h3>${risk.title || 'Finding'}</h3>
          <p>${risk.description || 'Critical accessibility issue affecting user completion.'}</p>
        </div>
        <div class="foot">
          <span>${risk.section508 || '508 ref'}</span>
          <span>${risk.criterion || 'WCAG ref'}</span>
        </div>
      </article>
    `;
  }).join('');
}

/**
 * Render findings by severity section
 */
function renderFindingsBySeverity(bySeverity, violations) {
  const severities = [
    { key: 'critical', label: 'Critical — blocks conformance', badge: 'C', class: 'is-critical', summary: 'Failures that prevent a class of learners from completing required training.' },
    { key: 'serious', label: 'Serious — impairs use for an identifiable group', badge: 'S', class: 'is-serious', summary: 'Conformance failures that make the experience materially worse for a defined audience.' },
    { key: 'moderate', label: 'Moderate — degrades experience', badge: 'M', class: 'is-moderate', summary: 'Issues that degrade use or weaken assistive-tech compatibility.' },
    { key: 'minor', label: 'Minor — polish', badge: 'm', class: 'is-minor', summary: 'Small fixes shipped with the auto-fix tier; no conformance impact individually.' },
  ];

  return severities.map(sev => {
    const count = bySeverity[sev.key] || 0;
    if (count === 0) return '';

    return `
      <div class="sev-row ${sev.class}">
        <div class="badge">${sev.badge}</div>
        <div class="meat">
          <h3>${sev.label}</h3>
          <p class="summary">${sev.summary}</p>
        </div>
        <div class="stat-block">
          <div class="num">${count}</div>
          <div class="lbl">Finding${count !== 1 ? 's' : ''}</div>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Build Section 508 reference map from violations
 */
function buildSection508Map(violations) {
  const map = {};
  const section508Refs = [
    { ref: '501.1', desc: 'Operable without specialized input', wcag: ['2.1.1', '2.1.2', '2.4.3'], key: 'keyboard' },
    { ref: '501.5', desc: 'Captions for synchronized media', wcag: ['1.2.1', '1.2.2'], key: 'captions' },
    { ref: '502', desc: 'Interoperability with assistive tech', wcag: ['1.3.1', '1.4.1', '4.1.2'], key: 'aria' },
    { ref: '503', desc: 'Applications', wcag: ['2.4', '3.2', '3.3'], key: 'app' },
    { ref: '504.2', desc: 'Content authoring tools', wcag: [], key: 'tools' },
    { ref: '602.3', desc: 'Electronic support documentation', wcag: [], key: 'docs' },
  ];

  // Initialize counts
  section508Refs.forEach(r => {
    map[r.ref] = { desc: r.desc, wcag: r.wcag, count: 0 };
  });

  // Count violations by section508 reference
  violations.forEach(v => {
    const ref = v.section508;
    if (ref && map[ref]) {
      map[ref].count++;
    }
  });

  return { refs: section508Refs, counts: map };
}

/**
 * Render Section 508 mapping table
 */
function renderSection508Map(mapData) {
  const { refs, counts } = mapData;
  return refs.map(r => {
    const count = counts[r.ref]?.count || 0;
    const hasBadFindings = count > 0 && r.ref !== '504.2' && r.ref !== '602.3';
    const wcagStr = r.wcag && r.wcag.length > 0 ? r.wcag.join(', ') : 'N/A — out of scope';
    const countDisplay = r.ref === '504.2' || r.ref === '602.3' ? '—' : count;
    const rowClass = r.ref === '504.2' || r.ref === '602.3' ? 'row-clean' : (hasBadFindings ? 'row-bad' : '');

    return `
      <tr${rowClass ? ` class="${rowClass}"` : ''}>
        <td class="ref">${r.ref}</td>
        <td>${r.desc}</td>
        <td class="ref">${wcagStr}</td>
        <td class="count">${countDisplay}</td>
      </tr>
    `;
  }).join('');
}

module.exports = { renderHtml };
