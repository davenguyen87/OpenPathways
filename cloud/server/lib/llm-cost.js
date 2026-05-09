/**
 * LLM cost estimator for Anthropic models.
 *
 * Pricing table (as of 2026-05): per 1M tokens, in USD.
 * Source: Anthropic's published pricing page. Update here when pricing changes.
 *
 * Supported models use the alias form (without date suffix) since that is what
 * the provider module uses. Model IDs from the API response may include date
 * suffixes (e.g. "claude-haiku-4-5-20250305") — we normalize by checking
 * whether the returned model string contains a known alias as a prefix.
 */

'use strict';

// Pricing per 1M tokens: { inputPer1M, outputPer1M }
const PRICING = {
  'claude-haiku-4-5':  { inputPer1M: 1,  outputPer1M: 5  },
  'claude-sonnet-4-6': { inputPer1M: 3,  outputPer1M: 15 },
  'claude-opus-4-7':   { inputPer1M: 5,  outputPer1M: 25 },
};

// Ordered from most-specific to least so prefix matching doesn't misfire.
const PRICING_ALIASES = Object.keys(PRICING);

/**
 * Find the pricing entry for a given model id.
 *
 * First tries an exact match, then tries prefix matching (API responses often
 * return date-suffixed ids like "claude-haiku-4-5-20250305").
 *
 * @param {string} model
 * @returns {{ inputPer1M: number, outputPer1M: number } | null}
 */
function lookupPricing(model) {
  if (!model || typeof model !== 'string') return null;
  const normalized = model.toLowerCase().trim();

  // Exact match.
  if (PRICING[normalized]) return PRICING[normalized];

  // Prefix match for date-suffixed variants.
  for (const alias of PRICING_ALIASES) {
    if (normalized.startsWith(alias)) return PRICING[alias];
  }

  return null;
}

/**
 * Estimate the cost of an LLM call in USD.
 *
 * @param {{ model: string, inputTokens: number, outputTokens: number }} opts
 * @returns {number} Estimated cost in USD (may be 0.0 for very small calls).
 */
function estimateCostUsd({ model, inputTokens, outputTokens }) {
  const pricing = lookupPricing(model);

  if (!pricing) {
    // Unknown model — warn and use Haiku pricing as a safe lower bound so we
    // never over-charge in the telemetry display.
    console.warn(
      `[llm-cost] unknown model "${model}"; using Haiku pricing as lower bound`
    );
    const fallback = PRICING['claude-haiku-4-5'];
    return (
      ((inputTokens || 0) / 1_000_000) * fallback.inputPer1M +
      ((outputTokens || 0) / 1_000_000) * fallback.outputPer1M
    );
  }

  return (
    ((inputTokens || 0) / 1_000_000) * pricing.inputPer1M +
    ((outputTokens || 0) / 1_000_000) * pricing.outputPer1M
  );
}

module.exports = { estimateCostUsd, PRICING, lookupPricing };
