# CLAUDE.md — Prism v4 Rebuild Workstream

> **Status (2026-05-08):** v4 shipped. Safe-tier rebuild + diff/summary reports + undo are merged. The deferred-feature notice for `--mode full` was removed in v5; full-tier transforms now run through the same orchestrator. v4.1 (assisted-tier LLM content) remains pending. See `v5/PRD_v5_FullTier.md` and `v5/CLAUDE.md` for the next workstream.

This file is **scoped to the v4 rebuild work only**. The repo's top-level `CLAUDE.md` still governs everything else — read it first if you don't already know the project. This document tells a Claude Code worker picking up a single rebuild prompt how to fit into the parallel build.

## What v4 adds

A fourth pipeline stage after Review → Triage → Estimate: **Rebuild**. Given an audit result and the original `.zip`, produce a remediated `.zip` that meets WCAG 2.2 AA + Section 508, plus a re-audit verification and a per-fix diff report.

v4 ships **safe-tier rebuild + diff report scaffolding only**. Assisted-tier (LLM-generated content) and full-tier (structural rework, SCORM modernization) are deferred to v4.1 / v5. The scaffolding is built so assisted lights up the same UI later without reshaping it.

The complete spec is in `PRD_v4_Rebuild.md` (same folder). Read it before any prompt.

## How parallel work is structured

Prompts live in `build/`, numbered 00–09. Run order is described in `build/README.md`. Short version:

1. **00-foundation must complete first.** It defines the `Patch` and `RebuildManifest` types and adds a `revert()` method to all 9 existing fixers. Every later prompt depends on this.
2. **01–06 run in parallel** in separate terminals after 00 lands.
3. **07–09 run after 01–06** are merged. 07 wires the CLI; 08 adds the undo command; 09 does end-to-end integration tests.

**Critical rule for parallelism: each prompt creates its own files.** The only exceptions are 00 (modifies the 9 existing fixers) and 07 (modifies `src/cli.js` and `src/index.js` to register the new commands). If your prompt is not 00 or 07, you should not edit shared files. If you think you need to, stop and surface it — the prompt is wrong, not the rule.

## Repo conventions you must follow

- **Engine code lives in `src/`.** `web/` is frozen as the v1 reference; do not touch it. `cloud/` imports from `src/` as a library; do not touch it from a rebuild prompt.
- **Rebuild code goes in `src/rebuild/`** (new module). New fixers go in `src/fixers/`. New reporters go in `src/reporter/`.
- **Style matches the existing codebase.** CommonJS (`require`/`module.exports`), no TypeScript, no transpilation. JSDoc typedefs for shapes. Vitest for tests.
- **No new runtime dependencies** unless the prompt explicitly says so. The codebase already has `adm-zip`, `cheerio`, `commander`, `kleur`, `ora`, `playwright`. Use them.
- **No outbound network calls.** Telemetry is forbidden. The egress trap (`scripts/check-no-network.js`) runs in CI; if you add code that talks to the network the build fails. The one allowed exception is the existing `npx playwright install chromium` first-run install.
- **No copyright reproduction in the diff report.** When you render before/after, render only the diff range plus reasonable context — do not embed the full source page.

## What "done" means

Each prompt has its own acceptance criteria. The high bar across all of them:

- New code is covered by Vitest tests in the matching `test/` location. Aim for one happy path + one failure path per public function.
- `npm test` passes.
- `npm run check-no-network` passes.
- The prompt's stated files-created and files-modified lists are exactly what was created/modified — nothing extra, nothing missing.
- Public behavior matches the manifest schema in `PRD_v4_Rebuild.md` § "Manifest schema" verbatim. Schemas are contracts; do not improvise field names.

## Tier semantics in v4

Only **safe** tier is implemented in this workstream. The CLI accepts `--mode safe|assisted|full`. In v4 itself, `assisted` and `full` printed a deferred-feature notice and exited cleanly with code 0. The orchestrator's tier dispatch was built so later tiers add new fixer / transformer modules, not architectural changes.

> **v5 update:** the `--mode full` deferred-feature notice has been removed. v5's transformers run through the same orchestrator behind a checkpoint gate. The `--mode assisted` notice is preserved for installs without v4.1's LLM glue (still pending). See the v5 workstream for the full-tier surface.

## When in doubt

If a prompt is ambiguous, prefer reading the PRD section it cites over guessing. If the PRD is also ambiguous, surface the question rather than picking. Conservative wins over clever for a tool that ships rebuilt content to regulated clients.
