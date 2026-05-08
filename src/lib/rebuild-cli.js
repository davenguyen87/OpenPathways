/**
 * rebuild-cli.js — CLI registration helpers for the Prism v4 rebuild commands.
 *
 * Exports three registration functions:
 *   registerUndo(program)         — chunk 08
 *   registerRebuild(program)      — chunk 07 (this chunk)
 *   registerRebuildLibrary(program) — chunk 07 (this chunk)
 *
 * Carry-forward decisions (from chunk 02 review, actioned here per chunk 07):
 *
 * 1. VERIFY OPTION ALLOWLIST: When calling verify(), we pass an explicit
 *    allowlist { standard, packageType, browser, timeoutDynamic, signal }.
 *    We do NOT modify verify.js; the allowlist is enforced at call-site here.
 *    This prevents accidentally passing `fix: true` or other keys that would
 *    cause verify's internal audit() call to write a *.scorm-fixed.zip.
 *
 * 2. RESOLVED/INTRODUCED SEMANTICS: We skip setVerification() entirely and
 *    write manifest.verification directly from verify()'s return value. The
 *    set-matched counts from verify() are more accurate than
 *    Math.max(0, before-after) arithmetic. The summary renderer (chunk 06)
 *    reads manifest.verification — it sees set-matched numbers.
 *
 * 3. IMPORT DISCIPLINE: Production code imports { verify } only. We never
 *    import __setAuditForTest from verify.js. Test stubs are injected via
 *    the _deps injectable in the action functions below.
 *
 * 4. LIBRARY ROLLUP PLACEMENT: The rebuild-library rollup renderer lives
 *    inline in this file (not in a separate src/reporter/rebuild-rollup.js).
 *    The rollup is simple enough (a Markdown summary and an HTML wrapper)
 *    that splitting it out would add indirection without benefit.
 */

'use strict';

const fs = require('fs').promises;
const path = require('path');
const kleur = require('kleur');
const ora = require('ora').default;

const { undo } = require('../rebuild/undo');

/**
 * Register the `rebuild-undo` subcommand on `program`.
 *
 * CLI shape:
 *   prism rebuild-undo --engagement <id> --package <name> --patch <id> [--patch <id>...]
 *
 * Exit codes (set via process.exitCode; the runtime exits naturally):
 *   0 — undo succeeded; rebuilt zip has zero remaining violations
 *   1 — undo succeeded; rebuilt zip still has remaining violations (expected)
 *   2 — tool error or undo incomplete
 *
 * @param {import('commander').Command} program
 * @param {Object} [testOpts] - injectable for tests
 * @param {Function} [testOpts.exit] - called instead of setting process.exitCode
 *                                     (useful in tests to avoid `process.exitCode` leaking)
 */
function registerUndo(program, testOpts) {
  const setExit = (testOpts && testOpts.exit)
    ? (code) => testOpts.exit(code)
    : (code) => { process.exitCode = code; };

  program
    .command('rebuild-undo')
    .description(
      'Reverse selected patches from a prior rebuild without re-running the full orchestrator.\n' +
      'Updates rebuilt.zip, rebuild-manifest.json, rebuild-diff.html, and rebuild-summary.html.'
    )
    .requiredOption('--engagement <id>', 'Engagement ID (required)')
    .requiredOption('--package <name>', 'Package name (required), e.g. compliance-101.zip')
    .option('--patch <id>', 'Patch ID to revert (repeat for multiple: --patch patch-0001 --patch patch-0002)')
    .option('--engagements-root <path>', 'Root directory for engagements (default: ./engagements)', './engagements')
    .action(async (cmdOpts) => {
      // Collect --patch values. Commander stores repeated --option as an array
      // when `.option` is declared without the variadic `...` syntax.
      // We use the raw args to gather all --patch flags.
      const patchIds = collectPatchIds(program.args, cmdOpts);

      if (!patchIds || patchIds.length === 0) {
        console.error(
          kleur.red('Error: at least one --patch <id> is required. ' +
            'Example: --patch patch-0001 --patch patch-0002')
        );
        setExit(2);
        return;
      }

      const engagementsRoot = cmdOpts.engagementsRoot || './engagements';
      const engagementDir = path.resolve(engagementsRoot, cmdOpts.engagement);

      try {
        const result = await undo(
          engagementDir,
          cmdOpts.package,
          patchIds
        );

        const remaining = result.manifest.verification
          ? result.manifest.verification.remaining
          : null;

        console.log(
          kleur.green(
            `✔  Undo complete. Reverted: ${result.reverted.join(', ')}`
          )
        );

        if (remaining !== null) {
          if (remaining === 0) {
            console.log(kleur.green(`   Verification: 0 remaining violations.`));
            setExit(0);
          } else {
            console.log(
              kleur.yellow(
                `   Verification: ${remaining} remaining violation(s) — ` +
                  `rebuilt zip is not fully compliant (expected).`
              )
            );
            setExit(1);
          }
        } else {
          setExit(0);
        }
      } catch (err) {
        console.error(kleur.red(`Error: ${err.message}`));
        setExit(2);
      }
    });
}

