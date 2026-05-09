/**
 * Transformer Judgment (v5.1)
 *
 * LLM-assisted widget classification for the four v5 widget-replacement
 * transformers (tabs, accordion, carousel, dialog). Takes a heuristic
 * candidate and asks an LLM whether it is actually the expected widget type.
 *
 * Design notes:
 * - Provider is always passed in — never constructed here. Per-engagement
 *   isolation is the caller's responsibility (mirrors v4.1 assisted fixers).
 * - On any provider error, invalid output, or misconfiguration, returns
 *   `{ ok: false, reason }`. The transformer treats this as "no judgment
 *   available" — the heuristic decision stands, no `judgment` field is
 *   attached to the emitted transform.
 * - The only structured-JSON-output prompt in the project. The validator is
 *   designed to be reusable for the v5.2+ positive-discovery prompts that
 *   follow the same schema.
 */

'use strict';

const { generateAssistedSuggestion } = require('./llm-provenance');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum bytes of candidate HTML sent to the LLM. */
const HTML_CLIP_BYTES = 3072;

/** Allowed verdict literals. */
const VALID_VERDICTS = new Set(['match', 'no-match', 'uncertain']);

// ---------------------------------------------------------------------------
// JSDoc typedefs
// ---------------------------------------------------------------------------

/**
 * @typedef {'tabs'|'accordion'|'carousel'|'dialog'} WidgetType
 */

/**
 * @typedef {Object} CandidateStructure
 * @property {string}  [tagName]
 * @property {number}  [childCount]
 * @property {boolean} [hasButtons]
 * @property {boolean} [hasForm]
 * @property {number}  [headingCount]
 */

/**
 * @typedef {Object} WidgetCandidate
 * @property {string}           file       Source file path (for provenance / logging).
 * @property {string}           html       Raw HTML fragment (will be clipped to ~3KB).
 * @property {string[]}         classes    CSS class tokens on the root or key children.
 * @property {CandidateStructure} structure  Structural summary.
 * @property {string}           rationale  The heuristic's reason for the candidate.
 */

/**
 * @typedef {Object} JudgmentProvenance
 * @property {'llm'}   source
 * @property {string}  provider
 * @property {string}  model
 * @property {string}  promptHash
 * @property {{ inputTokens: number, outputTokens: number }} usage
 * @property {number}  latencyMs
 * @property {string}  generatedAt   ISO 8601 UTC.
 */

/**
 * @typedef {Object} JudgmentSuccess
 * @property {true}              ok
 * @property {'match'|'no-match'|'uncertain'} verdict
 * @property {number}            confidence   0..1; 0 when verdict is 'no-match'.
 * @property {string}            rationale    ≤ 280 characters.
 * @property {JudgmentProvenance} provenance
 */

/**
 * @typedef {Object} JudgmentFailure
 * @property {false}  ok
 * @property {string} reason
 */

/**
 * @typedef {JudgmentSuccess|JudgmentFailure} JudgmentResult
 */

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Constant system prompt for `classifyWidget`. Cached-prompt-friendly — do
 * not embed per-call data here.
 *
 * @returns {string}
 */
function buildSystemPrompt() {
  return [
    "You are a senior accessibility engineer reviewing a heuristic's candidate widget for replacement.",
    '',
    'Your task: decide whether the HTML fragment shown is actually the widget type the heuristic expects.',
    '',
    'Rules:',
    '- Reason from the *actual HTML structure* (nesting, roles, element types, aria-* attributes, content)',
    '  not from class names alone. Class names can be misleading — a styled FAQ list may carry',
    '  class="tab-pane" on its items even though it is not a tabs widget.',
    '- Return ONLY a JSON object with exactly three keys: "verdict", "confidence", "rationale".',
    '  No prose before or after the JSON. No markdown fences. No explanations outside the JSON.',
    '- "verdict" must be exactly one of: "match", "no-match", "uncertain".',
    '- "confidence" must be a number in [0.0, 1.0]. Use 0 when verdict is "no-match".',
    '- "rationale" must be a string of ≤ 240 characters explaining the key structural evidence.',
    '',
    'Output format (strict):',
    '{"verdict":"match","confidence":0.92,"rationale":"..."}',
  ].join('\n');
}

