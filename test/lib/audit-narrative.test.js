/**
 * Tests for v3.1 audit narrative generation.
 *
 * Two layers:
 *  - Unit tests against generateNarrative + the validators (no real provider).
 *  - End-to-end test through writeReports: rendered HTML/Markdown contains the
 *    provenance pill when narrative succeeds; renders byte-identically to the
 *    no-LLM run when narrative is disabled.
 *
 * Provider is always a fake (returns canned text). No real network call.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';

const require = createRequire(import.meta.url);

const {
  generateNarrative,
  generateLibrarySynthesis,
  validateExecutive,
  validateCriterionGuide,
  validateScopeMemo
} = require('../../src/lib/audit-narrative.js');
const { writeReports } = require('../../src/reporter/index.js');

// ─── Helpers ──────────────────────────────────────────────────────────────

const tmpDirs = [];
function makeTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `prism-narr-${prefix}-`));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

/**
 * Build a fake provider that returns canned text per route. Routes match on
 * the user prompt; the order matters — first match wins.
 */
function makeFakeProvider(routes, model = 'claude-haiku-4-5') {
  const calls = [];
  return {
    name: 'anthropic',
    model,
    calls,
    async generate({ systemPrompt, userPrompt }) {
      calls.push({ systemPrompt, userPrompt });
      for (const [predicate, text] of routes) {
        if (predicate(userPrompt, systemPrompt)) {
          return {
            text,
            model,
            usage: { inputTokens: 100, outputTokens: 50 },
            latencyMs: 50
          };
        }
      }
      // Fallback returns a 3-item list so the scope-memo validator passes.
      // Tests that need different defaults should add a route earlier.
      return {
        text: '- Start with alt-text fixes because they unblock screen readers across every page.\n' +
              '- Batch-fix link text rewrites since the pattern is consistent across pages.\n' +
              '- Defer contrast token rewrites until after the brand refresh.',
        model,
        usage: { inputTokens: 50, outputTokens: 10 },
        latencyMs: 25
      };
    }
  };
}

/**
 * A minimum-viable enriched scorecard, enough to exercise every prompt path.
 */
function makeScorecard() {
  return {
    tool: 'prism',
    version: 'test',
    wcagVersion: 'wcag22',
    packageType: 'scorm12',
    passed: false,
    score: 35,
    summary: {
      criteriaEvaluated: 50,
      criteriaPassed: 38,
      criteriaFailed: 12,
      totalViolations: 47,
      bySeverity: { serious: 28, moderate: 15, minor: 4 },
      byConfidence: { definitive: 30, likely: 17 }
    },
    criteria: [
      { id: '1.1.1', name: 'Non-text content', level: 'A', wcagIntroduced: '2.0', violationCount: 23, passed: false },
      { id: '2.4.4', name: 'Link purpose', level: 'A', wcagIntroduced: '2.0', violationCount: 12, passed: false },
      { id: '3.3.2', name: 'Labels or instructions', level: 'A', wcagIntroduced: '2.0', violationCount: 8, passed: false },
      { id: '1.4.3', name: 'Contrast (minimum)', level: 'AA', wcagIntroduced: '2.0', violationCount: 4, passed: false }
    ],
    violations: [
      { criterion: '1.1.1', file: 'p1.html', line: 11, snippet: '<img src="x.png">', message: 'missing alt' }
    ],
    triage: {
      rollup: {
        dominantTag: 'auto-fix safe',
        byTriage: { 'auto-fix safe': 30, 'auto-fix assisted': 10, 'author rework': 7 }
      }
    },
    scopeEstimate: { totalHours: 12, breakdown: {} },
    topRisks: ['Missing alt text', 'Vague link text', 'Color contrast'],
    engagementId: 'test-eng',
    section508Table: [],
    complete: true,
    incompleteReason: null
  };
}

// ─── Unit tests: validators ───────────────────────────────────────────────

