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

## Engagement Deliverable Structure

The audit engagement produces three output files per package under `engagements/<id>/<package>/`:

| File | Description |
|------|-------------|
| `report.html` | Brand-matched HTML report; primary consultant deliverable |
| `report.md` | Markdown variant; same logical structure |
| `results.json` | JSON scorecard; structured data for programmatic consumers |

The HTML and Markdown reports contain the following sections in order:

- **Cover / title block** — engagement ID, package name, audit date, standard
- **Section 01a — Engagement Narrative** *(optional; present only when LLM narrative ran)* — see below
- **Section 01** — Summary statistics (total violations, by severity, by confidence)
- **Section 02** — Triage rollup (by disposition tag)
- **Section 03** — Scope estimate (consultant-hour bands by disposition)
- **Section 04** — Top risks
- **Section 05** — Per-criterion detail table
- **Section 06** — Section 508 mapping
- **Section 07** — Dynamic check results
- **Section 08** — Per-file violation listings

### Section 01a — Engagement Narrative (optional)

When `--llm-provider` is configured and narrative has not been suppressed (`--no-llm-narrative`), a new section appears between the title block and Section 01. It contains three prose blocks in order:

1. **Executive narrative** — one to two paragraphs in plain English: what dominates the findings (citing actual scorecard numbers), what the consultant should know in 30 seconds. Written for the buyer (LMS admin / training director), not the technical author.
2. **Per-criterion remediation guides** — one paragraph per failed criterion (capped at 12 by default). What is wrong in this package specifically, and what the fix shape is. Grounded in this package's violations; not a paraphrase of the WCAG SC text.
3. **Recommended remediation order** — a short prioritized list (3–7 items). Each item leads with an action verb and names a criterion by name (not number) with a one-clause rationale.

Each block renders with a provenance pill immediately under its heading:

```
[ AI-DRAFTED · <model-id> · <ISO-8601-timestamp> · review before sharing ]
```

The pill is brand-matched (system muted color in HTML; italics in Markdown). It is non-decorative: it communicates the binding contract that the consultant must read and edit the block before sharing with any client.

When narrative is absent (LLM not configured, section failed, or `--no-llm-narrative` passed), the section is omitted entirely. The rest of the report is byte-identical to the no-LLM path.

Library mode (`audit-library`) additionally renders a **Library Synthesis** block at the top of `_library-rollup.{html,md}` when narrative ran. It has the same provenance pill.

### `results.json` shape

`results.json` carries the v3 scorecard fields plus one optional top-level object:

```jsonc
{
  // ... existing scorecard fields unchanged ...

  // Present only when narrative ran; absent (field omitted) otherwise.
  "auditNarrative": {
    "schemaVersion": "1.0.0",
    "executive": {
      "text": "...",
      "provenance": {
        "source": "llm",
        "provider": "anthropic",
        "model": "claude-haiku-4-5",
        "promptHash": "sha256:…",
        "usage": { "inputTokens": 1240, "outputTokens": 180 },
        "latencyMs": 940,
        "generatedAt": "2026-05-08T19:22:11Z"
      }
    },
    "remediationGuides": [ /* one entry per failed criterion */ ],
    "scopeMemo": { "text": "...", "provenance": { ... } },
    "totals": {
      "sectionsAttempted": 5,
      "sectionsSucceeded": 5,
      "totalInputTokens": 4120,
      "totalOutputTokens": 720,
      "totalLatencyMs": 3140
    }
  }
}
```

Readers that do not recognize `auditNarrative` ignore it safely; no existing reader needs to change.

---

## Rebuild Deliverable Structure

The rebuild pipeline produces output under `engagements/<id>/<package>/rebuild/`:

| File | Description |
|------|-------------|
| `rebuild-manifest.json` | Machine-readable record of every patch and transform applied |
| `rebuild-diff.html` | Patch-level diff report for consultant sign-off |
| `rebuild-preview.html` | Transform-level preview for checkpoint approval (full-tier only) |
| `<package>-rebuilt.zip` | The rebuilt SCORM package |

