# PRD v5.1: Transformer Judgment (LLM-Assisted Widget Classification)

**Status:** Shipped (2026-05-08). All four widget transformers wired (tabs/accordion/carousel/dialog); 5 integration tests in `test/integration/rebuild-judgment.test.js`. Side-effect orchestrator fixes plugged two pre-existing v5 leaks (judgment field passthrough, `result.deferred` propagation from transformers).
**Date:** 2026-05-08
**Author:** Dave Nguyen
**Built by:** Claude (autonomous)
**Supersedes nothing.** Extends [PRD v5](../v5-full-tier/PRD_v5_FullTier.md) by adding an optional LLM judgment layer to the four widget-replacement transformers (`tabs`, `accordion`, `carousel`, `dialog`). The full-tier orchestrator, manifest schema 2.0.0, checkpoint gate, undo flow, and existing rule-based transformers are unchanged. v5.1 adds (a) a judgment module, (b) a small hook in each widget transformer, (c) a new optional `judgment` field on the Transform record, and (d) a preview pill that surfaces the LLM verdict to the consultant approving the rebuild.

This is the third LLM-activation phase. v4.1 (assisted rebuild) and v3.1 (audit narrative) shipped first; v5.1 closes the loop by activating LLM in the structural rework tier where heuristics make the highest-leverage decisions.

---

## Problem statement

v5's widget-replacement transformers convert div-soup into vetted ARIA widgets — they detect "this looks like a tabs widget" by class-token matching, structural pattern detection, and decline rules (forms present, scripts present, item-count bounds). When the heuristic is right, the transformer ships a deterministic, reviewable replacement. When the heuristic is wrong, two failure modes:

- **False positive.** The transformer replaces markup that wasn't actually a tabs widget (e.g. a styled list of quotes that happens to use `class="tab-item"`). The checkpoint gate catches this — the consultant rejects the transform — but the package processed nothing for that candidate, costing review time and producing no improvement.
- **False negative.** The transformer's heuristic doesn't recognize a clear tabs pattern (idiosyncratic class names from a custom authoring tool template, e.g. `<div class="tcs-pane">`). The widget stays as inaccessible div-soup; the consultant has to fix it by hand.

Both failure modes are *judgment* problems, not data-extraction problems. Heuristics on class names and structural patterns are right most of the time but miss the long tail. An LLM looking at the actual HTML (and a short structural summary) can make better classifications: "yes, this is a tabs widget despite the unusual class names" or "no, this is a styled FAQ list, leave it alone."

