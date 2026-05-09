# PRD v4.1: Assisted Tier (LLM-Generated Content)

**Status:** Shipped (2026-05-08). All acceptance criteria met; assisted fixers `generate-alt-text`, `rewrite-link-text`, `generate-form-label` live, integration tests in `test/integration/rebuild-pipeline.test.js`.
**Date:** 2026-05-08
**Author:** Dave Nguyen
**Built by:** Claude (autonomous)
**Supersedes nothing.** Extends [PRD v4](../v4-rebuild/PRD_v4_Rebuild.md) by lighting up the assisted tier the v4 orchestrator already dispatches to. The safe-tier fixers, manifest schema, diff report, undo, and verification step are unchanged. v4.1 adds (a) a provider abstraction, (b) three judgment-based fixers, and (c) the orchestrator + CLI glue to load assisted-tier fixers when the operator has supplied LLM credentials.

---

## Problem statement

v4's safe tier handles every WCAG 2.2 AA / Section 508 finding that has a deterministic right answer. Everything else — missing alt text on content images, vague link text ("click here", "more"), form controls with no label at all — gets written into `manifest.deferred[]` with the reason `tier=assisted not enabled in mode=safe`. A senior consultant still sees these in the report and fixes them by hand; for a 200-package library that is hours per package.

The v3 LLM provenance scaffolding (`src/lib/llm-provenance.js`), the v4 manifest's tier-conditional `provenance.{model, promptHash, modelConfidence}` fields, and the v4 diff report's `needs sign-off` chip were all built for this moment. v4.1 is the smallest change that converts that scaffolding into a working assisted tier: a provider, three fixers, and the dispatch wiring.

---

## Goals

1. **Eliminate the deferred-feature stub.** `--mode assisted` runs end-to-end with real LLM-generated patches when credentials are supplied; without credentials it degrades cleanly to today's deferred behavior with a clear message.
2. **Hold the v4 manifest contract.** Schema stays `1.0.0`. Assisted patches populate the tier-conditional provenance fields v4 already specified. No manifest reader needs to change.
3. **Hold the v4 diff report contract.** Assisted patches render with the existing `needs sign-off` chip and approval checkbox. No reporter needs to change.
4. **Make every assisted patch reviewable, reversible, and auditable.** Same `revert()` interface as safe-tier patches. Provenance includes provider, model, prompt hash, latency, and token usage so the consultant can audit exactly what the LLM saw and produced.
5. **Hold the no-telemetry posture.** The provider call is the only outbound network call introduced; it is opt-in (off without `--llm-provider`), it goes only to the configured provider, and `scripts/check-no-network.js` gains a per-test override rather than a blanket allowlist.

## Non-goals

1. **No new tier in v4.1.** The full tier (transformers, page splits, widget replacement) is v5 and stays in v5. Assisted fixers are still per-file, per-criterion judgment items — not structural rework.
2. **No multi-modal / vision calls.** Alt-text generation in v4.1 reads the surrounding HTML context (filename, alt of sibling images, caption text, paragraph context) and the image filename — it does not download or send the image. Vision-based alt is on the v4.2 / v5 wishlist.
3. **No prompt tuning telemetry.** We will not collect prompt/response pairs across runs to improve prompts. Each engagement's calls stay in that engagement.
4. **No parallel provider calls in v4.1.** Assisted fixers run sequentially per file. Concurrency is a v4.2 optimization once we have a real cost / throughput baseline.
5. **No changes to web/ or cloud/.** v4.1 is engine + CLI only. The hosted service can adopt assisted later by passing the same options through `audit()` / `rebuild()`.

---

## Architecture