describe('audit-narrative validators', () => {
  it('validateExecutive rejects "As an AI" prefix', () => {
    const reason = validateExecutive('As an AI assistant, I think this package has issues.', { totalViolations: 47 });
    expect(reason).toBeTruthy();
  });

  it('validateExecutive rejects HTML-injection characters', () => {
    expect(validateExecutive('Some text with <script> tags here.', { totalViolations: 47 })).toBeTruthy();
  });

  it('validateExecutive rejects text containing numbers absent from inputs', () => {
    // "47 issues" matches; "999" does not appear in inputs and must be rejected.
    const inputs = { totalViolations: 47, criteriaFailed: 12 };
    expect(validateExecutive('Found 999 issues across this package.', inputs)).toBeTruthy();
  });

  it('validateExecutive accepts grounded prose', () => {
    const inputs = { totalViolations: 47, criteriaFailed: 12 };
    const text = 'This package shows 47 violations across 12 failed criteria. The dominant pattern is missing alt text.';
    expect(validateExecutive(text, inputs)).toBeNull();
  });

  it('validateCriterionGuide rejects text containing the literal SC number', () => {
    expect(validateCriterionGuide('Per WCAG 1.1.1, all images need alt text.', '1.1.1')).toBeTruthy();
  });

  it('validateCriterionGuide accepts plain-language guidance', () => {
    const text = 'Several images lack descriptive alt text. Add a one-line description for each content image.';
    expect(validateCriterionGuide(text, '1.1.1')).toBeNull();
  });

  it('validateScopeMemo rejects fewer than 3 items', () => {
    expect(validateScopeMemo('- Start with alt text fixes\n- Defer contrast work')).toBeTruthy();
  });

  it('validateScopeMemo accepts a 3-item list', () => {
    const text = '- Start with alt-text fixes because they unblock screen readers across every page.\n' +
                 '- Batch-fix link text rewrites since the pattern is consistent across pages.\n' +
                 '- Defer the brand contrast rewrites until after the upcoming refresh.';
    expect(validateScopeMemo(text)).toBeNull();
  });
});

// ─── Unit tests: generateNarrative ────────────────────────────────────────

describe('generateNarrative', () => {
  it('returns null when no provider is supplied', async () => {
    const result = await generateNarrative({
      auditResults: makeScorecard(),
      options: { engagementId: 'test' },
      provider: null
    });
    expect(result).toBeNull();
  });

  it('returns the full structure with provenance for every section', async () => {
    // Route on systemPrompt to disambiguate which section is being requested:
    // each section uses a different "You are a ..." opening, so substring
    // matches against the system prompt are stable.
    const fake = makeFakeProvider([
      // executive narrative
      [(_u, s) => /executive narrative/i.test(s),
       'This package shows 47 violations across 12 failed criteria, dominated by missing alt text on content imagery. The 23 alt-text fixes would resolve about half of the user-facing issues.'],
      // per-criterion guides
      [(_u, s) => /explaining a specific finding|content author/i.test(s),
       'Several pages lack descriptive content for this criterion. Add a short description for each instance.'],
      // scope memo
      [(_u, s) => /scope memo/i.test(s),
       '- Start with alt-text fixes because they unblock screen readers across every page.\n' +
       '- Batch-fix link text rewrites since the pattern is consistent across pages.\n' +
       '- Defer the contrast token rewrites until after the brand refresh.']
    ]);

    const result = await generateNarrative({
      auditResults: makeScorecard(),
      options: { engagementId: 'test' },
      provider: fake
    });

    expect(result).not.toBeNull();
    expect(result.schemaVersion).toBe('1.0.0');
    expect(result.executive).not.toBeNull();
    expect(result.executive.text.length).toBeGreaterThan(0);
    expect(result.executive.provenance.provider).toBe('anthropic');
    expect(result.executive.provenance.model).toBe('claude-haiku-4-5');
    expect(result.executive.provenance.promptHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.executive.provenance.usage.inputTokens).toBeGreaterThan(0);

    expect(Array.isArray(result.remediationGuides)).toBe(true);
    expect(result.remediationGuides.length).toBeGreaterThan(0);
    for (const guide of result.remediationGuides) {
      expect(guide.criterion).toMatch(/\d/);
      expect(guide.text.length).toBeGreaterThan(0);
      expect(guide.provenance.provider).toBe('anthropic');
    }

    expect(result.scopeMemo).not.toBeNull();
    expect(result.scopeMemo.text.length).toBeGreaterThan(0);
    expect(result.scopeMemo.provenance.provider).toBe('anthropic');

    expect(result.totals.sectionsAttempted).toBeGreaterThan(0);
    expect(result.totals.sectionsSucceeded).toBeGreaterThan(0);
  });

  it('respects the criterion cap', async () => {
    const fake = makeFakeProvider([
      // Match the per-criterion-guide system prompt; let exec/scope hit the
      // fallback which is also a passable list/text shape.
      [(_u, s) => /content author/i.test(s),
       'Several pages have issues for this criterion. Apply the standard fix pattern.']
    ]);

    const sc = makeScorecard();
    // Add many failed criteria so the cap actually bites.
    for (let i = 0; i < 20; i++) {
      sc.criteria.push({
        id: `9.${i}.${i}`,
        name: `Synthetic criterion ${i}`,
        level: 'A',
        violationCount: i + 1,
        passed: false
      });
    }

    const result = await generateNarrative({
      auditResults: sc,
      options: { engagementId: 'test', llmNarrativeCriterionCap: 5 },
      provider: fake
    });

    expect(result.remediationGuides.length).toBeLessThanOrEqual(5);
  });

  it('skips sections when the token budget is exhausted', async () => {
    const fake = makeFakeProvider([], 'claude-haiku-4-5');

    const result = await generateNarrative({
      auditResults: makeScorecard(),
      options: { engagementId: 'test', llmNarrativeTokenBudget: 1 },
      provider: fake
    });

    // With a 1-token budget, the very first call's estimate exceeds it,
    // so every section should be skipped (null) and no provider call should
    // ever happen.
    expect(fake.calls.length).toBe(0);
    expect(result.executive).toBeNull();
    expect(result.scopeMemo).toBeNull();
    // remediationGuides may be null or empty depending on implementation;
    // both signal "section produced no output".
    expect(result.remediationGuides == null || result.remediationGuides.length === 0).toBe(true);
  });
});

