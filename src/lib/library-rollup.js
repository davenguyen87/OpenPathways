/**
 * Library-level rollup renderers (HTML and Markdown).
 *
 * Render the aggregated library report that shows package-level stats,
 * triage distribution, top risks, and recommended engagement shape.
 *
 * Both renderers follow the same structure and brand system as the per-package reports.
 */

/**
 * Render library rollup as HTML.
 *
 * @param {object} library - Aggregated library object from auditLibrary()
 * @param {object} options - { engagementId }
 * @returns {string} HTML content
 */
function renderLibraryRollupHtml(library, options = {}) {
  const { engagementId = 'Library', librarySynthesis = null } = options;

  // Brand variables (from V3_CONTRACT_NOTES.md §7)
  const colors = {
    paper: '#f3efe6',
    paperAlt: '#ebe5d6',
    ink: '#111633',
    rule: '#c8bfa8',
    accent: '#2f7d72',
    ctaOrange: '#f28619',
    okGreen: '#1b7a3d',
    critical: '#c46a14',
    serious: '#de8a2e',
    moderate: '#55597a',
    minor: '#948a74',
  };

  const fonts = {
    display: '"Space Grotesk", sans-serif',
    sans: '"Inter", sans-serif',
    mono: '"JetBrains Mono", monospace',
  };

  const { packageCount, cleanCount, triageDistribution, totalEffortHours, topRisks, recommendedEngagementShape } = library;

  // Compute percentages
  const cleanPct = packageCount > 0 ? Math.round((cleanCount / packageCount) * 100) : 0;

  // Build triage bar chart data
  const triageItems = [
    { label: 'Auto-fix safe', count: triageDistribution['auto-fix safe'], color: colors.okGreen },
    { label: 'Auto-fix assisted', count: triageDistribution['auto-fix assisted'], color: colors.accent },
    { label: 'Author rework', count: triageDistribution['author rework'], color: colors.moderate },
    { label: 'Content rework', count: triageDistribution['content rework'], color: colors.serious },
    { label: 'Recommend retire', count: triageDistribution['recommend retire'], color: colors.critical },
    { label: 'Clean', count: triageDistribution['clean'], color: colors.okGreen },
  ].filter((t) => t.count > 0);

  const totalTriageItems = triageItems.reduce((sum, t) => sum + t.count, 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Library Rollup Assessment - ${engagementId}</title>
  <style>
    :root {
      --paper: ${colors.paper};
      --paper-2: #ebe5d6;
      --paper-3: #e3dcc8;
      --ink: ${colors.ink};
      --ink-2: #2a3158;
      --ink-3: #55597a;
      --rule: ${colors.rule};
      --rule-2: #948a74;
      --accent: ${colors.accent};
      --accent-deep: #1d4f48;
      --accent-soft: rgba(47,125,114,0.14);
      --cta: ${colors.ctaOrange};
      --ok: ${colors.okGreen};
      --sev-critical: ${colors.critical};
      --sev-serious: ${colors.serious};
      --sev-moderate: ${colors.moderate};
      --sev-minor: ${colors.minor};
      --font-display: ${fonts.display};
      --font-sans: ${fonts.sans};
      --font-mono: ${fonts.mono};
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    html, body {
      background: var(--paper);
      color: var(--ink);
      font: 16px var(--font-sans);
      line-height: 1.5;
    }

    .container {
      max-width: 8.5in;
      margin: 0 auto;
      padding: 40px;
      background: white;
      color: var(--ink);
    }

    h1, h2, h3 {
      font-family: var(--font-display);
      font-weight: 700;
      line-height: 1.2;
      margin: 1.5em 0 0.5em;
      color: var(--ink);
    }

    h1 {
      font-size: 36px;
      margin-top: 0;
      border-bottom: 3px solid var(--accent);
      padding-bottom: 0.5em;
    }

    h2 {
      font-size: 24px;
      margin-top: 2em;
      page-break-after: avoid;
    }

    h3 {
      font-size: 18px;
    }

    p {
      margin: 0.5em 0;
      page-break-inside: avoid;
    }

    .cover {
      text-align: center;
      padding: 80px 40px;
      page-break-after: always;
    }

    .cover-title {
      font-size: 48px;
      font-family: var(--font-display);
      font-weight: 700;
      color: var(--ink);
      margin-bottom: 0.5em;
    }

    .cover-subtitle {
      font-size: 20px;
      color: var(--ink-3);
      margin-bottom: 2em;
    }

    .cover-meta {
      font-size: 14px;
      color: var(--ink-3);
      text-align: center;
    }

    .four-stat {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr 1fr;
      gap: 20px;
      margin: 2em 0;
      page-break-inside: avoid;
    }

    .stat-box {
      background: var(--paper);
      border: 1px solid var(--rule);
      padding: 20px;
      text-align: center;
      border-radius: 4px;
    }

    .stat-value {
      font-size: 32px;
      font-weight: 700;
      font-family: var(--font-display);
      color: var(--accent);
      margin: 0.3em 0;
    }

    .stat-label {
      font-size: 12px;
      color: var(--ink-3);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .rollup-bar {
      display: flex;
      height: 40px;
      border-radius: 4px;
      overflow: hidden;
      margin: 1em 0;
      page-break-inside: avoid;
      border: 1px solid var(--rule);
    }

    .rollup-segment {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 600;
      color: white;
      flex-basis: 0;
      flex-grow: 1;
    }

    .triage-legend {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin: 1em 0;
      font-size: 12px;
      page-break-inside: avoid;
    }

    .triage-legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .triage-color-dot {
      width: 12px;
      height: 12px;
      border-radius: 2px;
      flex-shrink: 0;
    }

    .risk-card {
      background: var(--paper);
      border-left: 4px solid var(--cta);
      padding: 16px;
      margin: 1em 0;
      page-break-inside: avoid;
      border-radius: 2px;
    }

    .risk-severity {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 600;
      margin-bottom: 0.5em;
    }

    .risk-criterion {
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--ink-3);
      margin-bottom: 0.5em;
    }

    .risk-message {
      font-size: 14px;
      line-height: 1.4;
      margin-bottom: 0.5em;
    }

    .risk-packages {
      font-size: 12px;
      color: var(--ink-3);
    }

    .engagement-recommendation {
      background: var(--accent-soft);
      border: 1px solid var(--accent);
      padding: 20px;
      border-radius: 4px;
      margin: 1.5em 0;
      page-break-inside: avoid;
    }

    .engagement-recommendation-label {
      font-size: 12px;
      text-transform: uppercase;
      color: var(--accent-deep);
      letter-spacing: 0.05em;
      margin-bottom: 0.5em;
      font-weight: 600;
    }

    .engagement-recommendation-text {
      font-size: 16px;
      color: var(--ink);
      line-height: 1.5;
    }

    .method-note {
      background: var(--paper-2);
      padding: 16px;
      border-radius: 4px;
      font-size: 12px;
      line-height: 1.6;
      color: var(--ink-3);
      margin: 2em 0;
      page-break-inside: avoid;
    }

    .ai-pill {
      display: inline-block;
      margin: 6px 0 12px;
      padding: 4px 10px;
      background: var(--paper-2);
      border: 1px solid var(--rule);
      border-radius: 4px;
      font-size: 10px;
      font-family: var(--font-mono);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--ink-3);
    }

    .synthesis-block {
      background: var(--paper);
      border: 1px solid var(--rule);
      border-radius: 6px;
      padding: 20px 24px;
      margin: 1.5em 0 2em;
      page-break-inside: avoid;
    }

    .synthesis-block h2 {
      margin-top: 0;
      font-size: 20px;
    }

    .synthesis-text {
      font-size: 15px;
      line-height: 1.65;
      color: var(--ink);
      white-space: pre-wrap;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1em 0;
      font-size: 13px;
      page-break-inside: avoid;
    }

    th, td {
      padding: 8px;
      text-align: left;
      border-bottom: 1px solid var(--rule);
    }

    th {
      background: var(--paper-2);
      font-weight: 600;
      font-family: var(--font-display);
    }

    tr:last-child td {
      border-bottom: none;
    }

    @media print {
      .container {
        max-width: 100%;
        padding: 0.5in;
      }
      h2 {
        page-break-before: avoid;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Cover -->
    <div class="cover">
      <div class="cover-title">Library Assessment</div>
      <div class="cover-subtitle">Batch WCAG 2.1 AA Audit Report</div>
      <div class="cover-meta">
        <p>Engagement: <strong>${engagementId}</strong></p>
        <p>Assessment Date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
      </div>
    </div>

    <!-- Library Synthesis (narrative) -->
    ${renderLibrarySynthesisHtml(librarySynthesis)}

    <!-- Executive Summary -->
    <h1>Executive Summary</h1>
    <p>This report summarizes the accessibility assessment of a library of ${packageCount} SCORM/AICC training packages audited for WCAG 2.1 AA compliance.</p>

    <div class="four-stat">
      <div class="stat-box">
        <div class="stat-label">Total Packages</div>
        <div class="stat-value">${packageCount}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Clean Packages</div>
        <div class="stat-value">${cleanCount}</div>
        <div style="font-size: 12px; color: var(--ink-3); margin-top: 0.3em;">${cleanPct}%</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Total Effort</div>
        <div class="stat-value">${totalEffortHours}h</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Engagement Shape</div>
        <div style="font-size: 13px; color: var(--ink); margin-top: 0.3em; font-weight: 500;">${recommendedEngagementShape.split(',')[0]}</div>
      </div>
    </div>

    <!-- Triage Distribution -->
    <h2>Triage Distribution Across Library</h2>
    <p>Finding severity and recommended triage action, aggregated across all packages:</p>

    <div class="rollup-bar">
      ${triageItems.map((item) => {
        const pct = totalTriageItems > 0 ? (item.count / totalTriageItems) * 100 : 0;
        return `<div class="rollup-segment" style="background: ${item.color}; flex-grow: ${pct || 0.1};">${item.count}</div>`;
      }).join('')}
    </div>

    <div class="triage-legend">
      ${triageItems.map((item) => `
        <div class="triage-legend-item">
          <div class="triage-color-dot" style="background: ${item.color};"></div>
          <span>${item.label} (${item.count})</span>
        </div>
      `).join('')}
    </div>

    <!-- Top Risks -->
    <h2>Top Risks Across Library</h2>
    <p>The three highest-impact findings aggregated across all packages, prioritized by severity and package affected count.</p>

    ${topRisks.length > 0
      ? topRisks.map((risk) => `
          <div class="risk-card">
            <div class="risk-severity" style="color: ${getSeverityColor(risk.severity)};">${risk.severity}</div>
            <div class="risk-criterion">WCAG ${risk.criterion}</div>
            <div class="risk-message">${risk.message || 'Finding'}</div>
            <div class="risk-packages">Affects ${risk.packageCount} package${risk.packageCount !== 1 ? 's' : ''}</div>
          </div>
        `).join('')
      : '<p style="color: var(--ok); font-weight: 600;">No critical-tier findings detected.</p>'}

    <!-- Engagement Recommendation -->
    <h2>Recommended Engagement Shape</h2>
    <div class="engagement-recommendation">
      <div class="engagement-recommendation-label">Scope Estimate</div>
      <div class="engagement-recommendation-text">${recommendedEngagementShape}</div>
    </div>

    <!-- Method and Scope -->
    <h2>Method and Scope</h2>
    <div class="method-note">
      <strong>Assessment Method:</strong> This library audit applies automated static analysis and dynamic accessibility checks (WCAG 2.1 Level AA) to all HTML, CSS, and JavaScript within each SCORM package. Violations are categorized by severity and triage action (auto-fix safe, auto-fix assisted, author rework, content rework, or recommend retire). Effort estimates are derived from per-finding categorization and reflect consultant labor, not tool runtime.
      <br><br>
      <strong>Batch Mode Scope:</strong> This assessment was conducted in batch mode across ${packageCount} packages in the library. Per-package details are available in separate per-package reports. This rollup aggregates triage distribution, effort, and risk across the library to inform engagement sequencing and resource planning.
      <br><br>
      <strong>Dynamic Checks:</strong> Playright-based dynamic checks (JavaScript execution, dynamic DOM, screen reader trees) were run on all packages to detect runtime accessibility failures beyond static HTML/CSS analysis.
      <br><br>
      <strong>Exclusions:</strong> This audit does not assess learner performance metrics, SCORM sequencing logic, or content pedagogical quality. External iframes and third-party embedded content are flagged for awareness but not scored as direct audit violations.
    </div>
  </div>
</body>
</html>`;
}

/**
 * Render library rollup as Markdown.
 *
 * @param {object} library - Aggregated library object from auditLibrary()
 * @param {object} options - { engagementId }
 * @returns {string} Markdown content
 */
function renderLibraryRollupMarkdown(library, options = {}) {
  const { engagementId = 'Library', librarySynthesis = null } = options;

  const { packageCount, cleanCount, triageDistribution, totalEffortHours, topRisks, recommendedEngagementShape } = library;

  const cleanPct = packageCount > 0 ? Math.round((cleanCount / packageCount) * 100) : 0;

  let markdown = `# Library Assessment Report

**Engagement:** ${engagementId}
**Assessment Date:** ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}

${renderLibrarySynthesisMarkdown(librarySynthesis)}## Executive Summary

This report summarizes the accessibility assessment of a library of **${packageCount}** SCORM/AICC training packages audited for WCAG 2.1 AA compliance.

### Key Metrics

| Metric | Value |
|--------|-------|
| **Total Packages** | ${packageCount} |
| **Clean Packages** | ${cleanCount} (${cleanPct}%) |
| **Total Effort Estimate** | ${totalEffortHours} hours |
| **Recommended Engagement Shape** | ${recommendedEngagementShape} |

## Triage Distribution Across Library

The following table shows the distribution of packages by their dominant triage category (the highest-priority finding category within each package):

| Category | Count |
|----------|-------|
| Auto-fix safe | ${triageDistribution['auto-fix safe']} |
| Auto-fix assisted | ${triageDistribution['auto-fix assisted']} |
| Author rework | ${triageDistribution['author rework']} |
| Content rework | ${triageDistribution['content rework']} |
| Recommend retire | ${triageDistribution['recommend retire']} |
| Clean | ${triageDistribution['clean']} |

## Top Risks Across Library

The following are the three highest-impact findings aggregated across all packages, prioritized by severity and package-affected count:

`;

  if (topRisks.length > 0) {
    topRisks.forEach((risk, i) => {
      markdown += `
### Risk ${i + 1}: WCAG ${risk.criterion}

**Severity:** ${risk.severity}
**Affected Packages:** ${risk.packageCount}

${risk.message || 'Finding detected in package(s).'}

`;
    });
  } else {
    markdown += `
No critical-tier findings were detected across the library.

`;
  }

  markdown += `
## Recommended Engagement Shape

\`\`\`
${recommendedEngagementShape}
\`\`\`

This estimate represents the total consultant labor required to address all findings at the package level, broken down by triage category. No pricing or resource markup is included.

## Method and Scope

### Assessment Method

This library audit applies automated static analysis and dynamic accessibility checks (WCAG 2.1 Level AA) to all HTML, CSS, and JavaScript within each SCORM package. Violations are categorized by severity and triage action:

- **Auto-fix safe:** Deterministic patch applied by the tool; consultant reviews the diff before deployment.
- **Auto-fix assisted:** Tool generates a candidate; consultant or author confirms.
- **Author rework:** Change requires authoring-tool access or judgment a tool shouldn't make alone.
- **Content rework:** Net-new content required (captions, transcripts, re-record).
- **Recommend retire:** Remediation cost exceeds rebuild-in-Galaxy cost; flagged for the migration plan.

Effort estimates are derived from per-finding categorization and reflect consultant labor, not tool runtime.

### Batch Mode Scope

This assessment was conducted in batch mode across ${packageCount} packages in the library. Per-package details are available in separate per-package reports. This rollup aggregates triage distribution, effort, and risk across the library to inform engagement sequencing and resource planning.

### Dynamic Checks

Playwright-based dynamic checks (JavaScript execution, dynamic DOM, screen reader trees) were run on all packages to detect runtime accessibility failures beyond static HTML/CSS analysis.

### Exclusions

This audit does not assess learner performance metrics, SCORM sequencing logic, or content pedagogical quality. External iframes and third-party embedded content are flagged for awareness but not scored as direct audit violations.

---

*Generated by Prism v3.0 — Skill Loop internal tool. For questions, contact the accessibility team.*
`;

  return markdown;
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render the library synthesis block as HTML.
 * Returns empty string when absent.
 */
function renderLibrarySynthesisHtml(librarySynthesis) {
  if (!librarySynthesis || !librarySynthesis.synthesis) return '';
  const { text, provenance } = librarySynthesis.synthesis;
  if (!text) return '';
  const model = escapeHtml((provenance && provenance.model) || '');
  const ts = escapeHtml(((provenance && provenance.generatedAt) || '').replace(/\.\d{3}Z$/, 'Z'));
  const pill = `<div class="ai-pill" role="note">AI-DRAFTED · ${model} · ${ts} · review before sharing</div>`;
  return `<div class="synthesis-block">
      <h2>Library Synthesis</h2>
      ${pill}
      <div class="synthesis-text">${escapeHtml(text)}</div>
    </div>`;
}

/**
 * Render the library synthesis block as Markdown.
 * Returns empty string when absent.
 */
function renderLibrarySynthesisMarkdown(librarySynthesis) {
  if (!librarySynthesis || !librarySynthesis.synthesis) return '';
  const { text, provenance } = librarySynthesis.synthesis;
  if (!text) return '';
  const model = (provenance && provenance.model) || '';
  const ts = ((provenance && provenance.generatedAt) || '').replace(/\.\d{3}Z$/, 'Z');
  let md = `## Library Synthesis\n\n`;
  md += `_AI-drafted · ${model} · ${ts} · review before sharing_\n\n`;
  md += `${text}\n\n`;
  return md;
}

/**
 * Map severity to display color.
 */
function getSeverityColor(severity) {
  const colorMap = {
    critical: '#c46a14',
    serious: '#de8a2e',
    moderate: '#55597a',
    minor: '#948a74',
  };
  return colorMap[severity] || '#111633';
}

module.exports = { renderLibraryRollupHtml, renderLibraryRollupMarkdown };
