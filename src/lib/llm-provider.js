/**
 * LLM Provider Abstraction (v4.1)
 *
 * Thin wrapper around vendor SDKs. The rest of the codebase depends only on
 * the shape returned by `getProvider()` — swapping providers later means
 * adding a new implementation here, not changing call sites.
 *
 * Posture: provider calls are the only outbound network traffic v4.1
 * introduces, and they are opt-in (the caller must supply --llm-provider
 * and --llm-key-from-env). Per-engagement isolation: instantiate a fresh
 * provider per `rebuild()` call; never cache module-level.
 */

const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_MODEL_BY_PROVIDER = {
  anthropic: 'claude-haiku-4-5',
  openrouter: 'anthropic/claude-haiku-4-5'
};

const SUPPORTED_PROVIDERS = ['anthropic', 'openrouter', 'openai', 'azure-openai'];

/**
 * Build a provider instance.
 *
 * @param {string} name              Provider name (currently only 'anthropic' has a real impl).
 * @param {string} apiKey            API key (already resolved from env by the caller).
 * @param {Object} [opts]            Provider options.
 * @param {string} [opts.model]      Default model id for every call. Use the alias
 *                                   form (e.g. `claude-haiku-4-5`), not date-suffixed.
 * @param {number} [opts.maxTokens]  Default per-call max output tokens. Default 256.
 * @param {number} [opts.timeoutMs]  Per-request timeout. Default 15000.
 * @returns {{
 *   name: string,
 *   model: string,
 *   generate: (req: GenerateRequest) => Promise<GenerateResponse>
 * }}
 *
 * @typedef {Object} GenerateRequest
 * @property {string} systemPrompt  Frozen role / format / constraints.
 * @property {string} userPrompt    Per-call payload.
 * @property {number} [maxTokens]   Override the provider default for this call.
 * @property {string} [model]       Override the provider default for this call.
 *
 * @typedef {Object} GenerateResponse
 * @property {string} text                       Concatenated text from all `text`-type content blocks.
 * @property {string} model                      Model id the provider actually served.
 * @property {{ inputTokens: number, outputTokens: number }} usage
 * @property {number} latencyMs                  Wall-clock ms for the API call (excludes retry backoff).
 */
function getProvider(name, apiKey, opts = {}) {
  if (!SUPPORTED_PROVIDERS.includes(name)) {
    throw new Error(
      `llmProvider "${name}" is not supported. Supported: ${SUPPORTED_PROVIDERS.join(', ')}.`
    );
  }
  if (!apiKey) {
    throw new Error(`getProvider("${name}", apiKey): apiKey is required.`);
  }

  const model = opts.model || DEFAULT_MODEL_BY_PROVIDER[name];
  const defaultMaxTokens = opts.maxTokens || 256;
  const timeoutMs = opts.timeoutMs || 15000;

  if (name === 'anthropic') {
    return makeAnthropicProvider({ apiKey, model, defaultMaxTokens, timeoutMs });
  }

  if (name === 'openrouter') {
    return makeOpenRouterProvider({ apiKey, model, defaultMaxTokens, timeoutMs });
  }

  // openai / azure-openai are reserved for v4.2; explicitly reject so callers
  // never silently fall through to a no-op.
  return {
    name,
    model,
    async generate() {
      throw new Error(
        `llmProvider "${name}" is reserved but not implemented in v4.1. ` +
        `Use --llm-provider anthropic until v4.2 ships.`
      );
    }
  };
}

function makeAnthropicProvider({ apiKey, model, defaultMaxTokens, timeoutMs }) {
  const client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 0 });

  return {
    name: 'anthropic',
    model,
    async generate({ systemPrompt, userPrompt, maxTokens, model: callModel }) {
      if (typeof systemPrompt !== 'string' || systemPrompt.length === 0) {
        throw new Error('generate(): systemPrompt is required.');
      }
      if (typeof userPrompt !== 'string' || userPrompt.length === 0) {
        throw new Error('generate(): userPrompt is required.');
      }

      const requestModel = callModel || model;
      const requestMaxTokens = maxTokens || defaultMaxTokens;

      const t0 = Date.now();
      let response;
      try {
        response = await callWithRetry(() =>
          client.messages.create({
            model: requestModel,
            max_tokens: requestMaxTokens,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }]
          })
        );
      } catch (err) {
        // Re-throw with a stable shape; fixers will catch and defer the violation.
        throw normalizeProviderError(err);
      }
      const latencyMs = Date.now() - t0;

      const text = (response.content || [])
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();

      return {
        text,
        model: response.model || requestModel,
        usage: {
          inputTokens: response.usage ? response.usage.input_tokens : 0,
          outputTokens: response.usage ? response.usage.output_tokens : 0
        },
        latencyMs
      };
    }
  };
}