/**
 * Gather all `--patch <id>` values from Commander's parsed state.
 *
 * Commander stores the value of the last `--patch` in `cmdOpts.patch`.
 * To support multiple `--patch` flags we scan `process.argv` directly
 * (Commander v12 `collect` / variadic option isn't available on a plain
 * `.option()` declaration without a custom parser).
 *
 * @param {string[]} _args - program.args (unused; kept for signature symmetry)
 * @param {Object} cmdOpts
 * @returns {string[]}
 */
function collectPatchIds(_args, cmdOpts) {
  // Scan process.argv for all --patch values.
  const ids = [];
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--patch' && i + 1 < argv.length) {
      ids.push(argv[i + 1]);
      i += 1;
    }
  }
  // Fallback: if we couldn't read from argv (e.g., test runner), use cmdOpts.patch.
  if (ids.length === 0 && cmdOpts.patch) {
    return Array.isArray(cmdOpts.patch) ? cmdOpts.patch : [cmdOpts.patch];
  }
  return ids;
}

// ============================================================
// ACTION: rebuild (single package)
// ============================================================

/**
 * Core rebuild action. Separated from the Commander action so it can be
 * unit-tested with injected dependencies.
 *
 * @param {string} packagePath  - Path to the input .zip
 * @param {Object} cmdOpts      - Parsed Commander options
 * @param {Object} [deps]       - Injectable dependencies for testing
 * @param {Function} [deps.audit]                - audit() from src/index.js
 * @param {Function} [deps.rebuild]              - rebuild() from src/rebuild/index.js
 * @param {Function} [deps.verify]               - verify() from src/rebuild/verify.js
 * @param {Function} [deps.renderRebuildDiff]    - from src/reporter/rebuild-diff.js
 * @param {Function} [deps.renderRebuildSummary] - from src/reporter/rebuild-summary.js
 * @param {Function} [deps.exit]                 - process.exit replacement
 * @param {Object}   [deps.fsp]                  - fs.promises replacement
 * @returns {Promise<void>}
 */