### `rebuild-manifest.json` schema

Schema version `1.0.0` for safe and assisted runs (no transformers). Schema version `2.0.0` when full-tier transforms are present. Older manifests load without modification.

**Patch provenance — safe tier.** Deterministic: `source: "deterministic"`.

**Patch provenance — assisted tier.** LLM-generated content patches add these fields to the patch's `provenance` object:

```jsonc
{
  "source": "llm",
  "timestamp": "...",
  "provider": "anthropic",
  "model": "claude-haiku-4-5",
  "promptHash": "sha256:…",
  "usage": { "inputTokens": 412, "outputTokens": 18 },
  "latencyMs": 723
}
```

Every assisted patch carries `confidence: "needs-review"`, which causes the diff report to render a `needs sign-off` chip and approval checkbox. Consultant sign-off is required before delivery; the LLM does not bypass this gate.

**Transform records — full tier.** Transform records in schema-2.0.0 manifests gain an optional `judgment` field when LLM judgment ran:

```jsonc
{
  "judgment": {
    "source": "llm",
    "verdict": "match",          // "match" | "no-match" | "uncertain"
    "confidence": 0.92,
    "rationale": "...",
    "provider": "anthropic",
    "model": "claude-haiku-4-5",
    "promptHash": "sha256:…",
    "usage": { "inputTokens": 612, "outputTokens": 87 },
    "latencyMs": 410,
    "generatedAt": "2026-05-08T19:40:11Z"
  }
}
```

The `judgment` field is optional. Transforms without it were processed heuristic-only. v5.0 readers ignore the unknown field; v5.1 readers handle both shapes. LLM judgment never bypasses checkpoint approval — the consultant's approve/reject at the checkpoint gate remains the final word.

---

## LLM-Generated Content Posture

### Default-off

When `--llm-provider` is not set, deliverables are byte-identical to the pre-LLM path. No narrative sections are rendered, no assisted patches are generated, no judgment fields are written. LLM integration is opt-in per engagement.

### Provenance is the durable contract

Every LLM-generated artifact — narrative sections, assisted patches, transformer judgment — records full provenance: provider, model, prompt hash (SHA-256 of system + user prompt), token usage (input and output), latency, and generated-at timestamp. This is stored in:

- `results.json` under `auditNarrative[section].provenance`
- `rebuild-manifest.json` under `patches[n].provenance` (assisted tier)
- `rebuild-manifest.json` under `transforms[n].judgment` (full-tier judgment)

Consultants must read and edit every LLM-generated block before sharing with clients. The provenance pill and `needs sign-off` chip are not decorative — they are the documented signal that human review is required. The contract does not govern how long LLM-drafted prose may remain unedited; that is an engagement-management decision. The contract does require that the provenance pill remain visible and unaltered in any delivered artifact.

### Numeric grounding check

Executive narrative and library synthesis validators reject generated text containing numbers that do not appear in the scorecard inputs. This is a coarse hallucination check — it catches invented violation counts and fabricated percentages. It is not a substitute for consultant review. The provenance pill remains the primary contract.

### Model selection

Default model is `claude-haiku-4-5` (alias form; not a date-suffixed ID). Sonnet 4.6 is opt-in via `--llm-model claude-sonnet-4-6`. The configured model is recorded in every provenance block. If the model is deprecated after generation, the manifest records the model ID that was used; re-running with `--llm-model <new-id>` replaces the affected sections.

### No fallback model

When the configured model fails past one retry (rate limit, 5xx), the affected section or patch defers cleanly. The tool does not silently substitute a different model.

### Engagement isolation

The LLM provider is reinstantiated per `audit()` / `rebuild()` call. Engagement A's calls never share context with engagement B. The engagement ID is recorded in every provenance block.

---

*This contract is canonical and binding for all Phase 1 checks.*