/**
 * OpenRouter provider — OpenAI-compatible gateway that can route to Claude and
 * other models. Uses Node 18+ built-in `fetch`; no additional dependencies.
 *
 * Model auto-prefix: if `model` has no `/`, it is treated as a Claude alias
 * and prefixed with `anthropic/`. So users who already configured
 * `LLM_MODEL=claude-haiku-4-5` for the Anthropic-direct path do not need to
 * change anything when switching to OpenRouter.
 *
 * @param {{ apiKey: string, model: string, defaultMaxTokens: number, timeoutMs: number }} opts
 */
function makeOpenRouterProvider({ apiKey, model, defaultMaxTokens, timeoutMs }) {
  const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
  const OPENROUTER_REFERER =
    process.env.OPENROUTER_REFERER || 'https://prism.skill-loop.com';

  /**
   * If the model string has no `/`, treat it as a Claude alias and prepend
   * `anthropic/`. Models that already include a `/` (e.g. `openai/gpt-4o`)
   * pass through unchanged.
   */
  function resolveModel(m) {
    return m.includes('/') ? m : `anthropic/${m}`;
  }

  return {
    name: 'openrouter',
    model,
    async generate({ systemPrompt, userPrompt, maxTokens, model: callModel }) {
      if (typeof systemPrompt !== 'string' || systemPrompt.length === 0) {
        throw new Error('generate(): systemPrompt is required.');
      }
      if (typeof userPrompt !== 'string' || userPrompt.length === 0) {
        throw new Error('generate(): userPrompt is required.');
      }

      const requestModel = resolveModel(callModel || model);
      const requestMaxTokens = maxTokens || defaultMaxTokens;

      const body = JSON.stringify({
        model: requestModel,
        max_tokens: requestMaxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      });

      const t0 = Date.now();
      let response;
      try {
        response = await callWithRetry(async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          let res;
          try {
            res = await fetch(OPENROUTER_ENDPOINT, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': OPENROUTER_REFERER,
                'X-Title': 'Prism Accessibility Auditor'
              },
              body,
              signal: controller.signal
            });
          } finally {
            clearTimeout(timer);
          }

          if (res.status === 401 || res.status === 403) {
            const err = new Error(
              `OpenRouter authentication failed (status ${res.status}). ` +
              `Check that OPENROUTER_API_KEY is set correctly.`
            );
            err.status = res.status;
            throw err;
          }

          if (res.status === 429 || res.status >= 500) {
            const err = new Error(`OpenRouter request failed with status ${res.status}.`);
            err.status = res.status;
            throw err;
          }

          if (!res.ok) {
            const text = await res.text().catch(() => '');
            const err = new Error(
              `OpenRouter request failed (status ${res.status}): ${text.slice(0, 200)}`
            );
            err.status = res.status;
            throw err;
          }

          return res.json();
        });
      } catch (err) {
        // AbortController fires with a DOMException name 'AbortError'
        if (err.name === 'AbortError') {
          const wrapped = new Error(
            `OpenRouter request timed out after ${timeoutMs}ms.`
          );
          wrapped.cause = err;
          throw wrapped;
        }
        // Auth errors propagate directly; other errors get normalized.
        if (err.message && err.message.startsWith('OpenRouter authentication')) {
          throw err;
        }
        throw normalizeProviderError(err);
      }
      const latencyMs = Date.now() - t0;

      const content =
        response &&
        Array.isArray(response.choices) &&
        response.choices[0] &&
        response.choices[0].message &&
        typeof response.choices[0].message.content === 'string'
          ? response.choices[0].message.content.trim()
          : '';

      const usage = response && response.usage ? response.usage : {};

      return {
        text: content,
        model: (response && response.model) || requestModel,
        usage: {
          inputTokens: usage.prompt_tokens || 0,
          outputTokens: usage.completion_tokens || 0
        },
        latencyMs
      };
    }
  };
}

/**
 * Single retry on transient failures (429, 5xx, network/timeout). Each call
 * site should be cheap enough that one extra attempt doesn't blow the
 * per-package token budget.
 */
async function callWithRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isTransient(err)) throw err;
    await sleep(1000);
    return await fn();
  }
}

function isTransient(err) {
  if (!err) return false;
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.InternalServerError) return true;
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return true;
  if (typeof err.status === 'number' && err.status >= 500) return true;
  if (typeof err.status === 'number' && err.status === 429) return true;
  return false;
}

function normalizeProviderError(err) {
  if (!err) return new Error('LLM provider returned an unknown error.');
  const status = typeof err.status === 'number' ? ` (status ${err.status})` : '';
  const wrapped = new Error(`LLM provider call failed${status}: ${err.message}`);
  wrapped.cause = err;
  wrapped.providerStatus = err.status;
  return wrapped;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  getProvider,
  SUPPORTED_PROVIDERS,
  DEFAULT_MODEL_BY_PROVIDER
};
