const fs = require('fs').promises;
const path = require('path');
const { buildScorecard, serializeScorecard } = require('./json');
const { renderMarkdown } = require('./markdown');
const { renderText } = require('./text');
const { generateSarif } = require('./sarif');
const { loadChecks } = require('../lib/load-checks');
const { loadDynamicChecks } = require('../lib/load-dynamic-checks');

/**
 * Main writeReports function.
 *
 * Expected signature:
 * writeReports({ scorecard, violations, manualReview, options, dynamicReport, fixesApplied }): Promise<{ jsonPath?, mdPath?, jsonString? }>
 *
 * Behavior:
 * - When options.json === true: returns jsonString only (no file writes)
 * - Otherwise: writes files to options.output directory and returns paths
 *
 * @param {object} config - { scorecard, violations, manualReview, options, scos, dynamicReport, fixesApplied }
 * @returns {Promise<{ jsonPath?: string, mdPath?: string, jsonString?: string }>}
 */
async function writeReports(config) {
  const { violations, manualReview, options, scos, dynamicReport, fixesApplied } = config;

  const {
    json: jsonOnly = false,
    format = 'md',
    output = './open-pathways-report',
    standard = 'wcag22',
    packageType,
    packagePath,
    maxViolations,
    iframeWarnings = [],
  } = options;

  // Load static + dynamic checks; merge so dynamic-only criteria
  // (2.4.3, 3.2.4, 4.1.3) get proper names/URLs in the scorecard
  // instead of "Unknown".
  const [staticChecks, dynamicChecks] = await Promise.all([
    loadChecks(),
    loadDynamicChecks(),
  ]);
  const seen = new Set();
  const allChecks = [];
  for (const c of [...staticChecks, ...dynamicChecks]) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      allChecks.push(c);
    }
  }

  // Filter checks by standard
  const checksByStandard = allChecks.filter((check) => {
    if (standard === 'wcag21') {
      return check.wcagIntroduced === '2.0' || check.wcagIntroduced === '2.1';
    } else if (standard === 'wcag22') {
      return check.wcagIntroduced === '2.0' || check.wcagIntroduced === '2.1' || check.wcagIntroduced === '2.2';
    }
    return true;
  });

  // Build scorecard with enriched data.
  // dynamicCheckIds tells the scorecard which criteria require --simulate
  // so it can mark them "not evaluated" when the runner didn't run.
  const dynamicCheckIds = new Set(dynamicChecks.map((c) => c.id));
  const scorecard = buildScorecard({
    violations,
    manualReview,
    options: {
      standard,
      packageType,
      packagePath,
      maxViolations,
      iframeWarnings,
    },
    checks: checksByStandard,
    scos,
    dynamicReport,
    fixesApplied,
    dynamicCheckIds,
  });

  // Serialize to JSON
  const jsonString = serializeScorecard(scorecard);

  // If --json flag only: return jsonString and exit
  if (jsonOnly) {
    return { jsonString };
  }

  // Create output directory if needed
  await fs.mkdir(output, { recursive: true });

  // Write JSON file
  const jsonPath = path.join(output, 'results.json');
  await fs.writeFile(jsonPath, jsonString, 'utf8');

  // Render and write report file
  let reportPath;
  if (format === 'txt') {
    const textReport = renderText(scorecard);
    reportPath = path.join(output, 'report.txt');
    await fs.writeFile(reportPath, textReport, 'utf8');
  } else if (format === 'sarif') {
    const sarifReport = generateSarif({ scorecard, violations });
    reportPath = path.join(output, 'results.sarif');
    await fs.writeFile(reportPath, sarifReport, 'utf8');
  } else {
    // Default to markdown
    const mdReport = renderMarkdown(scorecard);
    reportPath = path.join(output, 'report.md');
    await fs.writeFile(reportPath, mdReport, 'utf8');
  }

  return {
    jsonPath,
    mdPath: format === 'txt' ? undefined : (format === 'sarif' ? undefined : reportPath),
    txtPath: format === 'txt' ? reportPath : undefined,
    sarifPath: format === 'sarif' ? reportPath : undefined,
    jsonString,
  };
}

module.exports = { writeReports };
