/**
 * LLM Provenance Module for Open Pathways v3.0
 *
 * Gating + provenance recording infrastructure for LLM-assisted findings.
 * v3.0 does NOT make real LLM calls — this is the scaffolding that v3.1+ will
 * plug providers into.
 *
 * Design:
 * - LLM assistance is opt-in: both `llmProvider` and `llmKeyFromEnv` must be
 *   set AND the env var must be non-empty.
 * - Every assisted finding records provenance (provider, model, engagementId, timestamp).
 * - v3.0: stubAssistedSuggestion() returns null (no real call) but still records
 *   provenance with model='v3.0-stub'.
 * - v3.1+: swap stubAssistedSuggestion for real provider implementations.
 */

const SUPPORTED_PROVIDERS = ['anthropic', 'openai', 'azure-openai'];

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
 * Placeholder for LLM-assisted suggestions in v3.0.
 *
 * In v3.0, this always returns null (no real LLM call). Future v3.1+ providers
 * will override this with real implementations that return candidate suggestions.
 *
 * Even though it returns null, this function:
 * - Records provenance with model='v3.0-stub'
 * - Can be called in test/demo contexts to verify the provenance tracking
 * - Serves as the contract that v3.1+ providers must implement
 *
 * @param {Object} violation - The violation to get suggestions for
 * @param {Object} options - Configuration (llmProvider, llmKeyFromEnv, engagementId, etc.)
 * @returns {null} In v3.0, always null (no real suggestion)
 */
function stubAssistedSuggestion(violation, options = {}) {
  // Record provenance even though we're not making a real call
  if (options.engagementId) {
    recordProvenance(violation, {
      provider: options.llmProvider || 'none',
      model: 'v3.0-stub',
      engagementId: options.engagementId,
      timestamp: new Date().toISOString(),
    });
  }

  // v3.0: no real LLM call; returns null
  return null;
}

module.exports = {
  isLlmEnabled,
  validateLlmConfig,
  recordProvenance,
  stubAssistedSuggestion,
  SUPPORTED_PROVIDERS,
};
