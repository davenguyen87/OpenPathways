# CLAUDE.md — Prism v5 Rebuild Workstream (Full Tier)

This file is **scoped to the v5 rebuild work only**. The repo's top-level `CLAUDE.md` still governs everything else — read it first if you don't already know the project. The `v4/CLAUDE.md` is the closest precedent — read it second; v5 inherits its conventions and the v4 codebase as its substrate.

## What v5 adds

The third and final rebuild tier: **full**. Where v4 ships safe-tier (deterministic mechanical fixes inside a single file) and v4.1 adds assisted-tier (LLM-generated content inside a single file), v5 introduces **transforms** — coordinated, package-scoped rewrites that span multiple files and can edit `imsmanifest.xml`. v5 implements three families of transform:

1. **Landmark insertion + labeling** — promote inferred regions to `<header>`/`<nav>`/`<main>`/`<footer>` and label them.
2. **Custom-widget replacement** — swap div-soup carousels, tabs, accordions, and dialogs for vetted ARIA-compliant components from a Skill Loop component library shipped in `src/widgets/`.
3. **Page splitting** — when a single SCO violates 2.4.1 / 3.3.x by cramming a course into one HTML page, split into multiple SCOs and rewrite `imsmanifest.xml` accordingly.

v5 also introduces a **checkpoint** lifecycle: full-tier rebuilds stage their output under `.rebuild-staging/`, render a side-by-side preview, and require `prism rebuild-checkpoint approve` before the final `rebuilt.zip` is written. This is the human gate full-tier needs because the rewritten package can change *meaning*, not just markup.

The complete spec is in `PRD_v5_FullTier.md` (same folder). Read it before any prompt.

## What v5 explicitly does NOT include

- **No SCORM modernization.** SCORM 1.2 stays SCORM 1.2; SCORM 2004 stays 2004. SCORM 1.2 → 2004 / cmi5 / xAPI migration is a separate `prism modernize` workstream and out of scope here.
- **No new fixer tiers beyond full.** v5 closes the tier system; safe / assisted / full is the complete set.
- **No mode beyond rebuild.** v5 is engine and CLI only. `web/` and `cloud/` adoption is post-v5.

## Dependencies on v4 and v4.1

- **v4 must be merged.** The `Patch` type, `RebuildManifest` schema, packager, fixer registry, diff/summary reporters, and `rebuild-undo` command are v4 artifacts that v5 extends.
- **v4.1 is a soft dependency.** Page splitting's "where to split" decision benefits from LLM judgment, which v4.1's assisted-tier glue provides. v5 ships a rule-based fallback (split at top-level `<h1>` boundaries) so the workstream isn't blocked on v4.1, but the LLM path is the recommended production mode and lights up the same UI when v4.1 is in place.

## How parallel work is structured

Same shape as v4: prompts live in `build/`, numbered 00–09. Run order is described in `build/README.md`. Short version:

1. **00-foundation must complete first.** It defines the `Transform` type, the `Transformer` interface (separate from `Fixer`), bumps the manifest schema to 2.0.0 with a `transforms[]` block, and adds `transformId` to `Patch`. Every later prompt depends on this.
2. **01–06 run in parallel** in separate terminals after 00 lands. One small extra dependency: chunk 04 (widget-replacement transforms) depends on chunk 02 (the widget library) — see `build/README.md`.
3. **07–08 run after 01–06** are merged. 07 wires the CLI; 08 adds the checkpoint module and extends undo to handle transforms atomically.
4. **09 runs last.** End-to-end fixtures + integration tests.

**Critical rule for parallelism: each prompt creates its own files.** The exceptions are:

- **00** modifies `src/rebuild/types.js`, `src/rebuild/manifest.js`, and the existing fixer registry to flow the new `transformId` through.
- **01** modifies `src/rebuild/index.js` to add full-tier dispatch (single owner of the orchestrator extension).
- **07** modifies `src/cli.js` and `src/index.js` to register full-mode and the checkpoint commands.
- **08** modifies `src/rebuild/undo.js` to handle transform-atomic revert.

If your prompt is not 00, 01, 07, or 08, you should not edit shared files. If you think you need to, stop and surface it — the prompt is wrong, not the rule.

## Repo conventions you must follow

- **Engine code lives in `src/`.** `web/` is frozen as the v1 reference; do not touch it. `cloud/` imports from `src/` as a library; do not touch it from a v5 prompt.
- **New transform code goes in `src/transformers/`** (new module). The component library goes in `src/widgets/` (new module). The checkpoint module goes in `src/rebuild/checkpoint.js`. The new reporter goes in `src/reporter/rebuild-preview.js`.
- **Style matches the existing codebase.** CommonJS (`require`/`module.exports`), no TypeScript, no transpilation. JSDoc typedefs for shapes. Vitest for tests.
- **No new runtime dependencies** unless the prompt explicitly says so. The codebase already has `adm-zip`, `cheerio`, `commander`, `kleur`, `ora`, `playwright`, plus whatever v4.1 added for LLM glue. Use them. The widget library MUST ship as vanilla HTML/CSS/JS — no React, no Stencil, no build step.
- **No outbound network calls.** Telemetry is forbidden. The egress trap (`scripts/check-no-network.js`) runs in CI. Page splitting's LLM mode is the one exception, and it must reuse v4.1's existing assisted-tier provider abstraction — no new providers.
- **No copyright reproduction in the diff or preview report.** Even when rendering side-by-side previews, render only the section that changed plus surrounding context. Do not embed full source pages.

## What "done" means

Each prompt has its own acceptance criteria. The high bar across all of them:

- New code is covered by Vitest tests in the matching `test/` location. Aim for one happy path + one failure path per public function. Transforms additionally need a round-trip test (apply → revert → byte-identical original).
- `npm test` passes.
- `npm run check-no-network` passes.
- The prompt's stated files-created and files-modified lists are exactly what was created/modified — nothing extra, nothing missing.
- Public behavior matches the manifest schema in `PRD_v5_FullTier.md` § "Manifest schema v2.0.0" verbatim. Schemas are contracts; do not improvise field names.

## Tier semantics in v5

After v5 ships, all three tiers are implemented. The CLI accepts `--mode safe|assisted|full`:

- `safe` (default) — runs v4's deterministic fixers. Behaviour unchanged from v4.
- `assisted` — runs v4.1's LLM-content fixers in addition to safe. Behaviour unchanged from v4.1.
- `full` — runs v5's transforms in addition to safe + assisted. Stages output under `.rebuild-staging/`. Requires checkpoint approval before final `rebuilt.zip`.

The orchestrator's tier dispatch from v4 remains the entry point. v5 only adds full-tier transformers to the registry and a checkpoint pre-write step.

## Risk posture for full-tier

Full tier crosses from "automated remediation" into "automated authoring." A landmark insertion can mis-identify which `<div>` is `<main>`. A widget replacement can miss a custom interaction the original carousel supported. A page split can break the author's intended pacing. v5's design treats these as expected: every transform is staged, every transform renders a side-by-side preview, every transform requires explicit approval. **Do not relax the checkpoint gate.** When a prompt offers a `--no-checkpoint` flag, surface it but the default must always be checkpoint-on for full mode.

## When in doubt

If a prompt is ambiguous, prefer reading the PRD section it cites over guessing. If the PRD is also ambiguous, surface the question rather than picking. Conservative wins over clever for a tool that ships rebuilt content to regulated clients — the bar is even higher in v5 than in v4 because the blast radius is larger.
