/**
 * LLM Provenance Module
 *
 * Gating, validation, and provenance helpers for LLM-assisted findings (v3
 * audit-time path) and LLM-assisted patches (v4.1 rebuild-time path).
 *
 * Design:
 * - LLM assistance is opt-in: both `llmProvider` and `llmKeyFromEnv` must be
 *   set AND the env var must be non-empty.
 * - v3.0 shipped the gating + provenance schema; v4.1 wires the real provider
 *   call via `generateAssistedSuggestion()`.
 * - Every assisted artifact carries enough provenance for a consultant to
 *   audit exactly what the LLM saw and produced (provider, model, prompt
 *   hash, usage, latency).
 */

const crypto = require('crypto');
const { getProvider } = require('./llm-provider');

const SUPPORTED_PROVIDERS = ['anthropic', 'openrouter', 'openai', 'azure-openai'];

/**
 * Check if LLM assistance is enabled.
 *
 * Returns true ONLY when:
 * - options.llmProvider is non-empty AND
 * - options.llmKeyFromEnv is non-empty AND
 * - process.env[options.llmKeyFromEnv] is non-empty
 *
 * Otherwise returns false (LLM is opt-in, not required).
 *
 * @param {Object} options - Configuration object
 * @param {string} [options.llmProvider] - Provider name (e.g., 'anthropic', 'openai')
 * @param {string} [options.llmKeyFromEnv] - Name of env var holding the API key
 * @returns {boolean} Whether LLM assistance is enabled
 */
function isLlmEnabled(options) {
  if (!options) return false;

  const { llmProvider, llmKeyFromEnv } = options;

  // Both must be non-empty strings
  if (!llmProvider || !llmKeyFromEnv) {
    return false;
  }

  // The env var must exist and be non-empty
  const apiKey = process.env[llmKeyFromEnv];
  if (!apiKey) {
    return false;
  }

  return true;
}

/**
 * Validate LLM configuration.
 *
 * Throws a clear error if:
 * - llmProvider is set but llmKeyFromEnv is missing
 * - llmKeyFromEnv is set but llmProvider is missing
 * - llmProvider is not in SUPPORTED_PROVIDERS
 * - The env var named in llmKeyFromEnv is missing or empty
 *
 * Returns null (silently) when both are unset (LLM is opt-in, not required).
 *
 * @param {Object} options - Configuration object
 * @param {string} [options.llmProvider] - Provider name
 * @param {string} [options.llmKeyFromEnv] - Name of env var holding the API key
 * @throws {Error} With a clear message naming the missing piece
 * @returns {null} When validation passes or both are unset
 */
function validateLlmConfig(options) {
  if (!options) {
    return null;
  }

  const { llmProvider, llmKeyFromEnv } = options;

  // Both unset is OK (opt-in)
  if (!llmProvider && !llmKeyFromEnv) {
    return null;
  }

  // Provider set but key var name missing
  if (llmProvider && !llmKeyFromEnv) {
    throw new Error(
      `llmProvider is set to "${llmProvider}" but llmKeyFromEnv is missing. ` +
      `Provide --llm-key-from-env <env-var-name> to enable LLM assistance.`
    );
  }

  // Key var name set but provider missing
  if (!llmProvider && llmKeyFromEnv) {
    throw new Error(
      `llmKeyFromEnv is set to "${llmKeyFromEnv}" but llmProvider is missing. ` +
      `Provide --llm-provider <provider> to enable LLM assistance.`
    );
  }

  // Provider must be recognized
  if (!SUPPORTED_PROVIDERS.includes(llmProvider)) {
    throw new Error(
      `llmProvider "${llmProvider}" is not supported. ` +
      `Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}.`
    );
  }

  // The env var must exist and be non-empty
  const apiKey = process.env[llmKeyFromEnv];
  if (!apiKey) {
    throw new Error(
      `Environment variable "${llmKeyFromEnv}" is not set or is empty. ` +
      `Set this variable to your ${llmProvider} API key to enable LLM assistance.`
    );
  }

  return null;
}

