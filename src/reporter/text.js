/**
 * Render a scorecard as a plain-text report string (no markdown, no emojis).
 *
 * @param {object} scorecard - Scorecard object from buildScorecard
 * @returns {string} Plain text report
 */
function renderText(scorecard) {
  const {
    tool,
    version,
    packageType,
    packagePath,
    scannedAt,
    passed,
    score,
    summary,
    criteria,
    violations,
    manualReviewRequired,
    iframeWarnings,
  } = scorecard;

  let txt = '';

  // Title
  txt += `WCAG 2.2 AA COMPLIANCE REPORT\n`;
  txt += `${'='.repeat(50)}\n\n`;

  // Summary info
  const status = passed ? 'PASSED' : 'FAILED';
  txt += `Status:        ${status}\n`;
  txt += `Score:         ${score !== null ? score + '%' : 'N/A'}\n`;
  txt += `Package:       ${packagePath}\n`;
  txt += `Type:          ${packageType}\n`;
  txt += `Scanned at:    ${scannedAt}\n\n`;

  // Summary stats
  txt += `SUMMARY\n`;
  txt += `${'-'.repeat(50)}\n`;
  txt += `Criteria Evaluated:     ${summary.criteriaEvaluated}\n`;
  txt += `Criteria Passed:        ${summary.criteriaPassed}\n`;
  txt += `Criteria Failed:        ${summary.criteriaFailed}\n`;
  txt += `Total Violations:       ${summary.totalViolations}\n`;
  txt += `  - Critical:           ${summary.bySeverity.critical}\n`;
  txt += `  - Serious:            ${summary.bySeverity.serious}\n`;
  txt += `  - Moderate:           ${summary.bySeverity.moderate}\n`;
  txt += `  - Minor:              ${summary.bySeverity.minor}\n`;
  if (summary.byConfidence) {
    txt += `  - Definitive:         ${summary.byConfidence.definitive}\n`;
    txt += `  - Heuristic:          ${summary.byConfidence.heuristic}\n`;
  }

  if (summary.maxViolationsApplied !== undefined) {
    txt += `Max Violations Threshold: ${summary.maxViolationsApplied}\n`;
  }

  txt += `\n`;

  // Scorecard table
  txt += `WCAG 2.2 CRITERIA\n`;
  txt += `${'-'.repeat(50)}\n`;
  txt += `Criterion | Name                                | Level | Status | Violations\n`;
  txt += `${'-'.repeat(110)}\n`;

  criteria.forEach((crit) => {
    const status_cell = crit.passed ? 'Pass' : 'Fail';
    const violations_count = crit.violationCount || 0;
    // Simple fixed-width formatting
    const criterion_pad = crit.id.padEnd(10);
    const name_pad = (crit.name.substring(0, 35)).padEnd(36);
    const level_pad = crit.level.padEnd(6);
    const status_pad = status_cell.padEnd(7);
    txt += `${criterion_pad}| ${name_pad}| ${level_pad}| ${status_pad}| ${violations_count}\n`;
  });

  txt += `\n`;

  // Violations grouped by criterion
  if (violations.length > 0) {
    txt += `VIOLATIONS\n`;
    txt += `${'='.repeat(50)}\n\n`;

    // Group violations by criterion
    const groupedByC = {};
    violations.forEach((v) => {
      if (!groupedByC[v.criterion]) {
        groupedByC[v.criterion] = [];
      }
      groupedByC[v.criterion].push(v);
    });

    // Output in criterion order
    const criteriaIds = Array.from(
      new Set(violations.map((v) => v.criterion))
    ).sort((a, b) => {
      const aParts = a.split('.').map(Number);
      const bParts = b.split('.').map(Number);
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const aN = aParts[i] || 0;
        const bN = bParts[i] || 0;
        if (aN !== bN) return aN - bN;
      }
      return 0;
    });

    criteriaIds.forEach((critId) => {
      const crit = criteria.find((c) => c.id === critId);
      if (!crit) return;

      txt += `${crit.id} -- ${crit.name}\n`;
      txt += `View: ${crit.url}\n`;
      txt += `${'-'.repeat(70)}\n\n`;

      groupedByC[critId].forEach((v) => {
        const severity_label = v.severity.toUpperCase();
        txt += `  ${severity_label}\n`;
        txt += `    File: ${v.file}\n`;
        if (v.line !== null && v.line !== undefined) {
          txt += `    Line: ${v.line}\n`;
        }
        txt += `    Message: ${v.message}\n`;

        if (v.snippet) {
          txt += `\n    Snippet:\n`;
          const lines = v.snippet.split('\n');
          lines.forEach((line) => {
            txt += `        ${line}\n`;
          });
        }

        txt += `\n`;
      });
    });
  }

  // Iframe warnings
  if (iframeWarnings && iframeWarnings.length > 0) {
    txt += `EXTERNAL IFRAME WARNINGS\n`;
    txt += `${'='.repeat(50)}\n`;
    txt += `The following external iframes were detected. These cannot be audited automatically and require manual review.\n\n`;
    iframeWarnings.forEach((warning) => {
      txt += `  - ${warning.file} (line ${warning.line})\n`;
      txt += `    ${warning.iframeUrl}\n\n`;
    });
  }

  // Manual review checklist
  txt += `MANUAL REVIEW REQUIRED\n`;
  txt += `${'='.repeat(50)}\n`;
  txt += `The following criteria cannot be reliably evaluated by automated tools. You must test these manually:\n\n`;

  manualReviewRequired.forEach((item) => {
    txt += `${item.id} -- ${item.name}\n`;
    txt += `  Level: ${item.level}\n`;
    txt += `  Introduced in WCAG: ${item.wcagIntroduced}\n`;
    txt += `  View: ${item.url}\n\n`;
    txt += `  Guidance:\n`;
    const lines = item.guidance.split('\n');
    lines.forEach((line) => {
      txt += `    ${line}\n`;
    });
    txt += `\n`;
  });

  // Footer
  txt += `\n`;
  txt += `${'='.repeat(50)}\n`;
  txt += `Generated by ${tool} v${version}\n`;

  return txt;
}

module.exports = { renderText };
