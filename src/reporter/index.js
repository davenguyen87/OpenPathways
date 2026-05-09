const fs = require('fs').promises;
const path = require('path');
const { buildScorecard, serializeScorecard } = require('./json');
const { renderMarkdown } = require('./markdown');
const { renderMarkdownV3 } = require('./markdown-v3');
const { renderHtml } = require('./html');
const { renderText } = require('./text');
const { generateSarif } = require('./sarif');
const { loadChecks } = require('../lib/load-checks');
const { loadDynamicChecks } = require('../lib/load-dynamic-checks');
const { mapAllFindings } = require('../lib/section508');
const { tagAllFindings, dominantTriage, TRIAGE_TIERS } = require('../lib/triage');
const { estimateAllEfforts, rollupPackage, loadCalibration } = require('../lib/scope-estimator');
const { buildSection508Table } = require('../lib/section508');
const { extractTopRisks } = require('../lib/top-risks');

/**
 * Main writeReports function.
 *
 * Enhanced in v3 to:
 * 1. Enrich scorecard with v3 fields (triage, scope, 508, topRisks)
 * 2. Route output to engagement-namespaced paths
 * 3. Generate HTML reports via renderHtml
 * 4. Generate v3 Markdown via renderMarkdownV3
 *
 * @param {object} config - { scorecard, violations, manualReview, options, scos, dynamicReport, fixesApplied }
 * @returns {Promise<{ jsonPath?: string, mdPath?: string, htmlPath?: string, jsonString?: string }>}
 */
