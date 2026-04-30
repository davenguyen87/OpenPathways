# Check Author Contract

This document defines the exact interface that every WCAG 2.2 check must implement.

## File Naming & Location

Each check is a CommonJS module at `src/checks/<id-with-dashes>-<kebab-name>.js`.

The filename **MUST** start with the criterion ID using dashes (e.g., `1-1-1-non-text-content.js`) so the loader can sort them numerically by criterion.

**Example filenames:**
- `1-1-1-non-text-content.js` (criterion 1.1.1)
- `1-4-3-contrast-minimum.js` (criterion 1.4.3)
- `2-5-8-target-size-minimum.js` (criterion 2.5.8)

## Module Shape

```js
module.exports = {
  id: '1.1.1',                                       // criterion id, dotted form
  name: 'Non-text content',                          // human title
  level: 'A',                                        // 'A' | 'AA'
  wcagIntroduced: '2.0',                             // '2.0' | '2.1' | '2.2'
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/non-text-content',

  // Synchronous OR async; framework awaits the result.
  // Return [] when nothing flagged.
  async run(ctx) {
    return [];
  }
};
```

## Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | WCAG criterion ID in dotted form (e.g., `"1.1.1"`) |
| `name` | string | Human-readable criterion name (e.g., `"Non-text content"`) |
| `level` | string | `"A"` or `"AA"` |
| `wcagIntroduced` | string | `"2.0"`, `"2.1"`, or `"2.2"` — when the criterion was introduced |
| `url` | string | Full W3C Understanding URL for the criterion |
| `run(ctx)` | function | Async or sync function that returns an array of violations |

## AuditContext Shape

Each check receives an `AuditContext` object with this shape:

```js
{
  packageRoot: string,                  // absolute path to extracted package
  packageType: 'scorm12'|'scorm2004'|'aicc',
  manifest: object,                     // raw parsed manifest (parser-defined shape)
  entryPoints: string[],                // package-relative paths from manifest
  files: {
    html: Array<{ path, content, $ }>,  // $ is a memoized cheerio.load() function
    css:  Array<{ path, content }>,
    js:   Array<{ path, content }>,
    all:  Array<{ path, content }>      // every text file extracted
  }
}
```

### Using the AuditContext

- `ctx.packageRoot` — absolute path; safe for fs operations
- `ctx.packageType` — one of `scorm12`, `scorm2004`, `aicc`
- `ctx.manifest` — parser-provided manifest object (shape TBD by parser team)
- `ctx.entryPoints` — array of package-relative paths (forward-slash) to HTML entry points
- `ctx.files.html` — all `.html`/`.htm` files extracted; each has a `$()` getter that memoizes `cheerio.load(content)`
- `ctx.files.css` — all `.css` files
- `ctx.files.js` — all `.js`/`.mjs`/`.cjs` files
- `ctx.files.all` — all text files (union of html, css, js, and others)

**Example: using cheerio**
```js
ctx.files.html.forEach(file => {
  const $ = file.$();  // cheerio object for this file
  const imgs = $('img');
  imgs.each((i, el) => {
    if (!$(el).attr('alt')) {
      violations.push({ /* ... */ });
    }
  });
});
```

## Violation Shape

The `run()` function returns an array of violation objects. Return `[]` if no violations found.

```js
{
  file: string,                         // package-relative, forward-slash (e.g., "index.html")
  line: number | null,                  // 1-indexed; null when not pinpointable
  column: number | null,                // optional, 1-indexed
  snippet: string,                      // <= 200 chars of offending source
  message: string,                      // plain English: what's wrong AND why it matters
  severity: 'critical'|'serious'|'moderate'|'minor',  // axe-core taxonomy
  criterion: string,                    // optional; if omitted, defaults to check.id
  confidence: 'definitive'|'heuristic'  // optional; defaults to 'definitive'
}
```

### Field Guidelines

