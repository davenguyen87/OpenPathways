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

// Module-level temp-dir tracking + a single process.on('exit') handler.
//
// Phase 6 fix: previously audit() registered a fresh process.on('exit')
// listener on every call. After ~10 calls Node logged a
// MaxListenersExceededWarning, and after thousands the process slowed
// noticeably. Now we keep one Set of active temp roots and one exit
// handler; per-call cleanup is the responsibility of the audit() try/finally.
// The exit handler is a last-resort net for crashes/SIGKILL.
const ACTIVE_TEMP_ROOTS = new Set();
let _exitHandlerRegistered = false;
function ensureExitHandler() {
  if (_exitHandlerRegistered) return;
  _exitHandlerRegistered = true;
  process.on('exit', () => {
    if (ACTIVE_TEMP_ROOTS.size === 0) return;
    // Synchronous cleanup — process.on('exit') doesn't await async work.
    for (const root of ACTIVE_TEMP_ROOTS) {
      try {
        require('child_process').execSync(`rm -rf "${root}"`);
      } catch (_) {
        // Ignore — cleanup is best-effort during shutdown.
      }
    }
    ACTIVE_TEMP_ROOTS.clear();
  });
}

/**
 * Throw an AbortError-shaped error. Matches the DOM/Web-Streams convention
 * (err.name === 'AbortError') so callers can branch on it idiomatically.
 */
function makeAbortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Throw if the given AbortSignal has fired. No-op when signal is null.
 */
function throwIfAborted(signal) {
  if (signal && signal.aborted) throw makeAbortError();
}

/**
 * Main audit orchestrator.
 * Extracts the ZIP, parses the manifest, loads checks, runs them, and returns results.
 *
 * Dynamic checks run on every audit. If Playwright/Chromium can't be set up
 * (offline, locked-down CI), static checks still complete but the audit is
 * marked INCOMPLETE — see dynamicReport.skipped + reason.
 *
 * Optional progress hook
 * ----------------------
 * Pass `options.onProgress(event)` to observe pipeline progress. The CLI does
 * not set this; it is consumed by the web UI (web/server) to drive an SSE
 * stream. The hook is best-effort: any throw is caught and logged so a
 * misbehaving callback can never crash an audit.
 *
 * Event shape (always present): { stage, ts }
 *   stage: 'extracting'           — before zip extraction
 *          'static-checks-start'  — { count }            checks about to run
 *          'static-check'         — { id, name, index, total } per check
 *          'dynamic-checks-start' — Playwright phase begins
 *          'dynamic-page'         — { path, index, total } per entry-point load
 *          'dynamic-check'        — { id, name, index, total } per dynamic check
 *          'dynamic-checks-done'  — { skipped, reason, violationCount }
 *          'done'                 — { violationCount, score }
 *
 * Cancellation contract (Phase 6)
 * -------------------------------
 * Pass `options.signal` (an AbortSignal) to make audit() cancellable. When
 * the signal fires, audit() rejects with an Error whose `name` is
 * 'AbortError'. The pipeline checks the signal at three coarse-grained
 * checkpoints (after extraction, between every static check, and after
 * dynamic checks) and threads the signal into runDynamicChecks, which
 * additionally closes the Playwright browser early so any in-flight
 * page.goto() or browser context unblocks within ~1 second. Cooperative —
 * a signal that fires while a single static check is mid-execution is
 * picked up at the next inter-check boundary, not preemptively.
 *
 * The CLI does not set signal; it's consumed by the web/cloud servers to
 * implement real cancellation (replacing /web's prior best-effort path).
 *
 * @param {string} packagePath - Path to .zip file
 * @param {object} options - { packageType, standard, browser, timeoutDynamic, fix, fixDryRun, packagePath, jsonOnly, onProgress, signal }
 * @returns {Promise<{ scorecard, violations, scos, manualReview, dynamicReport, fixesApplied }>}
 */
