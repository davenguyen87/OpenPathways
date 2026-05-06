const fs = require('fs').promises;
const path = require('path');
const { audit } = require('../index');
const { writeReports } = require('../reporter');
const { renderLibraryRollupHtml, renderLibraryRollupMarkdown } = require('./library-rollup');
const { rollupLibrary } = require('./scope-estimator');

/**
 * Audit a directory of SCORM/AICC packages and produce a library-level rollup.
 *
 * Iterates the directory for *.zip files (one level deep), calls audit() for each
 * sequentially (not in parallel — Playwright browser contention isn't worth the complexity
 * in v3.0), routes per-package output to engagements/<id>/<package-name>/, and aggregates
 * all results into a library summary.
 *
 * @param {string} directory - Path to directory containing *.zip files
 * @param {object} options - {
 *   engagementId: string (required),
 *   standard?: 'wcag21' | 'wcag22' (default 'wcag21'),
 *   packageType?: 'auto' | 'scorm12' | 'scorm2004' | 'aicc' | 'cmi5' | 'xapi',
 *   browser?: 'chromium' | 'firefox',
 *   timeoutDynamic?: number (milliseconds),
 *   fix?: boolean,
 *   fixDryRun?: boolean,
 *   onProgress?: function(event),
 *   signal?: AbortSignal,
 * }
 * @returns {Promise<{
 *   packages: [ { name, status, result, error? } ],
 *   library: { packageCount, cleanCount, triageDistribution, totalEffortMinutes, totalEffortHours, topRisks, recommendedEngagementShape },
 *   outputDir: string
 * }>}
 */
async function auditLibrary(directory, options = {}) {
  const {
    engagementId,
    standard = 'wcag21',
    packageType = 'auto',
    browser = 'chromium',
    timeoutDynamic = 30000,
    fix = false,
    fixDryRun = false,
    onProgress = null,
    signal = null,
  } = options;

  if (!engagementId) {
    throw new Error('auditLibrary requires options.engagementId');
  }

  // Discover all .zip files in directory (one level deep)
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const zipFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.zip'))
    .map((e) => path.join(directory, e.name))
    .sort();

  if (zipFiles.length === 0) {
    throw new Error(`No .zip files found in ${directory}`);
  }

  const baseEngagementDir = path.join(process.cwd(), 'engagements', engagementId);
  const packageResults = [];
  const packageRollups = []; // Collect per-package scope estimates for library rollup
  let totalEffortMinutes = 0;

  // Audit each package sequentially
  for (const zipPath of zipFiles) {
    const zipName = path.basename(zipPath);
    const packageName = zipName.replace(/\.zip$/i, '');

    let result = null;
    let error = null;
    let status = 'success';

    try {
      // Route this package's output to engagements/<id>/<package-name>/
      const packageOutputDir = path.join(baseEngagementDir, packageName);
      await fs.mkdir(packageOutputDir, { recursive: true });

      // Call the single-package audit
      result = await audit(zipPath, {
        packageType,
        standard,
        browser,
        timeoutDynamic,
        fix,
        fixDryRun,
        onProgress,
        signal,
      });

      // Store the per-package output directory on the result for the integration agent
      result.outputDir = packageOutputDir;

      // BUG FIX 1 & 2: Apply v3 enrichments to violations and compute scopeEstimate
      // BEFORE calling writeReports. These enrichments are needed for effort estimation.
      const { mapAllFindings } = require('../lib/section508');
      const { tagAllFindings } = require('../lib/triage');
      const { estimateAllEfforts, rollupPackage, loadCalibration } = require('../lib/scope-estimator');
      
      // Apply enrichments (mapAllFindings, tagAllFindings, estimateAllEfforts)
      mapAllFindings(result.violations);
      const context = {
        packageType: result.packageType || 'unknown',
        packageScale: result.violations.length,
      };
      tagAllFindings(result.violations, context);
      const calibration = loadCalibration(null);
      estimateAllEfforts(result.violations, calibration);
      
      // Compute scopeEstimate from enriched violations
      const scopeEstimate = rollupPackage(result.violations);
      packageRollups.push(scopeEstimate);
      totalEffortMinutes += scopeEstimate.totalMinutes || 0;

      // Call writeReports() to produce per-package deliverables
      // (will re-apply enrichments internally, which is idempotent)
      await writeReports({
        scorecard: result.scorecard,
        violations: result.violations,
        manualReview: result.manualReview,
        scos: result.scos,
        dynamicReport: result.dynamicReport,
        fixesApplied: result.fixesApplied,
        options: {
          json: false,
          format: 'md',
          output: packageOutputDir,
          standard,
          packageType: result.packageType,
          packagePath: zipPath,
          engagementId,
          engagementRedact: false, // TODO: pass from caller if needed
          brandConfigPath: null, // TODO: pass from caller if needed
        },
      });

      // BUG FIX 3: Set status to 'violations' if any violations exist
      // so CLI can filter by status and compute correct exit code
      if (result.scorecard.totalViolations > 0) {
        status = 'violations';
      } else {
        status = 'clean';
      }
    } catch (err) {
      status = 'error';
      error = err.message;
    }

    packageResults.push({
      name: packageName,
      zipPath,
      status,
      result,
      error,
    });
  }

  // Aggregate library-level metrics using rollupLibrary for proper math
  // instead of manually computing effort
  const libraryRollup = rollupLibrary(packageRollups);
  const library = aggregateLibrary(packageResults, libraryRollup.totalMinutes);

  // Render and write library rollup
  const htmlPath = path.join(baseEngagementDir, '_library-rollup.html');
  const mdPath = path.join(baseEngagementDir, '_library-rollup.md');

  const htmlContent = renderLibraryRollupHtml(library, { engagementId });
  const mdContent = renderLibraryRollupMarkdown(library, { engagementId });

  await fs.mkdir(baseEngagementDir, { recursive: true });
  await fs.writeFile(htmlPath, htmlContent, 'utf8');
  await fs.writeFile(mdPath, mdContent, 'utf8');

  return {
    packages: packageResults,
    library,
    outputDir: baseEngagementDir,
  };
}

