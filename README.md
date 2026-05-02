# Open Pathways

WCAG 2.2 AA accessibility audit for SCORM 1.2, SCORM 2004, AICC, and xAPI/Tin Can packages.

Audit your courseware with a single command. No manual extraction, no LMS upload, no environment setup — point it at a `.zip` and get a structured report in seconds.

General-purpose accessibility tools (axe-core, WAVE, Pa11y) don't understand SCORM/AICC manifests, so auditing courseware before delivery is otherwise a manual, error-prone process. Open Pathways parses the manifest, extracts every HTML/CSS/JS asset, runs 21 static WCAG checks, and optionally runs 3 dynamic browser-based checks (with `--simulate`).

---

This repo ships three things:

1. **CLI** (root) — `npx open-pathways my-course.zip`. Documented below.
2. **Local web UI** (`web/`) — drop a `.zip` into the browser, watch progress stream in. `npm run serve`. See `web/README.md`.
3. **Hosted multi-tenant service** (`cloud/`) — magic-link auth, S3 storage, worker queue, deploy on Coolify. See **[`cloud/DEPLOY.md`](cloud/DEPLOY.md)** for the deploy runbook.

---

## Quick start

```bash
npx open-pathways my-course.zip
```

Output lands in `./open-pathways-report/` with a Markdown report, JSON scorecard, and optional SARIF results for GitHub Code Scanning. Exit code is `0` when clean, `1` when violations are found, `2` on tool error.

Requires Node.js 18+.

## Install

### Via `npx` (no global install)

```bash
npx open-pathways <package.zip>
```

### Global install

```bash
npm install -g open-pathways
open-pathways <package.zip>
```

Requires Node.js 18+.

## Optional: Dynamic checks with Playwright

The `--simulate` flag runs screen-reader simulation against the package in a headless browser (chromium-only for now). This detects 3 dynamic criteria: 2.4.3 Focus Order, 3.2.4 Consistent Identification, and 4.1.3 Status Messages.

To enable dynamic checks:

```bash
npm install playwright
npx playwright install chromium
npx open-pathways my-course.zip --simulate
```

Without Playwright installed, `--simulate` gracefully falls back to static analysis only and reports `dynamicCheckSkipReason` in the JSON scorecard.

## Usage

```bash
open-pathways <package.zip> [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--baseline <path>` | Path to prior results.json; report only new violations | — |
| `--browser <browser>` | Browser for dynamic checks: chromium, firefox, webkit | chromium |
| `--fix` | Apply mechanical fixes; writes `<package>.scorm-fixed.zip` | — |
| `--fix-dry-run` | Preview fixes without writing to disk | — |
| `--format <format>` | Report format: `md`, `txt`, `sarif` | `md` |
| `--json` | Print JSON scorecard to stdout only (suppresses spinner and file output) | — |
| `--max-violations <n>` | Fail if violation count exceeds this threshold | unlimited |
| `--output <dir>` | Output directory for reports | `./open-pathways-report` |
| `--package-type <type>` | `scorm12`, `scorm2004`, `aicc`, `xapi`, `auto` | `auto` |
| `--simulate` | Run dynamic checks via headless browser (requires Playwright) | — |
| `--standard <standard>` | WCAG version: `wcag21` or `wcag22` | `wcag22` |
| `--timeout-dynamic <ms>` | Timeout per SCO for dynamic checks | 30000 |
| `-v, --version` | Print tool version | — |

### Examples

Run a default audit and write `report.md` + `results.json`:

```bash
open-pathways my-course.zip
```

Pipe the JSON scorecard to stdout for CI integration:

```bash
open-pathways my-course.zip --json
```

Allow up to five violations before failing:

```bash
open-pathways my-course.zip --max-violations 5
```

Run dynamic checks (requires Playwright):

```bash
open-pathways my-course.zip --simulate
```

Preview mechanical fixes without writing:

```bash
open-pathways my-course.zip --fix-dry-run
```

Apply fixes and write the corrected package:

```bash
open-pathways my-course.zip --fix
```

Audit against WCAG 2.1 (filters to 2.1 and earlier criteria only):

```bash
open-pathways my-course.zip --standard wcag21
```

Establish a baseline, then report only new violations:

```bash
open-pathways my-course.zip --json > baseline.json
open-pathways my-course.zip --baseline baseline.json
```

