/**
 * LLM usage recorder — walks the output of audit/rebuild calls and records
 * every LLM usage entry into the workspace_llm_usage table.
 *
 * Provenance locations (by feature):
 *   narrative  → enrichedScorecard.auditNarrative.provenance   (from writeReports result)
 *   assisted   → manifest.patches[].provenance  (patches where provenance.source === undefined,
 *                                                i.e. all patches that have a provenance block)
 *   judgment   → manifest.transforms[].judgment.provenance      (from full rebuild)
 *
 * Each provenance block has shape:
 *   { provider, model, promptHash, usage: { inputTokens, outputTokens }, latencyMs }
 *
 * We call recordLlmUsage once per provenance block found.
 */

'use strict';

const crypto = require('crypto');
const { estimateCostUsd } = require('./llm-cost');

/**
 * Record all LLM usage found in an audit result.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {object} opts.store             - SqliteStore | PostgresStore
 * @param {object|null} opts.writeResult  - The object returned from writeReports, or a parsed
 *                                          scorecard. Should have auditNarrative on it when LLM
 *                                          narrative was generated.
 * @param {object|null} [opts.scorecard]  - Enriched scorecard (alternate path if writeResult
 *                                          holds the JSON string rather than a parsed object).
 * @returns {Promise<void>}
 */
async function recordAuditLlmUsage({ userId, store, writeResult, scorecard }) {
  if (!userId || !store || typeof store.recordLlmUsage !== 'function') return;

  // Prefer a parsed scorecard; fall back to parsing writeResult.jsonString.
  let sc = scorecard || null;
  if (!sc && writeResult) {
    if (typeof writeResult.jsonString === 'string') {
      try { sc = JSON.parse(writeResult.jsonString); } catch (_) {}
    } else if (writeResult && typeof writeResult === 'object') {
      sc = writeResult;
    }
  }

  if (!sc) return;

  // narrative provenance
  const narrative = sc.auditNarrative;
  if (narrative && narrative.provenance) {
    await _recordFromProvenance(store, userId, 'narrative', narrative.provenance);
  }
}

/**
 * Record all LLM usage found in a rebuild manifest.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {object} opts.store
 * @param {object|null} opts.manifest - The rebuild manifest object (result.manifest from rebuild()).
 * @returns {Promise<void>}
 */
async function recordRebuildLlmUsage({ userId, store, manifest }) {
  if (!userId || !store || typeof store.recordLlmUsage !== 'function') return;
  if (!manifest) return;

  // assisted-tier patches
  if (Array.isArray(manifest.patches)) {
    for (const patch of manifest.patches) {
      if (patch && patch.provenance && patch.provenance.usage) {
        await _recordFromProvenance(store, userId, 'assisted', patch.provenance);
      }
    }
  }

  // full-tier transform judgment
  if (Array.isArray(manifest.transforms)) {
    for (const transform of manifest.transforms) {
      if (transform && transform.judgment && transform.judgment.provenance) {
        await _recordFromProvenance(store, userId, 'judgment', transform.judgment.provenance);
      }
    }
  }
}

/**
 * Shared helper: record one provenance block.
 *
 * @param {object} store
 * @param {string} userId
 * @param {string} feature  - 'narrative' | 'assisted' | 'judgment'
 * @param {object} provenance - { provider, model, usage: { inputTokens, outputTokens }, ... }
 */
async function _recordFromProvenance(store, userId, feature, provenance) {
  if (!provenance) return;

  const usage = provenance.usage || {};
  const inputTokens = usage.inputTokens || 0;
  const outputTokens = usage.outputTokens || 0;
  const model = provenance.model || 'unknown';
  // provenance.provider is set by generateAssistedSuggestion via prov.name.
  // Older records without provider default to 'anthropic' (backward-compat).
  const provider = provenance.provider || 'anthropic';

  const estimatedCostUsd = estimateCostUsd({ model, inputTokens, outputTokens, provider });

  try {
    await store.recordLlmUsage({
      userId,
      feature,
      model,
      inputTokens,
      outputTokens,
      estimatedCostUsd,
    });
  } catch (err) {
    // Never let telemetry recording crash the main flow.
    console.warn(`[llm-usage-recorder] failed to record ${feature} usage for user ${userId}: ${err.message}`);
  }
}

module.exports = { recordAuditLlmUsage, recordRebuildLlmUsage };