async function rebuildAction(packagePath, cmdOpts, deps) {
  const d = deps || {};
  const doAudit = d.audit || require('../index').audit;
  const doRebuild = d.rebuild || require('../rebuild/index').rebuild;
  const doVerify = d.verify || require('../rebuild/verify').verify;
  const renderDiff = d.renderRebuildDiff || require('../reporter/rebuild-diff').renderRebuildDiff;
  const renderSummary = d.renderRebuildSummary || require('../reporter/rebuild-summary').renderRebuildSummary;
  const doExit = d.exit || ((code) => process.exit(code));
  const fsp = d.fsp || fs;

  // Validate required flags
  if (!cmdOpts.engagement) {
    console.error(kleur.red('Error: --engagement <id> is required for rebuild'));
    return doExit(2);
  }

  const mode = cmdOpts.mode || 'safe';
  const standard = cmdOpts.standard || 'wcag22';

  // Deferred-tier short-circuit: print notice and exit 0 without touching disk.
  if (mode === 'assisted' || mode === 'full') {
    console.log(
      kleur.yellow(
        `[rebuild] mode=${mode} is a deferred feature (v4.1/v5). ` +
        `No rebuild was performed. Exit 0.`
      )
    );
    return doExit(0);
  }

  // Resolve engagement + per-package output directory.
  const engagementsRoot = cmdOpts.engagementsRoot || './engagements';
  const packageBaseName = path.basename(packagePath, '.zip');
  const engagementDir = path.resolve(engagementsRoot, cmdOpts.engagement);
  const packageDir = path.join(engagementDir, packageBaseName);

  const spinner = ora('Rebuilding package...').start();

  try {
    await fsp.mkdir(packageDir, { recursive: true });

    // -------------------------------------------------------------------
    // Step 3: Decide whether to reuse an existing audit at this path.
    // -------------------------------------------------------------------
    const auditResultsPath = path.join(packageDir, 'results.json');
    let auditResults = null;

    let reusedAudit = false;
    try {
      const [auditStat, inputStat] = await Promise.all([
        fsp.stat(auditResultsPath),
        fsp.stat(packagePath)
      ]);
      if (auditStat.mtimeMs >= inputStat.mtimeMs) {
        // Fresh enough — reuse.
        const raw = await fsp.readFile(auditResultsPath, 'utf8');
        auditResults = JSON.parse(raw);
        reusedAudit = true;
        spinner.info('Reusing existing audit results (results.json is newer than input zip)');
      } else {
        spinner.info('Existing results.json is stale — re-running audit');
      }
    } catch (_) {
      // No results.json yet.
      spinner.info('No existing audit found — running audit first');
    }

    if (!auditResults) {
      spinner.start('Running audit...');
      // Run audit and write its outputs to the package directory.
      const { audit: coreAudit } = require('../index');
      const { writeReports } = require('../reporter');
      const rawAuditResults = await doAudit(packagePath, {
        standard,
        packageType: cmdOpts.packageType || 'auto',
        browser: cmdOpts.browser || 'chromium',
        timeoutDynamic: cmdOpts.timeoutDynamic ? parseInt(cmdOpts.timeoutDynamic, 10) : 30000,
        packagePath,
      });
      // Write audit artifacts so they're available for future rebuilds.
      await writeReports({
        scorecard: rawAuditResults.scorecard,
        violations: rawAuditResults.violations,
        manualReview: rawAuditResults.manualReview,
        scos: rawAuditResults.scos,
        dynamicReport: rawAuditResults.dynamicReport,
        fixesApplied: rawAuditResults.fixesApplied,
        options: {
          output: packageDir,
          standard,
          packageType: rawAuditResults.packageType,
          packagePath,
          engagementId: cmdOpts.engagement,
          brandConfigPath: cmdOpts.brandConfig,
        },
      });
      auditResults = rawAuditResults;
      spinner.succeed('Audit complete');
    }

    // -------------------------------------------------------------------
    // Step 4: Run the rebuild orchestrator.
    // -------------------------------------------------------------------
    spinner.start('Applying patches...');
    const { manifest, rebuiltZipPath } = await doRebuild(packagePath, auditResults, {
      mode,
      standard,
      engagementId: cmdOpts.engagement,
      packageName: path.basename(packagePath),
      outputDir: packageDir,
      brandConfigPath: cmdOpts.brandConfig,
    });
    spinner.succeed(`Rebuild complete (${manifest.patches.length} patches)`);

    // -------------------------------------------------------------------
    // Step 5: Deferred mode — no zip was written; render summary only.
    // -------------------------------------------------------------------
    if (!rebuiltZipPath) {
      // Orchestrator returned no zip (assisted/full stubs).
      spinner.start('Rendering summary...');
      const brandConfig = await loadBrandConfig(cmdOpts.brandConfig);
      const summaryPath = path.join(packageDir, 'rebuild-summary.html');
      await renderSummary(manifest, brandConfig, summaryPath);
      spinner.succeed('Summary rendered');
      console.log(kleur.yellow(`[rebuild] mode=${mode} produced no rebuilt zip (deferred). Summary: ${summaryPath}`));
      return doExit(0);
    }

    // -------------------------------------------------------------------
    // Step 6: Verify — re-audit the rebuilt zip.
    // Carry-forward #1: explicit allowlist — no extra keys forwarded.
    // Carry-forward #2: write manifest.verification directly from verify().
    // -------------------------------------------------------------------
    spinner.start('Verifying rebuilt package...');
    const verifyOpts = {
      standard,
      packageType: cmdOpts.packageType || 'auto',
      browser: cmdOpts.browser || 'chromium',
      timeoutDynamic: cmdOpts.timeoutDynamic ? parseInt(cmdOpts.timeoutDynamic, 10) : 30000,
      signal: cmdOpts.signal || null,
    };
    const verifyResult = await doVerify(rebuiltZipPath, auditResults, verifyOpts);

    // Write verification directly from verify()'s set-matched counts
    // (skip setVerification() — see carry-forward #2 in module header).
    manifest.verification = {
      before: verifyResult.before,
      after: verifyResult.after,
      resolved: verifyResult.resolved,
      introduced: verifyResult.introduced,
      remaining: verifyResult.remaining,
    };

    spinner.succeed('Verification complete');

    const brandConfig = await loadBrandConfig(cmdOpts.brandConfig);
    const manifestPath = path.join(packageDir, 'rebuild-manifest.json');
    const diffPath = path.join(packageDir, 'rebuild-diff.html');
    const summaryPath = path.join(packageDir, 'rebuild-summary.html');
    const outputZipPath = path.join(packageDir, 'rebuilt.zip');

    // -------------------------------------------------------------------
    // Step 6 (continued): Regression check.
    // -------------------------------------------------------------------
    if (verifyResult.hasRegression) {
      console.error(kleur.red(
        `[rebuild] REGRESSION: re-audit introduced ${verifyResult.introduced} new finding(s). ` +
        `rebuilt.zip will NOT be written.`
      ));
      // Write manifest and summary for the consultant to review.
      // We use fsp.writeFile (not writeManifest's writeFileSync) so tests
      // can intercept writes without touching the real filesystem.
      const { validateManifest } = require('../rebuild/manifest');
      const validation = validateManifest(manifest);
      if (validation.valid) {
        await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      }
      await renderSummary(manifest, brandConfig, summaryPath);
      console.error(kleur.red(`Manifest: ${manifestPath}`));
      console.error(kleur.red(`Summary:  ${summaryPath}`));
      return doExit(2);
    }

    // -------------------------------------------------------------------
    // Steps 7–10: Write all artifacts.
    // -------------------------------------------------------------------
    spinner.start('Writing artifacts...');

    await renderDiff(manifest, brandConfig, diffPath);
    await renderSummary(manifest, brandConfig, summaryPath);

    // Copy the rebuilt zip from its temp location to the engagement dir.
    await fsp.copyFile(rebuiltZipPath, outputZipPath);

    // Write manifest via fsp.writeFile so tests can intercept it without
    // touching the real filesystem. Production path still validates first.
    const { validateManifest: validate } = require('../rebuild/manifest');
    const valid = validate(manifest);
    if (!valid.valid) {
      throw new Error(`Cannot write invalid manifest: ${valid.errors.join('; ')}`);
    }
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    spinner.succeed('Artifacts written');

    // -------------------------------------------------------------------
    // Step 11: Print summary.
    // -------------------------------------------------------------------
    const v = manifest.verification;
    console.log(
      kleur.green(
        `Resolved: ${v.resolved} | Remaining: ${v.remaining} | Introduced: ${v.introduced}`
      )
    );
    console.log(`rebuilt.zip:            ${outputZipPath}`);
    console.log(`rebuild-manifest.json:  ${manifestPath}`);
    console.log(`rebuild-diff.html:      ${diffPath}`);
    console.log(`rebuild-summary.html:   ${summaryPath}`);

    // -------------------------------------------------------------------
    // Step 12: Exit 0 if remaining === 0, else 1.
    // -------------------------------------------------------------------
    return doExit(v.remaining === 0 ? 0 : 1);

  } catch (err) {
    spinner.stop();
    console.error(kleur.red(`Fatal rebuild error: ${err.message}`));
    return doExit(2);
  }
}