async function writeReports(config) {
  const { violations, manualReview, options, scos, dynamicReport, fixesApplied } = config;

  const {
    json: jsonOnly = false,
    format = 'md',
    output = './prism-report',
    standard = 'wcag21',
    packageType,
    packagePath,
    maxViolations,
    iframeWarnings = [],
    engagementId = null,
    engagementRedact = false,
    brandConfigPath = null,
    llmProvider = null,
    llmKeyFromEnv = null,
    llmModel = null,
    llmNarrative = true,                    // v3.1: narrative is on by default when LLM is configured
    llmNarrativeTokenBudget = 30000,        // v3.1: per-package narrative budget
    llmNarrativeCriterionCap = 12,          // v3.1: max per-criterion guides
    clientName = null,
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

  // ===== V3 ENRICHMENT: Enrich violations BEFORE scorecard building =====
  // This ensures the enriched violations are included in the scorecard
  if (engagementId) {
    // 1. Map all findings to Section 508 references
    mapAllFindings(violations);

    // 2. Tag each violation with a triage category
    const context = {
      packageType: packageType || 'unknown',
      packageScale: violations.length,
    };
    tagAllFindings(violations, context);

    // 3. Estimate effort for each finding
    const calibration = loadCalibration(brandConfigPath);
    estimateAllEfforts(violations, calibration);
  }

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
      engagementId,
      clientName,
    },
    checks: checksByStandard,
    scos,
    dynamicReport,
    fixesApplied,
    dynamicCheckIds,
  });

  // ===== V3 POST-SCORECARD ENRICHMENTS =====
  if (engagementId) {
    // Build enrichments for the scorecard
    scorecard.section508Table = buildSection508Table(violations);
    scorecard.scopeEstimate = rollupPackage(violations);
    const topRisksResult = extractTopRisks(violations);
    scorecard.topRisks = topRisksResult.risks || [];

    // Triage rollup: aggregate counts by tag
    const triageRollup = {};
    const triageCounts = {};
    for (const tier of TRIAGE_TIERS) {
      triageCounts[tier] = 0;
    }
    for (const v of violations) {
      if (v.triage) {
        triageCounts[v.triage] = (triageCounts[v.triage] || 0) + 1;
      }
    }
    for (const tier of TRIAGE_TIERS) {
      triageRollup[tier] = triageCounts[tier];
    }
    // Also count clean packages (no violations at all)
    if (violations.length === 0) {
      triageRollup.clean = 1;
    }

    const dominantTag = dominantTriage(violations);
    scorecard.triage = {
      rollup: {
        dominantTag,
        byTriage: triageRollup,
      },
    };
  }

  // ===== V3.1: GENERATE LLM NARRATIVE (opt-in, before serialization) =====
  // Narrative reads the fully-enriched scorecard and produces an `auditNarrative`
  // object the renderers will surface as "Section 01a — Engagement Narrative".
  // Gated on engagement mode + LLM provider + the --no-llm-narrative opt-out.
  // Failures (missing provider, validator rejection, token budget) leave the
  // section null; renderers fall back to the existing programmatic templates.
  if (engagementId && llmNarrative !== false) {
    const { buildProviderFromOptions } = require('../lib/llm-provenance');
    const { generateNarrative } = require('../lib/audit-narrative');
    const provider = buildProviderFromOptions({ llmProvider, llmKeyFromEnv, llmModel });
    if (provider) {
      try {
        const narrative = await generateNarrative({
          auditResults: scorecard,
          options: {
            engagementId,
            clientName,
            redactClientName: engagementRedact,
            llmNarrativeTokenBudget,
            llmNarrativeCriterionCap
          },
          provider
        });
        if (narrative) {
          scorecard.auditNarrative = narrative;
        }
      } catch (_err) {
        // Narrative is best-effort — the scorecard itself is the deliverable.
      }
    }
  }

  // Serialize to JSON
  const jsonString = serializeScorecard(scorecard);

  // If --json flag only: return jsonString and exit
  if (jsonOnly) {
    return { jsonString };
  }

  // Determine output directory with path traversal protection
  let outputDir = output;

  // Resolve the path to prevent directory traversal attacks
  // When engagementId is provided, ensure output stays within engagements/
  if (engagementId) {
    // Normalize the path to remove .. and . segments
    const resolved = path.resolve(outputDir);
    const engagementsDir = path.resolve(path.join(process.cwd(), 'engagements'));

    // Ensure the resolved path is within engagements/ directory
    if (!resolved.startsWith(engagementsDir)) {
      outputDir = path.join(engagementsDir, path.basename(engagementId), path.basename(output || 'report'));
    } else {
      outputDir = resolved;
    }
  }

  // Create output directory if needed
  await fs.mkdir(outputDir, { recursive: true });

  // Write JSON file
  const jsonPath = path.join(outputDir, 'results.json');
  await fs.writeFile(jsonPath, jsonString, 'utf8');

  let reportPaths = {
    jsonPath,
    jsonString,
  };

  // ===== V3 PATH: HTML + v3 Markdown =====
  if (engagementId) {
    // Load brand config (use default from config/brand.json if not provided)
    let brandConfig = null;
    const brandPath = brandConfigPath || path.join(process.cwd(), 'config', 'brand.json');
    try {
      const brandStr = await fs.readFile(brandPath, 'utf8');
      brandConfig = JSON.parse(brandStr);
    } catch (err) {
      // Silent fallback to null — renderHtml has a defaultBrand() function
      console.warn(`Could not load brand config from ${brandPath}, using defaults`);
    }

    // Render HTML
    const htmlReport = renderHtml(scorecard, {
      brand: brandConfig || undefined,
      engagementId,
      redactClientName: engagementRedact,
      narrative: scorecard.auditNarrative,    // v3.1
    });
    const htmlPath = path.join(outputDir, 'report.html');
    await fs.writeFile(htmlPath, htmlReport, 'utf8');
    reportPaths.htmlPath = htmlPath;

    // Render v3 Markdown
    const mdReport = renderMarkdownV3(scorecard, {
      engagementRedact,
      narrative: scorecard.auditNarrative,    // v3.1
    });
    const mdPath = path.join(outputDir, 'report.md');
    await fs.writeFile(mdPath, mdReport, 'utf8');
    reportPaths.mdPath = mdPath;
  } else {
    // ===== V2 BACKWARD COMPAT PATH =====
    let reportPath;
    if (format === 'txt') {
      const textReport = renderText(scorecard);
      reportPath = path.join(outputDir, 'report.txt');
      await fs.writeFile(reportPath, textReport, 'utf8');
      reportPaths.txtPath = reportPath;
    } else if (format === 'sarif') {
      const sarifReport = generateSarif({ scorecard, violations });
      reportPath = path.join(outputDir, 'results.sarif');
      await fs.writeFile(reportPath, sarifReport, 'utf8');
      reportPaths.sarifPath = reportPath;
    } else {
      // Default to markdown
      const mdReport = renderMarkdown(scorecard);
      reportPath = path.join(outputDir, 'report.md');
      await fs.writeFile(reportPath, mdReport, 'utf8');
      reportPaths.mdPath = reportPath;
    }
  }

  return reportPaths;
}

module.exports = { writeReports };
