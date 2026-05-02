#!/usr/bin/env node

const { program } = require('commander');
const path = require('path');
const { audit } = require('./index');
const { writeReports } = require('./reporter');
const { loadBaseline, diffAgainstBaseline } = require('./lib/baseline');
const kleur = require('kleur');
const ora = require('ora').default;

const VERSION = '1.0.0';

program
  .name('open-pathways')
  .version(VERSION, '-v, --version')
  .description('Audit SCORM/AICC packages for WCAG 2.2 AA compliance')
  .argument('<package>', 'Path to .zip SCORM/AICC package')
  .option('--baseline <path>', 'Path to prior results.json; suppress violations present in baseline')
  .option('--browser <browser>', 'Browser for dynamic checks: chromium|firefox|webkit (default: chromium)', 'chromium')
  .option('--fix', 'Apply mechanical fixes; writes <package>.scorm-fixed.zip')
  .option('--fix-dry-run', 'Preview fixes without writing')
  .option('--format <format>', 'Report format: md|txt (default: md)', 'md')
  .option('--json', 'Output JSON scorecard to stdout only (suppresses spinner/logs)')
  .option('--max-violations <n>', 'Maximum violations allowed before failing (default: unlimited)', null)
  .option('--output <dir>', 'Output directory for reports (default: ./open-pathways-report)', './open-pathways-report')
  .option('--package-type <type>', 'Package type: scorm12|scorm2004|aicc|cmi5|xapi|auto (default: auto)', 'auto')
  .option('--standard <standard>', 'WCAG standard: wcag21|wcag22 (default: wcag22)', 'wcag22')
  .option('--timeout-dynamic <ms>', 'Timeout (ms) per SCO for dynamic checks (default: 30000)', '30000')
  .parse(process.argv);

const opts = program.opts();
const packagePath = program.args[0];

(async () => {
  try {
    // Validate mutually exclusive flags
    if (opts.fix && opts.fixDryRun) {
      console.error(kleur.red('Error: --fix and --fix-dry-run are mutually exclusive'));
      process.exit(2);
    }

    // Determine if we should suppress spinner/logs when --json is set
    const isJsonOnly = opts.json;

    // Create spinner only if not JSON-only mode
    let spinner = null;
    if (!isJsonOnly) {
      spinner = ora('Analyzing package...').start();
    }

    // Run the audit
    let auditResult;
    try {
      auditResult = await audit(packagePath, {
        packageType: opts.packageType,
        standard: opts.standard,
        browser: opts.browser,
        timeoutDynamic: opts.timeoutDynamic ? parseInt(opts.timeoutDynamic, 10) : 30000,
        fix: opts.fix,
        fixDryRun: opts.fixDryRun,
        packagePath,
        jsonOnly: isJsonOnly,
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
    if (opts.baseline) {
      try {
        const baseline = await loadBaseline(opts.baseline);
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

    // Build options for reporter
    const reporterOptions = {
      json: opts.json,
      format: opts.format,
      output: opts.output,
      standard: opts.standard,
      packageType: auditResult.packageType,
      packagePath: packagePath,
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
    if (opts.json && reportResult.jsonString) {
      console.log(reportResult.jsonString);
    } else if (!isJsonOnly) {
      // Log summary info
      const scoreMsg = `Score: ${auditResult.scorecard.score}% | Violations: ${auditResult.violations.length}`;
      if (auditResult.scorecard.passed) {
        console.log(kleur.green(scoreMsg));
      } else {
        console.log(kleur.yellow(scoreMsg));
      }

      if (reportResult.mdPath) {
        console.log(`Full report: ${reportResult.mdPath}`);
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

    const maxViolations = opts.maxViolations ? parseInt(opts.maxViolations, 10) : null;
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
})();
