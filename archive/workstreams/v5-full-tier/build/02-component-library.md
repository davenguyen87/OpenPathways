# Chunk 02 — Component Library: ARIA-Compliant Widgets

**Workstream:** Prism v5 Full Tier
**Depends on:** 00-foundation
**Parallel-safe with:** 01, 03, 05, 06
**Blocks:** 04 (widget-replacement transformers consume the templates this chunk ships)

---

You are building the vetted component library that v5's widget-replacement transformers will swap into client packages. Before you write any code:

1. Read `v5/CLAUDE.md`
2. Read `v5/PRD_v5_FullTier.md` — focus on **Tier definitions: Full tier** (the widget-replacement family)
3. Read `config/brand.json` so the visual presets reflect the firm's design tokens
4. Read the W3C ARIA Authoring Practices Guide patterns for tabs, accordion, carousel, dialog, and tooltip — your templates must match those patterns. Document the specific APG version you target in each widget's README.

The library ships as **vanilla HTML / CSS / JS**. No build step. No framework. No external runtime. A widget dropped into a SCO must work without anything beyond what SCORM 1.2 already loads — and must continue to work offline (SCORM packages run from a local file:// in many LMS players).

## Files to create

Each widget lives in its own subdirectory under `src/widgets/`:

```
src/widgets/
├── tabs/
│   ├── template.html         ← markup fragment (not a full document)
│   ├── styles.css            ← scoped via a wrapping class to avoid colliding with package styles
│   ├── script.js             ← vanilla, no globals beyond a registration function
│   ├── axe-baseline.json     ← expected axe results: zero violations
│   └── README.md             ← one-page reference: APG version, props, slots, decline rules
├── accordion/                ← same shape
├── carousel/                 ← same shape
├── dialog/                   ← same shape
└── tooltip/                  ← same shape (used as a primitive by carousel and dialog)
```

### `template.html` requirements (per widget)

- Markup is a fragment, not a full document. The widget-replacement transformer (chunk 04) inserts this fragment into the existing SCO page.
- Mustache-like placeholders (`{{label}}`, `{{panelHTML}}`) for content the transformer fills in. Document every placeholder in the widget's `README.md`.
- The wrapper element carries a stable class (`prism-widget-tabs`, etc.) so the styles in `styles.css` are scoped and don't bleed into the rest of the page.
- ARIA attributes match APG verbatim. Keyboard interaction model documented in `README.md`.

### `styles.css` requirements

- Every selector is prefixed with the wrapper class. No global selectors.
- Brand tokens (color, type, spacing) reference `config/brand.json` values inlined as CSS custom properties. Document the token names in `README.md`. The styles must work even if the host SCO's `<head>` doesn't define those properties — declare safe fallbacks at the top of the file.
- Print-clean: when printed to PDF, panels expand and tabs / dialogs render their content inline so a printed report still shows the full content.
- Reduced motion: respect `@media (prefers-reduced-motion)` for any transitions or animations.

### `script.js` requirements

- IIFE-scoped. No globals beyond a single registration function attached to `window.PrismWidgets` (auto-creates the namespace if missing).
- Each widget exposes a single function: `window.PrismWidgets.registerTabs(rootElement)` (etc.). The function does keyboard wiring, focus management, and ARIA state updates.
- Auto-discovery: at DOMContentLoaded, the script auto-registers every `[data-prism-widget="tabs"]` element on the page. The widget-replacement transformer adds this attribute when injecting.
- Idempotent: calling `registerTabs(el)` twice is a no-op the second time (use a `data-prism-registered` attribute).
- No external dependencies. No fetch calls. No event listeners on `window` or `document` that could conflict with the host SCO's scripts (use the root element only).

### `axe-baseline.json` requirements

A snapshot of axe-core's run against the rendered widget with placeholder content filled in. Format:

```json
{
  "snapshotVersion": "1.0.0",
  "axeVersion": "X.Y.Z",
  "ruleset": "wcag22aa",
  "violations": [],
  "incomplete": [],
  "passes": [...]                 // optional but useful for diffing across releases
}
```

The contract: `violations` MUST be empty for the widget to ship. `incomplete` is allowed and documented in the widget's README so reviewers know which checks are deferred to context.

### `README.md` requirements

One-page max. Sections:

- **APG version:** which W3C ARIA Authoring Practices Guide pattern this widget implements, and the specific revision date / version pinned. (When the APG updates, the widget gets a CHANGELOG entry, not a silent rewrite.)
- **Props:** every `{{placeholder}}` in `template.html`, what type / shape it expects, how it's escaped.
- **Keyboard model:** every key supported and what it does.
- **Decline rules:** circumstances under which the widget-replacement transformer (chunk 04) MUST refuse to substitute this widget for an existing div-soup pattern. (E.g., tabs decline when the source has nested anchors that point off-page; carousel declines when the source has `<form>` elements inside slides.)

## Test fixture per widget

Create `test/widgets/<widget>.test.js`:

- Load the widget's `template.html` with placeholders filled by representative content.
- Render in jsdom. Run axe-core (already in the project's audit path — reuse the existing axe loader from `src/dynamic-checks/`).
- Assert the resulting violations match `axe-baseline.json` (zero violations).
- Run the widget's `script.js` against the rendered DOM. Assert keyboard behaviour for the documented model (Tab through, Arrow keys for tabs/accordion, Esc for dialog, etc.). Use `dom-testing-library` patterns if helpful — but do not add a new runtime dep; the project's existing test setup should already have what you need.
- Assert idempotency: registering twice does not double-bind events.

If the project doesn't currently have axe-core in the test dev-deps, that's a sign chunk 02 needs to surface a dep request rather than adding it silently. Don't introduce runtime deps; dev-deps for axe testing are acceptable but check the existing setup first.

## Constraints

- **No new runtime dependencies.** The widgets ship as static templates; the test runner can reuse existing dev tooling.
- **No external fonts / icons / assets.** Inline SVG only for icons. Fonts come from the host SCO's existing stack (or `config/brand.json` declares fallbacks).
- **No outbound network calls.** Templates and scripts must work offline.
- **No analytics, no telemetry, no remote logging.**
- **Print-to-PDF clean for every widget.** Specifically: tabs render all panels expanded, dialogs render inline (not modal-overlay), accordions render expanded, carousels render every slide stacked, tooltips render as adjacent text.

## Acceptance criteria

- `npm test` passes for every widget test.
- `npm run check-no-network` passes.
- Each widget's `axe-baseline.json` shows zero violations.
- Each widget's `README.md` is one page or less and documents APG version, props, keyboard model, and decline rules.
- Manual smoke test: open each `template.html` in a browser with the styles and script loaded against representative placeholder content. Tab through, exercise the keyboard model, print-preview the page. Document the manual smoke result in the chunk's PR description.

## Out of scope

- Do not write any transformer. Chunk 04 consumes this library.
- Do not modify `src/rebuild/`. The library is a sibling module.
- Do not modify any reporter. Chunk 06 owns preview rendering.
- Do not add a build step or bundler. Vanilla only.
- Do not extend the library beyond the five named widgets. New widgets are a v5.x or v6 concern.