Emit SARIF for GitHub Code Scanning:

```bash
open-pathways my-course.zip --format sarif --output ./a11y
```

## What it checks

The tool runs 21 static checks plus 3 optional dynamic checks (with `--simulate`). Violations include a file path, line number, severity (critical/serious/moderate/minor), and confidence level (definitive/heuristic).

### Static checks (21 criteria)

| Criterion | Level | Evaluation |
|-----------|-------|-----------|
| 1.1.1 Non-text content | A | Static |
| 1.2.1 Audio/video-only (prerecorded) | A | Static |
| 1.2.2 Captions (prerecorded) | A | Static |
| 1.3.4 Orientation | AA | Static |
| 1.3.5 Identify input purpose | AA | Static |
| 1.4.1 Use of color | A | Static |
| 1.4.2 Audio control | A | Static |
| 1.4.3 Contrast (minimum) | AA | Static |
| 1.4.4 Resize text | AA | Static |
| 1.4.10 Reflow | AA | Static |
| 1.4.11 Non-text contrast | AA | Static |
| 2.1.1 Keyboard | A | Static |
| 2.1.2 No keyboard trap | A | Static |
| 2.4.7 Focus visible | AA | Static |
| 2.4.11 Focus not obscured (minimum) | AA | Static |
| 2.5.7 Dragging movements | AA | Static |
| 2.5.8 Target size (minimum) | AA | Static |
| 3.2.6 Consistent help | A | Static |
| 3.3.2 Labels or instructions | A | Static |
| 3.3.8 Accessible authentication (minimum) | AA | Static |
| 4.1.2 Name, role, value | A | Static |

### Dynamic checks (3 criteria, with `--simulate`)

| Criterion | Level | Evaluation |
|-----------|-------|-----------|
| 2.4.3 Focus order | A | Dynamic |
| 3.2.4 Consistent identification | AA | Dynamic |
| 4.1.3 Status messages | AA | Dynamic |

### Manual review checklist (3 criteria)

These require human judgment and cannot be automated. The report includes a checklist:

- 1.2.3 Audio description or media alternative (prerecorded)
- 1.2.5 Audio description (prerecorded)
- 3.3.7 Redundant entry

When `--simulate` is enabled, 2.4.3, 3.2.4, and 4.1.3 are promoted to dynamic checks and removed from manual review.

Note: WCAG 2.2 removed 4.1.1 Parsing as obsolete — it is not implemented.

## Auto-fix mode

The `--fix` and `--fix-dry-run` flags automatically repair six classes of mechanical violations and write a corrected package as `<package>.scorm-fixed.zip`. Fixes are conservative — if a fixer is uncertain about a change, it reports `changed: false` and leaves the content as-is.

### Fixers

| Fixer | What it repairs |
|-------|----------------|
| `add-alt-decorative` | Adds `alt=""` to `<img>` elements that appear to be decorative |
| `add-tabindex-keyboard` | Adds `tabindex="0"` to `<div>` and `<span>` elements with `onclick` handlers but no keyboard support |
| `add-lang-attribute` | Adds `lang` attribute to the `<html>` element if missing |
| `add-title` | Adds a default `<title>` if the document lacks one |
| `add-autocomplete-password` | Adds `autocomplete="current-password"` to password `<input>` fields |
| `repair-viewport-scale` | Removes `user-scalable=no` from viewport meta tags to allow user zoom |