```
                                       v4 (unchanged)
┌─────────────────────────────────────────────────────────────────────┐
│  REBUILD orchestrator (src/rebuild/index.js)                        │
│                                                                     │
│  loadFixers(['safe'])                ← mode=safe                    │
│  loadFixers(['safe','assisted'])     ← mode=assisted   (NEW path)   │
│  loadFixers(['safe','assisted','full']) ← mode=full   (NEW: assisted│
│                                                       runs in full) │
└─────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Per-file fixer loop                                                │
│  for each violation -> for each fixer with canFix() -> apply()      │
│                                                                     │
│  Assisted fixer apply() additionally calls:                         │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ generateAssistedSuggestion({                                │    │
│  │   violation, prompt, context, options                       │    │
│  │ }) → { text, provenance } | null                            │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                            │                                         │
│                            ▼                                         │
│              src/lib/llm-provider.js                                │
│              ┌────────────────────────────┐                          │
│              │ getProvider(name, apiKey)  │                          │
│              │  .generate({system, user}) │                          │
│              └────────────────────────────┘                          │
│                            │                                         │
│              ┌─────────────┴─────────────┐                           │
│              ▼                           ▼                           │
│        anthropic provider          openai provider (v4.2)           │
└─────────────────────────────────────────────────────────────────────┘
```

### Components

- **`src/lib/llm-provider.js`** — NEW. Provider abstraction. Exports `getProvider(name, apiKey, opts)` returning `{ name, model, generate(opts) }`. Implementations: `anthropic` (v4.1, via the official `@anthropic-ai/sdk`), `openai` (v4.2 stub that throws "not implemented").
- **`@anthropic-ai/sdk`** — NEW runtime dependency. Required for the Anthropic provider implementation. Adds typed error classes (`Anthropic.RateLimitError`, `Anthropic.APIError`, etc.) and a stable wire layer; per the project's no-telemetry posture, the only outbound traffic the SDK emits is the configured provider call.
- **`src/lib/llm-provenance.js`** — MODIFIED. Replace `stubAssistedSuggestion()` with `generateAssistedSuggestion()` that wires through the provider. Keep stub exported under deprecated alias for one release.
- **`src/fixers/generate-alt-text.js`** — NEW. 1.1.1 content images missing alt.
- **`src/fixers/rewrite-link-text.js`** — NEW. 2.4.4 vague link text.
- **`src/fixers/generate-form-label.js`** — NEW. 3.3.2 form controls with no label at all.
- **`src/rebuild/index.js`** — MODIFIED. (1) `loadFixers` accepts a `tiers[]` array; (2) the early-exit assisted stub at lines 812–839 is removed; (3) opts.llmProvider/llmKeyFromEnv are threaded into each fixer's `apply()` context.
- **`src/lib/rebuild-cli.js`** — MODIFIED. The early-exit assisted stub at lines 235–242 is removed. `--llm-provider` / `--llm-key-from-env` are accepted on the rebuild command and forwarded.
- **`src/cli.js`** — MODIFIED. The two new flags are registered on `rebuild` and `rebuild-library`.

---

## Provider contract

The provider abstraction is intentionally thin. v4.1 ships exactly one provider; the abstraction exists so v4.2's OpenAI / Azure-OpenAI implementations don't reshape any caller.

```js
const { getProvider } = require('../lib/llm-provider');

const provider = getProvider('anthropic', process.env.ANTHROPIC_API_KEY, {
  model: 'claude-haiku-4-5',  // default — use alias, not date-suffixed ID
  maxTokens: 256,             // per call default
  timeoutMs: 15000
});

const result = await provider.generate({
  systemPrompt: '…',
  userPrompt: '…',
  maxTokens: 128                         // per-call override allowed
});
// result: { text, model, usage: { inputTokens, outputTokens }, latencyMs }
// throws on: timeout, network error, 4xx, 5xx after retries
```

**Defaults.** Haiku 4.5 by default (alias `claude-haiku-4-5`) — alt text, link rewrites, and label generation are short, well-scoped tasks that Haiku handles confidently and at the lowest cost. Sonnet 4.6 is opt-in via `--llm-model claude-sonnet-4-6`. Opus is not in scope for v4.1.

