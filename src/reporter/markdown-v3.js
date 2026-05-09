/**
 * Render a v3 scorecard as a Markdown report string.
 * Mirrors the HTML report structure and section ordering.
 *
 * @param {object} scorecard - v3 scorecard with triage, scope, 508, topRisks enrichments
 * @param {object} options - options.engagementRedact: boolean
 * @returns {string} Markdown report
 */
function renderMarkdownV3(scorecard, options = {}) {
  const {
    wcagVersion,
    clientName,
    engagementId,
    passed,
    score,
    totalCriteria,
    passedCriteria,
    failedCriteria,
    totalViolations,
    complete,
    incompleteReason,
    violations,
    criteriaResults,
    scannedAt,
    tool,
    version,
    scos,
    dynamicReport,
    // v3 enrichments
    triage,
    scopeEstimate,
    topRisks,
    section508Table,
    library,
  } = scorecard;

  const engagementRedact = options.engagementRedact || false;
  const reportTitle = getReportTitle(clientName, engagementId, engagementRedact);
  const narrative = options.narrative || null;

  let md = '';

  // ==================== COVER / TITLE BLOCK ====================
  md += `# ${reportTitle} — Library Accessibility Assessment\n\n`;

  // Metadata block as simple key: value pairs (Word-friendly)
  md += `**Engagement ID:** ${engagementId}\n`;
  md += `**Date:** ${formatDate(scannedAt)}\n`;
  md += `**Standard:** WCAG ${wcagVersion} AA + Section 508\n`;
  if (scos && scos.length > 0) {
    md += `**Package Count:** ${scos.length}\n`;
  }
  md += `**Client Redacted:** ${engagementRedact ? 'Yes' : 'No'}\n`;
  md += `**Audit Tool:** ${tool} v${version}\n`;
  md += `**Dynamic Checks:** ${complete ? 'Ran' : `Incomplete (${incompleteReason || 'unknown reason'})`}\n\n`;

  // INCOMPLETE banner if needed
  if (complete === false) {
    md += `> ⚠️ **AUDIT INCOMPLETE** — Dynamic checks did not run. Static findings are below, but the package has not been fully audited. Resolve the issue and re-run before relying on this report.\n\n`;
  }

  // ==================== 01a ENGAGEMENT NARRATIVE (optional) ====================
  md += renderNarrativeMarkdown(narrative);

  // ==================== 01 EXECUTIVE SUMMARY ====================
  md += `## 01 — Executive summary\n\n`;

  // 4-stat block as table
  const execStats = buildExecStats(scorecard, scopeEstimate);
  md += execStats + '\n\n';

  // Exec prose paragraph
  const execProse = buildExecProse(scorecard, scopeEstimate);
  if (execProse) {
    md += execProse + '\n\n';
  }

  // ==================== 02 LIBRARY HEALTH ====================
  md += `## 02 — Library health\n\n`;
  const healthTable = buildLibraryHealthTable(triage);
  if (healthTable) {
    md += healthTable + '\n\n';
  } else {
    md += `— No triage data available.\n\n`;
  }

  // ==================== 03 SCOPE RECOMMENDATION ====================
  md += `## 03 — Scope recommendation\n\n`;
  if (scopeEstimate && scopeEstimate.totalHours !== undefined) {
    md += `**Estimated effort:** ${scopeEstimate.totalHours} hours (senior consultant, all-in)\n\n`;
    const scopeTable = buildScopeBreakdownTable(scopeEstimate);
    if (scopeTable) {
      md += scopeTable + '\n\n';
    }
    if (scopeEstimate.recommendation) {
      md += `${scopeEstimate.recommendation}\n\n`;
    }
  } else {
    md += `— No scope estimate available.\n\n`;
  }

  // ==================== 04 TOP THREE RISKS ====================
  md += `## 04 — Top three risks\n\n`;
  if (topRisks && topRisks.risks && topRisks.risks.length > 0) {
    if (topRisks.fallback === true) {
      md += `No critical-tier findings; the top serious-tier risks are listed below.\n\n`;
    }
    topRisks.risks.forEach((risk, idx) => {
      md += `### Risk ${idx + 1}: ${risk.title}\n\n`;
      md += `${risk.description}\n\n`;
      if (risk.section508) {
        md += `**Section 508 Reference:** ${risk.section508}\n`;
      }
      if (risk.wcagCriterion) {
        md += `**WCAG Criterion:** ${risk.wcagCriterion}\n`;
      }
      if (risk.packageCount !== undefined) {
        md += `**Affected packages:** ${risk.packageCount}\n`;
      }
      md += '\n';
    });
  } else {
    md += `— No critical or serious findings.\n\n`;
  }

  // ==================== 05 FINDINGS BY SEVERITY ====================
  md += `## 05 — Findings by severity\n\n`;
  const findingsBySev = buildFindingsBySeverity(violations, criteriaResults);
  if (findingsBySev) {
    md += findingsBySev + '\n';
  } else {
    md += `— No violations found.\n\n`;
  }

  // ==================== 06 PER-PACKAGE DETAIL ====================
  md += `## 06 — Per-package detail (appendix)\n\n`;
  const pkgDetail = buildPackageDetail(violations, scos, criteriaResults);
  if (pkgDetail) {
    md += pkgDetail + '\n';
  } else {
    md += `— No per-package findings.\n\n`;
  }

  // ==================== 07 SECTION 508 MAPPING ====================
  md += `## 07 — Section 508 mapping\n\n`;
  if (section508Table && section508Table.length > 0) {
    const s508Table = buildSection508Table(section508Table);
    md += s508Table + '\n\n';
  } else {
    md += `— No Section 508 data available.\n\n`;
  }

  // ==================== 08 METHOD AND SCOPE ====================
  md += `## 08 — Method and scope note\n\n`;
  const methodNote = buildMethodNote(scorecard);
  md += methodNote + '\n\n';

  // ==================== FOOTER ====================
  md += `---\n\n`;
  md += `Generated by ${tool} v${version}\n`;

  return md;
}