/**
 * Aggregate library-level metrics from all package results.
 *
 * @param {array} packageResults - Results from auditLibrary iteration
 * @param {number} totalEffortMinutes - Sum of effort across all packages
 * @returns {object} Library aggregate with packageCount, cleanCount, triageDistribution, etc.
 */
function aggregateLibrary(packageResults, totalEffortMinutes) {
  const cleanPackages = [];
  const triageDistribution = {
    'auto-fix safe': 0,
    'auto-fix assisted': 0,
    'author rework': 0,
    'content rework': 0,
    'recommend retire': 0,
    'clean': 0,
  };

  const allRisks = [];

  for (const pkg of packageResults) {
    if (pkg.status === 'error' || !pkg.result) {
      continue;
    }

    const { scorecard, violations } = pkg.result;

    // Count clean packages
    if (scorecard && scorecard.passed) {
      cleanPackages.push(pkg.name);
      triageDistribution['clean']++;
    } else {
      // Compute the dominant triage tag for this package
      const triageTagCounts = {};
      for (const v of violations) {
        const tag = v.triage || 'author rework'; // default fallback
        triageTagCounts[tag] = (triageTagCounts[tag] || 0) + 1;
      }

      // Find the highest-tier tag by count
      let dominantTag = 'author rework';
      let maxCount = 0;
      const tierOrder = ['recommend retire', 'content rework', 'author rework', 'auto-fix assisted', 'auto-fix safe'];
      for (const tier of tierOrder) {
        if (triageTagCounts[tier] && triageTagCounts[tier] > maxCount) {
          dominantTag = tier;
          maxCount = triageTagCounts[tier];
        }
      }

      if (triageDistribution.hasOwnProperty(dominantTag)) {
        triageDistribution[dominantTag]++;
      }
    }

    // Collect top risks from this package
    if (scorecard && scorecard.topRisks && Array.isArray(scorecard.topRisks)) {
      for (const risk of scorecard.topRisks) {
        allRisks.push({
          ...risk,
          packageName: pkg.name,
        });
      }
    }
  }

  // Aggregate top three risks across library
  const topRisks = aggregateTopRisks(allRisks);

  // Compute recommended engagement shape from total hours
  const totalEffortHours = Math.round((totalEffortMinutes / 60) * 2) / 2; // round to nearest 0.5h
  const recommendedEngagementShape = computeEngagementShape(totalEffortHours);

  return {
    packageCount: packageResults.filter((p) => p.status === 'success').length,
    cleanCount: cleanPackages.length,
    triageDistribution,
    totalEffortMinutes,
    totalEffortHours,
    topRisks,
    recommendedEngagementShape,
  };
}

/**
 * Aggregate top three risks from all packages.
 * Priority: Critical severity → 508 reference urgency → number of packages affected.
 *
 * @param {array} allRisks - Flat list of risks from all packages, each with { severity, section508, packageName, ... }
 * @returns {array} Top three risks aggregated
 */
function aggregateTopRisks(allRisks) {
  if (allRisks.length === 0) {
    return [];
  }

  // Group by criterion + severity to aggregate package count
  const riskMap = new Map();
  for (const risk of allRisks) {
    const key = `${risk.criterion || 'unknown'}:${risk.severity || 'moderate'}`;
    if (!riskMap.has(key)) {
      riskMap.set(key, {
        ...risk,
        packageCount: 1,
        packageNames: [risk.packageName],
      });
    } else {
      const existing = riskMap.get(key);
      existing.packageCount++;
      if (!existing.packageNames.includes(risk.packageName)) {
        existing.packageNames.push(risk.packageName);
      }
    }
  }

  const aggregated = Array.from(riskMap.values());

  // Sort by severity (critical first), then by package count (descending)
  const severityOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  aggregated.sort((a, b) => {
    const aSev = severityOrder[a.severity] !== undefined ? severityOrder[a.severity] : 10;
    const bSev = severityOrder[b.severity] !== undefined ? severityOrder[b.severity] : 10;
    if (aSev !== bSev) return aSev - bSev;
    return b.packageCount - a.packageCount;
  });

  return aggregated.slice(0, 3);
}

/**
 * Compute the recommended engagement shape sentence from total hours.
 *
 * @param {number} totalHours - Total effort hours (may be fractional)
 * @returns {string} Sentence-only recommendation, no pricing
 */
function computeEngagementShape(totalHours) {
  if (totalHours < 30) {
    return `single-pass remediation, ~${Math.round(totalHours)} hours total`;
  } else if (totalHours < 80) {
    const perMonth = Math.round(totalHours / 2);
    return `two-month engagement, ~${perMonth} hours/month`;
  } else if (totalHours < 160) {
    const perMonth = Math.round(totalHours / 3);
    return `three-month engagement, ~${perMonth} hours/month`;
  } else if (totalHours < 300) {
    const perMonth = Math.round(totalHours / 4);
    return `quarterly engagement (Q1/Q2 phasing), ~${perMonth} hours/month`;
  } else {
    return `multi-quarter engagement; recommend prioritization workshop before kickoff`;
  }
}

module.exports = { auditLibrary };
