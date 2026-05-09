# Chunk 03 — Transformers: Landmark Insertion + Labeling

**Workstream:** Prism v5 Full Tier
**Depends on:** 00-foundation
**Parallel-safe with:** 01, 02, 04, 05, 06

---

You are adding two full-tier transformers that promote inferred regions to ARIA landmarks and label them. Before you write any code:

1. Read `v5/CLAUDE.md`
2. Read `v5/PRD_v5_FullTier.md` — focus on **Transformer interface** and **Tier definitions: Full tier** (the `landmark-insertion` family)
3. Read `src/rebuild/types.js` after chunk 00's modifications to confirm the `Transform` typedef and the `linkPatchToTransform` helper
4. Read `src/checks/1-3-1-info-and-relationships.js`, `src/checks/2-4-1-bypass-blocks.js`, and `src/checks/4-1-2-name-role-value.js` for the violation shapes the new transformers will consume
5. Read `src/fixers/add-skip-link.js` to see the existing skip-link fixer — landmarks pair with skip-links and your transformer must not stomp the fixer's output

## Files to create

Each transformer is a single file in `src/transformers/`. Each follows the Transformer interface from chunk 00 (`canTransform` + `apply` + `revert`, plus `family`, `criteria`, `tier: 'full'`, `provenance: 'rule-based'`).

### `src/transformers/landmark-insertion.js`

- **Family:** `landmark`
- **Criteria:** 1.3.1, 2.4.1, 4.1.2
- **Triage:** `author rework` (matches v3 triage taxonomy — landmark insertion is a structural rewrite)
- **What it does:** scans every HTML page in the package and promotes inferred wrapper elements to the appropriate landmark element:
  - First top-level wrapper (by document order, by depth-1 children of `<body>`) that contains the page's primary heading hierarchy → `<main>`.
  - Wrapper containing top-of-page navigation links (links to other SCOs, "Back" / "Next" buttons, table-of-contents) → `<nav>`.
  - Top-of-page wrapper containing logo / page title / breadcrumb → `<header>`.
  - Bottom-of-page wrapper containing copyright, attribution, or "footer" class → `<footer>`.
- **Detection signals (in priority order):**
  1. Explicit class names: `.main`, `.main-content`, `.content` → `<main>`. `.nav`, `.navigation`, `.menu` → `<nav>`. `.header`, `.banner` → `<header>`. `.footer` → `<footer>`.
  2. Explicit `id` attributes: same pattern.
  3. ARIA role attributes: `role="main"` → `<main>`. `role="navigation"` → `<nav>`. `role="banner"` → `<header>`. `role="contentinfo"` → `<footer>`. (When present, drop the redundant role from the converted element.)
  4. Heading-based inference for `<main>`: the wrapper that contains the highest-ranked heading (`<h1>` if present, otherwise the earliest `<h2>`).
  5. Position-based inference for `<header>` / `<footer>`: first / last depth-1 wrapper if it contains a `<h1>` (header) or copyright text (footer).