/**
 * Get the report title, applying redaction if requested.
 */
function getReportTitle(clientName, engagementId, redact) {
  if (redact && engagementId) {
    return engagementId;
  }
  return clientName || engagementId || 'Accessibility Assessment';
}

/**
 * Format a timestamp for display.
 */
function formatDate(timestamp) {
  if (!timestamp) return 'Unknown';
  const d = new Date(timestamp);
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/**
 * Build the 4-stat executive summary block as a GFM table.
 */
function buildExecStats(scorecard, scopeEstimate) {
  const { scos, totalViolations } = scorecard;
  const packageCount = scos && scos.length > 0 ? scos.length : 1;

  // Count conformant packages (no violations)
  const conformantCount = scos
    ? scos.filter(sco => {
        const scoViolations = scorecard.violations?.filter(v => v.sco?.id === sco.id) || [];
        return scoViolations.length === 0;
      }).length
    : 0;

  // Count critical findings
  const criticalCount = scorecard.violations?.filter(v => v.severity === 'critical')?.length || 0;

  // Hours from scope estimate
  const hoursEst = scopeEstimate?.totalHours ?? '—';

  let md = `| Metric | Count |\n`;
  md += `|--------|-------|\n`;
  md += `| Packages audited | ${packageCount} |\n`;
  md += `| Already conformant | ${conformantCount} |\n`;
  md += `| Critical blockers | ${criticalCount} |\n`;
  md += `| Hours to remediate | ${hoursEst} |\n`;

  return md;
}

/**
 * Build the executive prose paragraph.
 */
function buildExecProse(scorecard, scopeEstimate) {
  if (!scopeEstimate || !scopeEstimate.summary) {
    return '';
  }
  return scopeEstimate.summary;
}

/**
 * Build the library health table from triage rollup.
 */
function buildLibraryHealthTable(triage) {
  if (!triage || !triage.rollup || !Array.isArray(triage.rollup)) {
    return '';
  }

  const rollup = triage.rollup;
  if (rollup.length === 0) {
    return '';
  }

  let md = `| Triage Tag | Package Count | % of Library | Estimated Effort |\n`;
  md += `|-----------|---------------|------------|-------------------|\n`;

  rollup.forEach(row => {
    const pct = row.percentage !== undefined ? row.percentage.toFixed(1) + '%' : '—';
    const effort = row.effortHours !== undefined ? row.effortHours + ' hrs' : '—';
    md += `| ${row.tag} | ${row.packageCount} | ${pct} | ${effort} |\n`;
  });

  return md;
}

/**
 * Build the scope breakdown table.
 */
function buildScopeBreakdownTable(scopeEstimate) {
  if (!scopeEstimate.breakdown || !Array.isArray(scopeEstimate.breakdown)) {
    return '';
  }

  const breakdown = scopeEstimate.breakdown;
  if (breakdown.length === 0) {
    return '';
  }

  let md = `| Category | Hours |\n`;
  md += `|----------|-------|\n`;

  breakdown.forEach(row => {
    md += `| ${row.category} | ${row.hours} |\n`;
  });

  md += `| **Total** | **${scopeEstimate.totalHours}** |\n`;

  return md;
}

/**
 * Build findings by severity sections.
 */
function buildFindingsBySeverity(violations, criteriaResults) {
  if (!violations || violations.length === 0) {
    return '';
  }

  const severityOrder = ['critical', 'serious', 'moderate', 'minor'];
  let md = '';

  severityOrder.forEach(severity => {
    const sevViolations = violations.filter(v => v.severity === severity);
    if (sevViolations.length === 0) return;

    const severityTitle = severity.charAt(0).toUpperCase() + severity.slice(1);
    md += `### ${severityTitle} (${sevViolations.length} findings)\n\n`;

    // Group by criterion for readability
    const byCriterion = {};
    sevViolations.forEach(v => {
      if (!byCriterion[v.criterion]) {
        byCriterion[v.criterion] = [];
      }
      byCriterion[v.criterion].push(v);
    });

    // Render criterion groups as a table
    md += `| Criterion | File | Message | Triage | Effort |\n`;
    md += `|-----------|------|---------|--------|--------|\n`;

    Object.entries(byCriterion).forEach(([crit, vios]) => {
      vios.forEach((vio, idx) => {
        const triage = vio.triage || '—';
        const effort = vio.effortMinutes !== undefined ? vio.effortMinutes + ' min' : '—';
        const lineInfo = vio.line !== null && vio.line !== undefined ? `:${vio.line}` : '';
        md += `| ${crit} | ${vio.file}${lineInfo} | ${vio.message} | ${triage} | ${effort} |\n`;
      });
    });

    md += `\n`;
  });

  return md;
}

/**
 * Build per-package detail section.
 */
function buildPackageDetail(violations, scos, criteriaResults) {
  if (!scos || scos.length === 0 || !violations || violations.length === 0) {
    return '';
  }

  let md = '';

  // Group violations by SCO/package
  const bySco = {};
  violations.forEach(v => {
    const scoId = v.sco?.id || 'unattributed';
    if (!bySco[scoId]) {
      bySco[scoId] = {
        sco: v.sco || { id: 'unattributed', title: 'Unattributed' },
        violations: [],
      };
    }
    bySco[scoId].violations.push(v);
  });

  // Render each package
  Object.entries(bySco).forEach(([scoId, entry]) => {
    md += `### ${entry.sco.title}\n\n`;

    const pkgVios = entry.violations;
    const effortTotal = pkgVios.reduce((sum, v) => sum + (v.effortMinutes || 0), 0);

    md += `| Criterion | Severity | Message | Triage | Effort |\n`;
    md += `|-----------|----------|---------|--------|--------|\n`;

    pkgVios.forEach(v => {
      const sev = v.severity || '—';
      const triage = v.triage || '—';
      const effort = v.effortMinutes !== undefined ? v.effortMinutes + ' min' : '—';
      const lineInfo = v.line !== null && v.line !== undefined ? ` (${v.file}:${v.line})` : '';
      md += `| ${v.criterion} | ${sev} | ${v.message}${lineInfo} | ${triage} | ${effort} |\n`;
    });

    md += `\n**Estimated package effort:** ${effortTotal} minutes\n\n`;
  });

  return md;
}

/**
 * Build the Section 508 mapping table.
 */
function buildSection508Table(section508Table) {
  if (!Array.isArray(section508Table) || section508Table.length === 0) {
    return '';
  }

  let md = `| 508 Reference | Title | Finding Count | Mapped WCAG Criteria |\n`;
  md += `|----------|-------|---------------|----------------------|\n`;

  section508Table.forEach(row => {
    const ref = row.reference || '—';
    const title = row.title || '—';
    const count = row.findingCount !== undefined ? row.findingCount : '—';
    const wcag = row.wcagCriteria || '—';
    md += `| ${ref} | ${title} | ${count} | ${wcag} |\n`;
  });

  return md;
}

/**
 * Build the method and scope note section.
 */
function buildMethodNote(scorecard) {
  const { wcagVersion, tool, version, scannedAt, complete } = scorecard;

  let md = `**Standard audited:** WCAG ${wcagVersion} AA and Section 508 (2018).\n\n`;
  md += `**Dynamic checks:** ${complete ? 'Yes, ran via Playwright and headless Chromium' : 'No, did not run'}.\n\n`;
  md += `**Audit timestamp:** ${formatDate(scannedAt)}\n\n`;
  md += `**Tool version:** ${tool} v${version}\n\n`;
  md += `**Documentation:** See the project PRD at archive/workstreams/PRD_v3_SkillLoop_Scoping.md for detailed scope and methodology.\n`;

  return md;
}

/**
 * Render Section 01a — Engagement Narrative as Markdown.
 * Returns an empty string when narrative is absent or every section is null.
 */
function renderNarrativeMarkdown(narrative) {
  if (!narrative) return '';
  const hasExecutive = narrative.executive != null;
  const hasGuides = Array.isArray(narrative.remediationGuides) && narrative.remediationGuides.length > 0;
  const hasScopeMemo = narrative.scopeMemo != null;
  if (!hasExecutive && !hasGuides && !hasScopeMemo) return '';

  let md = `## 01a — Engagement narrative\n\n`;

  if (hasExecutive) {
    md += `### Executive narrative\n\n`;
    md += narrativePillMarkdown(narrative.executive.provenance);
    md += `${narrative.executive.text}\n\n`;
  }

  if (hasGuides) {
    md += `### Per-criterion remediation guidance\n\n`;
    for (const guide of narrative.remediationGuides) {
      md += `#### ${guide.criterion} ${guide.criterionName}\n\n`;
      md += narrativePillMarkdown(guide.provenance);
      md += `${guide.text}\n\n`;
    }
  }

  if (hasScopeMemo) {
    md += `### Recommended remediation order\n\n`;
    md += narrativePillMarkdown(narrative.scopeMemo.provenance);
    md += `${narrative.scopeMemo.text}\n\n`;
  }

  return md;
}

/**
 * Render a provenance pill as an italic Markdown line.
 */
function narrativePillMarkdown(provenance) {
  if (!provenance) return '';
  const model = provenance.model || '';
  const ts = (provenance.generatedAt || '').replace(/\.\d{3}Z$/, 'Z');
  return `_AI-drafted · ${model} · ${ts} · review before sharing_\n\n`;
}

module.exports = { renderMarkdownV3 };
