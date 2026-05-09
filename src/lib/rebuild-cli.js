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
 * 4. LIBRARY ROLLUP PLACEMENT: The rollup HTML/MD builders live in
 *    `src/reporter/rebuild-rollup.js` and are called from
 *    `src/rebuild/index.js`'s `rebuildLibrary()`. This file is now a thin
 *    CLI wrapper around `rebuildLibrary` — display + exit code only.
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
    .option('--transform <id>', 'Transform ID to revert atomically (repeat for multiple: --transform transform-0001 --transform transform-0002). v5.')
    .option('--engagements-root <path>', 'Root directory for engagements (default: ./engagements)', './engagements')
    .action(async (cmdOpts) => {
      // Collect --patch and --transform values. Commander stores repeated
      // --option as the LAST value when `.option` is not variadic, so we
      // scan process.argv for every occurrence.
      const patchIds = collectPatchIds(program.args, cmdOpts);
      const transformIds = collectFlagIds('--transform');

      if ((!patchIds || patchIds.length === 0) && transformIds.length === 0) {
        console.error(
          kleur.red('Error: at least one --patch <id> or --transform <id> is required. ' +
            'Example: --patch patch-0001 --patch patch-0002 OR --transform transform-0001')
        );
        setExit(2);
        return;
      }

      const engagementsRoot = cmdOpts.engagementsRoot || './engagements';
      const engagementDir = path.resolve(engagementsRoot, cmdOpts.engagement);

      try {
        // Chunk 08 extends undo to accept { patches, transforms } shape.
        // For backward compatibility with the v4 `undo(engagementDir,
        // packageName, patchIds, opts)` signature, we forward the old shape
        // when only --patch was passed and the new shape when --transform
        // is involved. The undo module decides how to dispatch.
        let result;
        if (transformIds.length > 0) {
          result = await undo(engagementDir, cmdOpts.package, {
            patches: patchIds || [],
            transforms: transformIds
          });
        } else {
          result = await undo(engagementDir, cmdOpts.package, patchIds);
        }

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
  const ids = collectFlagIds('--patch');
  // Fallback: if we couldn't read from argv (e.g., test runner), use cmdOpts.patch.
  if (ids.length === 0 && cmdOpts.patch) {
    return Array.isArray(cmdOpts.patch) ? cmdOpts.patch : [cmdOpts.patch];
  }
  return ids;
}

/**
 * Generic argv scanner for repeated flag values. Commander v12 stores only
 * the last value of a non-variadic `.option(<flag>)`; `--patch a --patch b`
 * yields `cmdOpts.patch === 'b'` rather than `['a','b']`. Scanning argv is
 * the simplest and lowest-risk way to recover every occurrence without
 * adding a custom parser.
 *
 * @param {string} flagName  - e.g. "--patch" or "--transform"
 * @returns {string[]}
 */
function collectFlagIds(flagName) {
  const ids = [];
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flagName && i + 1 < argv.length) {
      ids.push(argv[i + 1]);
      i += 1;
    }
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

  // Tier dispatch:
  //   safe     — handled below (v4 path).
  //   assisted — still a deferred-feature stub at the CLI level until v4.1
  //              wires its assisted-tier action. Behaviour unchanged here.
  //   full     — v5. Two sub-paths:
  //              1. checkpoint mode (default): rebuild() stages output under
  //                 .rebuild-staging/, the CLI renders preview, prints the
  //                 approval instruction, and exits 0.
  //              2. --no-checkpoint: rebuild() writes inline to packageDir;
  //                 verification runs and the v4 exit-code contract applies.
  if (mode === 'assisted') {
    console.log(
      kleur.yellow(
        `[rebuild] mode=${mode} is a deferred feature (v4.1/v5). ` +
        `No rebuild was performed. Exit 0.`
      )
    );
    return doExit(0);
  }
  if (mode === 'full') {
    return await runFullTierRebuild(packagePath, cmdOpts, d, doExit);
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
 * v5 full-tier rebuild path. Runs rebuild() with the appropriate
 * `noCheckpoint` flag and writes the corresponding artifacts.
 *
 * Checkpoint-on (default): rebuild() stages output under
 *   <packageDir>/.rebuild-staging/. The CLI renders the preview into the
 *   staging dir and prints the approve instruction. Exits 0.
 *
 * Checkpoint-off (--no-checkpoint): rebuild() writes inline. The CLI
 *   verifies and renders diff/summary/preview at the package root and
 *   exits per the v4 contract (0 if remaining===0, else 1, or 2 on
 *   regression).
 *
 * @param {string} packagePath
 * @param {Object} cmdOpts
 * @param {Object} d - resolved dependency map (audit, rebuild, ...)
 * @param {Function} doExit
 */
async function runFullTierRebuild(packagePath, cmdOpts, d, doExit) {
  const doAudit = d.audit || require('../index').audit;
  const doRebuild = d.rebuild || require('../rebuild/index').rebuild;
  const doVerify = d.verify || require('../rebuild/verify').verify;
  const renderDiff = d.renderRebuildDiff || require('../reporter/rebuild-diff').renderRebuildDiff;
  const renderSummary = d.renderRebuildSummary || require('../reporter/rebuild-summary').renderRebuildSummary;
  const renderPreview = d.renderRebuildPreview || require('../reporter/rebuild-preview').renderRebuildPreview;
  const fsp = d.fsp || fs;

  // Commander's `--no-checkpoint` boolean stores the *positive* form on
  // cmdOpts.checkpoint: true by default, false when the user passed
  // `--no-checkpoint`. We translate to `noCheckpoint` for clarity. Default
  // is checkpoint-on (PRD § "Checkpoint lifecycle"; a worker that flips this
  // default fails review).
  const noCheckpoint = cmdOpts.checkpoint === false;
  const standard = cmdOpts.standard || 'wcag22';
  const engagementsRoot = cmdOpts.engagementsRoot || './engagements';
  const packageBaseName = path.basename(packagePath, '.zip');
  const engagementDir = path.resolve(engagementsRoot, cmdOpts.engagement);
  const packageDir = path.join(engagementDir, packageBaseName);

  const spinner = ora('Rebuilding package (full-tier)...').start();

  try {
    await fsp.mkdir(packageDir, { recursive: true });

    // Reuse / run audit (same logic as the safe-tier path).
    const auditResultsPath = path.join(packageDir, 'results.json');
    let auditResults = null;
    try {
      const [auditStat, inputStat] = await Promise.all([
        fsp.stat(auditResultsPath),
        fsp.stat(packagePath)
      ]);
      if (auditStat.mtimeMs >= inputStat.mtimeMs) {
        auditResults = JSON.parse(await fsp.readFile(auditResultsPath, 'utf8'));
        spinner.info('Reusing existing audit results (results.json is newer than input zip)');
      } else {
        spinner.info('Existing results.json is stale — re-running audit');
      }
    } catch (_) {
      spinner.info('No existing audit found — running audit first');
    }

    if (!auditResults) {
      spinner.start('Running audit...');
      const { writeReports } = require('../reporter');
      const rawAuditResults = await doAudit(packagePath, {
        standard,
        packageType: cmdOpts.packageType || 'auto',
        browser: cmdOpts.browser || 'chromium',
        timeoutDynamic: cmdOpts.timeoutDynamic ? parseInt(cmdOpts.timeoutDynamic, 10) : 30000,
        packagePath
      });
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
          brandConfigPath: cmdOpts.brandConfig
        }
      });
      auditResults = rawAuditResults;
      spinner.succeed('Audit complete');
    }

    // Drive rebuild orchestrator. noCheckpoint defaults false (PRD: gate-on).
    spinner.start('Applying full-tier transforms...');
    const rebuildResult = await doRebuild(packagePath, auditResults, {
      mode: 'full',
      standard,
      engagementId: cmdOpts.engagement,
      packageName: path.basename(packagePath),
      outputDir: packageDir,
      noCheckpoint,
      brandConfigPath: cmdOpts.brandConfig
    });
    spinner.succeed(`Full-tier rebuild complete (${(rebuildResult.manifest.patches || []).length} patches)`);

    const brandConfig = await loadBrandConfig(cmdOpts.brandConfig);

    // ---------------------------------------------------------------------
    // Checkpoint mode (default): outputs are staged. Render the preview into
    // the staging directory, print the approval instruction, exit 0.
    // ---------------------------------------------------------------------
    if (!noCheckpoint) {
      const stagingDir = rebuildResult.stagingDir || path.join(packageDir, '.rebuild-staging');
      const previewPath = path.join(stagingDir, 'rebuild-preview.html');
      try {
        await renderPreview(rebuildResult.manifest, brandConfig, previewPath);
      } catch (err) {
        // A preview-render failure is not fatal — staging is intact and the
        // operator can re-render on approve. Log and continue.
        console.error(kleur.yellow(`[rebuild] preview render failed: ${err.message || String(err)}`));
      }
      console.log(kleur.green('Full-tier rebuild staged.'));
      console.log(`  Review at:  ${previewPath}`);
      console.log(
        `  Approve with: prism rebuild-checkpoint approve --engagement ${cmdOpts.engagement} --package ${path.basename(packagePath)}`
      );
      return doExit(0);
    }

    // ---------------------------------------------------------------------
    // No-checkpoint mode: write artifacts inline at the package root, then
    // verify and exit per the v4 contract.
    // ---------------------------------------------------------------------
    const rebuiltZipPath = rebuildResult.rebuiltZipPath;
    if (!rebuiltZipPath) {
      // No zip was produced — surface the manifest's deferred entries via
      // a summary file so the consultant has something to look at.
      const summaryPath = path.join(packageDir, 'rebuild-summary.html');
      await renderSummary(rebuildResult.manifest, brandConfig, summaryPath);
      console.log(kleur.yellow(`[rebuild] mode=full produced no rebuilt zip. Summary: ${summaryPath}`));
      return doExit(0);
    }

    // Verify (allowlist only — see carry-forward #1 in module header).
    spinner.start('Verifying rebuilt package...');
    const verifyOpts = {
      standard,
      packageType: cmdOpts.packageType || 'auto',
      browser: cmdOpts.browser || 'chromium',
      timeoutDynamic: cmdOpts.timeoutDynamic ? parseInt(cmdOpts.timeoutDynamic, 10) : 30000,
      signal: cmdOpts.signal || null
    };
    const verifyResult = await doVerify(rebuiltZipPath, auditResults, verifyOpts);
    rebuildResult.manifest.verification = {
      before: verifyResult.before,
      after: verifyResult.after,
      resolved: verifyResult.resolved,
      introduced: verifyResult.introduced,
      remaining: verifyResult.remaining
    };
    spinner.succeed('Verification complete');

    const manifestPath = path.join(packageDir, 'rebuild-manifest.json');
    const diffPath = path.join(packageDir, 'rebuild-diff.html');
    const summaryPath = path.join(packageDir, 'rebuild-summary.html');
    const previewPath = path.join(packageDir, 'rebuild-preview.html');
    const outputZipPath = path.join(packageDir, 'rebuilt.zip');

    if (verifyResult.hasRegression) {
      console.error(kleur.red(
        `[rebuild] REGRESSION: re-audit introduced ${verifyResult.introduced} new finding(s). ` +
        `rebuilt.zip will NOT be written.`
      ));
      const { validateManifest } = require('../rebuild/manifest');
      const validation = validateManifest(rebuildResult.manifest);
      if (validation.valid) {
        await fsp.writeFile(manifestPath, JSON.stringify(rebuildResult.manifest, null, 2), 'utf8');
      }
      await renderSummary(rebuildResult.manifest, brandConfig, summaryPath);
      console.error(kleur.red(`Manifest: ${manifestPath}`));
      console.error(kleur.red(`Summary:  ${summaryPath}`));
      return doExit(2);
    }

    spinner.start('Writing artifacts...');
    await renderDiff(rebuildResult.manifest, brandConfig, diffPath);
    await renderSummary(rebuildResult.manifest, brandConfig, summaryPath);
    try {
      await renderPreview(rebuildResult.manifest, brandConfig, previewPath);
    } catch (err) {
      console.error(kleur.yellow(`[rebuild] preview render failed: ${err.message || String(err)}`));
    }
    await fsp.copyFile(rebuiltZipPath, outputZipPath);
    const { validateManifest: validate } = require('../rebuild/manifest');
    const valid = validate(rebuildResult.manifest);
    if (!valid.valid) {
      throw new Error(`Cannot write invalid manifest: ${valid.errors.join('; ')}`);
    }
    await fsp.writeFile(manifestPath, JSON.stringify(rebuildResult.manifest, null, 2), 'utf8');
    spinner.succeed('Artifacts written');

    const v = rebuildResult.manifest.verification;
    console.log(kleur.green(`Resolved: ${v.resolved} | Remaining: ${v.remaining} | Introduced: ${v.introduced}`));
    console.log(`rebuilt.zip:            ${outputZipPath}`);
    console.log(`rebuild-manifest.json:  ${manifestPath}`);
    console.log(`rebuild-diff.html:      ${diffPath}`);
    console.log(`rebuild-summary.html:   ${summaryPath}`);
    console.log(`rebuild-preview.html:   ${previewPath}`);

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
    .option('--mode <mode>', 'Rebuild mode: safe|assisted|full (default: safe; assisted is deferred to v4.1)', 'safe')
    .option('--standard <standard>', 'WCAG standard: wcag21|wcag22 (default: wcag22 — rebuild target; differs from audit default)', 'wcag22')
    .option('--no-checkpoint', 'Skip the checkpoint gate and write directly to rebuilt.zip. Default off; the checkpoint gate is on by default for full mode.')
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

  if (!cmdOpts.engagement) {
    console.error(kleur.red('Error: --engagement <id> is required for rebuild-library'));
    return doExit(2);
  }

  const spinner = ora('Running library rebuild...').start();

  let library;
  try {
    const rebuildLibrary = d.rebuildLibrary || require('../rebuild').rebuildLibrary;
    library = await rebuildLibrary(directory, {
      engagementId: cmdOpts.engagement,
      engagementsRoot: cmdOpts.engagementsRoot || './engagements',
      mode: cmdOpts.mode || 'safe',
      standard: cmdOpts.standard || 'wcag22',
      packageType: cmdOpts.packageType || 'auto',
      browser: cmdOpts.browser || 'chromium',
      timeoutDynamic: cmdOpts.timeoutDynamic ? parseInt(cmdOpts.timeoutDynamic, 10) : 30000,
      brandConfig: await loadBrandConfig(cmdOpts.brandConfig),
      brandConfigPath: cmdOpts.brandConfig,
      audit: d.audit,
      verify: d.verify,
      writeReports: d.writeReports,
      renderRebuildDiff: d.renderRebuildDiff,
      renderRebuildSummary: d.renderRebuildSummary
    });
  } catch (err) {
    spinner.stop();
    console.error(kleur.red(`Error: ${err.message}`));
    return doExit(2);
  }

  spinner.succeed(`Rebuilt ${library.results.length} package(s)`);

  // Per-package status lines.
  for (const r of library.results) {
    const v = r.verification;
    if (r.exitCode === 2) {
      console.log(kleur.red(`  ✗ ${r.packageName} — error`));
    } else if (v && v.remaining === 0) {
      console.log(kleur.green(`  ✔ ${r.packageName} — clean (resolved ${v.resolved})`));
    } else if (v) {
      console.log(
        kleur.yellow(`  • ${r.packageName} — resolved ${v.resolved}, remaining ${v.remaining}`)
      );
    } else {
      console.log(kleur.gray(`  - ${r.packageName} — deferred mode, no verification`));
    }
  }

  console.log(`\nLibrary rollup: ${library.rollupHtmlPath}`);
  console.log(`               ${library.rollupMdPath}`);

  // Exit code: 0 all clean; 1 any remaining>0; 2 on tool error or introduced>0.
  const hasToolError = library.results.some((r) => r.exitCode === 2);
  if (hasToolError || library.totals.introduced > 0) return doExit(2);
  if (library.totals.remaining > 0) return doExit(1);
  return doExit(0);
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
    .option('--mode <mode>', 'Rebuild mode: safe|assisted|full (default: safe; assisted is deferred to v4.1)', 'safe')
    .option('--standard <standard>', 'WCAG standard: wcag21|wcag22 (default: wcag22 — rebuild target; differs from audit default)', 'wcag22')
    .option('--no-checkpoint', 'Skip the checkpoint gate and write directly to rebuilt.zip. Default off; the checkpoint gate is on by default for full mode.')
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
