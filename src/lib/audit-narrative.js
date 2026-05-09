/**
 * Audit Narrative Generation (v3.1)
 *
 * Converts a v3 audit scorecard into consultant-ready prose: an executive
 * narrative, per-criterion remediation guides, and a prioritized scope memo.
 * All text is LLM-generated via the existing provider abstraction, gated on
 * a pre-built provider instance passed in by the caller.
 *
 * Design notes:
 * - Provider is always passed in — never constructed here. Per-engagement
 *   isolation is the caller's responsibility (mirrors v4.1 assisted fixers).
 * - Each section is independent. A failed or invalid section goes to null;
 *   others still attempt. Renderers must handle partial / fully-null shapes.
 * - Token budget is tracked in a running counter across all calls. When the
 *   next call would push past the budget, remaining sections are skipped and
 *   their slot is left null.
 * - Validators mirror the assisted-fixer pattern: return null on pass, string
 *   reason on rejection. On rejection the section is null (not an error).
 */

'use strict';

const { generateAssistedSuggestion, hashPrompt } = require('./llm-provenance');

// ---------------------------------------------------------------------------
// JSDoc typedefs
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Provenance
 * @property {string} source         Always 'llm'.
 * @property {string} provider       Provider name (e.g. 'anthropic').
 * @property {string} model          Model id actually used.
 * @property {string} promptHash     sha256:… of the rendered prompts.
 * @property {{ inputTokens: number, outputTokens: number }} usage
 * @property {number} latencyMs
 * @property {string} generatedAt    ISO 8601 UTC.
 */

/**
 * @typedef {Object} NarrativeSection
 * @property {string} text
 * @property {Provenance} provenance
 */

/**
 * @typedef {Object} CriterionGuide
 * @property {string} criterion      e.g. '1.1.1'
 * @property {string} criterionName  e.g. 'Non-text content'
 * @property {string} text
 * @property {Provenance} provenance
 */

/**
 * @typedef {Object} NarrativeTotals
 * @property {number} sectionsAttempted
 * @property {number} sectionsSucceeded
 * @property {number} totalInputTokens
 * @property {number} totalOutputTokens
 * @property {number} totalLatencyMs
 */

/**
 * @typedef {Object} AuditNarrative
 * @property {'1.0.0'} schemaVersion
 * @property {NarrativeSection|null} executive
 * @property {CriterionGuide[]|null} remediationGuides
 * @property {NarrativeSection|null} scopeMemo
 * @property {NarrativeTotals} totals
 */

/**
 * @typedef {Object} LibrarySynthesis
 * @property {'1.0.0'} schemaVersion
 * @property {NarrativeSection|null} synthesis
 * @property {NarrativeTotals} totals
 */

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Build prompts for the executive narrative section.
 *
 * @param {Object} scorecard   Full audit scorecard.
 * @param {Object} options     Options carrying engagementId, clientName, etc.
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
function buildExecutivePrompt(scorecard, options = {}) {
  const { engagementId = '', clientName, redactClientName } = options;
  const clientLabel = (!redactClientName && clientName) ? clientName : 'the client';

  const systemPrompt = [
    'You are a Skill Loop accessibility consultant writing an executive narrative for a buyer (LMS administrator or training director). ',
    'Your audience is non-technical. They care about business impact and next steps, not technical specifications.',
    '',
    'Constraints:',
    '- Exactly two paragraphs, ≤ 240 words total.',
    '- Paragraph one: name what dominates the findings. Cite real numbers from the data provided.',
    '- Paragraph two: explain what the consultant would do first, in plain language.',
    '- Reference criteria by descriptive name only (e.g. "color contrast", "missing image descriptions") — never by WCAG SC number or code (e.g. never "1.4.3" or "SC 1.4.3").',
    '- No file paths, no SCO IDs, no package-internal identifiers.',
    '- No invented numbers. Every figure you cite must appear in the data provided.',
    '- Do not begin with "As an AI", "I am", "As an accessibility expert", or similar throat-clearing.',
    '- Do not use jargon (WCAG, Section 508, axe-core, etc.).',
    '- Plain text only. No markdown headers, no bullet lists. Two paragraphs separated by a blank line.',
  ].join('\n');

  const topCriteria = (scorecard.criteria || [])
    .filter((c) => c.violationCount > 0)
    .sort((a, b) => b.violationCount - a.violationCount)
    .slice(0, 5)
    .map((c) => `  ${c.name} (${c.violationCount} violations, Level ${c.level})`)
    .join('\n');

  const triageRollup = scorecard.triage && scorecard.triage.rollup
    ? JSON.stringify(scorecard.triage.rollup, null, 2)
    : '(not available)';

  const scopeHours = scorecard.scopeEstimate
    ? JSON.stringify(scorecard.scopeEstimate, null, 2)
    : '(not available)';

  const topRisks = Array.isArray(scorecard.topRisks)
    ? scorecard.topRisks.slice(0, 3).join('; ')
    : '(none listed)';

  const userPrompt = [
    `Engagement: ${engagementId}`,
    `Client: ${clientLabel}`,
    `Package type: ${scorecard.packageType || 'unknown'}`,
    '',
    '=== Summary ===',
    JSON.stringify(scorecard.summary || {}, null, 2),
    '',
    '=== Top failing criteria (by violation count) ===',
    topCriteria || '(none)',
    '',
    '=== Triage rollup ===',
    triageRollup,
    '',
    '=== Scope estimate ===',
    scopeHours,
    '',
    '=== Top three risks ===',
    topRisks,
    '',
    'Write the executive narrative now.',
  ].join('\n');

  return { systemPrompt, userPrompt };
}