// ─── Unit tests: generateLibrarySynthesis ─────────────────────────────────

describe('generateLibrarySynthesis', () => {
  it('returns null when no provider is supplied', async () => {
    const result = await generateLibrarySynthesis({
      libraryAudit: { packageCount: 10, totalViolations: 470 },
      options: { engagementId: 'test' },
      provider: null
    });
    expect(result).toBeNull();
  });

  it('produces a synthesis block with provenance when provider succeeds', async () => {
    const fake = makeFakeProvider([
      [() => true,
       'Across 10 packages we see 470 violations. The dominant pattern is missing alt text. Recommend a single template fix.']
    ]);

    const result = await generateLibrarySynthesis({
      libraryAudit: {
        packageCount: 10,
        totalViolations: 470,
        triageDistribution: { 'auto-fix safe': 200 },
        totalEffortHours: 24
      },
      options: { engagementId: 'test' },
      provider: fake
    });

    expect(result).not.toBeNull();
    expect(result.synthesis).not.toBeNull();
    expect(result.synthesis.text.length).toBeGreaterThan(0);
    expect(result.synthesis.provenance.provider).toBe('anthropic');
  });
});

// ─── End-to-end: writeReports renders the narrative slot ──────────────────

describe('writeReports + narrative integration', () => {
  let outputDir;

  beforeAll(() => {
    outputDir = makeTmp('writeReports-narrative-out');
  });

  it('renders the narrative section with provenance pill in the HTML report', async () => {
    // Stash and restore process.env so the LLM-enabled path resolves.
    const originalKey = process.env.NARRATIVE_TEST_KEY;
    process.env.NARRATIVE_TEST_KEY = 'sk-fake-narrative-test';

    // Patch buildProviderFromOptions so writeReports' narrative call uses our fake
    // without ever instantiating a real Anthropic client. We replace the export
    // on the loaded module; restore on cleanup.
    const provenanceMod = require('../../src/lib/llm-provenance.js');
    const original = provenanceMod.buildProviderFromOptions;
    // Canned text avoids specific numbers so the executive validator's
    // numeric-grounding check (numbers must appear in scorecard inputs) can't
    // reject for this minimal-violations scorecard.
    const fake = makeFakeProvider([
      [(_u, s) => /executive narrative/i.test(s),
       'This package shows the dominant pattern is missing alt text on content imagery. Recommend starting with the alt-text remediation since it unblocks screen-reader navigation across every page in the module.'],
      [(_u, s) => /content author/i.test(s),
       'Several pages have issues for this criterion. Apply the standard fix pattern.'],
      [(_u, s) => /scope memo/i.test(s),
       '- Start with alt-text fixes because they unblock every page.\n- Batch-fix link rewrites since the pattern is consistent.\n- Defer contrast work until after the brand refresh.']
    ]);
    provenanceMod.buildProviderFromOptions = () => fake;

    try {
      const auditViolations = [
        { criterion: '1.1.1', file: 'p1.html', line: 11, message: 'missing alt', snippet: '<img>' }
      ];

      const reportResult = await writeReports({
        scorecard: null,
        violations: auditViolations,
        manualReview: { items: [] },
        scos: [],
        dynamicReport: { skipped: false, iframeWarnings: [], violations: [] },
        fixesApplied: null,
        options: {
          output: outputDir,
          standard: 'wcag22',
          packageType: 'scorm12',
          packagePath: '/tmp/fake.zip',
          engagementId: 'test-eng',
          llmProvider: 'anthropic',
          llmKeyFromEnv: 'NARRATIVE_TEST_KEY',
          // narrative is on by default
        }
      });

      expect(reportResult.htmlPath).toBeTruthy();
      const html = fs.readFileSync(reportResult.htmlPath, 'utf8');
      // The provenance pill marker is the durable contract: model id +
      // generated-at timestamp + the "review before sharing" warning.
      expect(html).toMatch(/AI-?DRAFTED/i);
      expect(html).toMatch(/claude-haiku-4-5/);
      expect(html).toMatch(/review before sharing/i);
      // The executive prose itself appears verbatim.
      expect(html).toMatch(/dominant pattern is missing alt text/i);

      // Markdown has the same contract.
      const md = fs.readFileSync(reportResult.mdPath, 'utf8');
      expect(md).toMatch(/AI-?drafted/i);
      expect(md).toMatch(/dominant pattern is missing alt text/i);
    } finally {
      provenanceMod.buildProviderFromOptions = original;
      if (originalKey === undefined) delete process.env.NARRATIVE_TEST_KEY;
      else process.env.NARRATIVE_TEST_KEY = originalKey;
    }
  });

  it('renders byte-identical HTML when --no-llm-narrative is set', async () => {
    const auditViolations = [
      { criterion: '1.1.1', file: 'p1.html', line: 11, message: 'missing alt', snippet: '<img>' }
    ];

    const baseOpts = {
      scorecard: null,
      violations: auditViolations,
      manualReview: { items: [] },
      scos: [],
      dynamicReport: { skipped: false, iframeWarnings: [], violations: [] },
      fixesApplied: null
    };

    const dirA = makeTmp('no-llm-out');
    const dirB = makeTmp('explicit-no-narrative-out');

    const noLlm = await writeReports({
      ...baseOpts,
      options: {
        output: dirA,
        standard: 'wcag22',
        packageType: 'scorm12',
        packagePath: '/tmp/fake.zip',
        engagementId: 'test-eng-byte-A',
      }
    });

    const explicitOff = await writeReports({
      ...baseOpts,
      options: {
        output: dirB,
        standard: 'wcag22',
        packageType: 'scorm12',
        packagePath: '/tmp/fake.zip',
        engagementId: 'test-eng-byte-B',
        // LLM provider not set + narrative turned off — both knobs should
        // resolve to "no narrative", and the HTML should match what the
        // pre-v3.1 path produced.
        llmNarrative: false
      }
    });

    // Engagement IDs differ; strip them before comparison so we're comparing
    // the body, not the per-engagement metadata.
    const stripEng = (s) => s.replace(/test-eng-byte-[AB]/g, 'test-eng-byte');
    const htmlA = stripEng(fs.readFileSync(noLlm.htmlPath, 'utf8'));
    const htmlB = stripEng(fs.readFileSync(explicitOff.htmlPath, 'utf8'));
    expect(htmlA).toBe(htmlB);

    // And neither contains the pill marker.
    expect(htmlA).not.toMatch(/AI-?DRAFTED/i);
  });
});
