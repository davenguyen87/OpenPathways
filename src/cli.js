#!/usr/bin/env node

const { program } = require('commander');
const path = require('path');
const fs = require('fs').promises;
const { audit } = require('./index');
const { auditLibrary } = require('./lib/audit-library');
const { writeReports } = require('./reporter');
const { loadBaseline, diffAgainstBaseline } = require('./lib/baseline');
const { validateLlmConfig } = require('./lib/llm-provenance');
const kleur = require('kleur');
const ora = require('ora').default;

const VERSION = '3.0.0';

program
  .name('prism')
  .version(VERSION, '-v, --version')
  .description('Audit SCORM/AICC packages for WCAG 2.1 AA + Section 508 compliance. Produces brand-matched HTML reports, triage-tagged findings, and scope estimates.');

// ============================================================
// SUBCOMMAND: audit <package>
// ============================================================
const auditCmd = program
  .command('audit <package>')
  .description('Audit a single .zip SCORM/AICC/xAPI package and generate a brand-matched HTML report.')
  .option('--engagement <id>', 'Engagement ID (required for v3 deliverables; fall back to v2 behavior if omitted)')
  .option('--engagement-redact', 'Replace client name with engagement ID throughout report')
  .option('--brand-config <path>', 'Path to custom brand config (default: config/brand.json)')
  .option('--baseline <path>', 'Path to prior results.json; suppress violations present in baseline')
  .option('--browser <browser>', 'Browser for dynamic checks: chromium|firefox|webkit (default: chromium)', 'chromium')
  .option('--fix', 'Apply mechanical fixes; writes <package>.scorm-fixed.zip')
  .option('--fix-dry-run', 'Preview fixes without writing')
  .option('--format <format>', 'Report format: md|txt (deprecated in v3; HTML always generated)', 'md')
  .option('--json', 'Output JSON scorecard to stdout only (suppresses spinner/logs)')
  .option('--llm-provider <provider>', 'LLM provider for assisted findings (off by default; requires --llm-key-from-env)')
  .option('--llm-key-from-env <env-var>', 'Environment variable holding LLM API key (off by default; requires --llm-provider)')
  .option('--max-violations <n>', 'Maximum violations allowed before failing (default: unlimited)', null)
  .option('--output <dir>', 'Output directory (deprecated in v3; ignored when --engagement is set)', './prism-report')
  .option('--package-type <type>', 'Package type: scorm12|scorm2004|aicc|cmi5|xapi|auto (default: auto)', 'auto')
  .option('--standard <standard>', 'WCAG standard: wcag21|wcag22 (default: wcag21)', 'wcag21')
  .option('--timeout-dynamic <ms>', 'Timeout (ms) per SCO for dynamic checks (default: 30000)', '30000')
  .action(auditAction);

// ============================================================
// SUBCOMMAND: audit-library <directory>
// ============================================================
const auditLibCmd = program
  .command('audit-library <directory>')
  .description('Audit all .zip files in a directory and generate per-package reports plus a library-level rollup.')
  .option('--engagement <id>', 'Engagement ID (REQUIRED for v3 library mode)')
  .option('--engagement-redact', 'Replace client name with engagement ID throughout reports')
  .option('--brand-config <path>', 'Path to custom brand config (default: config/brand.json)')
  .option('--browser <browser>', 'Browser for dynamic checks: chromium|firefox|webkit (default: chromium)', 'chromium')
  .option('--llm-provider <provider>', 'LLM provider for assisted findings (off by default; requires --llm-key-from-env)')
  .option('--llm-key-from-env <env-var>', 'Environment variable holding LLM API key (off by default; requires --llm-provider)')
  .option('--package-type <type>', 'Package type: scorm12|scorm2004|aicc|cmi5|xapi|auto (default: auto)', 'auto')
  .option('--standard <standard>', 'WCAG standard: wcag21|wcag22 (default: wcag21)', 'wcag21')
  .option('--timeout-dynamic <ms>', 'Timeout (ms) per SCO for dynamic checks (default: 30000)', '30000')
  .action(auditLibraryAction);

// ============================================================
// SUBCOMMANDS: rebuild, rebuild-library, rebuild-undo (v4)
// ============================================================
// These are registered from src/lib/rebuild-cli.js so they can be
// unit-tested independently. Passing no deps means production code
// paths — the action functions require() their dependencies lazily.
const { registerRebuild, registerRebuildLibrary, registerUndo } = require('./lib/rebuild-cli');
registerRebuild(program);
registerRebuildLibrary(program);
registerUndo(program);

program.parse(process.argv);