/**
 * Build prompts for one per-criterion remediation guide.
 *
 * @param {Object} criterion         Criterion object from scorecard.criteria.
 * @param {Object[]} violations      Violations filtered to this criterion.
 * @param {Object} [triageMeta]      Optional triage tag and effort info for this criterion.
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
function buildCriterionGuidePrompt(criterion, violations, triageMeta = {}) {
  const systemPrompt = [
    'You are a senior accessibility consultant explaining a specific finding to a content author.',
    '',
    'Constraints:',
    '- One paragraph, ≤ 100 words.',
    '- Describe what is wrong *in this package specifically* using the examples provided.',
    '- Describe the fix shape in 1–2 concrete actions (no quoted code).',
    '- Do not paraphrase the WCAG success criterion text — the reader can follow the provided URL.',
    '- Do not include the SC number (e.g. do not write "1.1.1" or "SC 1.1.1").',
    '- Do not include file paths or filenames in the prose (the violations table already shows them).',
    '- Plain text only. No bullet lists, no headers.',
  ].join('\n');

  const exampleViolations = (violations || [])
    .slice(0, 5)
    .map((v) => `  [line ${v.line || '?'}] ${v.message}${v.snippet ? ' — ' + v.snippet.slice(0, 80) : ''}`)
    .join('\n');

  const userPrompt = [
    `Criterion: ${criterion.name}`,
    criterion.url ? `Reference: ${criterion.url}` : '',
    `Level: ${criterion.level || '?'}`,
    `Total violations in this package: ${criterion.violationCount}`,
    triageMeta.triageTag ? `Triage classification: ${triageMeta.triageTag}` : '',
    triageMeta.effortBand ? `Effort band: ${triageMeta.effortBand}` : '',
    '',
    '=== Example violations (up to 5) ===',
    exampleViolations || '(none provided)',
    '',
    'Write the remediation guide now.',
  ].filter(Boolean).join('\n');

  return { systemPrompt, userPrompt };
}

/**
 * Build prompts for the recommended remediation order / scope memo.
 *
 * @param {Object[]} failedCriteria  Criteria with violationCount > 0.
 * @param {string[]} topRisks        Top three risks from the scorecard.
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
function buildScopeMemoPrompt(failedCriteria, topRisks) {
  const systemPrompt = [
    'You are a consultant writing the scope memo for this accessibility remediation engagement.',
    '',
    'Constraints:',
    '- A short prioritized list of 3–7 items.',
    '- Each item is exactly one sentence.',
    '- Each sentence starts with an action verb ("Start with…", "Defer…", "Batch-fix…", "Address…").',
    '- Each item names a criterion by descriptive name (not by SC number) and includes a one-clause rationale.',
    '- No file paths. No "we recommend". Use declarative voice.',
    '- Format: one item per line, no leading bullets or numbers. Plain text.',
    '- Total list must have between 3 and 7 items (inclusive).',
  ].join('\n');

  const criteriaLines = (failedCriteria || [])
    .slice(0, 20)
    .map((c) => `  ${c.name}: ${c.violationCount} violations${c.triageTag ? ', ' + c.triageTag : ''}${c.effortBand ? ', effort: ' + c.effortBand : ''}`)
    .join('\n');

  const userPrompt = [
    '=== Failed criteria (by violation count) ===',
    criteriaLines || '(none)',
    '',
    '=== Top risks ===',
    Array.isArray(topRisks) ? topRisks.slice(0, 3).join('\n') : '(none)',
    '',
    'Write the prioritized remediation list now.',
  ].join('\n');

  return { systemPrompt, userPrompt };
}

/**
 * Build prompts for the library-level synthesis (rollup variant).
 *
 * @param {Object[]} packageSummaries  Per-package summaries for the prompt.
 * @param {Object}   aggregate         Cross-library totals.
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
function buildLibrarySynthesisPrompt(packageSummaries, aggregate) {
  const systemPrompt = [
    'You are a consultant writing the engagement-level synthesis for a multi-package accessibility audit.',
    '',
    'Constraints:',
    '- Exactly two paragraphs, ≤ 320 words total.',
    '- Paragraph one: name the dominant cross-package pattern, citing how many packages exhibit it.',
    '- Paragraph two: recommend one or two engagement-wide actions (e.g. "a single template fix lifts compliance across X packages").',
    '- No file paths, no package-internal identifiers.',
    '- No invented numbers. Every figure you cite must appear in the data provided.',
    '- Do not begin with "As an AI", "I am", or similar.',
    '- Plain text only. Two paragraphs separated by a blank line.',
  ].join('\n');

  const pkgLines = (packageSummaries || [])
    .slice(0, 50)
    .map((p) => `  ${p.packageName}: ${p.totalViolations} violations, dominant criterion: ${p.dominantCriterion || 'unknown'}, triage: ${p.dominantTriage || 'unknown'}, scope: ${p.scopeHours != null ? p.scopeHours + 'h' : 'unknown'}`)
    .join('\n');

  const userPrompt = [
    '=== Per-package summary ===',
    pkgLines || '(none)',
    '',
    '=== Library-wide aggregates ===',
    JSON.stringify(aggregate || {}, null, 2),
    '',
    'Write the library synthesis now.',
  ].join('\n');

  return { systemPrompt, userPrompt };
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/**
 * Validate executive narrative text.
 *
 * @param {string} text
 * @param {Object} scorecardInputs  The same scorecard passed to the prompt builder.
 * @returns {string|null}  null on pass, reason string on rejection.
 */
