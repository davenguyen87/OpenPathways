const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs').promises;
const { extractZip } = require('./lib/extract');
const { parsePackage } = require('./parser');
const { loadFiles } = require('./lib/load-files');
const { buildAuditContext } = require('./lib/audit-context');
const { loadChecks } = require('./lib/load-checks');
const { getManualReview } = require('./lib/manual-review');

/**
 * Main audit orchestrator.
 * Extracts the ZIP, parses the manifest, loads checks, runs them, and returns results.
 *
 * @param {string} packagePath - Path to .zip file
 * @param {object} options - { packageType, standard, simulate, browser, timeoutDynamic, fix, fixDryRun, packagePath }
 * @returns {Promise<{ scorecard, violations, scos, manualReview, dynamicReport, fixesApplied }>}
 */
async function audit(packagePath, options = {}) {
  const {
    packageType = 'auto',
    standard = 'wcag22',
    simulate = false,
    browser = 'chromium',
    timeoutDynamic = 30000,
    fix = false,
    fixDryRun = false,
  } = options;

  // Create temp directory for extraction
  const tempRoot = path.join(os.tmpdir(), `scorm-a11y-${crypto.randomBytes(6).toString('hex')}`);
  let cleanupDone = false;

  const cleanup = async () => {
    if (!cleanupDone) {
      cleanupDone = true;
      try {
        await fs.rm(tempRoot, { recursive: true, force: true });
      } catch (err) {
        // Silent fail on cleanup
      }
    }
  };

  // Register cleanup handlers
  process.on('exit', () => {
    if (!cleanupDone) {
      try {
        require('child_process').execSync(`rm -rf "${tempRoot}"`);
      } catch (err) {
        // Ignore cleanup errors on exit
      }
    }
  });

  try {
    // Ensure temp directory exists
    await fs.mkdir(tempRoot, { recursive: true });

    // Extract the ZIP
    await extractZip(packagePath, tempRoot);

    // Parse the manifest
    // Expected signature: parsePackage(packageRoot): Promise<{ packageType, entryPoints, scos, manifest, errors? }>
    const parseResult = await parsePackage(tempRoot);
    if (parseResult.errors) {
      throw new Error(parseResult.errors[0] || 'Could not detect a valid SCORM, AICC, xAPI, or cmi5 manifest');
    }

    const { packageType: detectedType, entryPoints, scos, manifest } = parseResult;

    // Load all files from the package
    const files = await loadFiles(tempRoot);

    // Build the AuditContext for checks to consume
    const ctx = buildAuditContext({
      packageRoot: tempRoot,
      packageType: detectedType,
      manifest,
      entryPoints,
      scos,
      files,
    });

    // Load all checks from src/checks/
    const checks = await loadChecks();

    // Filter checks by WCAG standard
    const checksByStandard = checks.filter((check) => {
      if (standard === 'wcag21') {
        return check.wcagIntroduced === '2.0' || check.wcagIntroduced === '2.1';
      } else if (standard === 'wcag22') {
        return check.wcagIntroduced === '2.0' || check.wcagIntroduced === '2.1' || check.wcagIntroduced === '2.2';
      }
      return true;
    });

    // Run all checks
    const allViolations = [];
    for (const check of checksByStandard) {
      try {
        const violations = await check.run(ctx);
        if (Array.isArray(violations)) {
          allViolations.push(...violations);
        }
      } catch (err) {
        // Log check errors but don't crash
        console.error(`Check ${check.id} error: ${err.message}`);
      }
    }

    // Attach SCO metadata to violations
    allViolations.forEach((violation) => {
      violation.sco = findScoForFile(violation.file, scos);
    });

    // Phase 3: Dynamic checks (optional, behind --simulate)
    let dynamicReport = { violations: [], iframeWarnings: [], skipped: true, reason: 'not requested' };
    if (simulate) {
      const { runDynamicChecks } = require('./lib/run-dynamic-checks');
      try {
        dynamicReport = await runDynamicChecks(ctx, {
          browser: browser || 'chromium',
          timeout: timeoutDynamic || 30000,
          headless: true,
        });
        if (Array.isArray(dynamicReport.violations) && dynamicReport.violations.length) {
          // Attach SCO metadata to dynamic violations too
          dynamicReport.violations.forEach((v) => {
            v.sco = findScoForFile(v.file, scos);
          });
          allViolations.push(...dynamicReport.violations);
        }
      } catch (err) {
        console.error(`Dynamic checks error: ${err.message}`);
        dynamicReport = { violations: [], iframeWarnings: [], skipped: true, reason: err.message };
      }
    }

    // Build scorecard.
    // When --simulate ran, merge dynamic-check definitions so the criteria
    // denominator and per-criterion summary include 2.4.3, 3.2.4, 4.1.3.
    let scorecardChecks = checksByStandard;
    if (simulate && !dynamicReport.skipped) {
      const { loadDynamicChecks } = require('./lib/load-dynamic-checks');
      const dynChecks = await loadDynamicChecks();
      const filteredDyn = dynChecks.filter((check) => {
        if (standard === 'wcag21') return check.wcagIntroduced === '2.0' || check.wcagIntroduced === '2.1';
        if (standard === 'wcag22') return ['2.0', '2.1', '2.2'].includes(check.wcagIntroduced);
        return true;
      });
      const seenIds = new Set(checksByStandard.map((c) => c.id));
      scorecardChecks = [
        ...checksByStandard,
        ...filteredDyn.filter((c) => !seenIds.has(c.id)),
      ];
    }

    const passedCriteria = new Set(scorecardChecks.map((c) => c.id));
    allViolations.forEach((v) => {
      if (v.criterion) passedCriteria.delete(v.criterion);
    });

    const totalCriteria = scorecardChecks.length;
    const passed = passedCriteria.size;
    const score = totalCriteria > 0 ? Math.round((passed / totalCriteria) * 100) : 100;

    const scorecard = {
      wcagVersion: standard.toUpperCase(),
      passed: passed === totalCriteria,
      score,
      totalCriteria,
      passedCriteria: passed,
      failedCriteria: totalCriteria - passed,
      totalViolations: allViolations.length,
      criteriaResults: scorecardChecks.map((check) => ({
        id: check.id,
        name: check.name,
        level: check.level,
        wcagIntroduced: check.wcagIntroduced,
        url: check.url,
        passed: passedCriteria.has(check.id),
        violationCount: allViolations.filter((v) => v.criterion === check.id).length,
      })),
    };

    // Get manual review items
    const manualReview = getManualReview(standard);

    // Phase 3: Auto-fix (optional, behind --fix or --fix-dry-run)
    let fixesApplied = null;
    if (fix || fixDryRun) {
      const { applyFixes, writeFixedZip } = require('./lib/auto-fix');
      try {
        const fixResult = await applyFixes({
          violations: allViolations,
          files: files.html,
          options: { packageType: detectedType, dryRun: !!fixDryRun },
        });

        fixesApplied = {
          count: fixResult.applied.length,
          applied: fixResult.applied,
          skipped: fixResult.skipped.length,
          dryRun: !!fixDryRun,
          outputPath: null,
        };

        if (fix && fixResult.fixedFiles && fixResult.fixedFiles.size > 0) {
          const path = require('path');
          const inputPath = options.packagePath || packagePath;
          const parsed = path.parse(inputPath);
          const outputZipPath = path.join(parsed.dir || '.', `${parsed.name}.scorm-fixed${parsed.ext || '.zip'}`);
          const writeResult = await writeFixedZip({
            originalZipPath: inputPath,
            outputZipPath,
            fixedFiles: fixResult.fixedFiles,
          });
          fixesApplied.outputPath = writeResult.outputPath;
          fixesApplied.bytes = writeResult.bytes;
        }
      } catch (err) {
        console.error(`Auto-fix error: ${err.message}`);
        fixesApplied = { count: 0, error: err.message, dryRun: !!fixDryRun };
      }
    }

    await cleanup();

    return {
      packageType: detectedType,
      scorecard,
      violations: allViolations,
      scos,
      manualReview,
      dynamicReport: {
        skipped: dynamicReport.skipped,
        reason: dynamicReport.reason,
        iframeWarnings: dynamicReport.iframeWarnings,
        dynamicViolationsCount: (dynamicReport.violations || []).length,
      },
      fixesApplied,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/**
 * Find SCO for a violation file.
 * Match by exact path or folder prefix.
 *
 * @param {string} filePath - Package-relative path (e.g., "index.html" or "content/lesson.html")
 * @param {array} scos - Array of SCO objects
 * @returns {object|null} - SCO { id, title } or null
 */
function findScoForFile(filePath, scos) {
  if (!scos || scos.length === 0) return null;

  // Exact match first
  const exactMatch = scos.find((sco) => sco.entryFile === filePath);
  if (exactMatch) {
    return { id: exactMatch.id, title: exactMatch.title };
  }

  // Check if file is in same folder as SCO
  const fileDir = filePath.split('/').slice(0, -1).join('/');
  const scoInSameFolder = scos.find((sco) => {
    const scoDir = sco.entryFile.split('/').slice(0, -1).join('/');
    return scoDir === fileDir || scoDir === '' || fileDir === scoDir;
  });

  if (scoInSameFolder) {
    return { id: scoInSameFolder.id, title: scoInSameFolder.title };
  }

  return null;
}

module.exports = { audit };
