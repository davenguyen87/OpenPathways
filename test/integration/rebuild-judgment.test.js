/**
 * v5.1 transformer-judgment integration tests.
 *
 * Drives a full-tier rebuild against the existing tabs-divsoup fixture with
 * a fake provider injected via `opts.llmProviderInstance`. Asserts:
 *   - manifest's tabs transform carries the judgment field with full provenance
 *   - heuristic-only path (no provider) leaves transforms judgment-free
 *   - LLM no-match verdict drops the candidate (and surfaces a deferred entry)
 *   - checkpoint preview HTML renders the AI verdict pill when judgment present
 *
 * No real network calls. Uses the same v4.1 injection point.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';

const require = createRequire(import.meta.url);

const { rebuild } = require('../../src/rebuild/index.js');
const { renderRebuildPreview } = require('../../src/reporter/rebuild-preview.js');
const { __setAuditForTest } = require('../../src/rebuild/verify.js');

// Stub the audit Playwright runner so verify() during full-mode rebuild
// doesn't try to spawn a browser. Mirrors the existing rebuild-full-pipeline
// test setup.
beforeAll(() => {
  __setAuditForTest(async () => ({
    violations: [],
    scorecard: { failedCriteria: 0, criteriaResults: [] }
  }));
});

afterAll(() => {
  __setAuditForTest(null);
});

// ─── Fixture ──────────────────────────────────────────────────────────────

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');
const FX_TABS = path.join(FIXTURES_DIR, 'rebuild-tabs-divsoup.zip');

const tmpDirs = [];
function makeTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `prism-judg-${prefix}-`));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

/**
 * Build a fake provider returning a canned JSON verdict from the v5.1 prompt.
 * Output mirrors the strict JSON contract the parseAndValidateVerdict expects.
 */
function makeJudgmentProvider(verdict, confidence, rationale) {
  const calls = [];
  return {
    name: 'anthropic',
    model: 'claude-haiku-4-5',
    calls,
    async generate({ systemPrompt, userPrompt }) {
      calls.push({ systemPrompt, userPrompt });
      const text = JSON.stringify({
        verdict,
        confidence,
        rationale: rationale || 'Heuristic candidate confirmed; class names and structure match a tabs widget.'
      });
      return {
        text,
        model: 'claude-haiku-4-5',
        usage: { inputTokens: 600, outputTokens: 80 },
        latencyMs: 410
      };
    }
  };
}

