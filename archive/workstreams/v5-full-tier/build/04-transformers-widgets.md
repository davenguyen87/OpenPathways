# Chunk 04 — Transformers: Widget Replacement

**Workstream:** Prism v5 Full Tier
**Depends on:** 00-foundation, 02-component-library
**Parallel-safe with:** 01, 03, 05, 06

---

You are adding four full-tier transformers that detect div-soup custom widgets and replace them with vetted ARIA-compliant components from the chunk 02 widget library. Before you write any code:

1. Read `v5/CLAUDE.md`
2. Read `v5/PRD_v5_FullTier.md` — focus on **Transformer interface** and **Tier definitions: Full tier** (the `widget-replacement` family)
3. Read every `README.md` under `src/widgets/` from chunk 02. The decline rules in those READMEs are non-negotiable.
4. Read `src/widgets/<widget>/template.html` for each widget so you know what placeholders the templates expect
5. Read `src/checks/2-1-1-keyboard.js`, `src/checks/4-1-2-name-role-value.js`, and `src/checks/2-4-3-focus-order.js` for the violation shapes

## Files to create

Each transformer is a single file in `src/transformers/`. One per widget family (you do not need a transformer for `tooltip` — it's a primitive used by carousel and dialog, not a top-level pattern).

- `src/transformers/widget-replacement-tabs.js`
- `src/transformers/widget-replacement-accordion.js`
- `src/transformers/widget-replacement-carousel.js`
- `src/transformers/widget-replacement-dialog.js`

Each follows the Transformer interface from chunk 00 (`canTransform` + `apply` + `revert`, plus `family: 'widget'`, `tier: 'full'`, `provenance: 'rule-based'`).

## Detection — the DOM-signature contract

Each transformer detects its target div-soup pattern by a **DOM signature** that you document inline in the file. A signature is a small set of structural rules; if every rule matches, the pattern is the widget. Examples (you finalize the exact signatures during implementation; document each one in a constant at the top of the file):

### `widget-replacement-tabs.js`

- **Criteria:** 1.3.1, 2.1.1, 2.4.3, 4.1.2
- **Signature (document precisely in code):**
  - A wrapper element with class containing `tab` (or `tabs`, `tabset`, `tab-container`) — case-insensitive
  - Inside it, a list of clickable elements (`<a>`, `<button>`, `<div onclick>`, `<li>`) that toggle visibility of sibling panels
  - The clickable elements are siblings or share a common parent (the "tab list")
  - The panels are sibling-of-tablist elements identifiable by class containing `panel` or `pane`, or by the tablist's `data-target` / `aria-controls` references when present
- **Content extraction (intermediate representation):**
  ```js
  {
    tabs: [
      { label: string, panelHTML: string, initiallyActive: boolean }
    ]
  }
  ```
- **Replacement:** load `src/widgets/tabs/template.html`, fill placeholders from the IR, replace the original wrapper element's outerHTML with the rendered template.

### `widget-replacement-accordion.js`

- **Criteria:** 1.3.1, 2.1.1, 4.1.2
- **Signature:**
  - Wrapper with class containing `accordion` (or `collapse`, `expandable`)
  - Pairs of `(trigger element, panel element)` where the trigger toggles the panel's visibility
  - Each pair shares a common parent or the trigger has a `data-target` / `aria-controls` reference to the panel
- **IR:** `{ items: [{ label, panelHTML, initiallyExpanded }] }`
- **Replacement:** template from `src/widgets/accordion/`.

### `widget-replacement-carousel.js`

- **Criteria:** 2.1.1, 2.4.3, 4.1.2
- **Signature:**
  - Wrapper with class containing `carousel`, `slider`, `slideshow`, or `gallery`
  - Inner `slides` element containing > 1 child slide elements
  - Optional `prev` / `next` controls and / or pagination dots
  - Optional autoplay (carries an inline `setInterval` or class `auto`)
- **IR:** `{ slides: [{ html: string, label?: string }], hasAutoplay: boolean }`
- **Replacement:** template from `src/widgets/carousel/`. Autoplay is dropped — the replacement widget defaults to manual advance only (the APG carousel pattern with autoplay disabled). Add the IR's `hasAutoplay: true` to the patch's `rationale` so the consultant knows.

### `widget-replacement-dialog.js`

- **Criteria:** 1.3.1, 2.1.1, 2.4.3, 4.1.2
- **Signature:**
  - Wrapper with class containing `modal`, `dialog`, `popup`, or `lightbox`
  - Style attribute or inline class indicating absolute / fixed positioning with high z-index
  - A trigger element on the page that toggles its visibility (matched by `data-target` / `aria-controls` or by class-pattern match)
  - Optional close button inside the dialog
- **IR:** `{ title?: string, bodyHTML: string, footerHTML?: string, triggers: TriggerInfo[] }`
- **Replacement:** template from `src/widgets/dialog/`. Triggers on the page are rewritten to use `<button>` with `aria-haspopup="dialog"` and the appropriate `aria-controls` reference.

## Decline rules (every transformer must implement)

Inherit and additionally enforce the decline rules each widget's `README.md` documents (chunk 02). General rules across all widget transformers:

- **Decline when the source contains a `<form>`** that posts data — replacing it with a different DOM structure can break form submission. (Form-aware widget replacement is a v5.1+ concern.)
- **Decline when the source contains nested `<script>` tags** with non-trivial logic. The replacement's `script.js` is auto-discovery-based and may conflict with bespoke scripts. Defer.
- **Decline when the IR extraction loses content.** Compute a hash of the source's text content; compute the same hash on the rendered replacement after placeholder filling. If text content drops, decline. (Markup is allowed to change; words are not.)
- **Decline when the source has > N items** (configurable per widget; default: tabs N=12, accordion N=24, carousel N=20, dialog N/A). Beyond N, the replacement may not handle keyboard interaction the same way and the consultant should design the page differently.
- **Decline when the audit's findings list does not include a violation that this widget pattern would resolve.** Don't replace patterns that aren't actually flagged.

When a transformer declines, append a `DeferredFinding` per source pattern with reason and a one-line description of which decline rule fired. The Transform itself is not emitted for declined pages.

## Implementation notes

- Use Cheerio for DOM parsing. Operate on a per-page basis; emit one Transform per HTML file that contains at least one matched and accepted pattern. (A page with three matched tabsets emits one Transform with three patches; a page with a tabset and a carousel emits two Transforms — one per family.)
- The transformer reads `src/widgets/<family>/template.html` from disk via a path relative to the transformer file (`path.join(__dirname, '..', 'widgets', '<family>', 'template.html')`). Cache the read in module scope.
- Placeholder filling is plain string replacement of `{{name}}` tokens. Escape user content before insertion: text content gets HTML-escaped; HTML content (panel bodies, etc.) is inserted as-is and the IR extractor is the place that ensures it's safe (it came from the existing page, so it's already in scope).
- **Apply must be deterministic.** Same input → same patches.
- **Revert must round-trip byte-identical.** The patch's `before` field captures the original outerHTML; revert restores it.
- `confidence: 'likely'` on every widget-replacement patch. The detection is heuristic by nature — even when the signature matches perfectly, the original may have had behaviour the replacement doesn't preserve.
- `provenance: 'rule-based'`. LLM-mode widget detection is deferred.