/**
 * Register the `rebuild` subcommand on `program`.
 *
 * NOTE: --standard defaults to wcag22 here (the rebuild target). This is
 * intentionally different from the `audit` command's wcag21 default.
 *
 * @param {import('commander').Command} program
 * @param {Object} [deps] - Injectable dependencies (for tests)
 */
function registerRebuild(program, deps) {
  program
    .command('rebuild <package>')
    .description(
      'Rebuild a .zip SCORM/AICC/xAPI package, applying mechanical fixes for WCAG 2.2 AA + Section 508.\n' +
      'Produces rebuilt.zip, rebuild-manifest.json, rebuild-diff.html, and rebuild-summary.html.'
    )
    .requiredOption('--engagement <id>', 'Engagement ID (required)')
    .option('--mode <mode>', 'Rebuild mode: safe|assisted|full (default: safe; assisted/full are deferred in v4)', 'safe')
    .option('--standard <standard>', 'WCAG standard: wcag21|wcag22 (default: wcag22 — rebuild target; differs from audit default)', 'wcag22')
    .option('--brand-config <path>', 'Path to custom brand config (default: config/brand.json)')
    .option('--browser <browser>', 'Browser for dynamic checks: chromium|firefox|webkit (default: chromium)', 'chromium')
    .option('--package-type <type>', 'Package type: scorm12|scorm2004|aicc|cmi5|xapi|auto (default: auto)', 'auto')
    .option('--timeout-dynamic <ms>', 'Timeout (ms) per SCO for dynamic checks (default: 30000)', '30000')
    .option('--engagements-root <path>', 'Root directory for engagements (default: ./engagements)', './engagements')
    .action(async (packagePath, cmdOpts) => {
      await rebuildAction(packagePath, cmdOpts, deps);
    });
}