// Synthesise the audit input the existing rebuild-full-pipeline tests use
// against this same fixture: per-page 1.3.1 violations on the two tab pages.
// The orchestrator surfaces these to transformers under the
// `findings`/`audit.findings`/`audit.violations` aliases via packageContext.
function tabsAudit() {
  return {
    violations: [
      { criterion: '1.3.1', file: 'tab-page-a.html', line: 1, message: 'div-soup tabs', snippet: '<div class="tab-container">', triage: 'author rework' },
      { criterion: '1.3.1', file: 'tab-page-b.html', line: 1, message: 'div-soup tabs', snippet: '<div class="tab-container">', triage: 'author rework' }
    ],
    scorecard: { failedCriteria: 1, criteriaResults: [{ id: '1.3.1', passed: false }] }
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('rebuild-pipeline: v5.1 transformer judgment', () => {
  // Skip if the fixture is missing in this branch.
  const haveFixture = fs.existsSync(FX_TABS);
  const itIf = haveFixture ? it : it.skip;

  itIf('match verdict attaches judgment + provenance to the tabs transform', async () => {
    const fake = makeJudgmentProvider('match', 0.92, 'Class names (tab-pane, tab-trigger) and structure (3 buttons + 3 panels under a common parent) are characteristic of a tabs widget.');
    const outDir = makeTmp('judg-match');

    const result = await rebuild(FX_TABS, tabsAudit(), {
      mode: 'full',
      engagementId: 'test-judgment-match',
      packageName: 'rebuild-tabs-divsoup.zip',
      outputDir: outDir,
      noCheckpoint: true,
      llmProviderInstance: fake
    });

    expect(fake.calls.length).toBeGreaterThan(0);
    // The fake should have received the v5.1 system prompt structure.
    expect(fake.calls[0].systemPrompt).toMatch(/accessibility|widget/i);

    const tabsTransforms = (result.manifest.transforms || []).filter(
      (t) => t.transformer === 'widget-replacement-tabs'
    );
    expect(tabsTransforms.length).toBeGreaterThan(0);

    for (const tx of tabsTransforms) {
      expect(tx.judgment).toBeDefined();
      expect(tx.judgment.source).toBe('llm');
      expect(tx.judgment.verdict).toBe('match');
      expect(tx.judgment.confidence).toBeCloseTo(0.92, 5);
      expect(tx.judgment.rationale.length).toBeGreaterThan(0);
      expect(tx.judgment.provider).toBe('anthropic');
      expect(tx.judgment.model).toBe('claude-haiku-4-5');
      expect(tx.judgment.promptHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(tx.judgment.usage.inputTokens).toBeGreaterThan(0);
      expect(typeof tx.judgment.latencyMs).toBe('number');
      expect(tx.judgment.generatedAt).toMatch(/T.*Z$/);
    }
    // Schema stays at 2.0.0 — v5.0 readers handle the new optional field.
    expect(result.manifest.schemaVersion).toBe('2.0.0');
  });

  itIf('uncertain verdict (low confidence) attaches judgment with verdict=uncertain', async () => {
    // Match-verdict but below the 0.7 threshold — transformer demotes to uncertain.
    const fake = makeJudgmentProvider('match', 0.55, 'Class names suggest a tabs pattern but the structure is ambiguous.');
    const outDir = makeTmp('judg-uncertain');

    const result = await rebuild(FX_TABS, tabsAudit(), {
      mode: 'full',
      engagementId: 'test-judgment-uncertain',
      packageName: 'rebuild-tabs-divsoup.zip',
      outputDir: outDir,
      noCheckpoint: true,
      llmProviderInstance: fake
    });

    const tabsTransforms = (result.manifest.transforms || []).filter(
      (t) => t.transformer === 'widget-replacement-tabs'
    );
    expect(tabsTransforms.length).toBeGreaterThan(0);
    // 0.55 < 0.7 default threshold — every match collapses to uncertain.
    for (const tx of tabsTransforms) {
      expect(tx.judgment.verdict).toBe('uncertain');
      expect(tx.judgment.confidence).toBeCloseTo(0.55, 5);
    }
  });

  itIf('no-match verdict drops the candidate and records a deferred entry', async () => {
    const fake = makeJudgmentProvider('no-match', 0, 'Despite tab-pane class names, this is a styled FAQ list, not a tabs widget.');
    const outDir = makeTmp('judg-nomatch');

    const result = await rebuild(FX_TABS, tabsAudit(), {
      mode: 'full',
      engagementId: 'test-judgment-nomatch',
      packageName: 'rebuild-tabs-divsoup.zip',
      outputDir: outDir,
      noCheckpoint: true,
      llmProviderInstance: fake
    });

    // No tabs transform was emitted (LLM rejected every candidate).
    const tabsTransforms = (result.manifest.transforms || []).filter(
      (t) => t.transformer === 'widget-replacement-tabs'
    );
    expect(tabsTransforms.length).toBe(0);

    // The rejection surfaces in deferred[] with a clear LLM reason.
    const llmDeferred = (result.manifest.deferred || []).filter(
      (d) => /LLM rejected as not a tabs widget/i.test(d.reason)
    );
    expect(llmDeferred.length).toBeGreaterThan(0);
    expect(llmDeferred[0].reason).toMatch(/styled FAQ list/i);
  });

  itIf('without a provider, transforms emit unchanged (no judgment field)', async () => {
    const outDir = makeTmp('judg-heuristic');

    const result = await rebuild(FX_TABS, tabsAudit(), {
      mode: 'full',
      engagementId: 'test-judgment-heuristic',
      packageName: 'rebuild-tabs-divsoup.zip',
      outputDir: outDir,
      noCheckpoint: true
      // No llmProviderInstance, no llmProvider — transformers run heuristic-only.
    });

    const tabsTransforms = (result.manifest.transforms || []).filter(
      (t) => t.transformer === 'widget-replacement-tabs'
    );
    expect(tabsTransforms.length).toBeGreaterThan(0);
    for (const tx of tabsTransforms) {
      expect(tx.judgment).toBeUndefined();
    }
  });

  itIf('checkpoint preview renders the AI verdict pill when judgment present', async () => {
    const fake = makeJudgmentProvider('match', 0.92, 'Tab pattern confirmed.');
    const outDir = makeTmp('judg-preview');

    const result = await rebuild(FX_TABS, tabsAudit(), {
      mode: 'full',
      engagementId: 'test-judgment-preview',
      packageName: 'rebuild-tabs-divsoup.zip',
      outputDir: outDir,
      noCheckpoint: true,
      llmProviderInstance: fake
    });

    const previewPath = path.join(makeTmp('preview-out'), 'rebuild-preview.html');
    const html = await renderRebuildPreview(result.manifest, null, previewPath, {});
    expect(html).toMatch(/AI-CONFIRMED/i);
    expect(html).toMatch(/claude-haiku-4-5/);
    expect(html).toMatch(/92%/);
    expect(html).toMatch(/AI rationale:/i);
    expect(html).toMatch(/Tab pattern confirmed/i);
  });
});
