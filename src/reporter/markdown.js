/**
 * Render a scorecard as a Markdown report string.
 *
 * @param {object} scorecard - Scorecard object from buildScorecard
 * @returns {string} Markdown report
 */
function renderMarkdown(scorecard) {
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
    scos,
    dynamicChecksRun,
    dynamicCheckSkipReason,
    fixesApplied,
  } = scorecard;

  let md = '';

  // Title + summary
  const badge = passed ? '✅ PASSED' : '❌ FAILED';
  md += `# WCAG 2.2 AA Compliance Report\n\n`;
  md += `**Status:** ${badge}\n`;
  md += `**Score:** ${score !== null ? score + '%' : 'N/A'}\n`;
  md += `**Package:** ${packagePath}\n`;
  md += `**Type:** ${packageType}\n`;
  md += `**Scanned at:** ${scannedAt}\n\n`;

  // Summary stats
  md += `## Summary\n\n`;
  md += `| Metric | Count |\n`;
  md += `|--------|-------|\n`;
  md += `| Criteria Evaluated | ${summary.criteriaEvaluated} |\n`;
  md += `| Criteria Passed | ${summary.criteriaPassed} |\n`;
  md += `| Criteria Failed | ${summary.criteriaFailed} |\n`;
  md += `| Total Violations | ${summary.totalViolations} |\n`;
  md += `| Critical | ${summary.bySeverity.critical} |\n`;
  md += `| Serious | ${summary.bySeverity.serious} |\n`;
  md += `| Moderate | ${summary.bySeverity.moderate} |\n`;
  md += `| Minor | ${summary.bySeverity.minor} |\n`;
  if (summary.byConfidence) {
    md += `| Definitive | ${summary.byConfidence.definitive} |\n`;
    md += `| Heuristic | ${summary.byConfidence.heuristic} |\n`;
  }

  if (summary.maxViolationsApplied !== undefined) {
    md += `| Max Violations Threshold | ${summary.maxViolationsApplied} |\n`;
  }

  md += `\n`;

  // Phase 3: Dynamic checks status (only render when --simulate was attempted)
  if (dynamicChecksRun === true || dynamicCheckSkipReason) {
    md += `## Dynamic Checks (Screen Reader Simulation)\n\n`;
    if (dynamicChecksRun === true) {
      md += `Status: **ran** — Playwright loaded each entry-point HTML and walked the Accessibility Tree. Findings for 2.4.3, 3.2.4, and 4.1.3 are included in the violations section above.\n\n`;
    } else {
      md += `Status: **skipped** — ${dynamicCheckSkipReason || 'unknown reason'}.\n\n`;
      if (dynamicCheckSkipReason && /playwright/i.test(dynamicCheckSkipReason)) {
        md += `To enable dynamic checks, install Playwright in the consuming project:\n\n`;
        md += `\`\`\`bash\nnpm install playwright\nnpx playwright install chromium\n\`\`\`\n\n`;
      }
    }
  }

  // Phase 3: Fixes applied (only render when --fix or --fix-dry-run was used)
  if (fixesApplied) {
    md += `## Fixes Applied\n\n`;
    md += `**Mode:** ${fixesApplied.dryRun ? 'dry run (no files written)' : 'applied'}\n`;
    md += `**Count:** ${fixesApplied.count}\n`;
    if (fixesApplied.skipped !== undefined) {
      md += `**Skipped:** ${fixesApplied.skipped}\n`;
    }
    if (fixesApplied.outputPath) {
      md += `**Output package:** \`${fixesApplied.outputPath}\``;
      if (fixesApplied.bytes) md += ` (${fixesApplied.bytes} bytes)`;
      md += `\n`;
    }
    md += `\n`;

    if (Array.isArray(fixesApplied.applied) && fixesApplied.applied.length > 0) {
      md += `| Fixer | File | Line | Criterion | Confidence |\n`;
      md += `|-------|------|------|-----------|------------|\n`;
      fixesApplied.applied.forEach((entry) => {
        const line = entry.line === null || entry.line === undefined ? '—' : entry.line;
        md += `| ${entry.fixerId} | ${entry.file} | ${line} | ${entry.criterion || '—'} | ${entry.confidence || '—'} |\n`;
      });
      md += `\n`;
    }
  }

  // Scorecard table
  md += `## WCAG 2.2 Criteria\n\n`;
  md += `| Criterion | Name | Level | Status | Violations |\n`;
  md += `|-----------|------|-------|--------|------------|\n`;

  criteria.forEach((crit) => {
    let status;
    if (crit.evaluated === false) {
      status = '⏭️ Not evaluated (run with --simulate)';
    } else if (crit.passed) {
      status = '✅ Pass';
    } else {
      status = '❌ Fail';
    }
    const violations_count = crit.violationCount || 0;
    md += `| ${crit.id} | ${crit.name} | ${crit.level} | ${status} | ${violations_count} |\n`;
  });

  md += `\n`;

  // Violations section
  if (violations.length > 0) {
    md += `## Violations\n\n`;

    // Determine if we should group by SCO
    const shouldGroupBySco = scos && scos.length > 1;

    if (shouldGroupBySco) {
      // Group violations by SCO
      const byScoDef = {};
      const unattributed = [];

      violations.forEach((v) => {
        if (v.sco && v.sco.id) {
          if (!byScoDef[v.sco.id]) {
            byScoDef[v.sco.id] = {
              sco: v.sco,
              violations: [],
            };
          }
          byScoDef[v.sco.id].violations.push(v);
        } else {
          unattributed.push(v);
        }
      });

      // Render each SCO section
      Object.values(byScoDef).forEach((scoEntry) => {
        md += `## SCO: ${scoEntry.sco.title}\n\n`;
        md += renderViolationsByCriterion(scoEntry.violations, criteria);
      });

      // Render unattributed violations
      if (unattributed.length > 0) {
        md += `## Unattributed\n\n`;
        md += renderViolationsByCriterion(unattributed, criteria);
      }
    } else {
      // Single SCO or no SCOs: use flat layout
      md += renderViolationsByCriterion(violations, criteria);
    }
  }

  // Iframe warnings
  if (iframeWarnings && iframeWarnings.length > 0) {
    md += `## External iFrame Warnings\n\n`;
    md += `The following external iframes were detected. These cannot be audited automatically and require manual review.\n\n`;
    iframeWarnings.forEach((warning) => {
      md += `- **${warning.file}** (line ${warning.line}): ${warning.iframeUrl}\n`;
    });
    md += `\n`;
  }

  // Manual review checklist (always include, per PRD)
  md += `## Manual Review Required\n\n`;
  md += `The following criteria cannot be reliably evaluated by automated tools. You must test these manually:\n\n`;

  manualReviewRequired.forEach((item) => {
    md += `### ${item.id} — ${item.name}\n\n`;
    md += `**Level:** ${item.level}\n`;
    md += `**Introduced in WCAG:** ${item.wcagIntroduced}\n`;
    md += `[View WCAG Understanding](${item.url})\n\n`;
    md += `**Guidance:** ${item.guidance}\n\n`;
  });

  // Footer
  md += `---\n\n`;
  md += `Generated by ${tool} v${version}\n`;

  return md;
}