// ============================================================
// ACTION: rebuild-library
// ============================================================

/**
 * Core rebuild-library action. Separated for testability.
 *
 * @param {string} directory   - Directory containing .zip packages
 * @param {Object} cmdOpts     - Parsed Commander options
 * @param {Object} [deps]      - Injectable dependencies for testing
 * @param {Function} [deps.rebuildAction] - override per-package rebuild
 * @param {Function} [deps.exit]          - process.exit replacement
 * @param {Object}   [deps.fsp]           - fs.promises replacement
 * @returns {Promise<void>}
 */
async function rebuildLibraryAction(directory, cmdOpts, deps) {
  const d = deps || {};
  const doExit = d.exit || ((code) => process.exit(code));
  const fsp = d.fsp || fs;

  if (!cmdOpts.engagement) {
    console.error(kleur.red('Error: --engagement <id> is required for rebuild-library'));
    return doExit(2);
  }

  const spinner = ora('Scanning directory...').start();

  let zipFiles;
  try {
    const entries = await fsp.readdir(directory);
    zipFiles = entries
      .filter((e) => e.toLowerCase().endsWith('.zip'))
      .map((e) => path.resolve(directory, e));
  } catch (err) {
    spinner.stop();
    console.error(kleur.red(`Error reading directory: ${err.message}`));
    return doExit(2);
  }

  if (zipFiles.length === 0) {
    spinner.warn('No .zip files found in directory');
    return doExit(0);
  }

  spinner.succeed(`Found ${zipFiles.length} package(s)`);

  // Results accumulator for rollup.
  const results = [];
  let hasToolError = false;

  for (const zipPath of zipFiles) {
    const pkgName = path.basename(zipPath);
    console.log(kleur.cyan(`\n→ Rebuilding: ${pkgName}`));
    let exitCode = null;
    const fakeExit = (code) => { exitCode = code; };

    // Delegate to the shared rebuildAction with same opts.
    try {
      await rebuildAction(zipPath, cmdOpts, { ...d, exit: fakeExit, fsp });
    } catch (err) {
      console.error(kleur.red(`  Error rebuilding ${pkgName}: ${err.message}`));
      exitCode = 2;
    }

    // Read back the manifest to get verification counts.
    const engagementsRoot = cmdOpts.engagementsRoot || './engagements';
    const packageBaseName = path.basename(zipPath, '.zip');
    const packageDir = path.join(engagementsRoot, cmdOpts.engagement, packageBaseName);
    const manifestPath = path.join(packageDir, 'rebuild-manifest.json');

    let verification = null;
    try {
      const raw = await fsp.readFile(manifestPath, 'utf8');
      const mf = JSON.parse(raw);
      verification = mf.verification;
    } catch (_) {
      // Manifest not written (error case).
    }

    const result = {
      packageName: pkgName,
      exitCode: exitCode !== null ? exitCode : 2,
      verification,
    };
    results.push(result);

    if (exitCode === 2) hasToolError = true;
  }

  // -------------------------------------------------------------------
  // Render library-level rollup.
  // Library rollup renderer lives inline here (see module header note).
  // -------------------------------------------------------------------
  const engagementsRoot = cmdOpts.engagementsRoot || './engagements';
  const engagementDir = path.resolve(engagementsRoot, cmdOpts.engagement);
  await fsp.mkdir(engagementDir, { recursive: true });

  const rollupHtmlPath = path.join(engagementDir, '_rebuild-rollup.html');
  const rollupMdPath = path.join(engagementDir, '_rebuild-rollup.md');

  const rollupMd = buildRollupMarkdown(cmdOpts.engagement, results);
  const rollupHtml = buildRollupHtml(cmdOpts.engagement, results);

  await fsp.writeFile(rollupHtmlPath, rollupHtml, 'utf8');
  await fsp.writeFile(rollupMdPath, rollupMd, 'utf8');

  console.log(`\nLibrary rollup: ${rollupHtmlPath}`);
  console.log(`               ${rollupMdPath}`);

  // -------------------------------------------------------------------
  // Exit code: 0 all remaining=0; 1 any remaining>0; 2 on error or introduced>0
  // -------------------------------------------------------------------
  const anyIntroduced = results.some(
    (r) => r.verification && r.verification.introduced > 0
  );
  const anyRemaining = results.some(
    (r) => r.verification && r.verification.remaining > 0
  );

  if (hasToolError || anyIntroduced) {
    return doExit(2);
  } else if (anyRemaining) {
    return doExit(1);
  } else {
    return doExit(0);
  }
}