async function audit(packagePath, options = {}) {
  const {
    packageType = 'auto',
    standard = 'wcag22',
    browser = 'chromium',
    timeoutDynamic = 30000,
    fix = false,
    fixDryRun = false,
    jsonOnly = false,
    onProgress = null,
    signal = null,
  } = options;

  // Best-effort progress emitter. Never throws; never blocks (sync only).
  const emit = typeof onProgress === 'function'
    ? (stage, details) => {
        try {
          onProgress({ stage, ts: Date.now(), ...(details || {}) });
        } catch (err) {
          // Silent — a bad subscriber must not break the audit.
        }
      }
    : () => {};

  // Create temp directory for extraction
  const tempRoot = path.join(os.tmpdir(), `scorm-a11y-${crypto.randomBytes(6).toString('hex')}`);
  let cleanupDone = false;

  // Track this temp root in the module-level set. The single exit handler
  // (registered once below) sweeps any roots that survive a crash. Per-call
  // cleanup is handled by the try/finally — we remove from the set there.
  ensureExitHandler();
  ACTIVE_TEMP_ROOTS.add(tempRoot);

  const cleanup = async () => {
    if (!cleanupDone) {
      cleanupDone = true;
      ACTIVE_TEMP_ROOTS.delete(tempRoot);
      try {
        await fs.rm(tempRoot, { recursive: true, force: true });
      } catch (err) {
        // Silent fail on cleanup
      }
    }
  };

  try {
    // If the caller's signal fires before we even start, fail fast.
    throwIfAborted(signal);

    // Ensure temp directory exists
    await fs.mkdir(tempRoot, { recursive: true });

    // Extract the ZIP
    emit('extracting');
    await extractZip(packagePath, tempRoot);
    throwIfAborted(signal);

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
    emit('static-checks-start', { count: checksByStandard.length });
    const allViolations = [];
    for (let i = 0; i < checksByStandard.length; i++) {
      // Cancel boundary — at most one check runs after a fired signal.
      throwIfAborted(signal);
      const check = checksByStandard[i];
      emit('static-check', {
        id: check.id,
        name: check.name,
        index: i + 1,
        total: checksByStandard.length,
      });
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
    throwIfAborted(signal);

    // Attach SCO metadata to violations
    allViolations.forEach((violation) => {
      violation.sco = findScoForFile(violation.file, scos);
    });

    // Phase 3: Dynamic checks (mandatory). If Playwright can't be set up,
    // we mark the audit INCOMPLETE rather than silently skipping.
    emit('dynamic-checks-start');
    let dynamicReport = { violations: [], iframeWarnings: [], skipped: true, reason: 'not run' };

    const { ensurePlaywright } = require('./lib/ensure-playwright');
    // In JSON-only mode the auto-install banner would corrupt stdout, so suppress it.
    const log = jsonOnly ? () => {} : (msg) => console.error(msg);
    const ensured = ensurePlaywright({ autoInstall: true, log });

    if (!ensured.ok) {
      dynamicReport = {
        violations: [],
        iframeWarnings: [],
        skipped: true,
        reason: ensured.reason,
      };
    } else {
      const { runDynamicChecks } = require('./lib/run-dynamic-checks');
      try {
        dynamicReport = await runDynamicChecks(ctx, {
          browser: browser || 'chromium',
          timeout: timeoutDynamic || 30000,
          headless: true,
          // Pass-through so SSE subscribers see per-page and per-check
          // events from the Playwright phase too. CLI never sets onProgress.
          onProgress: typeof onProgress === 'function' ? onProgress : null,
          // Phase 6 cancellation: lets the dynamic runner abort page.goto
          // and close the browser early when the caller's signal fires.
          signal,
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

    emit('dynamic-checks-done', {
      skipped: !!dynamicReport.skipped,
      reason: dynamicReport.skipped ? dynamicReport.reason : null,
      violationCount: (dynamicReport.violations || []).length,
    });

    // Build scorecard.
    // When dynamic checks ran, merge dynamic-check definitions so the criteria
    // denominator and per-criterion summary include them.
    //
    // Dedupe by check.id as we go: src/dynamic-checks/ can contain multiple
    // modules covering the same WCAG criterion (e.g., two 2.4.3 entries —
    // "Focus Order" and "Focus order"). Without this dedup, scorecardChecks
    // ends up with duplicate IDs, then `new Set(...).size` (used for
    // passedCriteria below) is smaller than `scorecardChecks.length`,
    // and a fully-clean audit reports score < 100% with passed=false.
    let scorecardChecks = checksByStandard;
    if (!dynamicReport.skipped) {
      const { loadDynamicChecks } = require('./lib/load-dynamic-checks');
      const dynChecks = await loadDynamicChecks();
      const filteredDyn = dynChecks.filter((check) => {
        if (standard === 'wcag21') return check.wcagIntroduced === '2.0' || check.wcagIntroduced === '2.1';
        if (standard === 'wcag22') return ['2.0', '2.1', '2.2'].includes(check.wcagIntroduced);
        return true;
      });
      const seenIds = new Set(checksByStandard.map((c) => c.id));
      const uniqueDyn = [];
      for (const c of filteredDyn) {
        if (seenIds.has(c.id)) continue;
        seenIds.add(c.id);
        uniqueDyn.push(c);
      }
      scorecardChecks = [...checksByStandard, ...uniqueDyn];
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

    emit('done', {
      violationCount: allViolations.length,
      score: scorecard.score,
    });

    return {
      packageType: detectedType,
      complete: !dynamicReport.skipped,
      incompleteReason: dynamicReport.skipped ? dynamicReport.reason : null,
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