v5.1 introduces a *judgment* call that runs alongside the existing heuristic. The heuristic still proposes candidates (it's faster and free); the LLM confirms or rejects. The verdict + confidence + rationale attach to the Transform record so the consultant sees exactly what the LLM thought when reviewing at the checkpoint.

---

## Goals

1. **Cut false positives at the checkpoint gate.** When the LLM rejects a heuristic candidate, the transformer skips that candidate and the consultant doesn't waste review time on it.
2. **Cut false negatives in the long tail.** v5.1 doesn't yet do *positive* discovery (LLM finding candidates the heuristic missed) — that's v5.2. But by widening the heuristic's accept threshold and using LLM as the disambiguator, the transformer can entertain candidates today's heuristic declines as ambiguous.
3. **Hold the v5 manifest contract.** Schema stays 2.0.0. The Transform record gains one new optional field (`judgment`); manifest validation accepts both v5 and v5.1 manifests interchangeably.
4. **Hold the checkpoint gate's load-bearing role.** LLM judgment never bypasses checkpoint approval. When the verdict is uncertain, the transform proceeds *into the staging area* — the consultant's approve/reject is still the final word.
5. **Engagement isolation, opt-in posture.** Provider is reinstantiated per `rebuild()` call; calls only happen when `--llm-provider` is set (and not `--no-llm-judgment`).

## Non-goals

1. **No positive discovery in v5.1.** Heuristic still produces the candidate list; LLM only confirms or rejects. v5.2 may add `proposeCandidates(packageContext)` for LLM-driven discovery.
2. **No vision input.** Judgment reads the candidate's HTML + structural summary only. Rendering a screenshot, sending it to a vision model, and deciding from pixels is a v5.2/v6 question.
3. **No autonomous landmark proposal.** Landmark transformers (`landmark-insertion`, `landmark-labeling`) keep their existing heuristic-only behavior in v5.1. Landmark judgment is a structurally similar problem and can be added in a follow-up using the same module.
4. **No page-split judgment.** `page-split` remains heuristic-only.
5. **No new web/cloud surfaces.** Engine + CLI only.

---

## Architecture

```
                       v5 (unchanged)
┌─────────────────────────────────────────────────────────────────────┐
│  REBUILD orchestrator → fixers pass → transformers pass             │
│  for each transformer:                                              │
│    if (transformer.canTransform(packageContext)) {                  │
│      result = await transformer.apply(packageContext)               │
│    }                                                                │
└─────────────────────────────────────────────────────────────────────┘
                                       │
                            new in v5.1: packageContext.provider
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Inside widget transformer's apply(packageContext):                 │
│                                                                     │
│  for (each heuristic candidate)                                     │
│    if (packageContext.provider) {                                   │
│      verdict = await classifyWidget({                               │
│        html, candidate, expectedType, provider, options             │
│      })                                                             │
│      if (verdict === 'no-match') skip; defer with reason            │
│      attach verdict to the emitted transform                        │
│    }                                                                │
│    emit transform + patches                                         │
└─────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
                  Transform record gains optional `judgment`
                                       │
                                       ▼
              checkpoint preview surfaces "AI verdict" pill
              alongside the existing provenance pill
```

### Components

- **`src/lib/transformer-judgment.js`** — NEW. Classification module. Exports `classifyWidget({ packageContext, html, candidate, expectedType, options, provider })` returning `{ ok, verdict, confidence, rationale, provenance } | { ok: false, reason }`. Reuses `generateAssistedSuggestion` from `src/lib/llm-provenance.js` under the hood.
- **`src/transformers/widget-replacement-tabs.js`** — MODIFIED. Inside `apply(packageContext)`, for each heuristic candidate, call `classifyWidget` when `packageContext.provider` is set. Skip candidates the LLM rejects; attach `judgment` to the emitted transform for the rest.
- **`src/transformers/widget-replacement-{accordion,carousel,dialog}.js`** — MODIFIED. Same pattern as tabs. Each transformer carries its own `expectedType` literal so the prompt is type-specific.
- **`src/rebuild/types.js`** — MODIFIED. The Transform typedef gains optional `judgment?: { source: 'llm', verdict, confidence, rationale, model, promptHash, usage, latencyMs, generatedAt }`.
- **`src/rebuild/manifest.js`** — MODIFIED. Manifest validator accepts the new field. Schema version stays `2.0.0`.
- **`src/reporter/rebuild-preview.js`** — MODIFIED. Per-transform card renders the AI judgment pill in the chip row, and a short rationale row beneath the existing rationale paragraph.
- **`src/rebuild/index.js`** — MODIFIED. `runTransformerPass()` threads the per-rebuild `llmProvider` into `packageContext.provider` (parallel to the v4.1 fixer-context wiring).
- **`src/lib/rebuild-cli.js`** — MODIFIED. New `--no-llm-judgment` flag (judgment is auto-on when `--llm-provider` is set; opt out for cost control).

The judgment module reuses the v4.1 provider abstraction wholesale. No new dependencies.

---

## Judgment API contract

```js
const { classifyWidget } = require('../lib/transformer-judgment');

const verdict = await classifyWidget({
  packageContext,                  // for engagementId / packageName provenance fields
  candidate: {
    file: 'pages/lesson-3.html',   // for the rationale + log
    html: '<div class="tab-pane">…</div>',     // the candidate HTML, clipped to ~3KB
    classes: ['tab-pane', 'active'],
    structure: {                                // a small structural summary
      tagName: 'div',
      childCount: 4,
      hasButtons: true,
      hasForm: false,
      headingCount: 0
    },
    rationale: 'matched TAB_CLASS_TOKENS on 3 children; no form present'
  },
  expectedType: 'tabs',            // 'tabs' | 'accordion' | 'carousel' | 'dialog'
  options: {                       // pass-through from packageContext
    engagementId,
    packageName,
    llmJudgmentMaxTokens: 256
  },
  provider                         // pre-built provider from packageContext.provider
});
```

Returns:

```js
{
  ok: true,
  verdict: 'match' | 'no-match' | 'uncertain',
  confidence: 0.92,                // 0 to 1; 0 when verdict is 'no-match'
  rationale: 'The classes and child structure match a tabs widget…',
  provenance: {
    source: 'llm',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    promptHash: 'sha256:…',
    usage: { inputTokens: 612, outputTokens: 87 },
    latencyMs: 410,
    generatedAt: '2026-05-08T19:40:11Z'
  }
}
```

On any provider error or validator rejection, returns `{ ok: false, reason: string }`. Transformers treat `ok: false` as "no judgment available" — the heuristic decision stands and the transform proceeds without a `judgment` field.

### How transformers consume the verdict

| Verdict | Behavior |
|---|---|
| `match` (confidence ≥ 0.7) | Emit the transform with `judgment` attached. Standard checkpoint approval. |
| `match` (confidence < 0.7) | Treat as `uncertain`. |
| `uncertain` | Emit the transform with `judgment` attached, but the preview pill renders in a "needs scrutiny" color. The consultant decides at checkpoint. |
| `no-match` | Skip the candidate. Push a `deferred` entry with reason `LLM rejected as not a {expectedType} widget: {brief rationale}`. |
| `ok: false` | Heuristic decision stands; transform emitted without a `judgment` field. A log line records the failure reason. |

The 0.7 confidence threshold is the only magic number. It's tunable via `--llm-judgment-confidence-threshold` (default 0.7).

---

## Manifest schema (v5.1 addition)

The Transform record gains one optional field:

```jsonc
{
  "id": "transform-0003",
  "transformer": "widget-replacement-tabs",
  "family": "widget",
  "criteria": ["1.3.1", "2.1.1", "4.1.2"],
  "tier": "full",
  "scope": { "files": ["pages/lesson-3.html"], "manifestEdited": false },
  "patchIds": ["patch-0007", "patch-0008", "patch-0009"],
  "provenance": {
    "source": "rule-based",
    "timestamp": "2026-05-08T19:40:09Z"
  },
  "rationale": "Replaced div-soup tab pattern with vetted ARIA tabs widget.",

  // NEW in v5.1 — optional, present only when LLM judgment ran.
  "judgment": {
    "source": "llm",
    "verdict": "match",
    "confidence": 0.92,
    "rationale": "The class names (`tab-pane`, `tab-trigger`) and the structure (3 buttons followed by 3 panels in the same parent) are characteristic of a tabs widget. The absence of a form rules out a stepper.",
    "provider": "anthropic",
    "model": "claude-haiku-4-5",
    "promptHash": "sha256:…",
    "usage": { "inputTokens": 612, "outputTokens": 87 },
    "latencyMs": 410,
    "generatedAt": "2026-05-08T19:40:11Z"
  },

  "previewPath": "rebuild-preview.html#transform-0003",
  "requiresCheckpointApproval": true,
  "status": "pending-checkpoint"
}
```

Manifest schema version stays `2.0.0`. v5.0 readers ignore the unknown `judgment` field. v5.1 readers handle both shapes.

---

## Prompt design

### `classifyWidget` prompt

**System prompt** (constant, cached-friendly):
- Voice: senior accessibility engineer reviewing a heuristic's candidate.
- Output schema (strict): a JSON object with three keys — `verdict`, `confidence`, `rationale`. No prose outside the JSON.
- Constraint: the model must reason from the *actual HTML structure*, not the class names alone. (Class names can be misleading — `class="tab-pane"` on a styled FAQ list is the canonical false positive.)
- Constraint: `verdict` ∈ `{"match", "no-match", "uncertain"}`. `confidence` ∈ `[0.0, 1.0]`. `rationale` ≤ 240 characters.

**User prompt** (per candidate):
- The expected widget type (`tabs`, `accordion`, `carousel`, `dialog`).
- The candidate's HTML (clipped to ~3KB; the structural summary covers the rest).
- The structural summary (tagName, childCount, hasButtons, hasForm, headingCount, characteristic class tokens).
- The heuristic's rationale ("why I think this is a tabs widget").

**Output validation** (in `transformer-judgment.js`):
- Must parse as JSON.
- `verdict` must be one of the three literals.
- `confidence` must be a number in [0, 1].
- `rationale` must be a string ≤ 280 characters.
- On any parse failure, return `{ ok: false, reason: 'invalid LLM response shape' }`.

This is the only structured-output prompt in the project so far. Phase 4+ work (positive widget discovery, landmark proposal) will follow the same JSON-output pattern; the validator is reusable.

---

## Checkpoint preview surface

The per-transform card in `rebuild-preview.html` gains:

1. **AI verdict pill** in the chip row, next to the existing provenance pill:
   - `AI-CONFIRMED · claude-haiku-4-5 · 92%` (verdict=match, brand "system" green)
   - `AI-UNCERTAIN · claude-haiku-4-5 · 58%` (verdict=uncertain, brand "system" amber)
   - No pill when `judgment` is absent (heuristic-only path).

2. **AI rationale row** beneath the existing rationale paragraph:
   - `AI rationale: The class names (tab-pane, tab-trigger) and the structure are characteristic of a tabs widget. The absence of a form rules out a stepper.`

3. **AI rejection footnote** in the deferred-list section: when LLM rejected a candidate, render a row showing what was rejected and the rationale, so the consultant sees what *didn't* make it into the rebuild — and can override (re-run with `--no-llm-judgment`) if the rejection looks wrong.

The checkpoint approval form is unchanged — the consultant still approves or rejects; the AI pill is informational, not gating.

---

## Cost & safety guardrails

- **Per-package judgment budget.** Default `--llm-judgment-token-budget 20000` (~$0.025/package on Haiku 4.5 across all candidates). When the running total exceeds the budget, remaining candidates fall back to heuristic-only and the package's manifest log records `judgment budget exceeded`.
- **Per-call timeout and retry.** Reuse the v4.1 provider defaults (15 s, one retry on 429/5xx). On persistent failure: heuristic decision stands; no `judgment` field on the emitted transform.
- **No fallback model.** Same posture as v4.1 / v3.1.
- **Engagement isolation.** Provider is reinstantiated per `rebuild()` call; engagement ID recorded in every judgment's `generatedAt` provenance.
- **Candidate HTML clipping.** ~3KB max sent to the model. Wider context goes through the structural summary, not the raw HTML.
- **Confidence threshold.** Default 0.7 — tunable per engagement. Below threshold, the transform is marked uncertain and the preview surfaces it for human attention.
- **Heuristic-only is the safety floor.** If LLM is off, mis-configured, over-budget, or returns invalid output, the transformer behaves exactly as it does today. v5.1 adds nothing that can break v5.

---

## CLI surface

```
prism rebuild <pkg.zip> --engagement <id> --mode full
  [--llm-provider anthropic|openai]                # already from v4.1
  [--llm-key-from-env <env-var-name>]              # already from v4.1
  [--llm-model <model-id>]                         # already from v4.1
  [--no-llm-judgment]                              # NEW in v5.1; default on when --llm-provider set
  [--llm-judgment-token-budget <n>]                # NEW; default 20000
  [--llm-judgment-confidence-threshold <0..1>]     # NEW; default 0.7
```

`audit` and `audit-library` are unaffected (judgment lives in the rebuild path only).

**Mode interactions.**

| `--mode` | `--llm-provider` | `--no-llm-judgment` | Behavior |
|---|---|---|---|
| safe | any | any | LLM ignored. v4 path. |
| assisted | none | any | Assisted-tier fixers defer (v4.1 contract). No judgment. |
| assisted | set | any | Assisted-tier fixers run (v4.1). No judgment (assisted has no transformers). |
| full | none | any | Heuristic-only transformers. v5 path. |
| full | set | (default) | Heuristic-only fixers + LLM-judgment-enhanced widget transformers. |
| full | set | passed | Heuristic-only transformers (LLM is reserved for assisted-tier fixers only). |

---

## Acceptance criteria for v5.1

The release ships when all of the following are true:

1. `prism rebuild <fixture> --mode full --llm-provider anthropic --llm-key-from-env ANTHROPIC_API_KEY` against a tabs-pattern fixture produces a manifest whose tabs transform has a `judgment` field with verdict, confidence, rationale, and full provenance.
2. The same command with `--no-llm-judgment` produces a manifest whose transforms do NOT have a `judgment` field — byte-identical to the v5 path for the transform record.
3. The same command without `--llm-provider` produces the same heuristic-only manifest.
4. When the fake provider returns `verdict: "no-match"`, the candidate is dropped from the patches list and a `deferred` entry records the LLM rejection.
5. The checkpoint preview HTML renders the AI pill (`AI-CONFIRMED` / `AI-UNCERTAIN`) for transforms with `judgment`; renders nothing new when `judgment` is absent.
6. Manifest schema version stays `2.0.0`. A v5.0 manifest reader loads a v5.1-emitted manifest without modification.
7. `npm test` passes. The integration test injects a fake provider via the existing `opts.llmProviderInstance` injection point.
8. `npm run check-no-network` passes. The fake-provider test path does not trigger the egress trap.

---

## Risks and mitigations

- **LLM rejects a real widget the heuristic correctly identified.** Mitigation: the consultant sees the rejection in the deferred-list footnote and can re-run with `--no-llm-judgment` to bypass. The cost of one false rejection is one re-run, not a broken package.
- **LLM confirms a non-widget the heuristic incorrectly identified.** Mitigation: the `match` verdict still goes through the checkpoint gate. The pill says "AI-CONFIRMED" with confidence; the consultant reviews the side-by-side preview and rejects if the LLM was wrong. The pill is informational, not gating.
- **Judgment cost runs away on large libraries.** Per-package budget bounds it. A typical SCORM package with 3–5 widget candidates and 4 transformers maxes out at ~20 candidate calls × ~1KB in/out each = ~20K tokens / package. Default budget covers this.
- **Engagement A's judgment context leaks into engagement B.** Mitigation: provider reinstantiated per rebuild; engagement ID in every judgment's `generatedAt` (and per-call provenance metadata).
- **Schema drift between v5 and v5.1 manifests.** Mitigation: schema version stays 2.0.0. The new field is optional. Validator accepts both shapes. Older readers ignore unknown fields per JSON convention.

---

## Sequencing

v5.1 is a single workstream. Order:

1. `archive/workstreams/v5.1-judgment/PRD_v5.1_TransformerJudgment.md` (this document) — defines the contract.
2. `src/lib/transformer-judgment.js` — defines the API the transformers will consume.
3. Wave 1 in parallel after step 2 (the API is the contract):
   - `src/transformers/widget-replacement-{tabs,accordion,carousel,dialog}.js` — wire the LLM call into each transformer.
   - `src/rebuild/types.js` + `src/rebuild/manifest.js` — extend Transform typedef, accept the new field in validation.
   - `src/reporter/rebuild-preview.js` — render the AI pill + rationale row.
4. `src/rebuild/index.js` + `src/lib/rebuild-cli.js` — thread provider into `packageContext`, register `--no-llm-judgment` and the budget/threshold flags.
5. Integration test: full-tier rebuild with fake provider; assert manifest carries judgment and preview renders the pill.

Steps 2 and 3 share the JSON-output contract; the PRD is the source of truth for the verdict shape so they can run concurrently.
