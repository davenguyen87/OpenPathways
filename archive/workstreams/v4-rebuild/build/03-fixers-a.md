# Chunk 03 — Mechanical Fixers, Batch A

**Workstream:** Prism v4 Rebuild
**Depends on:** 00-foundation
**Parallel-safe with:** 01, 02, 04, 05, 06

---

You are adding three new mechanical, deterministic, safe-tier fixers. Before you write any code:

1. Read `v4/CLAUDE.md`
2. Read `v4/PRD_v4_Rebuild.md` — focus on **Tier definitions: Safe tier**
3. Read `src/fixers/add-alt-decorative.js` after chunk 00's modifications to confirm the v2 fixer interface
4. Read `src/checks/1-3-1-info-and-relationships.js` if it exists — or any check that produces violations on `criterion: '1.3.1'` — so you understand the `violation` shape coming in
5. Read `src/checks/2-5-8-target-size-minimum.js` and `src/checks/3-3-2-labels-or-instructions.js` for the violation shapes the new fixers will consume

## Files to create

Each fixer is a single file in `src/fixers/`. Each follows the v2 interface (`apply` + `revert` + `fix` shim, plus `triage`, `tier`, `provenance` metadata).

### `src/fixers/normalize-heading-order.js`

- **Criterion:** 1.3.1
- **Triage:** auto-fix safe
- **What it does:** detects pages where the heading hierarchy is broken. Two specific patterns it fixes deterministically; everything else it declines:
  1. **Missing `<h1>`:** if the page has `<h2>` or lower but no `<h1>`, and there's exactly one candidate (the first heading on the page, or the page `<title>`-equivalent in body), promote it to `<h1>`.
  2. **Orphan `<h1>` in a section that already has one:** if a `<section>` or `<article>` contains an `<h1>` and there's already a sibling `<h1>` at the same DOM depth, demote the orphan to `<h2>`.
- **canFix returns false** for any other heading-skip pattern (h1 → h3, missing h2, etc.). Those go to `deferred` for human judgment.
- Use Cheerio (already a dep). Operate on the DOM, serialize once.

### `src/fixers/associate-form-label.js`

- **Criterion:** 1.3.1, 3.3.2 (a label fix often resolves both — emit one patch per criterion-finding pair)
- **Triage:** auto-fix safe
- **What it does:** pairs `<label>` with `<input>` via `for` / `id` when the relationship is unambiguous.
- **Unambiguous means:** within a parent block element, exactly one `<label>` without a `for` and exactly one `<input>` (or `<textarea>` or `<select>`) without an `id`. Generate a stable id from a hash of the input's name + position; assign matching `for`.
- **Decline** when there are multiple labels, multiple inputs, or any `for` / `id` already present in the block.
- **revert** removes the generated `id` and `for` only — leaves user-authored ids alone.

### `src/fixers/raise-target-size.js`

- **Criterion:** 2.5.8
- **Triage:** auto-fix safe
- **What it does:** for elements flagged by the 2.5.8 check as below 24×24, inject a CSS rule scoped to the violation's selector (or a generated class added to the element) that sets `min-width: 24px; min-height: 24px`.
- The injected stylesheet goes in a new `<style>` tag inside `<head>` with a stable id (`prism-target-size`) so the revert is just removing that style block's matching rule. If `<style id="prism-target-size">` already exists, append to it.
- **Decline** when the element's computed layout suggests the bump would cause overlap with siblings (use the violation's `boundingBox` field if available; if not, decline — this is safe-tier, no guessing).

## Implementation notes

- Every fixer must populate every required `Patch` field per the PRD § "Manifest schema". `before` and `after` capture the diff range with reasonable context, never full file contents.
- **Apply must be deterministic and stable across runs.** Same input → same patches in same order with same ids (the orchestrator assigns the global ids; the fixer assigns local ordering).
- **Revert must round-trip byte-identical** with the original file. Chunk 09's integration test will assert this on every fixture.
- Mark `confidence: 'definitive'` on every patch this batch emits.
- `tier: 'safe'`, `provenance: 'deterministic'` on every patch.

## Tests

Create one test file per fixer in `test/fixers/`:

- `test/fixers/normalize-heading-order.test.js`
- `test/fixers/associate-form-label.test.js`
- `test/fixers/raise-target-size.test.js`

Each test file covers:

- Happy path: a known violation → fixer claims it → `apply` produces correct patch → `revert` round-trips byte-identical.
- Decline path: ambiguous input → `canFix` returns false.
- Edge cases: multiple violations on the same file → multiple patches with distinct ranges.

## Acceptance criteria

- `npm test` passes for the three new test files.
- `npm run check-no-network` passes.
- Each fixer's `revert` round-trips on every test case.
- Each fixer follows the v2 interface from chunk 00 exactly. Compare against the modified `add-alt-decorative.js`.

## Out of scope

- Do not create the contrast / captions / focus polyfill fixers. Those are chunk 04.
- Do not modify existing fixers. Chunk 00 owns the existing fixer files.
- Do not touch the orchestrator, the CLI, or any reporter.
- Do not register fixers anywhere. The orchestrator (chunk 01) discovers fixers by scanning `src/fixers/`.