function validateExecutive(text, scorecardInputs) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return 'executive text is empty';
  }

  // Reject AI-intro prefixes
  const trimmed = text.trimStart();
  if (/^(As an AI|I am\b)/i.test(trimmed)) {
    return 'executive starts with disallowed AI-intro phrase';
  }

  // No raw HTML angle brackets
  if (/<|>/.test(text)) {
    return 'executive contains raw < or > characters';
  }

  // Word count ≤ 280
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length > 280) {
    return `executive word count ${words.length} exceeds 280`;
  }

  // Numeric grounding: every number-like token in the text must appear in some
  // stringified form within the scorecard inputs. Coarse hallucination check.
  const inputsStr = JSON.stringify(scorecardInputs || {});
  const numTokens = text.match(/\b\d[\d,.]*%?\b/g) || [];
  for (const tok of numTokens) {
    // Normalize: strip trailing % and commas before checking, but also try raw form.
    const normalized = tok.replace(/,/g, '').replace(/%$/, '');
    if (!inputsStr.includes(tok) && !inputsStr.includes(normalized)) {
      return `executive contains number "${tok}" not found in scorecard inputs`;
    }
  }

  return null;
}

/**
 * Validate a per-criterion remediation guide.
 *
 * @param {string} text
 * @param {string} criterionId  e.g. '1.1.1'
 * @returns {string|null}
 */
