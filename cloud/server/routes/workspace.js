/**
 * Workspace settings routes — Phase 12.5.
 *
 *   GET    /api/workspace/llm-config          — read config (redacted)
 *   PUT    /api/workspace/llm-config          — store encrypted API key
 *   DELETE /api/workspace/llm-config          — remove key
 *   POST   /api/workspace/llm-config/test     — test the stored or provided key
 *
 * All routes require auth in hosted mode. PUT and DELETE require CSRF.
 * The plaintext API key and the encrypted blob are never logged.
 */

'use strict';

const express = require('express');
const { encrypt, decrypt, getDataEncryptionKey, redactKey } = require('../lib/crypto');
const llmProvider = require('../../../src/lib/llm-provider');

// Both Anthropic keys (sk-ant-...) and OpenRouter keys (sk-or-v1-...) start
// with 'sk-', so the existing prefix check accepts both without modification.
const SUPPORTED_PROVIDERS = ['anthropic', 'openrouter'];
const MIN_API_KEY_LENGTH = 20;
const TEST_TIMEOUT_MS = 15000;

/**
 * @param {object} deps
 * @param {object} deps.store          - store adapter (getWorkspaceLlmConfig, setWorkspaceLlmConfig, deleteWorkspaceLlmConfig)
 * @param {object} [deps.config]       - { isHosted, mode }
 * @param {function} [deps.requireAuth] - middleware that 401s when req.user is missing
 * @param {function} [deps.csrfProtect] - csrf-csrf doubleCsrfProtection
 * @returns {{ router: express.Router }}
 */