- **`file`** — Must be package-relative with forward-slashes (e.g., `"course/index.html"`). No leading slashes.
- **`line`** — 1-indexed (first line is 1, not 0). Null if you can't pinpoint a location.
- **`column`** — 1-indexed. Typically omitted unless you have precise information.
- **`snippet`** — Extract from source using `require('./lib/snippet')`. Keep ≤ 160 chars for readability in reports.
- **`message`** — Explain WHAT is wrong and WHY it violates the criterion. Example: `"<img> lacks alt attribute; images must have text alternatives for screen readers"`
- **`severity`** — Use axe-core's impact taxonomy:
  - `critical` — blocks access for users with disabilities
  - `serious` — significantly degrades access
  - `moderate` — noticeably impacts access
  - `minor` — minor impact on access
- **`confidence`** — Distinguishes violation certainty:
  - `'definitive'` (default) — Deterministic detection; the violation is real with very high confidence (e.g., `<img>` with no `alt` attribute is unambiguous, or a CSS rule with `outline: none` and no replacement is clear).
  - `'heuristic'` — Pattern-based detection that may have false positives. Use when the check infers intent from signals but cannot statically prove the violation (e.g., detecting video-only status, color-only language patterns, keyboard trap intent, or CAPTCHA usage). Heuristic findings still count as failures, but are transparently marked in reports so users know what to verify manually.

## Helper Utilities

Import from `src/lib/`:

### `lineOf(content, indexOrSubstring): number`
Returns the 1-indexed line number for a byte offset or first occurrence of a substring.

```js
const { lineOf } = require('../lib/line-of');

const index = html.indexOf('<img src="x.png">');
const lineNum = lineOf(html, index);  // 1-indexed

// Or find the line of a substring:
const line = lineOf(html, 'alt=""');
```

### `snippet(content, line, maxLen=160): string`
Returns a trimmed source snippet for a given line number.

```js
const { snippet } = require('../lib/snippet');

const src = snippet(cssContent, 42);  // trimmed line 42, max 160 chars
```

## Example Check: 1.1.1 Non-text content (stub)

```js
/**
 * 1.1.1 Non-text content
 * Detects images without alt text, missing role="presentation" on decorative images.
 */

const { lineOf, snippet } = require('../lib/line-of');

module.exports = {
  id: '1.1.1',
  name: 'Non-text content',
  level: 'A',
  wcagIntroduced: '2.0',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/non-text-content',

  async run(ctx) {
    const violations = [];

    for (const file of ctx.files.html) {
      const $ = file.$();

      $('img').each((i, el) => {
        const $img = $(el);
        const alt = $img.attr('alt');
        const role = $img.attr('role');

        // If no alt and not marked as presentational
        if (!alt && role !== 'presentation') {
          const index = file.content.indexOf(file.content.substring(
            file.content.indexOf($img.toString()),
            file.content.indexOf($img.toString()) + 200
          ));

          violations.push({
            file: file.path,
            line: lineOf(file.content, $img.toString()),
            column: null,
            snippet: snippet(file.content, lineOf(file.content, $img.toString())),
            message: '<img> lacks alt attribute. Images must have text alternatives for screen readers.',
            severity: 'critical',
            criterion: '1.1.1',
          });
        }
      });
    }

    return violations;
  }
};
```

## Best Practices

1. **Always provide a line number** if the violation is in an HTML/CSS/JS file (use `lineOf()`).
2. **Make violation messages actionable** — tell the author exactly what to fix.
3. **Include the WCAG criterion ID** in violation.criterion to aid reporting.
4. **Use try/catch** inside loops to handle edge cases (e.g., malformed HTML) without crashing.
5. **Skip external content** — if a check encounters an external iframe (`<iframe src="https://..."`), flag it as a coverage gap (not a violation) with a field like `iframeUrl` in the violation, and set `severity: 'minor'`.
6. **Test with the real AuditContext** — the loader calls `check.run(ctx)` at runtime; mock ctx in unit tests.

## Validation

The loader (`src/lib/load-checks.js`) will validate that each check has the required fields and throws an error if validation fails. Checks that fail validation are skipped with a warning.

---

*This contract is canonical and binding for all Phase 1 checks.*