```bash
# Preview fixes without writing
open-pathways my-course.zip --fix-dry-run

# Apply fixes and write the corrected package
open-pathways my-course.zip --fix
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | No violations found |
| 1 | Violations detected (or `--max-violations` threshold exceeded) |
| 2 | Tool error (invalid package, missing file, invalid flags, etc.) |

## Output formats

**Markdown report** (`report.md`): Human-readable summary, violations with WCAG links and source snippets, manual-review checklist.

**JSON scorecard** (`results.json`): Machine-readable results with per-criterion pass/fail, violation detail, and summary statistics. Use `--json` to print to stdout.

**SARIF** (`results.sarif`): SARIF 2.1.0 format for GitHub Code Scanning and other security dashboards. Use `--format sarif`.

**Plain text** (`report.txt`): Same as Markdown but without formatting. Use `--format txt`.

## Output examples

### JSON scorecard example

```json
{
  "tool": "open-pathways",
  "version": "2.0.0",
  "wcagVersion": "2.2",
  "packageType": "scorm12",
  "scannedAt": "2026-04-30T18:48:22.454Z",
  "passed": false,
  "score": 80.9,
  "dynamicChecksRun": true,
  "summary": {
    "criteriaEvaluated": 21,
    "criteriaPassed": 17,
    "criteriaFailed": 4,
    "totalViolations": 8,
    "bySeverity": { "critical": 0, "serious": 2, "moderate": 4, "minor": 2 },
    "byConfidence": { "definitive": 6, "heuristic": 2 }
  },
  "violations": [
    {
      "criterion": "1.1.1",
      "file": "index.html",
      "line": 42,
      "severity": "serious",
      "confidence": "definitive",
      "message": "Image is missing alt text",
      "evaluationMode": "static"
    }
  ]
}
```

SARIF maps severity as: `critical` and `serious` → `error`, `moderate` → `warning`, `minor` → `note`.

## CI / GitHub Actions

Fail a build if violations are found:

```yaml
- name: Audit accessibility
  run: npx open-pathways ./dist/course.zip
```

Upload results to GitHub Code Scanning:

```yaml
- name: Audit accessibility
  run: npx open-pathways ./dist/course.zip --format sarif --output ./a11y

- name: Upload SARIF results
  uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: ./a11y/results.sarif

- name: Fail if violations exceed threshold
  run: npx open-pathways ./dist/course.zip --max-violations 5
```

Exit code `0` = pass, `1` = violations found, `2` = tool error.

## Package type support

The tool automatically detects and audits:

- **SCORM 1.2** — legacy format, still widely used in Moodle and older LMS platforms
- **SCORM 2004** — modern SCORM variant with advanced sequencing (most common)
- **AICC profiles 1–2** — legacy e-learning standard (profiles 3–4 not supported)
- **xAPI / Tin Can** — modern event-streaming courseware packages
- **cmi5** — SCORM successor built on xAPI *(if parser available)*

Use `--package-type auto` (default) for automatic detection, or specify explicitly with `--package-type scorm12|scorm2004|aicc|xapi`.

## Limitations

- **Chromium-only for `--simulate`**: dynamic checks (focus order, consistent identification, status messages) require a headless Chromium browser. Firefox and WebKit support is planned.
- **No auto-fix for ARIA semantics or contrast**: fixers handle mechanical issues only (alt text, keyboard support, viewport scaling, etc.). ARIA and color fixes require domain expertise.
- **AICC profiles 3–4 not supported**: the tool targets common authoring-tool output (Articulate, Lectora, Captivate). Profiles 3–4 are out of scope.

## Contributing

The tool is designed for easy extension. To add a new check or dynamic check:

```bash
npm install
npm test         # run the test suite (vitest)
```

**Static checks** live in `src/checks/` — see [`docs/CONTRACT.md`](./docs/CONTRACT.md) for the check interface.

**Dynamic checks** live in `src/dynamic-checks/` — see [`docs/DYNAMIC_CHECKS.md`](./docs/DYNAMIC_CHECKS.md) for the dynamic check contract.

Each check is auto-discovered by its filename and criterion ID. The test suite exercises all 52 test cases.

## Privacy

No telemetry, no outbound network calls. The tool reads the package, writes the report, and exits.

## Project layout

```
src/parser/              SCORM 1.2, SCORM 2004, AICC, and xAPI manifest parsing
src/checks/              21 static WCAG checks (one file per criterion)
src/dynamic-checks/      3 browser-based checks (requires Playwright)
src/fixers/              6 mechanical auto-fixers (for --fix mode)
src/reporter/            JSON, Markdown, text, and SARIF output generators
src/lib/                 baseline diffing, file loading, audit context, AX tree adapter
src/cli.js               CLI entry point and flag parsing
test/fixtures/           sample SCORM/AICC/xAPI packages with known violations
docs/CONTRACT.md         interface for writing new static checks
docs/DYNAMIC_CHECKS.md   interface for writing dynamic checks
docs/PRD_SCORM_WCAG22.md full product specification
```

**Technical notes**: Static analysis uses CSS color parsing (`@asamuzakjp/css-color`) and the W3C relative-luminance formula for contrast checks — zero native dependencies, deterministic results. Dynamic checks use Playwright (optional) for accessibility tree inspection.

## License

MIT