/**
 * Build the per-candidate user prompt for `classifyWidget`.
 *
 * @param {WidgetType}       expectedType
 * @param {WidgetCandidate}  candidate
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
function buildClassifyPrompt(expectedType, candidate) {
  const systemPrompt = buildSystemPrompt();

  const htmlClipped = typeof candidate.html === 'string'
    ? candidate.html.slice(0, HTML_CLIP_BYTES)
    : '';

  const structureLine = candidate.structure
    ? JSON.stringify(candidate.structure)
    : '(not provided)';

  const classLine = Array.isArray(candidate.classes) && candidate.classes.length > 0
    ? candidate.classes.join(', ')
    : '(none)';

  const userPrompt = [
    `Expected widget type: ${expectedType}`,
    '',
    '=== Candidate HTML (clipped to 3 KB) ===',
    htmlClipped || '(empty)',
    '',
    '=== Structural summary ===',
    structureLine,
    '',
    '=== CSS class tokens ===',
    classLine,
    '',
    '=== Heuristic rationale ===',
    candidate.rationale || '(none)',
    '',
    'Is this actually a ' + expectedType + ' widget? Return JSON now.',
  ].join('\n');

  return { systemPrompt, userPrompt };
}

// ---------------------------------------------------------------------------
// Output validator
// ---------------------------------------------------------------------------

/**
 * Parse and validate the raw LLM text into a typed verdict object.
 *
 * Handles the common case where a model wraps JSON in markdown code fences
 * (```json ... ``` or ``` ... ```). Strips them before parsing.
 *
 * Trailing text after the closing `}` is ignored — the first complete JSON
 * object wins. This covers models that emit a trailing newline, a comment,
 * or a brief explanation sentence after the object.
 *
 * @param {string} text   Raw text returned by the provider.
 * @returns {{ ok: true, verdict: string, confidence: number, rationale: string }
 *          |{ ok: false, reason: string }}
 */
function parseAndValidateVerdict(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, reason: 'invalid LLM response shape: empty text' };
  }

  // Strip markdown code fences if present: ```json\n...\n``` or ```\n...\n```
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Extract the first JSON object, ignoring trailing text.
  // Find the first '{' and the matching closing '}'.
  const openIdx = cleaned.indexOf('{');
  if (openIdx === -1) {
    return { ok: false, reason: 'invalid LLM response shape: no JSON object found' };
  }

  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < cleaned.length; i++) {
    if (cleaned[i] === '{') depth++;
    else if (cleaned[i] === '}') {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }

  if (closeIdx === -1) {
    return { ok: false, reason: 'invalid LLM response shape: unterminated JSON object' };
  }

  const jsonStr = cleaned.slice(openIdx, closeIdx + 1);

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return { ok: false, reason: `invalid LLM response shape: JSON parse error: ${err.message}` };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid LLM response shape: expected a JSON object' };
  }

  // --- verdict ---
  if (!VALID_VERDICTS.has(parsed.verdict)) {
    return {
      ok: false,
      reason: `invalid LLM response shape: verdict must be "match", "no-match", or "uncertain"; got ${JSON.stringify(parsed.verdict)}`
    };
  }

  // --- confidence ---
  let confidence = Number(parsed.confidence);
  if (!isFinite(confidence)) {
    confidence = 0;
  }
  // Clamp to [0, 1]
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;

  // --- rationale ---
  if (typeof parsed.rationale !== 'string') {
    return { ok: false, reason: 'invalid LLM response shape: rationale must be a string' };
  }
  let rationale = parsed.rationale;
  if (rationale.length > 280) {
    rationale = rationale.slice(0, 280);
  }

  return { ok: true, verdict: parsed.verdict, confidence, rationale };
}

// ---------------------------------------------------------------------------
// Primary entry
// ---------------------------------------------------------------------------

/**
 * Ask the LLM whether a heuristic candidate is actually the expected widget
 * type. Returns the verdict + provenance on success, or `{ ok: false, reason }`
 * on any failure so the transformer can fall back to the heuristic decision.
 *
 * @param {Object}          args
 * @param {Object}          args.packageContext  Rebuild package context (for engagementId / packageName).
 * @param {WidgetCandidate} args.candidate       Heuristic candidate with html, classes, structure, rationale.
 * @param {WidgetType}      args.expectedType    The widget type this transformer expects.
 * @param {Object}          [args.options]       Options bag (engagementId, packageName, llmJudgmentMaxTokens, etc.).
 * @param {Object|null}     args.provider        Pre-built provider instance from llm-provider.js.
 * @returns {Promise<JudgmentResult>}
 */
async function classifyWidget({ packageContext, candidate, expectedType, options, provider }) {
  if (!provider) {
    return { ok: false, reason: '--llm-provider not set' };
  }

  const opts = options || {};
  const maxTokens = opts.llmJudgmentMaxTokens || 256;

  const { systemPrompt, userPrompt } = buildClassifyPrompt(expectedType, candidate);

  const result = await generateAssistedSuggestion({
    systemPrompt,
    userPrompt,
    options: { ...opts, llmMaxTokens: maxTokens },
    provider,
  });

  if (!result.ok) {
    return { ok: false, reason: `LLM call failed: ${result.reason}` };
  }

  const validated = parseAndValidateVerdict(result.text);
  if (!validated.ok) {
    return validated; // passes through `{ ok: false, reason: 'invalid LLM response shape: ...' }`
  }

  const provenance = {
    source: 'llm',
    provider: result.provenance.provider,
    model: result.provenance.model,
    promptHash: result.provenance.promptHash,
    usage: result.provenance.usage || { inputTokens: 0, outputTokens: 0 },
    latencyMs: result.provenance.latencyMs || 0,
    generatedAt: new Date().toISOString(),
  };

  return {
    ok: true,
    verdict: validated.verdict,
    confidence: validated.confidence,
    rationale: validated.rationale,
    provenance,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  classifyWidget,
  // Exported for testing only:
  buildClassifyPrompt,
  parseAndValidateVerdict,
};