**Network exception.** The provider is the only outbound call introduced. `scripts/check-no-network.js` gains a `LLM_NETWORK_ALLOWED=1` env-var override that integration tests using a fake provider don't need but that real-credential smoke tests can opt into. Production CI continues to assert no network.

**Retry.** On `429` or `5xx`: one retry with 1 s backoff. After that, the call surfaces an error to the fixer, which defers the violation rather than failing the rebuild.

---

## Fixer interface (assisted-tier addendum)

Assisted fixers expose the same v4 interface — `id`, `name`, `criterion`, `triage`, `tier`, `confidence`, `canFix`, `apply`, `revert`, plus the v4 fields. Three fields differ:

```js
module.exports = {
  // ... v4 fields unchanged ...
  tier: 'assisted',                    // was 'safe' for v4 fixers
  provenance: 'llm',                   // was 'deterministic'
  confidence: 'needs-review',          // assisted output always needs sign-off

  // canFix is unchanged in shape but typically narrower:
  // it should reject violations the LLM cannot reason about confidently
  // (e.g. an image with no surrounding text context at all).
  canFix(file, violation) { ... },

  // apply() calls generateAssistedSuggestion() and decorates the patch's
  // provenance object. If the LLM call fails or returns invalid output,
  // apply() returns { changed: false, patches: [], log: ['<reason>'] }
  // and the violation defers.
  async apply(file, violations, context) {
    // context.options carries llmProvider, llmKeyFromEnv, llmModel,
    //   engagementId, packageName, etc.
    // context.packageContext carries siblings (existing v4 contract)
    ...
  },

  // revert is identical to v4 — patches are byte-level edits and reverse
  // exactly the same way regardless of provenance.
  async revert(file, patch) { return revertPatch(file, patch); }
};
```

The `context` argument is new. v4 fixers received `(file, violations)`; the orchestrator now passes a third argument containing options and package metadata. v4 fixers ignore it (JS arity is permissive); assisted fixers depend on it. This is the smallest possible change to the v4 contract.

---

## Manifest provenance (assisted-tier addendum)

The patch provenance object for assisted patches:

```jsonc
{
  "id": "patch-0042",
  "fixer": "generate-alt-text",
  "criterion": "1.1.1",
  "triage": "auto-fix assisted",
  "tier": "assisted",
  "confidence": "needs-review",
  "provenance": {
    "source": "llm",
    "timestamp": "2026-05-08T19:14:22Z",
    "provider": "anthropic",
    "model": "claude-haiku-4-5",
    "promptHash": "sha256:7b2c…",          // SHA-256 of (systemPrompt + userPrompt)
    "modelConfidence": null,                 // reserved; v4.1 does not request self-rated confidence
    "usage": { "inputTokens": 412, "outputTokens": 18 },
    "latencyMs": 723
  },
  // ... file, range, before, after, rationale, reversible, status unchanged ...
}
```

`modelConfidence` is reserved for a later iteration. v4.1 never sets it — every assisted patch carries the implicit confidence of `needs-review`, which is what makes the diff report's sign-off chip mandatory.

`promptHash` lets the consultant prove what the LLM saw without storing the full prompt in the manifest. Storing the full prompt is a v4.2 question (audit completeness vs. manifest size).

---

## Three starter fixers

### `generate-alt-text.js` — 1.1.1

**Claims.** Violations on `<img>` elements where the image is content-bearing (not flagged decorative by the safe-tier `add-alt-decorative` fixer) and surrounding context is rich enough to ground a generation: nearby paragraph text within 200 chars, a caption sibling, or a non-empty filename without a generic stem (`image1.jpg`, `untitled.png` reject).

**Prompt shape.** System prompt fixes role + accessibility constraints (≤ 125 chars, no "image of", no redundant phrasing if a caption is present, plain language). User prompt provides the filename, surrounding 400 chars of plain text, the page title, and the alt text of any sibling images on the same page.

