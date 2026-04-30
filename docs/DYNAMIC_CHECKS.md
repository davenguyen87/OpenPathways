# Dynamic Check Author Contract

This document defines the exact interface that every Phase 3 (v2.0) dynamic WCAG 2.2 check must implement.

Dynamic checks share the base [Check Author Contract](./CONTRACT.md) but additionally consume a Playwright-rendered Accessibility Tree. They run after static checks to detect violations that require browser simulation (focus order, ARIA live regions, label consistency across entry points).

## File Naming & Location

Each dynamic check is a CommonJS module at `src/dynamic-checks/<criterion>-<kebab-name>-dynamic.js`.

The filename **MUST** start with the criterion ID using dashes (e.g., `2-4-3-focus-order-dynamic.js`) so the loader can sort them numerically by criterion.

**Example filenames:**
- `2-4-3-focus-order-dynamic.js` (criterion 2.4.3 focus order)
- `3-2-4-consistent-identification-dynamic.js` (criterion 3.2.4 consistent identification)
- `4-1-3-status-messages-dynamic.js` (criterion 4.1.3 status messages)

## Module Shape

```js
module.exports = {
  id: '2.4.3',                                       // criterion id, dotted form
  name: 'Focus order',                               // human title
  level: 'A',                                        // 'A' | 'AA'
  wcagIntroduced: '2.0',                             // '2.0' | '2.1' | '2.2'
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-order',

  // Async function; framework awaits the result.
  // Return [] when nothing flagged.
  async run(ctx) {
    return [];
  }
};
```

## Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | WCAG criterion ID in dotted form (e.g., `"2.4.3"`) |
| `name` | string | Human-readable criterion name (e.g., `"Focus order"`) |
| `level` | string | `"A"` or `"AA"` |
| `wcagIntroduced` | string | `"2.0"`, `"2.1"`, or `"2.2"` — when the criterion was introduced |
| `url` | string | Full W3C Understanding URL for the criterion |
| `run(ctx)` | function | Async function that returns an array of violations |

## AuditContext: Dynamic Extensions

Dynamic checks receive the base AuditContext (from [CONTRACT.md](./CONTRACT.md)) extended with three new fields:

```js
{
  // ... all base fields (packageRoot, manifest, files, etc.) ...

  // NEW FIELDS FOR DYNAMIC CHECKS:
  pages: Array<{
    path: string,                    // package-relative path to HTML entry point
    page: PlaywrightPage,            // Playwright Page object (for inspection only)
    url: string,                     // file:// URL for this entry point
    axTree: object,                  // root node of Accessibility Tree from page.accessibility.snapshot()
    error?: string                   // non-null if Playwright failed to load this page
  }>,

  axTree: Map<string, object>,       // convenience: path => axTree root node
  playwrightConfig: {
    headless: true,
    timeout: 30000,
    browser: 'chromium'              // 'chromium' | 'firefox' | 'webkit'
  }
}
```

### Fields in Detail

- **`ctx.pages`** — One entry per HTML entry point from the manifest. If Playwright fails to load a page, `error` is set to a descriptive string; checks **must skip pages with `error` set**. The `axTree` is the root node from Playwright's `page.accessibility.snapshot()` API, a JSON-like structure matching the AIA Accessibility Tree spec.
- **`ctx.axTree`** — Quick lookup from entry-point path to its accessibility tree root. Equivalent to `new Map(ctx.pages.map(p => [p.path, p.axTree]))`, provided for convenience.
- **`ctx.playwrightConfig`** — Configuration used by the runner. Checks can reference this (e.g., to log the browser used) but should not modify it.

## Accessibility Tree Adapter API

Dynamic checks query the Accessibility Tree using helpers from `src/lib/ax-tree-adapter.js`. All functions operate on AX nodes (immutable objects returned by `page.accessibility.snapshot()`).

### `snapshot(page)`
**Internal use only.** Runner calls this to invoke `page.accessibility.snapshot()`.

### `findByRole(node, role): AXNode[]`
Find all descendant nodes matching a role.

```js
const { findByRole } = require('../lib/ax-tree-adapter');

const buttons = findByRole(ctx.axTree.get(path), 'button');
buttons.forEach(btn => {
  console.log(btn.name, btn.role);  // e.g., "Next", "button"
});
```

### `findByName(node, nameOrRegex): AXNode[]`
Find all descendants matching a name (exact string or regex).

```js
const { findByName } = require('../lib/ax-tree-adapter');

// Exact match
const nextButtons = findByName(ctx.axTree.get(path), 'Next');

// Regex match
const progressElements = findByName(ctx.axTree.get(path), /progress|step/i);
```

### `walk(node, visitor(node): void)`
Depth-first traversal of the tree. Visitor is called on each node.

```js
const { walk } = require('../lib/ax-tree-adapter');

walk(ctx.axTree.get(path), (node) => {
  if (node.role === 'status') {
    console.log('Status region found:', node.name);
  }
});
```

### `flatten(node): AXNode[]`
Returns a flat array of all descendants (DFS order).

```js
const { flatten } = require('../lib/ax-tree-adapter');

const allNodes = flatten(ctx.axTree.get(path));
const focusableNodes = allNodes.filter(n => n.focused !== undefined);
```