/**
 * Register the `rebuild-library` subcommand on `program`.
 *
 * NOTE: --standard defaults to wcag22 here (the rebuild target). This is
 * intentionally different from the `audit` command's wcag21 default.
 *
 * @param {import('commander').Command} program
 * @param {Object} [deps] - Injectable dependencies (for tests)
 */
function registerRebuildLibrary(program, deps) {
  program
    .command('rebuild-library <directory>')
    .description(
      'Rebuild all .zip packages in a directory, then generate a library-level rollup.\n' +
      'Produces per-package artifacts and a _rebuild-rollup.{html,md} at the engagement level.'
    )
    .requiredOption('--engagement <id>', 'Engagement ID (required)')
    .option('--mode <mode>', 'Rebuild mode: safe|assisted|full (default: safe; assisted/full are deferred in v4)', 'safe')
    .option('--standard <standard>', 'WCAG standard: wcag21|wcag22 (default: wcag22 — rebuild target; differs from audit default)', 'wcag22')
    .option('--brand-config <path>', 'Path to custom brand config (default: config/brand.json)')
    .option('--browser <browser>', 'Browser for dynamic checks: chromium|firefox|webkit (default: chromium)', 'chromium')
    .option('--package-type <type>', 'Package type: scorm12|scorm2004|aicc|cmi5|xapi|auto (default: auto)', 'auto')
    .option('--timeout-dynamic <ms>', 'Timeout (ms) per SCO for dynamic checks (default: 30000)', '30000')
    .option('--engagements-root <path>', 'Root directory for engagements (default: ./engagements)', './engagements')
    .action(async (directory, cmdOpts) => {
      await rebuildLibraryAction(directory, cmdOpts, deps);
    });
}

// ============================================================
// ROLLUP RENDERERS (inline — see module header note)
// ============================================================

/**
 * Build a Markdown rollup summary for the rebuild-library command.
 *
 * @param {string} engagementId
 * @param {Array<{packageName: string, exitCode: number, verification: object|null}>} results
 * @returns {string}
 */