- **canTransform** returns true when at least one HTML page in the package is missing at least one landmark that the detection rules above can identify.
- **apply** rewrites the wrapping element's tag (`<div>` → `<main>`, etc.). Preserves all attributes including class, id, data-*. Each rewrite produces one `Patch`. The collection of patches is bundled into a single `Transform`.
- **Decline rules (per page; when a page declines, no patch for that page is emitted):**
  - The page already has the landmark (don't double-up).
  - Multiple wrappers compete for the same landmark with no clear winner (e.g., two divs with class `.main`). The transformer is conservative: ambiguity = decline. Append a `DeferredFinding` with a clear reason.
  - The wrapper element is a non-block-level element (e.g., `<span>`). Don't rewrite inline elements as block landmarks.
  - The page has been touched by `add-skip-link.js` (v4 fixer) and the skip-link target id would be invalidated by the rewrite. Compute the new target id and update the skip-link in the same transform if straightforward; if not, decline.

### `src/transformers/landmark-labeling.js`

- **Family:** `landmark`
- **Criteria:** 1.3.1, 4.1.2
- **Triage:** `author rework`
- **What it does:** when a page has multiple landmarks of the same role (e.g., two `<nav>` elements: primary nav and secondary), labels each with a distinct `aria-label` so screen reader users can distinguish them.
- **Labels are inferred from:**
  1. Existing `aria-label` (if present, leave alone — declines).
  2. Existing `aria-labelledby` (if present, leave alone — declines).
  3. The first `<h1>` / `<h2>` / `<h3>` inside the landmark, with content trimmed and HTML stripped to plain text. Limited to 60 characters.
  4. Position-based fallback: "Primary navigation" / "Secondary navigation" / "Footer navigation" based on document order. Document the exact strings as a constant in the file so they're greppable.
- **canTransform** returns true when at least one HTML page has multiple landmarks of the same role and at least one of them lacks both `aria-label` and `aria-labelledby`.
- **apply** inserts `aria-label="…"` on each unlabeled landmark. One patch per inserted attribute. The collection is bundled into a single Transform.
- **Decline rules:** when no heading and no positional fallback applies, decline that landmark and append a `DeferredFinding`.

## Implementation notes

- Both transformers use Cheerio (already a dep). Operate on the DOM, serialize once per file.
- Every transform's patches must populate every required `Patch` field per the PRD § "Manifest schema v2.0.0", with `transformId` set to the parent transform's id.
- **Apply must be deterministic and stable across runs.** Same input → same patches in same order with same ids. The orchestrator assigns global ids; the transformer assigns local ordering.
- **Revert must round-trip byte-identical** with the original file. Chunk 09's integration test asserts this on every fixture.
- `confidence: 'likely'` on landmark-insertion patches (the heuristic-based ones), `confidence: 'definitive'` on patches that converted explicit class / id / role signals. Document which is which in each patch's `rationale`.
- `confidence: 'likely'` on landmark-labeling when using positional fallback; `confidence: 'definitive'` when using existing heading text.
- `provenance: 'rule-based'` on every patch. v5 ships these as deterministic; LLM-mode landmark detection is a v5.1 concern.
- Both transformers must coordinate when run in sequence: insertion runs first, labeling runs second. The orchestrator handles ordering; your transformers do not call each other directly.

## Tests

Create one test file per transformer in `test/transformers/`:

- `test/transformers/landmark-insertion.test.js`
- `test/transformers/landmark-labeling.test.js`

Each test file covers:

- **Happy path** for every detection signal: a fixture demonstrating each rule (class-based, id-based, role-based, heading-based, position-based) → transformer claims it → `apply` produces the correct patches → `revert` round-trips byte-identical.
- **Decline path:** ambiguous input → `canTransform` returns false → `DeferredFinding` is emitted with the documented reason.
- **Multi-page transform:** a fixture with three pages, two of which need a landmark → the transform's `scope.files` lists both, `patchIds` lists both patches, the third page is untouched.
- **Coordination with v4 fixers:** a fixture where `add-skip-link.js` already ran and would be invalidated by the rewrite. Assert the transformer either updates the skip-link in the same transform or declines cleanly.
- **Round-trip determinism:** running `apply` twice on the same input produces identical patch ranges and rationale text. The only field that differs is `provenance.timestamp`.

## Acceptance criteria

- `npm test` passes for both new test files.
- `npm run check-no-network` passes.
- Each transformer's `revert` round-trips on every test case.
- Each transformer follows the Transformer interface from chunk 00 exactly. Compare the shape against `src/rebuild/types.js`'s `Transform` typedef.
- Patches emitted carry `transformId` matching the parent transform's id.

## Out of scope

- Do not create widget-replacement transformers. Those are chunk 04.
- Do not create the page-split transformer. That's chunk 05.
- Do not modify any v4 / v4.1 fixer. The fixer interface is closed.
- Do not modify the orchestrator, the CLI, or any reporter.
- Do not register transformers anywhere — the orchestrator (chunk 01) discovers them by scanning `src/transformers/` via the registry helper from chunk 01.
- Do not introduce LLM-mode detection. v5 ships landmarks as rule-based only.