/**
 * Render violations grouped by criterion.
 *
 * @param {array} violations - Violation objects
 * @param {array} criteria - Criteria definitions
 * @returns {string} Markdown snippet
 */
function renderViolationsByCriterion(violations, criteria) {
  let md = '';

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

    const viosByConfidence = {
      definitive: groupedByC[critId].filter(v => (v.confidence || 'definitive') === 'definitive'),
      heuristic: groupedByC[critId].filter(v => (v.confidence || 'definitive') === 'heuristic'),
    };

    const hasHeuristic = viosByConfidence.heuristic.length > 0;
    const heading = hasHeuristic ? `### ${crit.id} — ${crit.name} (heuristic)` : `### ${crit.id} — ${crit.name}`;
    md += `${heading}\n\n`;
    md += `[View WCAG Understanding](${crit.url})\n\n`;

    // Render definitive findings first
    viosByConfidence.definitive.forEach((v) => {
      let emoji = '🔵';
      if (v.severity === 'critical') emoji = '🔴';
      else if (v.severity === 'serious') emoji = '🟠';
      else if (v.severity === 'moderate') emoji = '🟡';

      md += `#### ${emoji} ${v.severity.toUpperCase()}\n\n`;
      md += `**File:** ${v.file}\n`;
      if (v.line !== null && v.line !== undefined) {
        md += `**Line:** ${v.line}\n`;
      }
      md += `**Message:** ${v.message}\n\n`;

      if (v.snippet) {
        md += `\`\`\`html\n${v.snippet}\n\`\`\`\n\n`;
      }
    });

    // Render heuristic findings in a separate subsection
    if (viosByConfidence.heuristic.length > 0) {
      md += `#### 🔍 Heuristic findings — please verify manually\n\n`;
      viosByConfidence.heuristic.forEach((v) => {
        let emoji = '🔵';
        if (v.severity === 'critical') emoji = '🔴';
        else if (v.severity === 'serious') emoji = '🟠';
        else if (v.severity === 'moderate') emoji = '🟡';

        md += `**${emoji} ${v.severity.toUpperCase()}** — ${v.file}`;
        if (v.line !== null && v.line !== undefined) {
          md += ` (line ${v.line})`;
        }
        md += `\n\n`;
        md += `${v.message}\n\n`;

        if (v.snippet) {
          md += `\`\`\`html\n${v.snippet}\n\`\`\`\n\n`;
        }
      });
    }
  });

  return md;
}

module.exports = { renderMarkdown };
