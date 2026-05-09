# Chunk 09 — Integration Tests + Fixtures

**Workstream:** Prism v5 Full Tier
**Depends on:** 07-cli, 08-checkpoint-undo (and transitively all wave-1 chunks)
**Parallel-safe with:** nothing — this is the final chunk

---

You are validating that v5's full-tier rebuild works end-to-end against realistic fixtures, including the checkpoint lifecycle and atomic transform undo. Before you write any code:

1. Read `v5/CLAUDE.md`
2. Read `v5/PRD_v5_FullTier.md` — focus on **Acceptance criteria for v5** and **Risks and mitigations**
3. Read every other chunk file in `v5/build/` — you're verifying their combined behavior
4. Read `test/integration/rebuild-pipeline.test.js` (v4) so the v5 test mirrors its style and patterns
5. Read `test/fixtures/` to see existing fixtures and the patterns they follow

## Files to create

### `test/fixtures/rebuild-landmark-needed.zip`

A minimal SCORM 1.2 package containing:

- `imsmanifest.xml` (valid SCORM 1.2 manifest)
- 3 HTML pages, each with a `<div class="main">` wrapping the body, no `<main>` element, no other landmarks
- 1 page with explicit `role="main"` on a div (tests the role-based rule)
- 1 page with two `<nav>` elements, one labeled, one not (tests landmark-labeling)
- Resources to make the package valid

Targets `landmark-insertion` and `landmark-labeling` from chunk 03.

### `test/fixtures/rebuild-tabs-divsoup.zip`

A minimal SCORM 1.2 package with:

- 2 pages containing div-soup tabsets that match the chunk-04 `widget-replacement-tabs` signature
- 1 page with a tabset whose source contains a nested `<form>` (must decline)
- 1 page with > 12 tabs (must decline per the documented item-count limit)

Targets `widget-replacement-tabs`.

### `test/fixtures/rebuild-overflowing-page.zip`

A minimal SCORM 1.2 package with:

- 1 SCO HTML file > 50KB containing 4 top-level `<h1>` boundaries (heuristic page-split target)
- 1 SCO with explicit `<!-- prism-split -->` markers (explicit-marker mode)
- 1 SCO that triggers a 2.4.1 finding without crossing the size threshold (deferred — neither heuristic nor explicit fires)
- A valid `imsmanifest.xml` with the 3 SCOs referenced in `<organization>`

Targets `page-split`.

### `test/fixtures/rebuild-full-mixed.zip`

The end-to-end fixture. A larger SCORM 1.2 package combining:

- Decorative images requiring v4 fixers
- A form-label association that requires v4 fixers
- A landmark-insertion candidate (one page with `<div class="main-content">`)
- A widget-replacement candidate (one tabset div-soup)
- A page-split candidate (one overflowing SCO)
- One or two violations no v5 transformer claims (deferred — sanity check the deferred path)

Targets the orchestrator's full dispatch behavior plus the checkpoint flow end-to-end.

### `test/integration/rebuild-full-pipeline.test.js`

End-to-end Vitest suite. Tests run against each fixture and additionally exercise the checkpoint lifecycle on `rebuild-full-mixed.zip`.

Per-fixture flow:

1. **Audit phase.** Run `audit()` on the fixture. Capture the result.
2. **Full rebuild.** Run the rebuild CLI action with `--mode full`. Assert the staging directory is created (`.rebuild-staging/`) and contains `rebuilt-staged.zip`, `rebuild-manifest-staged.json`, and `rebuild-preview.html`.
3. **Manifest validation.** Read the staged manifest. Schema 2.0.0. Every transform in `status: 'pending-checkpoint'`. Every transform's `patchIds` references real patches. Every transform-bearing patch has a populated `transformId`.
4. **Checkpoint promote (all-approve).** Call `prism rebuild-checkpoint approve --all`. Assert:
   - The final `rebuilt.zip`, `rebuild-manifest.json`, `rebuild-diff.html`, `rebuild-summary.html`, `rebuild-preview.html` exist at the package root.
   - `.rebuild-staging/` is removed.
   - Every transform in the final manifest is `status: 'applied'`, with `checkpointApprovedBy` and `checkpointApprovedAt` populated.
5. **Verification.** Read `manifest.verification`. Assert `introduced === 0`. Assert `resolved > 0` for every fixture with fixable violations.
6. **Round-trip undo.** Run `prism rebuild-undo --transform <id>` for every applied transform. Assert the resulting rebuilt zip's contained file bytes equal the original input zip's file bytes for every file the transforms touched. Assert the manifest XML is byte-equal to the original after the undo.
7. **Re-audit equality.** After full undo, run `audit()` against the post-undo rebuilt zip. Assert the violation count equals the original audit's violation count exactly.

Cross-cutting assertions on `rebuild-full-mixed.zip`:

- **Fixer + transformer order.** Mock the fixer registry and transformer registry to log calls. Assert every fixer ran before any transformer.
- **Mixed approve / reject promotion.** Run rebuild → checkpoint with one transform approved and one rejected → assert the approved transform's patches are in the final zip, the rejected transform's patches are not, the rejected transform is `status: 'rejected'` in the final manifest.
- **`--no-checkpoint` path.** Run rebuild with `--mode full --no-checkpoint`. Assert no staging directory is created and the final artifacts are written directly. Verification runs in-process.
- **Promotion failure rollback.** Hand-craft a fixture (or a mock) where the post-promotion verify detects a regression. Assert the staging directory is preserved, no final artifacts are written, and the CLI exits 2.
- **Manifest XML invariant at promotion.** Hand-craft a transform that produces an invalid `imsmanifest.xml`. Assert promotion aborts with a clear error and staging is preserved.
- **Preview report scope.** Render the preview report. Assert it contains every transform from the staged manifest. Assert the side-by-side rendering does not contain whole source files (size of any single rendered fragment is bounded by patch context + a small buffer).
- **No-network invariant.** Spawn the CLI under the no-network trap from `scripts/check-no-network.js`. Assert no outbound calls during audit, rebuild, checkpoint promotion, or undo. Page-split LLM mode is NOT exercised in these fixtures (heuristic mode only) — confirm that's the case in the test setup.
- **Library mode.** Run `rebuild-library --mode full` against a directory containing all four fixtures. Assert every package has its own staging directory. Run `rebuild-checkpoint list` and assert it returns 4 entries. Approve all and assert the rollup at `engagements/<id>/_rebuild-rollup.html` reflects the v5 transform stats.

### Fixture authoring notes

- Build each fixture as a small directory tree first, then zip with consistent compression. Commit the `.zip` files. Maximum size per fixture: ~30 KB (slightly larger than v4's 20 KB cap because v5 fixtures need multi-page content).
- Document the expected violation counts, expected fixer claims, and expected transformer claims in a sibling `*.expected.json` file in `test/fixtures/`. The integration test reads these expectations rather than hard-coding numbers in the test file.
- For each fixture, also document which decline rules are exercised (e.g., `rebuild-tabs-divsoup.expected.json` lists "form-inside-tabset" and "item-count-over-limit" as expected decline reasons).

## Notes carried forward from earlier chunks

These came out of chunks 01, 05, and 08 — surface them in the integration assertions:

1. **Manifest schema 1.0.0 back-compat.** Add a smoke test that a v4 fixture (no transforms) round-trips through v5 with `schemaVersion: "1.0.0"` byte-identical. Use a v4 fixture from `test/fixtures/` directly. This guards chunk 00's back-compat invariant in CI.

2. **LLM mode dead-code path for page-split.** The page-split transformer's LLM branch must not throw when no v4.1 provider is available. Add a unit-level test (in chunk 05's test file, not here) that asserts heuristic fallback. This integration suite confirms heuristic mode runs end-to-end without LLM.

3. **Patch context size on file-creation patches.** The page-split transformer emits patches with `before: ""` for newly-created files. Confirm the manifest validator and the diff renderer handle 0-length `before` correctly. If they don't, that's a chunk 00 follow-up — surface it; do not work around it here.

## Constraints

- **No new runtime dependencies.** `adm-zip`, `cheerio`, and `vitest` cover everything you need. Axe-core is a dev-dep already used by chunk 02's widget tests; reuse it if you need to assert post-transform accessibility on rendered fragments.
- **Deterministic.** Tests must pass byte-equal assertions across machines. Strip or normalize zip metadata that varies (file mtime, extra fields) before comparing.
- **No outbound network calls.**
- **No real LLM calls in CI.** Page-split's LLM mode is gated; the test setup must not configure a provider.

## Acceptance criteria

- `npm test` passes including the new integration suite.
- `npm run check-no-network` passes.
- All ten items in **PRD § "Acceptance criteria for v5"** are satisfied and explicitly asserted by tests in this chunk.
- A fresh checkout, after running every chunk in order, lands at: `npm install && npm test && npm run check-no-network` all green, plus a manual:
  ```
  node src/cli.js rebuild test/fixtures/rebuild-full-mixed.zip --engagement smoketest --mode full
  node src/cli.js rebuild-checkpoint approve --engagement smoketest --package rebuild-full-mixed --all
  ```
  produces all five v5 artifacts at `engagements/smoketest/rebuild-full-mixed/`.

## Out of scope

- Do not modify any production code. Integration tests live in `test/`. If you find a bug in another chunk's code, file it as a follow-up rather than fixing it here — that preserves the chunk-ownership rule and keeps PRs reviewable.
- Do not add fixtures for SCORM modernization. That's a separate workstream.
- Do not write performance tests. Library throughput at scale is a v5.x or v6 concern.
- Do not exercise LLM-mode page-split in CI. Heuristic mode only.
- Do not relax the checkpoint gate in any test. `--no-checkpoint` is exercised as one path; the default-on path is also exercised. Both must pass.