/**
 * Attach provenance metadata to a violation.
 *
 * Mutates the violation object to add:
 *   llmProvenance: { provider, model, engagementId, timestamp }
 *
 * Used by future assisted-finding generators. In v3.0, this function exists
 * but is called only by stubAssistedSuggestion (which returns null).
 * v3.1+ will call this from real provider implementations.
 *
 * @param {Object} violation - The violation object to mutate
 * @param {Object} config - Provenance metadata
 * @param {string} config.provider - Provider name (e.g., 'anthropic')
 * @param {string} config.model - Model identifier or version
 * @param {string} config.engagementId - Engagement ID for isolation tracking
 * @param {string} config.timestamp - ISO 8601 timestamp of the assistant call
 * @returns {Object} The mutated violation (for chaining)
 */
function recordProvenance(violation, { provider, model, engagementId, timestamp }) {
  violation.llmProvenance = {
    provider,
    model,
    engagementId,
    timestamp,
  };
  return violation;
}

/**
 * SHA-256 of the rendered prompt. Lets the manifest record exactly what the
 * LLM saw without storing the full prompt body.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @returns {string}  `sha256:<hex>`
 */
function hashPrompt(systemPrompt, userPrompt) {
  const h = crypto.createHash('sha256');
  h.update(String(systemPrompt));
  h.update('\n---\n');
  h.update(String(userPrompt));
  return 'sha256:' + h.digest('hex');
}

/**
 * Build a per-rebuild provider instance lazily. Engagement isolation: callers
 * pass `options` carrying llmProvider, llmKeyFromEnv (the env-var name), and
 * optionally llmModel. Returns null when LLM assistance is not enabled — the
 * caller (an assisted fixer) skips and the violation defers.
 *
 * Do not memoize across rebuilds: cross-engagement leakage is the failure
 * mode this guards against.
 *
 * @param {Object} options
 * @returns {ReturnType<typeof getProvider>|null}
 */
function buildProviderFromOptions(options) {
  if (!isLlmEnabled(options)) return null;
  const apiKey = process.env[options.llmKeyFromEnv];
  return getProvider(options.llmProvider, apiKey, {
    model: options.llmModel,
    maxTokens: options.llmMaxTokens,
    timeoutMs: options.llmTimeoutMs
  });
}

/**
 * Generate an LLM-assisted suggestion and return it alongside the provenance
 * fields that the patch will carry. Returns `{ ok: false, reason }` on
 * disable, validation failure, or provider error so the caller can defer the
 * violation rather than failing the rebuild.
 *
 * Output validation is the fixer's job — this function returns the raw text
 * and only fails on transport-level errors. Length / format / redundancy
 * checks live in the fixer next to the prompt that produced the text.
 *
 * @param {Object} args
 * @param {string} args.systemPrompt
 * @param {string} args.userPrompt
 * @param {Object} args.options                   Caller's full options bag (llmProvider,
 *                                                llmKeyFromEnv, llmModel, engagementId, ...).
 * @param {Object} [args.provider]                Pre-built provider instance. When supplied,
 *                                                `args.options` only needs the gating fields
 *                                                used to record provenance — the provider is
 *                                                used as-is. The orchestrator supplies one.
 * @returns {Promise<
 *   { ok: true, text: string, provenance: Object } |
 *   { ok: false, reason: string }
 * >}
 */
async function generateAssistedSuggestion({ systemPrompt, userPrompt, options, provider }) {
  const prov = provider || buildProviderFromOptions(options || {});
  if (!prov) {
    return { ok: false, reason: '--llm-provider not set' };
  }

  let result;
  try {
    result = await prov.generate({
      systemPrompt,
      userPrompt,
      maxTokens: options && options.llmMaxTokens
    });
  } catch (err) {
    return { ok: false, reason: `LLM call failed: ${err.message}` };
  }

  if (!result || typeof result.text !== 'string' || result.text.length === 0) {
    return { ok: false, reason: 'LLM returned empty response' };
  }

  return {
    ok: true,
    text: result.text,
    provenance: {
      provider: prov.name,
      model: result.model,
      promptHash: hashPrompt(systemPrompt, userPrompt),
      usage: result.usage,
      latencyMs: result.latencyMs
    }
  };
}

module.exports = {
  isLlmEnabled,
  validateLlmConfig,
  recordProvenance,
  buildProviderFromOptions,
  generateAssistedSuggestion,
  hashPrompt,
  SUPPORTED_PROVIDERS,
};