function buildRollupMarkdown(engagementId, results) {
  const lines = [
    `# Rebuild rollup — ${engagementId}`,
    '',
    `**Packages rebuilt:** ${results.length}`,
    '',
    '| Package | Resolved | Remaining | Introduced | Status |',
    '|---------|----------|-----------|------------|--------|',
  ];

  let totalResolved = 0;
  let totalRemaining = 0;
  let totalIntroduced = 0;

  for (const r of results) {
    const v = r.verification;
    const resolved = v ? v.resolved : '—';
    const remaining = v ? v.remaining : '—';
    const introduced = v ? v.introduced : '—';
    const status = r.exitCode === 2 ? 'Error' : (v && v.remaining === 0 ? 'Clean' : 'Remaining');

    if (v) {
      totalResolved += v.resolved || 0;
      totalRemaining += v.remaining || 0;
      totalIntroduced += v.introduced || 0;
    }

    lines.push(`| ${r.packageName} | ${resolved} | ${remaining} | ${introduced} | ${status} |`);
  }

  lines.push('', `**Totals:** Resolved: ${totalResolved} | Remaining: ${totalRemaining} | Introduced: ${totalIntroduced}`, '');
  return lines.join('\n');
}

/**
 * Build an HTML rollup report for the rebuild-library command.
 * Minimal self-contained HTML; reuses brand colors but keeps it simple.
 *
 * @param {string} engagementId
 * @param {Array<{packageName: string, exitCode: number, verification: object|null}>} results
 * @returns {string}
 */
function buildRollupHtml(engagementId, results) {
  const rows = results.map((r) => {
    const v = r.verification;
    const resolved = v ? v.resolved : '—';
    const remaining = v ? v.remaining : '—';
    const introduced = v != null ? v.introduced : '—';
    const status = r.exitCode === 2 ? 'Error'
      : (v && v.remaining === 0 ? 'Clean' : 'Remaining');
    const statusClass = r.exitCode === 2 ? 'st-error'
      : (v && v.remaining === 0 ? 'st-clean' : 'st-remaining');
    const introClass = (v && v.introduced > 0) ? 'st-error' : '';
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return [
      '<tr>',
      `<td>${esc(r.packageName)}</td>`,
      `<td>${esc(String(resolved))}</td>`,
      `<td>${esc(String(remaining))}</td>`,
      `<td class="${introClass}">${esc(String(introduced))}</td>`,
      `<td class="${statusClass}">${esc(status)}</td>`,
      '</tr>'
    ].join('');
  }).join('');

  const total = results.length;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${esc(engagementId)} — Rebuild rollup</title>`,
    '<style>',
    'body{font-family:system-ui,sans-serif;background:#f3efe6;color:#111633;margin:0;padding:32px 40px}',
    'h1{font-size:24px;margin-bottom:16px}',
    'table{width:100%;border-collapse:collapse;border:2px solid #111633;font-size:14px}',
    'th{background:#111633;color:#f3efe6;padding:8px 12px;text-align:left;font-size:11px;letter-spacing:.1em;text-transform:uppercase}',
    'td{padding:8px 12px;border-top:1px solid #c8bfa8}',
    '.st-clean{color:#1b7a3d;font-weight:700}',
    '.st-error{color:#c46a14;font-weight:700}',
    '.st-remaining{color:#2a3158}',
    '</style>',
    '</head>',
    '<body>',
    `<h1>Rebuild rollup — ${esc(engagementId)}</h1>`,
    `<p>Packages rebuilt: <strong>${total}</strong></p>`,
    '<table>',
    '<thead><tr>',
    '<th>Package</th><th>Resolved</th><th>Remaining</th><th>Introduced</th><th>Status</th>',
    '</tr></thead>',
    '<tbody>',
    rows,
    '</tbody>',
    '</table>',
    '</body>',
    '</html>',
    ''
  ].join('\n');
}

// ============================================================
// SHARED HELPERS
// ============================================================

/**
 * Load brand config from disk, falling back to the default config/brand.json.
 * Returns null (callers accept null; the renderer has its own fallback).
 *
 * @param {string|undefined} configPath
 * @returns {Promise<object|null>}
 */
async function loadBrandConfig(configPath) {
  const target = configPath || path.resolve('./config/brand.json');
  try {
    const raw = await fs.readFile(target, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

module.exports = {
  registerUndo,
  registerRebuild,
  registerRebuildLibrary,
  // Export action functions for unit testing.
  rebuildAction,
  rebuildLibraryAction,
};