function validateCriterionGuide(text, criterionId) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return 'criterion guide text is empty';
  }

  // Word count ≤ 120
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length > 120) {
    return `criterion guide word count ${words.length} exceeds 120`;
  }

  // Must not contain the literal SC number (want plain language, not WCAG citation)
  if (criterionId && text.includes(criterionId)) {
    return `criterion guide contains literal SC number "${criterionId}"`;
  }

  // Must not contain file-path-like tokens (e.g. "module1.html", "styles.css")
  if (/\b[a-z0-9_-]+\.(html?|js|css)\b/i.test(text)) {
    return 'criterion guide contains a file-path-like token';
  }

  return null;
}

/**
 * Validate the scope memo (prioritized list).
 *
 * @param {string} text
 * @returns {string|null}
 */
function validateScopeMemo(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return 'scope memo text is empty';
  }

  // Parse as list: split on newlines, drop empty lines
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  if (lines.length < 3) {
    return `scope memo has ${lines.length} items; minimum is 3`;
  }
  if (lines.length > 8) {
    return `scope memo has ${lines.length} items; maximum is 8`;
  }

  for (const line of lines) {
    const wordCount = line.split(/\s+/).filter(Boolean).length;
    if (wordCount > 35) {
      return `scope memo item exceeds 35 words: "${line.slice(0, 60)}…"`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a successful LLM result into the Provenance shape required by the PRD.
 *
 * @param {Object} raw  Object from generateAssistedSuggestion (ok: true branch).
 * @returns {Provenance}
 */
function buildProvenance(raw) {
  return {
    source: 'llm',
    provider: raw.provenance.provider,
    model: raw.provenance.model,
    promptHash: raw.provenance.promptHash,
    usage: raw.provenance.usage || { inputTokens: 0, outputTokens: 0 },
    latencyMs: raw.provenance.latencyMs || 0,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Extract usage totals from a provenance object.
 *
 * @param {Provenance} prov
 * @returns {{ inputTokens: number, outputTokens: number, latencyMs: number }}
 */
function extractUsage(prov) {
  return {
    inputTokens: (prov.usage && prov.usage.inputTokens) || 0,
    outputTokens: (prov.usage && prov.usage.outputTokens) || 0,
    latencyMs: prov.latencyMs || 0,
  };
}

/**
 * Rough token estimate for budget check before making a call.
 * 1 token ≈ 4 chars; we add a conservative 20 % overhead.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {number}
 */
function estimateInputTokens(systemPrompt, userPrompt) {
  return Math.ceil(((systemPrompt.length + userPrompt.length) / 4) * 1.2);
}

// ---------------------------------------------------------------------------
// Primary entry: generateNarrative
// ---------------------------------------------------------------------------

/**
 * Generate an AuditNarrative for a single-package scorecard.
 *
 * @param {Object} args
 * @param {Object} args.auditResults   Full audit scorecard (buildScorecard() output).
 * @param {Object} [args.options]      Narrative generation options.
 * @param {string} [args.options.engagementId]
 * @param {string} [args.options.clientName]
 * @param {boolean} [args.options.redactClientName]
 * @param {number}  [args.options.llmNarrativeTokenBudget]   Default 30000.
 * @param {number}  [args.options.llmNarrativeCriterionCap]  Default 12.
 * @param {Object|null} args.provider  Pre-built provider instance (from llm-provider.js).
 * @returns {Promise<AuditNarrative|null>}
 */
async function generateNarrative({ auditResults, options = {}, provider }) {
  if (!provider) return null;

  const tokenBudget = options.llmNarrativeTokenBudget != null
    ? options.llmNarrativeTokenBudget
    : 30000;
  const criterionCap = options.llmNarrativeCriterionCap != null
    ? options.llmNarrativeCriterionCap
    : 12;

  // Running budget tracker
  let usedTokens = 0;
  let sectionsAttempted = 0;
  let sectionsSucceeded = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalLatencyMs = 0;

  /**
   * Attempt one LLM section call.
   * Returns the section object { text, provenance } on success, null on skip or failure.
   *
   * @param {Object} prompts   { systemPrompt, userPrompt }
   * @param {Function} validator  (text, ...extraArgs) => null | string
   * @param {*[]} validatorArgs   Extra args passed to the validator after text.
   * @param {Object} inputsForValidation  Inputs object passed to validateExecutive (may be null).
   */
  async function attemptSection(prompts, validator, validatorArgs = [], inputsForValidation = null) {
    const { systemPrompt, userPrompt } = prompts;

    // Token budget pre-check
    const estimatedInput = estimateInputTokens(systemPrompt, userPrompt);
    if (usedTokens + estimatedInput > tokenBudget) {
      return null; // budget exceeded — skip silently
    }

    sectionsAttempted++;
    const result = await generateAssistedSuggestion({
      systemPrompt,
      userPrompt,
      options,
      provider,
    });

    if (!result.ok) {
      return null;
    }

    // Run validator
    const rejectReason = inputsForValidation !== null
      ? validator(result.text, inputsForValidation, ...validatorArgs)
      : validator(result.text, ...validatorArgs);

    if (rejectReason) {
      return null;
    }

    const prov = buildProvenance(result);
    const usage = extractUsage(prov);

    usedTokens += usage.inputTokens + usage.outputTokens;
    totalInputTokens += usage.inputTokens;
    totalOutputTokens += usage.outputTokens;
    totalLatencyMs += usage.latencyMs;
    sectionsSucceeded++;

    return { text: result.text, provenance: prov };
  }

  // --- 1. Executive narrative ---
  const execPrompts = buildExecutivePrompt(auditResults, options);
  const executive = await attemptSection(
    execPrompts,
    validateExecutive,
    [],
    auditResults
  );

  // --- 2. Per-criterion remediation guides ---
  const failedCriteria = (auditResults.criteria || [])
    .filter((c) => c.violationCount > 0)
    .sort((a, b) => b.violationCount - a.violationCount)
    .slice(0, criterionCap);

  const remediationGuides = [];

  for (const criterion of failedCriteria) {
    // Budget check before each per-criterion call
    const violationsForCriterion = (auditResults.violations || [])
      .filter((v) => v.criterion === criterion.id);

    // Collect triage meta from violations
    const triageCounts = {};
    for (const v of violationsForCriterion) {
      if (v.triage) triageCounts[v.triage] = (triageCounts[v.triage] || 0) + 1;
    }
    const triageTag = Object.keys(triageCounts).sort((a, b) => triageCounts[b] - triageCounts[a])[0] || null;

    const guide = await attemptSection(
      buildCriterionGuidePrompt(criterion, violationsForCriterion, { triageTag }),
      validateCriterionGuide,
      [criterion.id]
    );

    if (guide) {
      remediationGuides.push({
        criterion: criterion.id,
        criterionName: criterion.name,
        text: guide.text,
        provenance: guide.provenance,
      });
    }
    // If guide is null (failed/budget/validation), simply skip — not a fatal error.
  }

  // remediationGuides is null only when no criteria existed at all; otherwise it's the
  // array (possibly empty if every guide failed).
  const remediationGuidesOut = failedCriteria.length === 0 ? null
    : remediationGuides.length > 0 ? remediationGuides
    : null;

  // --- 3. Scope memo ---
  // Enrich failed criteria with triage tags before building the prompt
  const failedCriteriaWithTriage = failedCriteria.map((c) => {
    const violationsForC = (auditResults.violations || []).filter((v) => v.criterion === c.id);
    const triageCounts = {};
    for (const v of violationsForC) {
      if (v.triage) triageCounts[v.triage] = (triageCounts[v.triage] || 0) + 1;
    }
    const triageTag = Object.keys(triageCounts).sort((a, b) => triageCounts[b] - triageCounts[a])[0] || null;
    return { ...c, triageTag };
  });

  const scopeMemoRaw = await attemptSection(
    buildScopeMemoPrompt(failedCriteriaWithTriage, auditResults.topRisks || []),
    validateScopeMemo,
    []
  );

  return {
    schemaVersion: '1.0.0',
    executive,
    remediationGuides: remediationGuidesOut,
    scopeMemo: scopeMemoRaw,
    totals: {
      sectionsAttempted,
      sectionsSucceeded,
      totalInputTokens,
      totalOutputTokens,
      totalLatencyMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Library-rollup entry: generateLibrarySynthesis
// ---------------------------------------------------------------------------

/**
 * Generate a LibrarySynthesis for a multi-package library rollup.
 *
 * @param {Object} args
 * @param {Object} args.libraryAudit    Aggregated library object from auditLibrary().
 * @param {Object} [args.options]       Options (engagementId, token budget, etc.)
 * @param {Object|null} args.provider   Pre-built provider instance.
 * @returns {Promise<LibrarySynthesis|null>}
 */
async function generateLibrarySynthesis({ libraryAudit, options = {}, provider }) {
  if (!provider) return null;

  const tokenBudget = options.llmNarrativeTokenBudget != null
    ? options.llmNarrativeTokenBudget
    : 30000;

  let sectionsAttempted = 0;
  let sectionsSucceeded = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalLatencyMs = 0;

  // Build per-package summaries for the prompt.
  // libraryAudit.packages is the per-package results array; library is the aggregate.
  const packages = Array.isArray(libraryAudit.packages) ? libraryAudit.packages : [];
  const packageSummaries = packages
    .filter((p) => p.status !== 'error' && p.result)
    .map((p) => {
      const scorecard = (p.result && p.result.scorecard) || {};
      const violations = (p.result && p.result.violations) || [];

      // Dominant criterion: most-violated
      const byCriterion = {};
      for (const v of violations) {
        byCriterion[v.criterion] = (byCriterion[v.criterion] || 0) + 1;
      }
      const dominantCriterionId = Object.keys(byCriterion).sort((a, b) => byCriterion[b] - byCriterion[a])[0] || null;
      const dominantCriterionName = dominantCriterionId
        ? ((scorecard.criteria || []).find((c) => c.id === dominantCriterionId) || {}).name || dominantCriterionId
        : null;

      // Dominant triage
      const byTriage = {};
      for (const v of violations) {
        if (v.triage) byTriage[v.triage] = (byTriage[v.triage] || 0) + 1;
      }
      const dominantTriage = Object.keys(byTriage).sort((a, b) => byTriage[b] - byTriage[a])[0] || null;

      const scopeHours = scorecard.scopeEstimate
        ? scorecard.scopeEstimate.totalHours || null
        : null;

      return {
        packageName: p.name,
        totalViolations: (scorecard.summary && scorecard.summary.totalViolations) || 0,
        dominantCriterion: dominantCriterionName,
        dominantTriage,
        scopeHours,
      };
    });

  const aggregate = libraryAudit.library || libraryAudit;

  const prompts = buildLibrarySynthesisPrompt(packageSummaries, {
    packageCount: aggregate.packageCount,
    cleanCount: aggregate.cleanCount,
    triageDistribution: aggregate.triageDistribution,
    totalEffortHours: aggregate.totalEffortHours,
    topRisks: aggregate.topRisks,
  });

  const estimatedInput = estimateInputTokens(prompts.systemPrompt, prompts.userPrompt);
  let synthesis = null;

  if (estimatedInput <= tokenBudget) {
    sectionsAttempted++;
    const result = await generateAssistedSuggestion({
      systemPrompt: prompts.systemPrompt,
      userPrompt: prompts.userPrompt,
      options,
      provider,
    });

    if (result.ok) {
      // Reuse validateExecutive rules for the synthesis (same shape constraints)
      const rejectReason = validateExecutive(result.text, aggregate);
      if (!rejectReason) {
        const prov = buildProvenance(result);
        const usage = extractUsage(prov);
        totalInputTokens += usage.inputTokens;
        totalOutputTokens += usage.outputTokens;
        totalLatencyMs += usage.latencyMs;
        sectionsSucceeded++;
        synthesis = { text: result.text, provenance: prov };
      }
    }
  }

  return {
    schemaVersion: '1.0.0',
    synthesis,
    totals: {
      sectionsAttempted,
      sectionsSucceeded,
      totalInputTokens,
      totalOutputTokens,
      totalLatencyMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  generateNarrative,
  generateLibrarySynthesis,
  // Exported for testing only:
  buildExecutivePrompt,
  buildCriterionGuidePrompt,
  buildScopeMemoPrompt,
  buildLibrarySynthesisPrompt,
  validateExecutive,
  validateCriterionGuide,
  validateScopeMemo,
};
