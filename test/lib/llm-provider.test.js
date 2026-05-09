/**
 * Tests for src/lib/llm-provider.js
 *
 * Covers: getProvider dispatch, OpenRouter provider factory, auto-prefix logic,
 *         request shape, response parsing, error handling (401, 429, 500), and timeout.
 *
 * All fetch calls are stubbed via global.fetch so no network traffic is made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  getProvider,
  SUPPORTED_PROVIDERS,
  DEFAULT_MODEL_BY_PROVIDER
} = require('../../src/lib/llm-provider.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOkResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function makeErrorResponse(status, body = '') {
  return {
    ok: false,
    status,
    json: async () => { throw new Error('not json'); },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

function openRouterResponse({ content = 'hello', model = 'anthropic/claude-haiku-4-5', promptTokens = 10, completionTokens = 5 } = {}) {
  return makeOkResponse({
    choices: [{ message: { content } }],
    model,
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens }
  });
}

// ---------------------------------------------------------------------------
// SUPPORTED_PROVIDERS / DEFAULT_MODEL_BY_PROVIDER
// ---------------------------------------------------------------------------

describe('SUPPORTED_PROVIDERS', () => {
  it('includes openrouter', () => {
    expect(SUPPORTED_PROVIDERS).toContain('openrouter');
  });

  it('lists anthropic before openrouter (documented default first)', () => {
    const ai = SUPPORTED_PROVIDERS.indexOf('anthropic');
    const or = SUPPORTED_PROVIDERS.indexOf('openrouter');
    expect(ai).toBeGreaterThanOrEqual(0);
    expect(or).toBeGreaterThan(ai);
  });
});

describe('DEFAULT_MODEL_BY_PROVIDER', () => {
  it('has openrouter default model anthropic/claude-haiku-4-5', () => {
    expect(DEFAULT_MODEL_BY_PROVIDER['openrouter']).toBe('anthropic/claude-haiku-4-5');
  });
});

// ---------------------------------------------------------------------------
// getProvider('openrouter', ...)
// ---------------------------------------------------------------------------

describe('getProvider("openrouter", apiKey)', () => {
  it('returns an object with name="openrouter"', () => {
    const p = getProvider('openrouter', 'sk-or-test');
    expect(p.name).toBe('openrouter');
  });

  it('has default model anthropic/claude-haiku-4-5', () => {
    const p = getProvider('openrouter', 'sk-or-test');
    expect(p.model).toBe('anthropic/claude-haiku-4-5');
  });

  it('respects an explicit model override', () => {
    const p = getProvider('openrouter', 'sk-or-test', { model: 'openai/gpt-4o' });
    expect(p.model).toBe('openai/gpt-4o');
  });

  it('exposes a generate function', () => {
    const p = getProvider('openrouter', 'sk-or-test');
    expect(typeof p.generate).toBe('function');
  });

  it('throws when apiKey is empty', () => {
    expect(() => getProvider('openrouter', '')).toThrow(/apiKey is required/);
  });
});

// ---------------------------------------------------------------------------
// generate() — request shape
// ---------------------------------------------------------------------------

describe('OpenRouter generate() — request shape', () => {
  let fetchCalls;

  beforeEach(() => {
    fetchCalls = [];
    global.fetch = vi.fn(async (url, opts) => {
      fetchCalls.push({ url, opts });
      return openRouterResponse();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
  });

  it('POSTs to https://openrouter.ai/api/v1/chat/completions', async () => {
    const p = getProvider('openrouter', 'sk-or-test');
    await p.generate({ systemPrompt: 'sys', userPrompt: 'user' });
    expect(fetchCalls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(fetchCalls[0].opts.method).toBe('POST');
  });

  it('sends Authorization header with Bearer token', async () => {
    const p = getProvider('openrouter', 'sk-or-mykey');
    await p.generate({ systemPrompt: 's', userPrompt: 'u' });
    expect(fetchCalls[0].opts.headers['Authorization']).toBe('Bearer sk-or-mykey');
  });

  it('sends correct Content-Type header', async () => {
    const p = getProvider('openrouter', 'sk-or-test');
    await p.generate({ systemPrompt: 's', userPrompt: 'u' });
    expect(fetchCalls[0].opts.headers['Content-Type']).toBe('application/json');
  });

  it('sends X-Title header', async () => {
    const p = getProvider('openrouter', 'sk-or-test');
    await p.generate({ systemPrompt: 's', userPrompt: 'u' });
    expect(fetchCalls[0].opts.headers['X-Title']).toBe('Prism Accessibility Auditor');
  });

  it('sends HTTP-Referer header', async () => {
    const p = getProvider('openrouter', 'sk-or-test');
    await p.generate({ systemPrompt: 's', userPrompt: 'u' });
    expect(fetchCalls[0].opts.headers['HTTP-Referer']).toMatch(/^https?:\/\//);
  });

  it('sends OpenAI-compatible message body with system + user roles', async () => {
    const p = getProvider('openrouter', 'sk-or-test');
    await p.generate({ systemPrompt: 'sys content', userPrompt: 'user content' });
    const body = JSON.parse(fetchCalls[0].opts.body);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys content' },
      { role: 'user', content: 'user content' }
    ]);
  });

  it('includes max_tokens in the body', async () => {
    const p = getProvider('openrouter', 'sk-or-test', { maxTokens: 128 });
    await p.generate({ systemPrompt: 's', userPrompt: 'u' });
    const body = JSON.parse(fetchCalls[0].opts.body);
    expect(body.max_tokens).toBe(128);
  });
});

// ---------------------------------------------------------------------------
// generate() — auto-prefix logic
// ---------------------------------------------------------------------------

describe('OpenRouter generate() — auto-prefix logic', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => openRouterResponse());
  });
  afterEach(() => { vi.restoreAllMocks(); delete global.fetch; });

  it('prefixes claude-haiku-4-5 with anthropic/', async () => {
    const p = getProvider('openrouter', 'sk-or-test', { model: 'claude-haiku-4-5' });
    await p.generate({ systemPrompt: 's', userPrompt: 'u' });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.model).toBe('anthropic/claude-haiku-4-5');
  });

  it('passes anthropic/claude-haiku-4-5 through unchanged', async () => {
    const p = getProvider('openrouter', 'sk-or-test', { model: 'anthropic/claude-haiku-4-5' });
    await p.generate({ systemPrompt: 's', userPrompt: 'u' });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.model).toBe('anthropic/claude-haiku-4-5');
  });

  it('passes openai/gpt-4o through unchanged', async () => {
    const p = getProvider('openrouter', 'sk-or-test', { model: 'openai/gpt-4o' });
    await p.generate({ systemPrompt: 's', userPrompt: 'u' });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.model).toBe('openai/gpt-4o');
  });

  it('per-call model override also gets auto-prefixed when slash-free', async () => {
    const p = getProvider('openrouter', 'sk-or-test', { model: 'anthropic/claude-haiku-4-5' });
    await p.generate({ systemPrompt: 's', userPrompt: 'u', model: 'claude-sonnet-4-6' });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.model).toBe('anthropic/claude-sonnet-4-6');
  });
});

// ---------------------------------------------------------------------------
// generate() — response parsing
// ---------------------------------------------------------------------------

describe('OpenRouter generate() — response parsing', () => {
  afterEach(() => { vi.restoreAllMocks(); delete global.fetch; });

  it('extracts text from choices[0].message.content', async () => {
    global.fetch = vi.fn(async () =>
      openRouterResponse({ content: '  trimmed text  ' })
    );
    const p = getProvider('openrouter', 'sk-or-test');
    const result = await p.generate({ systemPrompt: 's', userPrompt: 'u' });
    expect(result.text).toBe('trimmed text');
  });

  it('maps prompt_tokens → inputTokens', async () => {
    global.fetch = vi.fn(async () =>
      openRouterResponse({ promptTokens: 42, completionTokens: 7 })
    );
    const p = getProvider('openrouter', 'sk-or-test');
    const result = await p.generate({ systemPrompt: 's', userPrompt: 'u' });
    expect(result.usage.inputTokens).toBe(42);
  });

  it('maps completion_tokens → outputTokens', async () => {
    global.fetch = vi.fn(async () =>
      openRouterResponse({ promptTokens: 42, completionTokens: 7 })
    );
    const p = getProvider('openrouter', 'sk-or-test');
    const result = await p.generate({ systemPrompt: 's', userPrompt: 'u' });
    expect(result.usage.outputTokens).toBe(7);
  });

  it('returns the model from the response', async () => {
    global.fetch = vi.fn(async () =>
      openRouterResponse({ model: 'anthropic/claude-haiku-4-5-20250305' })
    );
    const p = getProvider('openrouter', 'sk-or-test');
    const result = await p.generate({ systemPrompt: 's', userPrompt: 'u' });
    expect(result.model).toBe('anthropic/claude-haiku-4-5-20250305');
  });

  it('returns a non-negative latencyMs', async () => {
    global.fetch = vi.fn(async () => openRouterResponse());
    const p = getProvider('openrouter', 'sk-or-test');
    const result = await p.generate({ systemPrompt: 's', userPrompt: 'u' });
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// generate() — error handling
// ---------------------------------------------------------------------------

describe('OpenRouter generate() — error handling', () => {
  afterEach(() => { vi.restoreAllMocks(); delete global.fetch; });

  it('throws "authentication failed" on 401', async () => {
    global.fetch = vi.fn(async () => makeErrorResponse(401));
    const p = getProvider('openrouter', 'sk-or-bad');
    await expect(p.generate({ systemPrompt: 's', userPrompt: 'u' }))
      .rejects.toThrow(/authentication failed/);
  });

  it('throws "authentication failed" on 403', async () => {
    global.fetch = vi.fn(async () => makeErrorResponse(403));
    const p = getProvider('openrouter', 'sk-or-bad');
    await expect(p.generate({ systemPrompt: 's', userPrompt: 'u' }))
      .rejects.toThrow(/authentication failed/);
  });

  it('retries once on 429 then succeeds', async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) return makeErrorResponse(429);
      return openRouterResponse({ content: 'retry success' });
    });
    const p = getProvider('openrouter', 'sk-or-test');
    const result = await p.generate({ systemPrompt: 's', userPrompt: 'u' });
    expect(calls).toBe(2);
    expect(result.text).toBe('retry success');
  });

  it('retries once on 500 then succeeds', async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) return makeErrorResponse(500);
      return openRouterResponse({ content: 'recovered' });
    });
    const p = getProvider('openrouter', 'sk-or-test');
    const result = await p.generate({ systemPrompt: 's', userPrompt: 'u' });
    expect(calls).toBe(2);
    expect(result.text).toBe('recovered');
  });

  it('throws after two 500s (no more retries)', async () => {
    global.fetch = vi.fn(async () => makeErrorResponse(500));
    const p = getProvider('openrouter', 'sk-or-test');
    await expect(p.generate({ systemPrompt: 's', userPrompt: 'u' }))
      .rejects.toThrow(/status 500/);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('throws when systemPrompt is empty', async () => {
    const p = getProvider('openrouter', 'sk-or-test');
    await expect(p.generate({ systemPrompt: '', userPrompt: 'u' }))
      .rejects.toThrow(/systemPrompt is required/);
  });

  it('throws when userPrompt is empty', async () => {
    const p = getProvider('openrouter', 'sk-or-test');
    await expect(p.generate({ systemPrompt: 's', userPrompt: '' }))
      .rejects.toThrow(/userPrompt is required/);
  });
});

// ---------------------------------------------------------------------------
// generate() — timeout
// ---------------------------------------------------------------------------

describe('OpenRouter generate() — timeout', () => {
  afterEach(() => { vi.restoreAllMocks(); delete global.fetch; });

  it('aborts cleanly when fetch hangs past timeoutMs', async () => {
    // Simulate a never-resolving fetch; the provider's AbortController will
    // cancel it after timeoutMs.
    global.fetch = vi.fn((_url, opts) => {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const p = getProvider('openrouter', 'sk-or-test', { timeoutMs: 50 });
    await expect(p.generate({ systemPrompt: 's', userPrompt: 'u' }))
      .rejects.toThrow(/timed out/i);
  }, 2000);
});