### `extractFocusableSequence(node): Array<{ role, name, tabindex, node }>`
Returns the logical focus order as an array of focusable nodes with their tab indices.

```js
const { extractFocusableSequence } = require('../lib/ax-tree-adapter');

const focusOrder = extractFocusableSequence(ctx.axTree.get(path));
focusOrder.forEach((item, idx) => {
  console.log(idx, item.role, item.name, 'tabindex=' + item.tabindex);
});
```

### `findLiveRegions(node): Array<{ node, liveType, isStatus }>`
Find all `aria-live` regions and `role="status"` elements.

```js
const { findLiveRegions } = require('../lib/ax-tree-adapter');

const regions = findLiveRegions(ctx.axTree.get(path));
regions.forEach(({ node, liveType, isStatus }) => {
  console.log(node.name, 'liveType=' + liveType, 'isStatus=' + isStatus);
});
```

## Violation Shape

The `run()` function returns an array of violation objects. Return `[]` if no violations found. The shape is identical to static checks.

```js
{
  file: string,                         // package-relative, forward-slash (e.g., "index.html")
  line: number | null,                  // null for AX-tree detections (no source mapping)
  column: number | null,                // optional, 1-indexed
  snippet: string,                      // <= 200 chars; typically empty for AX tree findings
  message: string,                      // plain English: what's wrong AND why it matters
  severity: 'critical'|'serious'|'moderate'|'minor',  // axe-core taxonomy
  criterion: string,                    // optional; if omitted, defaults to check.id
  confidence: 'definitive'|'heuristic'  // optional; defaults to 'definitive'
}
```

### Dynamic Check Guidelines

- **`line`** — Almost always `null`. Accessibility Tree nodes do not map to source line numbers. Set `line: null` unless you have special logic to map back to HTML.
- **`snippet`** — Often empty string for AX tree findings. Use if you can extract a meaningful source context.
- **`confidence`** — Default to `'heuristic'` for AX-tree-based heuristics (e.g., tabindex ordering violations detected via tree analysis may be false positives if focus is dynamically manipulated). Use `'definitive'` only when the AX tree fact is unambiguous (e.g., element has `role="status"` and `aria-live="polite"`).

## Best Practices

1. **Always check `page.error`** — Skip pages where Playwright failed. Pages with `error` set are incomplete and should not generate violations.

   ```js
   for (const page of ctx.pages) {
     if (page.error) {
       console.warn(`Skipping ${page.path}: ${page.error}`);
       continue;
     }
     // Process page.axTree
   }
   ```

2. **Graceful multi-page handling** — If a check requires multiple entry points and only one page loaded, return `[]` cleanly (no violations). Don't error.

3. **Use confidence wisely** — Set to `'heuristic'` for checks that infer violations from signals but cannot statically prove them (e.g., focus order violations, label consistency patterns). Use `'definitive'` only for checks that read direct ARIA attributes or roles from the tree.

4. **No interactivity in v2.0** — Do not call `page.click()`, `page.evaluate()`, or other Playwright methods. Dynamic checks in Phase 3 operate on the static accessibility snapshot only. Interactive simulation is reserved for v2.1+.

5. **Consistent identification (3.2.4)** — Cross-SCO checks should extract label sets from all entry points, compare for consistency, and report violations per page pair (e.g., if page 1 uses "Next" and page 2 uses "Continue", report two violations, one per page).

## Validation

The loader (`src/lib/load-dynamic-checks.js`) validates that each dynamic check has the required fields, matching the logic in `load-checks.js`. Checks that fail validation are skipped with a warning. The same validation rules apply to static and dynamic checks.

## Browser Support

Dynamic checks require an Accessibility Tree. The implementation uses the Chrome DevTools Protocol (`Accessibility.enable` + `Accessibility.getFullAXTree`) and is therefore **chromium-only**.

- `--browser chromium` — fully supported (default).
- `--browser firefox` — not supported. CDP is unavailable; the snapshot returns `null` and dynamic checks abort with an explanatory error per page.
- `--browser webkit` — not supported. Same reason.

The legacy `page.accessibility.snapshot()` API (used by Playwright < 1.45) is also supported as a fallback, but Playwright >= 1.45 (which this project pins) removed it. New users should always use chromium.

### Why chromium-only

The CDP protocol is part of Chrome's DevTools and is implemented by Chromium-based browsers. Firefox and WebKit have their own accessibility APIs (`@webdriver/accessibility-tree`, `WebKit.AX*`) that don't expose the same data structure. Cross-browser AX support would require a separate adapter per engine — out of scope for v2.0.

### Tabindex caveat

The CDP `Accessibility.getFullAXTree` response does **not** carry the `tabindex` HTML attribute (it's consumed by the browser's focus engine and never surfaced as an AX property). The runner pulls explicit `tabindex` values via `page.evaluate` and attaches them to `pageRecord.explicitTabindex` as a parallel array of `{ tag, tabindex, text, outerHTML }`. The 2.4.3 focus-order check reads from this array; checks that need explicit tabindex should follow the same pattern.

---

*This contract is canonical and binding for all Phase 3 dynamic checks.*