// ============================================================
// ACTION: audit
// ============================================================
async function auditAction(packagePath, cmdOpts) {
  try {
    // Validate mutually exclusive flags
    if (cmdOpts.fix && cmdOpts.fixDryRun) {
      console.error(kleur.red('Error: --fix and --fix-dry-run are mutually exclusive'));
      process.exit(2);
    }

    // Validate LLM config early if both flags are set
    if (cmdOpts.llmProvider || cmdOpts.llmKeyFromEnv) {
      try {
        validateLlmConfig({ llmProvider: cmdOpts.llmProvider, llmKeyFromEnv: cmdOpts.llmKeyFromEnv });
      } catch (err) {
        console.error(kleur.red(`LLM config error: ${err.message}`));
        process.exit(2);
      }
    }

    // Determine if we should suppress spinner/logs when --json is set
    const isJsonOnly = cmdOpts.json;

    // Create spinner only if not JSON-only mode
    let spinner = null;
    if (!isJsonOnly) {
      spinner = ora('Analyzing package...').start();
    }

    // Run the audit
    let auditResult;
    try {
      auditResult = await audit(packagePath, {
        packageType: cmdOpts.packageType,
        standard: cmdOpts.standard,
        browser: cmdOpts.browser,
        timeoutDynamic: cmdOpts.timeoutDynamic ? parseInt(cmdOpts.timeoutDynamic, 10) : 30000,
        fix: cmdOpts.fix,
        fixDryRun: cmdOpts.fixDryRun,
        packagePath,
        jsonOnly: isJsonOnly,
        llmProvider: cmdOpts.llmProvider,
        llmKeyFromEnv: cmdOpts.llmKeyFromEnv,
      });
    } catch (err) {
      if (spinner) spinner.stop();
      if (!isJsonOnly) {
        console.error(kleur.red(`Error: ${err.message}`));
      }
      process.exit(2);
    }

    if (spinner) spinner.succeed('Analysis complete');

    // Apply baseline filtering if specified
    if (cmdOpts.baseline) {
      try {
        const baseline = await loadBaseline(cmdOpts.baseline);
        const filteredViolations = diffAgainstBaseline(auditResult.violations, baseline.violations);

        // Recompute scorecard with filtered violations
        const totalCriteria = auditResult.scorecard.totalCriteria;
        const passedCriteria = new Set(
          auditResult.scorecard.criteriaResults
            .filter((cr) => cr.passed)
            .map((cr) => cr.id)
        );

        filteredViolations.forEach((v) => {
          if (v.criterion) passedCriteria.delete(v.criterion);
        });

        const passed = passedCriteria.size;
        const score = totalCriteria > 0 ? Math.round((passed / totalCriteria) * 100) : 100;

        // Update scorecard
        auditResult.scorecard.passed = passed === totalCriteria;
        auditResult.scorecard.score = score;
        auditResult.scorecard.failedCriteria = totalCriteria - passed;
        auditResult.scorecard.totalViolations = filteredViolations.length;
        auditResult.scorecard.criteriaResults = auditResult.scorecard.criteriaResults.map((cr) => ({
          ...cr,
          passed: passedCriteria.has(cr.id),
          violationCount: filteredViolations.filter((v) => v.criterion === cr.id).length,
        }));

        // Replace violations with filtered list
        auditResult.violations = filteredViolations;
      } catch (err) {
        console.error(kleur.red(`Baseline error: ${err.message}`));
        process.exit(2);
      }
    }

    // Determine output mode
    let outputDir = cmdOpts.output;
    if (cmdOpts.engagement) {
      // v3 mode: engagement namespacing
      const packageName = path.basename(packagePath, '.zip');
      outputDir = path.join('./engagements', cmdOpts.engagement, packageName);
    } else {
      // v2 backward compatibility mode
      if (!isJsonOnly) {
        console.log(kleur.yellow('⚠ Note: --engagement not specified. Using v2 output mode (./prism-report/). Set --engagement for v3 deliverable mode.'));
      }
    }

    // Build options for reporter
    const reporterOptions = {
      json: cmdOpts.json,
      format: cmdOpts.format,
      output: outputDir,
      standard: cmdOpts.standard,
      packageType: auditResult.packageType,
      packagePath: packagePath,
      engagementId: cmdOpts.engagement,
      engagementRedact: cmdOpts.engagementRedact,
      brandConfigPath: cmdOpts.brandConfig,
      llmProvider: cmdOpts.llmProvider,
      llmKeyFromEnv: cmdOpts.llmKeyFromEnv,
    };

    // Generate reports
    let reportResult;
    try {
      reportResult = await writeReports({
        scorecard: auditResult.scorecard,
        violations: auditResult.violations,
        manualReview: auditResult.manualReview,
        scos: auditResult.scos,
        dynamicReport: auditResult.dynamicReport,
        fixesApplied: auditResult.fixesApplied,
        options: reporterOptions,
      });
    } catch (err) {
      if (!isJsonOnly) {
        console.error(kleur.red(`Report generation error: ${err.message}`));
      }
      process.exit(2);
    }

    // Output JSON to stdout if --json flag
    if (cmdOpts.json && reportResult.jsonString) {
      console.log(reportResult.jsonString);
    } else if (!isJsonOnly) {
      // Log summary info
      const scoreMsg = `Score: ${auditResult.scorecard.score}% | Violations: ${auditResult.violations.length}`;
      if (auditResult.scorecard.passed) {
        console.log(kleur.green(scoreMsg));
      } else {
        console.log(kleur.yellow(scoreMsg));
      }

      if (reportResult.htmlPath) {
        console.log(`HTML report: ${reportResult.htmlPath}`);
      }
      if (reportResult.mdPath) {
        console.log(`Markdown report: ${reportResult.mdPath}`);
      }
      if (reportResult.jsonPath) {
        console.log(`JSON scorecard: ${reportResult.jsonPath}`);
      }

      // Log fixes applied if any
      if (auditResult.fixesApplied && auditResult.fixesApplied.count > 0) {
        console.log(kleur.cyan(`Fixes applied: ${auditResult.fixesApplied.count} -> ${auditResult.fixesApplied.outputPath}`));
      }
    }

    // Determine exit code.
    // INCOMPLETE audits (dynamic checks could not run) take precedence over
    // violation counts: a partial audit must not be mistaken for a clean pass,
    // so we exit 2 (tool error) regardless of the violation count.
    const dyn = auditResult.dynamicReport || {};
    if (dyn.skipped) {
      if (!isJsonOnly) {
        console.log(
          kleur.yellow(
            `⚠ REPORT INCOMPLETE: dynamic checks did not run — ${dyn.reason || 'unknown reason'}`
          )
        );
        console.log(
          kleur.yellow(
            '  Static checks completed, but dynamic accessibility coverage is missing. Resolve the issue above and re-run.'
          )
        );
      }
      process.exit(2);
    }

    const maxViolations = cmdOpts.maxViolations ? parseInt(cmdOpts.maxViolations, 10) : null;
    const violationCount = auditResult.violations.length;

    if (maxViolations !== null && violationCount > maxViolations) {
      process.exit(1);
    } else if (violationCount > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (err) {
    console.error(kleur.red(`Fatal error: ${err.message}`));
    process.exit(2);
  }
}

// ============================================================
// ACTION: audit-library
// ============================================================
async function auditLibraryAction(directory, cmdOpts) {
  try {
    // Engagement ID is REQUIRED for library mode
    if (!cmdOpts.engagement) {
      console.error(kleur.red('Error: --engagement <id> is required for audit-library'));
      process.exit(2);
    }

    // Validate LLM config early if both flags are set
    if (cmdOpts.llmProvider || cmdOpts.llmKeyFromEnv) {
      try {
        validateLlmConfig({ llmProvider: cmdOpts.llmProvider, llmKeyFromEnv: cmdOpts.llmKeyFromEnv });
      } catch (err) {
        console.error(kleur.red(`LLM config error: ${err.message}`));
        process.exit(2);
      }
    }

    const spinner = ora('Scanning library...').start();

    try {
      const libraryResult = await auditLibrary(directory, {
        engagementId: cmdOpts.engagement,
        standard: cmdOpts.standard,
        packageType: cmdOpts.packageType,
        browser: cmdOpts.browser,
        timeoutDynamic: cmdOpts.timeoutDynamic ? parseInt(cmdOpts.timeoutDynamic, 10) : 30000,
        brandConfigPath: cmdOpts.brandConfig,
        engagementRedact: cmdOpts.engagementRedact,
        llmProvider: cmdOpts.llmProvider,
        llmKeyFromEnv: cmdOpts.llmKeyFromEnv,
      });

      spinner.succeed(`Audited ${libraryResult.packages.length} packages`);

      // Summary — count by status: 'clean' (no violations), 'violations' (has violations), 'error' (audit failed)
      const cleanCount = libraryResult.packages.filter((p) => p.status === 'clean').length;
      const failCount = libraryResult.packages.filter((p) => p.status === 'violations').length;
      const errorCount = libraryResult.packages.filter((p) => p.status === 'error').length;

      console.log(kleur.green(`Clean: ${cleanCount} | Violations: ${failCount} | Errors: ${errorCount}`));
      console.log(`Library rollup: ./engagements/${cmdOpts.engagement}/_library-rollup.html`);

      // Exit based on whether any package had violations
      if (errorCount > 0) {
        process.exit(2);
      } else if (failCount > 0) {
        process.exit(1);
      } else {
        process.exit(0);
      }
    } catch (err) {
      spinner.stop();
      console.error(kleur.red(`Library audit error: ${err.message}`));
      process.exit(2);
    }
  } catch (err) {
    console.error(kleur.red(`Fatal error: ${err.message}`));
    process.exit(2);
  }
}