**Output validation.** Reject and defer if: empty, > 250 chars, contains line breaks, starts with "Image of" / "Picture of" / "Photo of", or is byte-identical to a sibling alt.

### `rewrite-link-text.js` — 2.4.4

**Claims.** Violations on `<a>` elements whose accessible name (text content, `aria-label`, or `aria-labelledby` resolved) matches a vague-link allow-list: `click here`, `here`, `read more`, `more`, `link`, `details`, `info`. Only when surrounding context (preceding 200 chars + the link's `href`) is sufficient to infer purpose.

**Prompt shape.** System prompt fixes constraints (≤ 60 chars, action-oriented, never quote the link's destination URL verbatim, plain language). User prompt provides the original link text, the preceding paragraph context, the link's destination filename / fragment (not the full URL — privacy posture), and the page title.

**Output validation.** Reject and defer if: empty, > 80 chars, contains the literal vague phrases the violation flagged, or is byte-identical to the original.

### `generate-form-label.js` — 3.3.2

**Claims.** Violations on `<input>`, `<select>`, `<textarea>` with no associated `<label>`, no `aria-label`, no `aria-labelledby`, AND no preceding text node within 100 chars that the safe-tier `associate-form-label` fixer could pair. The control's `name`, `id`, `type`, `placeholder`, and any visible text in the parent `<fieldset>` / `<legend>` are sent as context.

**Prompt shape.** System prompt fixes constraints (≤ 40 chars, noun phrase, no "Please enter", no trailing colon, no instructional helper text — that's 3.3.5, not 3.3.2). User prompt provides the control's HTML attributes (sanitized — never the value of `value=`), the parent fieldset/legend text if any, and the page's heading text.

**Output validation.** Reject and defer if: empty, > 80 chars, contains the placeholder verbatim (not a label), or contains a verb phrase.

Each fixer emits exactly one patch per violation: a wrapper `<label>` element inserted immediately before the control, with the generated text and `for`/`id` wiring. Reverting removes the label and the `id` attribute the fixer added.

---

## Cost & safety guardrails

- **Per-package token budget.** Default `--llm-token-budget 50000` (≈ $0.05 / package on Haiku 4.5 input, ≈ $0.025 on output). When a package's running total exceeds the budget, remaining violations defer with reason `llm token budget exceeded`. Override with the flag.
- **Per-call timeout.** 15 seconds. Beyond that the call defers — never blocks the rebuild.
- **Per-call max output tokens.** 128 for alt / link / label fixers (tight ceilings on intentionally short strings). Each fixer's prompt explicitly states the cap.
- **Engagement isolation.** The engagement ID is recorded in provenance. Rebuilds for engagement A never share LLM context with engagement B — the provider is reinstantiated per `rebuild()` call.
- **No retry on validation failure.** If the model returns text that fails the fixer's output validator (length, format, redundancy), the violation defers immediately. No "try again with a different prompt" loop in v4.1 — that's a v4.2 decision once we have data.
- **No fallback model.** If the configured model rate-limits past one retry, the violation defers. We do not silently swap to a different model the consultant didn't authorize.

---

## CLI surface

```
prism rebuild <pkg.zip> --engagement <id>
  [--mode safe|assisted|full]
  [--llm-provider anthropic|openai]
  [--llm-key-from-env <env-var-name>]
  [--llm-model <model-id>]
  [--llm-token-budget <n>]

prism rebuild-library <dir> --engagement <id>
  [same flags as above]
```

`--llm-provider` and `--llm-key-from-env` already exist on `audit` (v3). v4.1 adds them to `rebuild` and `rebuild-library`. `--llm-model` and `--llm-token-budget` are new flags that apply to both audit (existing v3 LLM-assisted findings) and rebuild.

**Mode interactions.**

| Mode | LLM flags supplied | Behavior |
|---|---|---|
| `safe` | any | LLM flags ignored — safe never calls the LLM |
| `assisted` | none | Assisted fixers' `canFix()` returns false; every assisted-claimable violation defers with reason `--llm-provider not set` |
| `assisted` | both, env var set | Assisted fixers run; deferred fallback per-violation on validation failure |
| `assisted` | partial / invalid | `validateLlmConfig()` throws; CLI exits 2 with the existing v3 error message |
| `full` | any | Same matrix as assisted, plus full-tier transformers run unchanged. The full-tier checkpoint gate is unchanged. |

---

## Acceptance criteria for v4.1

The release ships when all of the following are true:

1. `prism rebuild <fixture> --mode assisted --llm-provider anthropic --llm-key-from-env ANTHROPIC_API_KEY` produces non-empty `patches[]` against `test/fixtures/rebuild-assisted-judgment.zip`.
2. The same command without `--llm-provider` produces an empty `patches[]` and populated `deferred[]` with reason `--llm-provider not set` — no error, exit 0 (or 1 if remaining violations).
3. Every assisted patch in the manifest has provenance `source: 'llm'`, populated `model`, `promptHash`, `usage`, `latencyMs`, and `confidence: 'needs-review'`.
4. The diff report renders the `needs sign-off` chip and an `<input type="checkbox">` for every assisted patch (no reporter changes required — this is a regression test).
5. `prism rebuild-undo --patch <id>` reverses an assisted patch byte-for-byte.
6. `npm test` passes. The integration test uses an in-process fake provider — no real network call in CI.
7. `npm run check-no-network` passes. The fake-provider test path does not trigger the egress trap.
8. The manifest schema version stays `1.0.0`. A v4.0 manifest reader loads a v4.1-emitted manifest without modification.
9. Full-tier rebuild (`--mode full`) picks up assisted fixers automatically when LLM credentials are supplied — no v5 code changes needed.

---

## Risks and mitigations

- **LLM produces an alt that defames or misrepresents the image.** The model only sees text context, not the image itself. Mitigation: confidence is always `needs-review`; the diff report's sign-off checkbox is the human gate. The PRD does not claim the consultant can skip review of assisted patches.
- **A vague-link rewrite leaks the destination URL into visible text.** The system prompt explicitly forbids quoting the URL; the output validator rejects outputs containing URL fragments. If both fail, the worst case is a single bad patch the consultant rejects in the diff report. Mitigation: the validator + the sign-off gate.
- **Cost runs away on a large library.** A 200-package library with 50 assisted violations each at default Haiku rates costs roughly $5–10. Mitigation: token budget per package, with the per-library rollup tracking the aggregate. If a future iteration needs Sonnet for harder packages, the per-package budget and the explicit `--llm-model` flag prevent surprise.
- **Engagement A's LLM context leaks into engagement B.** Mitigation: provider is reinstantiated per `rebuild()` call; no module-level caching; engagement ID recorded in every patch's provenance.
- **A model deprecation breaks reproducibility.** Manifests record the model ID at the time of the run. If a model is sunset, the consultant can re-run with `--llm-model <new-id>` and the diff report shows the change.

---

## Sequencing

v4.1 is a single workstream, not a parallel build. Order:

1. `src/lib/llm-provider.js` (new module, no dependencies on the rest)
2. `src/lib/llm-provenance.js` (replace stub; depends on 1)
3. `src/fixers/generate-alt-text.js`, `rewrite-link-text.js`, `generate-form-label.js` (depend on 2)
4. `src/rebuild/index.js` (loadFixers extension; remove early-exit; thread context — depends on 3)
5. `src/lib/rebuild-cli.js` + `src/cli.js` (remove early-exit; register flags — depends on 4)
6. `test/fixtures/rebuild-assisted-judgment.zip` + `test/integration/rebuild-pipeline.test.js` updates (depends on 5)

Each step is small enough to land in a single edit pass. The integration test in step 6 is the only consumer that exercises the whole stack; it uses an in-process fake provider so the egress trap stays clean.
