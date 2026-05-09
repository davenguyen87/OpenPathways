# Chunk 04 — Mechanical Fixers, Batch B

**Workstream:** Prism v4 Rebuild
**Depends on:** 00-foundation
**Parallel-safe with:** 01, 02, 03, 05, 06

---

You are adding three more mechanical, deterministic, safe-tier fixers. Before you write any code:

1. Read `v4/CLAUDE.md`
2. Read `v4/PRD_v4_Rebuild.md` — focus on **Tier definitions: Safe tier**
3. Read `src/fixers/add-alt-decorative.js` after chunk 00's modifications to confirm the v2 fixer interface
4. Read `src/checks/1-4-3-contrast-minimum.js`, `src/checks/1-4-11-non-text-contrast.js`, `src/checks/1-2-2-captions.js`, `src/checks/2-4-7-focus-visible.js` for the violation shapes
5. Read `config/brand.json` for the calibrated palette the contrast fixer will rewrite to
6. Read `config/effort-calibration.json` so you understand how triage interacts with effort estimates

## Files to create

### `src/fixers/rewrite-contrast-tokens.js`

- **Criteria:** 1.4.3, 1.4.11
- **Triage:** auto-fix safe
- **What it does:** when CSS uses palette tokens (custom properties like `--color-primary`, `--color-text`), rewrite token *values* to the nearest compliant pair from a calibrated palette so the failing pair becomes ≥4.5:1 (or ≥3:1 for non-text).
- **Decline** when the violation involves ad-hoc hex literals not behind a token. Rewriting hex literals risks brand damage; that's an author conversation, not a mechanical fix. It goes to `deferred` with reason "ad-hoc color literal — needs author review".
- **Decline** when no calibrated palette mapping exists for the offending token (configured via `config/brand.json`'s palette or a future `config/contrast-calibration.json`).
- The patch records the token name, the old value, the new value. `revert` restores the old value.

### `src/fixers/wire-captions-track.js`

- **Criterion:** 1.2.2
- **Triage:** auto-fix safe
- **What it does:** when a `<video>` element exists and a `.vtt` file is present in the same package directory (or a sibling `captions/` directory) with a name that matches the video file's stem, inject `<track kind="captions" src="<vtt-path>" srclang="en" default>` inside the video element.
- **Decline** when no matching `.vtt` exists. The `<video>` without captions stays a violation; the fix is content-creation work, not mechanical.
- **Decline** when a `<track>` element is already present (any kind), even if not `captions` — the author has made a choice and we don't override.
- The patch records the inserted track element. `revert` removes it.

### `src/fixers/inject-focus-polyfill.js`

- **Criteria:** 2.4.7, 2.4.11
- **Triage:** auto-fix safe
- **What it does:** when the audit's dynamic checks confirm focus indicators are demonstrably absent or below 3:1 contrast, inject a deterministic stylesheet fragment that sets a focus indicator meeting both 2.4.7 (visible) and 2.4.11 (not obscured).
- The injected styles live in `<style id="prism-focus-polyfill">` in `<head>`. Same pattern as `raise-target-size.js`: stable id, append-or-create.
- The polyfill's content: a 2px solid outline using the brand's focus color from `config/brand.json` with sufficient contrast against the page background, plus an offset that ensures the indicator isn't clipped by overflow.
- **Decline** when the audit indicates focus styles exist and pass 3:1 — don't double-style.
- The patch records the injected style block. `revert` removes the rule (or removes the entire style block if it ends up empty).

## Implementation notes

- All three fixers operate on HTML or CSS. Use Cheerio for HTML; for CSS, raw-string operations are fine but document the boundaries.
- Same v2 interface as chunk 03. Same `confidence: 'definitive'`, `tier: 'safe'`, `provenance: 'deterministic'`.
- Determinism: same input → same patches every run. The contrast fixer's "nearest compliant pair" must be a pure function of the inputs.
- Round-trip: every `apply` followed by `revert` produces byte-identical original content.

## Tests

Create one test file per fixer in `test/fixers/`:

- `test/fixers/rewrite-contrast-tokens.test.js`
- `test/fixers/wire-captions-track.test.js`
- `test/fixers/inject-focus-polyfill.test.js`

Each test covers happy path, decline path, and round-trip.

The contrast test must include a synthetic palette mapping (don't depend on production `config/brand.json` values; mock them) so the test is stable.

The captions test needs a fixture with a `.vtt` file present and a fixture without — both in `test/fixtures/` (small enough to commit).

## Acceptance criteria

- `npm test` passes for the three new test files.
- `npm run check-no-network` passes.
- Each fixer's `revert` round-trips byte-identical on every test case.
- Each fixer follows the v2 interface from chunk 00 exactly.

## Out of scope

- Do not create heading / form-label / target-size fixers. Those are chunk 03.
- Do not modify existing fixers. Chunk 00 owns those files.
- Do not touch the orchestrator, the CLI, or any reporter.
- Do not introduce a runtime contrast-calculation library. If you need WCAG contrast math, write the formula by hand — it's `(L1 + 0.05) / (L2 + 0.05)` over relative luminance and a few lines of code.