## Tests

Create one test file per transformer in `test/transformers/`:

- `test/transformers/widget-replacement-tabs.test.js`
- `test/transformers/widget-replacement-accordion.test.js`
- `test/transformers/widget-replacement-carousel.test.js`
- `test/transformers/widget-replacement-dialog.test.js`

Each test file covers:

- **Happy path:** a fixture matching the signature → transformer claims it → `apply` swaps the markup → `revert` round-trips byte-identical.
- **IR extraction:** assert the intermediate representation captures every label, panel body, and (where applicable) initial-active state from the source. Assert the count and the text-content hash match before and after substitution.
- **Decline paths (one test per documented decline rule):** signature partial match, embedded `<form>`, embedded `<script>`, content loss, item count over limit, no matching audit finding. Assert `DeferredFinding` with the right reason in each case.
- **axe baseline:** after substitution, run axe-core against the rendered fragment. Assert it matches the widget's `axe-baseline.json` from chunk 02.
- **Multi-pattern page:** a fixture with two tabsets on one page → one Transform with two patches.
- **Round-trip determinism:** running `apply` twice on the same input produces identical patches (modulo `provenance.timestamp`).

## Acceptance criteria

- `npm test` passes for all four test files.
- `npm run check-no-network` passes.
- Each transformer's `revert` round-trips on every test case.
- Each transformer's post-substitution axe scan matches the widget library's baseline.
- Each transformer follows the Transformer interface from chunk 00 exactly.

## Out of scope

- Do not create the landmark transformers. Those are chunk 03.
- Do not create the page-split transformer. That's chunk 05.
- Do not modify the widget library — chunk 02 owns `src/widgets/`. If you find a placeholder you need that the template doesn't expose, surface it as a follow-up to chunk 02 rather than adding to the template here.
- Do not modify the orchestrator, the CLI, or any reporter.
- Do not introduce LLM-mode detection.
- Do not add new widgets beyond the four families. Tooltip exists as a primitive in chunk 02 but doesn't get its own top-level transformer.
