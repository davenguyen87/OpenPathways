/**
 * LLM key resolver — threads per-workspace API keys into the audit/rebuild pipeline.
 *
 * Design note on the env-var sentinel approach:
 *
 *   The existing src/ infrastructure (llm-provenance.js → buildProviderFromOptions →
 *   isLlmEnabled) reads keys exclusively via `process.env[llmKeyFromEnv]`. Modifying
 *   src/ to accept a direct apiKey parameter would be cleaner in isolation but is
 *   out of scope for this task (CLAUDE.md: "Touch only what the task requires").
 *
 *   Instead, `injectLlmConfigForCall` writes the decrypted plaintext key into
 *   a process-env sentinel (`PRISM_RESOLVED_LLM_KEY`) and returns
 *   `{ llmKeyFromEnv: 'PRISM_RESOLVED_LLM_KEY' }` so existing infrastructure
 *   finds it at the expected location. The caller MUST call `_restore()` in a
 *   `finally` block to delete it immediately after the call completes.
 *
 * Security posture:
 *   - The sentinel env var exists only for the duration of one writeReports /
 *     rebuild call (microseconds to seconds at most).
 *   - `llmKeyFromEnv` is the *name* of the env var — it is logged in the
 *     provenance record as-is and contains no key material.
 *   - The decrypted key value is never logged. It lives in process.env only
 *     transiently, deleted in the finally-block _restore().
 *   - In a single-process server this is sufficient; a multi-threaded runtime
 *     (worker_threads) would need a per-call scoped approach instead.
 *   - If a cleaner path becomes available (direct apiKey param in src/), prefer
 *     that and remove the sentinel approach.
 */

'use strict';

const { decrypt, getDataEncryptionKey } = require('./crypto');

// The name of the transient sentinel env var. Deliberately generic so it is
// obviously not a user-provided var name and is easy to grep for.
const SENTINEL_ENV_VAR = 'PRISM_RESOLVED_LLM_KEY';

/**
 * Resolve the LLM config for a given user (or fall back to server env).
 *
 * Resolution order:
 *   1. If userId is set and the store has a workspace config for that user,
 *      decrypt the stored key and return it.
 *   2. Otherwise, if process.env.LLM_PROVIDER is set, return the server-wide
 *      config (apiKey may be null if LLM_KEY_FROM_ENV points to an unset var).
 *   3. Otherwise return null (LLM assistance is disabled).
 *
 * @param {object} store - SqliteStore | PostgresStore
 * @param {string|null} userId
 * @returns {Promise<{ provider: string, model: string|null, apiKey: string|null } | null>}
 */
async function resolveLlmConfig(store, userId) {
  // --- Workspace key path ---
  if (userId && store && typeof store.getWorkspaceLlmConfig === 'function') {
    try {
      const cfg = await store.getWorkspaceLlmConfig(userId);
      if (cfg && cfg.encryptedApiKey) {
        const dek = getDataEncryptionKey();
        const apiKey = decrypt(cfg.encryptedApiKey, dek);
        return {
          provider: cfg.provider || 'anthropic',
          model: cfg.model || null,
          apiKey,
        };
      }
    } catch (err) {
      // Log but don't crash — fall through to server env. The key may have been
      // stored with a different DEK (key rotation), or the row may be corrupt.
      // Either way, we should not block the audit run.
      console.warn(`[llm-key-resolver] failed to resolve workspace key for user ${userId}: ${err.message}`);
    }
  }

  // --- Server-env fallback path ---
  const envProvider = process.env.LLM_PROVIDER;
  if (envProvider) {
    const keyEnvVar = process.env.LLM_KEY_FROM_ENV;
    const apiKey = keyEnvVar ? (process.env[keyEnvVar] || null) : null;
    return {
      provider: envProvider,
      model: process.env.LLM_MODEL || null,
      apiKey,
    };
  }

  return null;
}

/**
 * Inject a resolved LLM config into the process environment for a single call.
 *
 * Returns an options fragment `{ llmProvider, llmKeyFromEnv, llmModel }` that
 * the caller passes into writeReports / rebuild options, plus a `_restore`
 * function that MUST be called in a `finally` block to clean up the sentinel.
 *
 * When resolvedConfig is null (LLM disabled), returns no-op values so callers
 * don't need to branch.
 *
 * @param {{ provider: string, model: string|null, apiKey: string|null } | null} resolvedConfig
 * @returns {{ llmProvider: string|null, llmKeyFromEnv: string|null, llmModel: string|null, _restore: () => void }}
 */
function injectLlmConfigForCall(resolvedConfig) {
  if (!resolvedConfig) {
    return {
      llmProvider: null,
      llmKeyFromEnv: null,
      llmModel: null,
      _restore: () => {},
    };
  }

  // Set the sentinel. We intentionally do not log the key value.
  if (resolvedConfig.apiKey) {
    process.env[SENTINEL_ENV_VAR] = resolvedConfig.apiKey;
  } else {
    // Provider is configured but key is absent (misconfiguration). Unset the
    // sentinel so isLlmEnabled correctly returns false rather than silently
    // reading a stale value from a prior call (defensive).
    delete process.env[SENTINEL_ENV_VAR];
  }

  return {
    llmProvider: resolvedConfig.provider,
    llmKeyFromEnv: SENTINEL_ENV_VAR,
    llmModel: resolvedConfig.model,
    _restore: () => {
      delete process.env[SENTINEL_ENV_VAR];
    },
  };
}

module.exports = { resolveLlmConfig, injectLlmConfigForCall, SENTINEL_ENV_VAR };
