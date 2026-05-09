/**
 * Tests for cloud/server/lib/llm-cost.js
 *
 * Covers: pricing table for all 3 supported models, date-suffixed model ids,
 *         fallback for unknown models, and zero-token edge cases.
 */

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { estimateCostUsd, PRICING, lookupPricing, OPENROUTER_MARKUP } = require('../server/lib/llm-cost.js');

describe('PRICING table', () => {
  it('contains entries for all three supported models', () => {
    expect(PRICING['claude-haiku-4-5']).toBeDefined();
    expect(PRICING['claude-sonnet-4-6']).toBeDefined();
    expect(PRICING['claude-opus-4-7']).toBeDefined();
  });

  it('Haiku has lower input price than Sonnet', () => {
    expect(PRICING['claude-haiku-4-5'].inputPer1M)
      .toBeLessThan(PRICING['claude-sonnet-4-6'].inputPer1M);
  });

  it('Sonnet has lower input price than Opus', () => {
    expect(PRICING['claude-sonnet-4-6'].inputPer1M)
      .toBeLessThan(PRICING['claude-opus-4-7'].inputPer1M);
  });
});

describe('lookupPricing', () => {
  it('finds Haiku by exact alias', () => {
    const p = lookupPricing('claude-haiku-4-5');
    expect(p).not.toBeNull();
    expect(p.inputPer1M).toBe(1);
    expect(p.outputPer1M).toBe(5);
  });

  it('finds Sonnet by exact alias', () => {
    const p = lookupPricing('claude-sonnet-4-6');
    expect(p).not.toBeNull();
    expect(p.inputPer1M).toBe(3);
    expect(p.outputPer1M).toBe(15);
  });

  it('finds Opus by exact alias', () => {
    const p = lookupPricing('claude-opus-4-7');
    expect(p).not.toBeNull();
    expect(p.inputPer1M).toBe(5);
    expect(p.outputPer1M).toBe(25);
  });

  it('finds Haiku by date-suffixed model id', () => {
    const p = lookupPricing('claude-haiku-4-5-20250305');
    expect(p).not.toBeNull();
    expect(p.inputPer1M).toBe(1);
  });

  it('finds Sonnet by date-suffixed model id', () => {
    const p = lookupPricing('claude-sonnet-4-6-20251001');
    expect(p).not.toBeNull();
    expect(p.inputPer1M).toBe(3);
  });

  it('returns null for unknown model', () => {
    const p = lookupPricing('gpt-4-turbo');
    expect(p).toBeNull();
  });

  it('returns null for empty string', () => {
    const p = lookupPricing('');
    expect(p).toBeNull();
  });

  it('returns null for null input', () => {
    const p = lookupPricing(null);
    expect(p).toBeNull();
  });
});

describe('estimateCostUsd', () => {
  it('computes correct cost for Haiku (1M input + 0 output)', () => {
    const cost = estimateCostUsd({
      model: 'claude-haiku-4-5',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cost).toBeCloseTo(1.0, 6); // $1 per 1M input
  });

  it('computes correct cost for Haiku (0 input + 1M output)', () => {
    const cost = estimateCostUsd({
      model: 'claude-haiku-4-5',
      inputTokens: 0,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(5.0, 6); // $5 per 1M output
  });

  it('computes correct cost for Sonnet (1M input + 1M output)', () => {
    const cost = estimateCostUsd({
      model: 'claude-sonnet-4-6',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(18.0, 6); // $3 + $15
  });

  it('computes correct cost for Opus (1M input + 1M output)', () => {
    const cost = estimateCostUsd({
      model: 'claude-opus-4-7',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(30.0, 6); // $5 + $25
  });

  it('returns 0 for zero tokens', () => {
    const cost = estimateCostUsd({
      model: 'claude-haiku-4-5',
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(cost).toBe(0);
  });

  it('uses Haiku pricing as lower-bound fallback for unknown model', () => {
    // estimateCostUsd should not throw and should return a non-negative cost.
    const cost = estimateCostUsd({
      model: 'unknown-future-model',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // Haiku pricing: $1 + $5 = $6.
    expect(cost).toBeCloseTo(6.0, 6);
  });

  it('handles undefined inputTokens gracefully', () => {
    const cost = estimateCostUsd({
      model: 'claude-haiku-4-5',
      inputTokens: undefined,
      outputTokens: 100,
    });
    expect(typeof cost).toBe('number');
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it('defaults to anthropic provider (no markup) when provider is omitted', () => {
    const direct = estimateCostUsd({
      model: 'claude-haiku-4-5',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // Haiku: $1 + $5 = $6 — no markup
    expect(direct).toBeCloseTo(6.0, 6);
  });

  it('applies OPENROUTER_MARKUP when provider="openrouter"', () => {
    const direct = estimateCostUsd({
      model: 'claude-haiku-4-5',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    const via = estimateCostUsd({
      model: 'claude-haiku-4-5',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      provider: 'openrouter',
    });
    expect(via).toBeCloseTo(direct * OPENROUTER_MARKUP, 6);
  });

  it('OpenRouter cost is ~5% more than Anthropic-direct cost', () => {
    const direct = estimateCostUsd({
      model: 'claude-haiku-4-5',
      inputTokens: 500_000,
      outputTokens: 250_000,
    });
    const via = estimateCostUsd({
      model: 'claude-haiku-4-5',
      inputTokens: 500_000,
      outputTokens: 250_000,
      provider: 'openrouter',
    });
    expect(via / direct).toBeCloseTo(1.05, 4);
  });

  it('OpenRouter with anthropic-prefixed model resolves correct pricing', () => {
    const prefixed = estimateCostUsd({
      model: 'anthropic/claude-haiku-4-5',
      inputTokens: 1_000_000,
      outputTokens: 0,
      provider: 'openrouter',
    });
    // Should use Haiku input price ($1) × OPENROUTER_MARKUP
    expect(prefixed).toBeCloseTo(1.0 * OPENROUTER_MARKUP, 6);
  });
});

describe('OPENROUTER_MARKUP', () => {
  it('is exported', () => {
    expect(OPENROUTER_MARKUP).toBeDefined();
  });

  it('equals 1.05 (5% gateway fee)', () => {
    expect(OPENROUTER_MARKUP).toBe(1.05);
  });
});

describe('lookupPricing — OpenRouter-prefixed models', () => {
  it('finds Haiku by anthropic/claude-haiku-4-5', () => {
    const p = lookupPricing('anthropic/claude-haiku-4-5');
    expect(p).not.toBeNull();
    expect(p.inputPer1M).toBe(1);
    expect(p.outputPer1M).toBe(5);
  });

  it('finds Sonnet by anthropic/claude-sonnet-4-6', () => {
    const p = lookupPricing('anthropic/claude-sonnet-4-6');
    expect(p).not.toBeNull();
    expect(p.inputPer1M).toBe(3);
  });

  it('finds Haiku by anthropic/claude-haiku-4-5-20250305 (date-suffixed)', () => {
    const p = lookupPricing('anthropic/claude-haiku-4-5-20250305');
    expect(p).not.toBeNull();
    expect(p.inputPer1M).toBe(1);
  });

  it('returns null for openai/gpt-4o (unknown model after stripping prefix)', () => {
    const p = lookupPricing('openai/gpt-4o');
    expect(p).toBeNull();
  });
});