function createWorkspaceRouter({ store, config, requireAuth, csrfProtect }) {
  if (!store) throw new Error('createWorkspaceRouter: store is required');

  const isHosted = !!(config && config.isHosted);
  const authEnabled = !!requireAuth;

  const auth = isHosted && authEnabled ? [requireAuth] : [];
  const csrf = isHosted && csrfProtect ? [csrfProtect] : [];

  const router = express.Router();
  router.use(express.json());

  // Helper: resolve userId from req.user (hosted mode) or a sentinel.
  const userId = (req) => (req.user && req.user.id) || '__local__';

  // ------------------------------------------------------------------
  // GET /api/workspace/llm-config
  // Never returns the plaintext or encrypted key. Returns a shape that
  // tells the frontend whether a key is stored + the last-4 digits.
  // ------------------------------------------------------------------
  router.get('/workspace/llm-config', ...auth, async (req, res) => {
    try {
      const cfg = await store.getWorkspaceLlmConfig(userId(req));
      if (!cfg) {
        return res.json({ hasKey: false });
      }
      return res.json({
        hasKey: true,
        provider: cfg.provider,
        model: cfg.model || 'claude-haiku-4-5',
        keyLast4: cfg.keyLast4,
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to read config: ${err.message}` });
    }
  });

  // ------------------------------------------------------------------
  // PUT /api/workspace/llm-config
  // Body: { provider, model, apiKey }
  // ------------------------------------------------------------------
  router.put('/workspace/llm-config', ...auth, ...csrf, async (req, res) => {
    const { provider, model, apiKey } = req.body || {};

    // Validate provider
    if (!provider || !SUPPORTED_PROVIDERS.includes(provider)) {
      return res.status(400).json({
        error: `provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}`,
      });
    }

    // Validate apiKey
    if (typeof apiKey !== 'string' || !apiKey.startsWith('sk-')) {
      return res.status(400).json({ error: "apiKey must be a string starting with 'sk-'" });
    }
    if (apiKey.length < MIN_API_KEY_LENGTH) {
      return res.status(400).json({
        error: `apiKey is too short (minimum ${MIN_API_KEY_LENGTH} characters)`,
      });
    }

    try {
      const dek = getDataEncryptionKey();
      const encryptedApiKey = encrypt(apiKey, dek);
      const keyLast4 = apiKey.slice(-4);

      await store.setWorkspaceLlmConfig(userId(req), {
        provider,
        model: model || 'claude-haiku-4-5',
        encryptedApiKey,
        keyLast4,
      });

      return res.status(204).end();
    } catch (err) {
      // Don't surface encryption internals
      res.status(500).json({ error: 'Failed to save config' });
    }
  });

  // ------------------------------------------------------------------
  // DELETE /api/workspace/llm-config
  // ------------------------------------------------------------------
  router.delete('/workspace/llm-config', ...auth, ...csrf, async (req, res) => {
    try {
      const deleted = await store.deleteWorkspaceLlmConfig(userId(req));
      if (!deleted) {
        return res.status(404).json({ error: 'No LLM config found for this workspace' });
      }
      return res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: `Failed to delete config: ${err.message}` });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/workspace/llm-config/test
  // Body: { apiKey?, provider? }  — if apiKey absent, uses the stored encrypted key.
  //   provider in body is only used when apiKey is also in body (test-before-save).
  //   When testing a stored key, provider and model are read from stored config.
  // Returns: { ok: true, latencyMs } or { ok: false, error: '<safe message>' }
  // Hard timeout: 15s.
  // ------------------------------------------------------------------
  router.post('/workspace/llm-config/test', ...auth, async (req, res) => {
    let plaintextKey;
    let resolvedProvider;
    let resolvedModel;

    const bodyKey      = (req.body || {}).apiKey;
    const bodyProvider = (req.body || {}).provider;

    if (bodyKey) {
      // Caller provided a key in the body — use it directly (for "Test before Save").
      if (typeof bodyKey !== 'string' || !bodyKey.startsWith('sk-') || bodyKey.length < MIN_API_KEY_LENGTH) {
        return res.status(400).json({ ok: false, error: 'Provided apiKey is invalid' });
      }
      plaintextKey     = bodyKey;
      // Use the body provider if it's a supported one, else default to anthropic.
      resolvedProvider = SUPPORTED_PROVIDERS.includes(bodyProvider) ? bodyProvider : 'anthropic';
      // Default model per provider.
      resolvedModel    = resolvedProvider === 'openrouter' ? 'anthropic/claude-haiku-4-5' : 'claude-haiku-4-5';
    } else {
      // No key in body — decrypt the stored key and read stored provider/model.
      try {
        const cfg = await store.getWorkspaceLlmConfig(userId(req));
        if (!cfg || !cfg.encryptedApiKey) {
          return res.status(400).json({ ok: false, error: 'No API key configured for this workspace' });
        }
        const dek    = getDataEncryptionKey();
        plaintextKey     = decrypt(cfg.encryptedApiKey, dek);
        resolvedProvider = cfg.provider || 'anthropic';
        resolvedModel    = cfg.model    || (resolvedProvider === 'openrouter' ? 'anthropic/claude-haiku-4-5' : 'claude-haiku-4-5');
      } catch (err) {
        return res.status(500).json({ ok: false, error: 'Failed to retrieve stored key' });
      }
    }

    // Run a minimal generation with a hard 15s timeout.
    const t0 = Date.now();
    try {
      const provider = llmProvider.getProvider(resolvedProvider, plaintextKey, { model: resolvedModel });

      // Race the generate call against a 15-second timeout.
      await Promise.race([
        provider.generate({
          systemPrompt: 'Reply with the word OK.',
          userPrompt: 'OK',
          maxTokens: 10,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Request timed out')), TEST_TIMEOUT_MS)
        ),
      ]);

      const latencyMs = Date.now() - t0;
      return res.json({ ok: true, latencyMs });
    } catch (err) {
      const latencyMs = Date.now() - t0;
      // Return a safe message — don't leak internals or the key.
      const safeError = err.message && err.message.includes('timed out')
        ? 'Request timed out after 15s'
        : 'API call failed — check that your key is valid and has sufficient quota';
      return res.json({ ok: false, error: safeError, latencyMs });
    }
  });

  return { router };
}

module.exports = { createWorkspaceRouter };
