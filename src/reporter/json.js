const fs = require('fs');

/**
 * Build a scorecard object from violations and audit results.
 *
 * @param {object} config - { violations, manualReview, options, checks, scos, dynamicReport, fixesApplied }
 * @returns {object} Scorecard object matching the PRD JSON shape
 */
function buildScorecard({ violations, manualReview, options, checks, scos, dynamicReport, fixesApplied, dynamicCheckIds }) {
  const { standard = 'wcag22', packageType, packagePath, maxViolations, iframeWarnings = [], engagementId, clientName } = options;
  const dynIds = dynamicCheckIds instanceof Set ? dynamicCheckIds : new Set();
  const simulateRan = !!(dynamicReport && dynamicReport.skipped === false);
  // A dynamic criterion is "not evaluated" when --simulate didn't run successfully.
  const isNotEvaluated = (id) => dynIds.has(id) && !simulateRan;

  // Determine WCAG version string
  const wcagVersion = standard === 'wcag21' ? '2.1' : '2.2';

  // Build passed criteria set (criteria with zero violations)
  const violationsByCriterion = {};
  violations.forEach((v) => {
    if (!violationsByCriterion[v.criterion]) {
      violationsByCriterion[v.criterion] = [];
    }
    violationsByCriterion[v.criterion].push(v);
  });

  const passedSet = new Set();
  const failedSet = new Set();
  const notEvaluatedSet = new Set();

  checks.forEach((check) => {
    if (isNotEvaluated(check.id)) {
      notEvaluatedSet.add(check.id);
      return;
    }
    if (violationsByCriterion[check.id]) {
      failedSet.add(check.id);
    } else {
      passedSet.add(check.id);
    }
  });

  // Score denominator excludes not-evaluated criteria so users aren't
  // rewarded for skipping --simulate.
  const criteriaEvaluated = checks.length - notEvaluatedSet.size;
  const criteriaPassed = passedSet.size;
  const criteriaFailed = failedSet.size;

  // Calculate score: 100 * criteriaPassed / criteriaEvaluated
  let score = null;
  if (criteriaEvaluated > 0) {
    score = Math.round((100 * criteriaPassed / criteriaEvaluated) * 10) / 10; // 1 decimal place, as percentage
  }

  // Determine passed: false if violations exist OR if maxViolations threshold exceeded
  let passed = violations.length === 0;
  if (maxViolations !== null && maxViolations !== undefined) {
    passed = violations.length <= maxViolations;
  }

  // Count violations by severity
  const bySeverity = {
    critical: 0,
    serious: 0,
    moderate: 0,
    minor: 0,
  };
  violations.forEach((v) => {
    if (bySeverity[v.severity] !== undefined) {
      bySeverity[v.severity]++;
    }
  });

  // Count violations by confidence
  const byConfidence = {
    definitive: 0,
    heuristic: 0,
  };
  violations.forEach((v) => {
    const conf = v.confidence || 'definitive';
    if (byConfidence[conf] !== undefined) {
      byConfidence[conf]++;
    }
  });


  // Build criteria array (all evaluated criteria, including passes)
  const criteria = checks.map((check) => {
    const notEvaluated = notEvaluatedSet.has(check.id);
    return {
      id: check.id,
      name: check.name,
      level: check.level,
      wcagIntroduced: check.wcagIntroduced,
      url: check.url,
      // Mark dynamic criteria as 'dynamic' regardless of evaluation status,
      // so consumers can filter the criteria table.
      evaluationMode: dynIds.has(check.id) ? 'dynamic' : 'static',
      evaluated: !notEvaluated,
      passed: notEvaluated ? null : passedSet.has(check.id),
      violationCount: violationsByCriterion[check.id]
        ? violationsByCriterion[check.id].length
        : 0,
    };
  });

  // Sort criteria numerically (1.1.1, 1.1.2, 1.2.1, etc.)
  criteria.sort((a, b) => {
    const aParts = a.id.split('.').map(Number);
    const bParts = b.id.split('.').map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aN = aParts[i] || 0;
      const bN = bParts[i] || 0;
      if (aN !== bN) return aN - bN;
    }
    return 0;
  });

  // Build summary object
  const summary = {
    criteriaEvaluated,
    criteriaPassed,
    criteriaFailed,
    totalViolations: violations.length,
    bySeverity,
    byConfidence,
  };

  // Add maxViolationsApplied if threshold is set and active
  if (maxViolations !== null && maxViolations !== undefined) {
    summary.maxViolationsApplied = maxViolations;
  }

  // Sort violations by file path, then line number
  const sortedViolations = [...violations].sort((a, b) => {
    if (a.file !== b.file) {
      return a.file.localeCompare(b.file);
    }
    const lineA = a.line || 0;
    const lineB = b.line || 0;
    return lineA - lineB;
  });

  // Enrich violation objects with criterion name and level for the JSON
  const enrichedViolations = sortedViolations.map((v) => {
    const check = checks.find((c) => c.id === v.criterion);
    const enriched = {
      criterion: v.criterion,
      criterionName: check?.name || 'Unknown',
      level: check?.level || '',
      wcagIntroduced: check?.wcagIntroduced || '2.0',
      url: check?.url || '',
      file: v.file,
      line: v.line,
      column: v.column,
      snippet: v.snippet,
      message: v.message,
      severity: v.severity,
      confidence: v.confidence || 'definitive',
    };

    // Attach SCO if present
    if (v.sco) {
      enriched.sco = v.sco;
    }

    // v3.0 enrichments (per PRD §Acceptance criteria > Section 508 mapping):
    // every finding includes section508, triage, and effortMinutes when the
    // upstream pipeline has populated them. Defensive — when v2 callers run
    // without the v3 enrichment middlewares, these fields are simply absent.
    if (typeof v.section508 !== 'undefined') enriched.section508 = v.section508;
    if (typeof v.triage !== 'undefined') enriched.triage = v.triage;
    if (typeof v.effortMinutes !== 'undefined') enriched.effortMinutes = v.effortMinutes;
    if (typeof v.llmProvenance !== 'undefined') enriched.llmProvenance = v.llmProvenance;

    return enriched;
  });

  // An audit is "complete" only when the dynamic-check pass actually ran.
  // If Playwright/Chromium couldn't be set up, static checks still produce
  // results, but consumers (CI, dashboards) need to know the run is partial.
  const auditComplete = !!(dynamicReport && dynamicReport.skipped === false);
  const incompleteReason = auditComplete
    ? null
    : (dynamicReport && dynamicReport.reason) || 'dynamic checks did not run';

  // Build scorecard
  const scorecard = {
    tool: 'prism',
    version: require('../../package.json').version,
    wcagVersion,
    packageType,
    packagePath,
    scannedAt: new Date().toISOString(),
    complete: auditComplete,
    incompleteReason,
    passed,
    score,
    summary,
    criteria,
    violations: enrichedViolations,
    manualReviewRequired: manualReview,
    iframeWarnings,
  };

  // Add engagement metadata if present (v3 enrichment)
  if (engagementId) {
    scorecard.engagementId = engagementId;
  }
  if (clientName) {
    scorecard.clientName = clientName;
  }

  // Add SCOs if present
  if (scos && scos.length > 0) {
    scorecard.scos = scos;
  }

  // Add dynamic checks info if present
  if (dynamicReport) {
    scorecard.dynamicChecksRun = !dynamicReport.skipped;
    if (dynamicReport.skipped) {
      scorecard.dynamicCheckSkipReason = dynamicReport.reason;
    }
  }

  // Add fixes applied info if present
  if (fixesApplied) {
    scorecard.fixesApplied = {
      count: fixesApplied.count,
      dryRun: fixesApplied.dryRun,
    };
    if (fixesApplied.outputPath) {
      scorecard.fixesApplied.outputPath = fixesApplied.outputPath;
    }
    if (fixesApplied.bytes !== undefined) {
      scorecard.fixesApplied.bytes = fixesApplied.bytes;
    }
    if (fixesApplied.applied) {
      scorecard.fixesApplied.applied = fixesApplied.applied;
    }
  }

  return scorecard;
}

/**
 * Serialize a scorecard to JSON string (2-space indent).
 *
 * @param {object} scorecard
 * @returns {string} JSON string
 */
function serializeScorecard(scorecard) {
  return JSON.stringify(scorecard, null, 2);
}

module.exports = {
  buildScorecard,
  serializeScorecard,
};
