# Chunk 09 — Integration Tests + Fixtures

**Workstream:** Prism v4 Rebuild
**Depends on:** 07-cli, 08-undo (and transitively all wave-1 chunks)
**Parallel-safe with:** nothing — this is the final chunk

---

You are validating that the v4 rebuild stage works end-to-end against realistic fixtures. Before you write any code:

1. Read `v4/CLAUDE.md`
2. Read `v4/PRD_v4_Rebuild.md` — focus on **Acceptance criteria for v4** and **Risks and mitigations**
3. Read every other chunk file in `v4/build/` — you're verifying their combined behavior
4. Read `test/fixtures/` to see existing fixtures and the patterns they follow

## Files to create

### `test/fixtures/rebuild-decorative-imgs.zip`

A minimal SCORM 1.2 package containing:
- `imsmanifest.xml` (valid SCORM 1.2 manifest)
- One HTML page with 3–5 decorative `<img>` tags (no `alt`, with filenames like `spacer.gif`, `divider.png`)
- One HTML page with 1 image flagged `role="presentation"` and missing `alt`
- Resources to make the package valid

This fixture targets `add-alt-decorative` (the existing fixer, post-chunk-00 modification).

### `test/fixtures/rebuild-form-labels.zip`

A minimal SCORM 1.2 package with:
- 2 form pages, each with one unambiguous label/input pair missing the `for`/`id` association
- 1 form page with an ambiguous case (multiple labels, multiple inputs) that the fixer must decline

Targets `associate-form-label` from chunk 03.

### `test/fixtures/rebuild-mixed-violations.zip`

A larger fixture that combines:
- Decorative images (decline + apply cases)
- Heading order violations (one fixable, one declined)
- Target size violations (one fixable, one declined for overlap risk)
- A `<video>` with a sibling `.vtt` file (captions-track wireable)
- A `<video>` without any `.vtt` (deferred)
- One or two violations no v4 fixer claims (deferred — sanity check the deferred path)

Targets the orchestrator's full dispatch behavior.

### `test/integration/rebuild-pipeline.test.js`

End-to-end Vitest suite. For each fixture:

1. **Audit phase.** Run `audit()` on the fixture. Capture the result.
2. **Rebuild phase.** Run the rebuild CLI action. Assert all four output artifacts exist (`rebuilt.zip`, `rebuild-manifest.json`, `rebuild-diff.html`, `rebuild-summary.html`).
3. **Manifest validation.** Read the manifest, validate against the schema, assert all `applied` patches have `before`/`after`/`range` populated.
4. **Verification.** Read `manifest.verification`. Assert `introduced === 0` (the strict invariant — no regressions). Assert `resolved > 0` for fixtures with fixable violations.
5. **Round-trip.** Run `undo` on every applied patch. Assert the resulting rebuilt zip's contained file bytes equal the original input zip's file bytes.
6. **Re-audit equality.** After full undo, run `audit()` against the post-undo rebuilt zip. Assert the violation count equals the original audit's violation count exactly.

Additional cross-cutting assertions:

- **Tier dispatch.** Run rebuild with `--mode assisted` against `rebuild-mixed-violations.zip`. Assert no zip is written, the manifest has empty `patches`, `deferred` lists every original finding, and exit code is 0.
- **Library mode.** Run `rebuild-library` against a directory containing all three fixtures. Assert `_rebuild-rollup.html` and `_rebuild-rollup.md` exist with per-package totals matching the per-package manifests.
- **No-network invariant.** Spawn the CLI under the no-network trap from `scripts/check-no-network.js`. Assert no outbound calls during audit, rebuild, or undo. (The Playwright first-run install is allowed but should be a no-op in CI where Playwright is preinstalled.)

### Fixture authoring notes

- Build each fixture as a small directory tree first, then zip with consistent compression. Commit the `.zip` files. Maximum size per fixture: ~20 KB.
- Document the expected violation counts and which fixers should claim what in a sibling `*.expected.json` file in `test/fixtures/`. The integration test reads these expectations rather than hard-coding numbers in the test file.

## Notes carried forward from earlier chunks

These came out of the chunk 03 review. Plan around them when you author fixtures.

1. **`raise-target-size` requires `boundingBox` on the violation.** The chunk 03 fixer declines (per spec, "no guessing in safe-tier") whenever the incoming violation lacks a `boundingBox` field that proves the bump won't overlap siblings. The static `src/checks/2-5-8-target-size-minimum.js` does **not** currently emit `boundingBox` — only `file`, `line`, `snippet`, `severity`, `criterion`. Implication for the `rebuild-mixed-violations.zip` fixture: if you rely on the static check alone, `raise-target-size` will never fire and the "one fixable, one declined for overlap risk" assertion in this chunk's spec is unreachable. Two acceptable resolutions:
   - **Author the fixture so the dynamic 2.5.8 check (or whichever upstream populates `boundingBox`) is exercised**, and assert end-to-end behavior with a populated `boundingBox`.
   - **Mark the target-size case as a known integration gap** in the fixture's `*.expected.json` (set `expectedFixers: []` for the 2.5.8 violations and document that v4 ships with the fixer staged for v4.1's dynamic-check-emits-boundingBox work).
   Pick one; surface it in the `*.expected.json` so the assertion file documents the choice.

## Constraints

- **No new runtime dependencies.** `adm-zip`, `cheerio`, and `vitest` cover everything you need.
- **Deterministic.** Tests must pass byte-equal assertions across machines. Strip or normalize zip metadata that varies (file mtime, extra fields) before comparing.
- **No outbound network calls** — same posture as the rest of the project. The integration test can run `npm run check-no-network` as one of its assertions.

## Acceptance criteria

- `npm test` passes including the new integration suite.
- `npm run check-no-network` passes.
- All eight items in **PRD § "Acceptance criteria for v4"** are satisfied and explicitly asserted by tests in this chunk.
- A fresh checkout, after running every chunk in order, lands at: `npm install && npm test && npm run check-no-network` all green, plus a manual `node src/cli.js rebuild test/fixtures/rebuild-decorative-imgs.zip --engagement smoketest` produces all four artifacts.

## Out of scope

- Do not modify any production code. Integration tests live in `test/`. If you find a bug in another chunk's code, file it as a follow-up rather than fixing it here — that preserves the chunk-ownership rule and keeps the PRs reviewable.
- Do not add fixtures for assisted or full tier. Those tiers are deferred.
- Do not write performance tests. Library throughput is a v4.1 concern.
