# Open Pathways v3 — Assessment-Ready Deliverables

v3 transforms Open Pathways from a JSON-generating audit tool into a senior-consultant delivery platform for WCAG 2.1 AA + Section 508 accessibility assessments. The underlying audit engine (static and dynamic checks) ships unchanged from v2; the report layer, defaults, and CLI surface are completely reframed.

## Quick start

Audit a single SCORM/AICC package and generate a brand-matched HTML report:

```bash
node src/cli.js audit my-course.zip --engagement SL-2026-0418
```

Output lands in `./engagements/SL-2026-0418/<package-name>/` with `report.html` (primary deliverable), `report.md` (alternative for editing), and `results.json` (for automation).

Audit an entire client library in one pass and generate a library-level rollup:

```bash
node src/cli.js audit-library ./client-library/ --engagement SL-2026-0418
```

Output: per-package reports in `./engagements/SL-2026-0418/<package-name>/` plus a single library rollup at `./engagements/SL-2026-0418/_library-rollup.html`.

## Compliance baseline

Open Pathways defaults to **WCAG 2.1 AA + Section 508** compliance, aligned with the firm's published minimum standards for regulated clients (government, healthcare, education, financial services). This is the baseline; WCAG 2.2 remains available as an opt-in upgrade for forward-looking work.

## Key flags

| Flag | Meaning | Default | Notes |
|------|---------|---------|-------|
| `--engagement <id>` | Engagement ID (required for v3 deliverables) | — | e.g., `SL-2026-0418`. All output isolated under `./engagements/<id>/`. |
| `--engagement-redact` | Replace client name with engagement ID in report | — | For confidential drafts circulating internally. |
| `--brand-config <path>` | Path to custom brand config | `config/brand.json` | Override fonts, colors, logo for white-label or co-branded deliverables. |
| `--standard <standard>` | WCAG version: `wcag21` or `wcag22` | `wcag21` | Default flipped from v2 to 2.1. Use `wcag22` for forward-looking audits. |
| `--llm-provider <provider>` | LLM provider for assisted findings | — | Off by default. Both `--llm-provider` and `--llm-key-from-env` required to enable. |
| `--llm-key-from-env <env-var>` | Environment variable holding LLM API key | — | Off by default. No assisted findings without both flags set. |
| `--browser <browser>` | Browser for dynamic checks | `chromium` | `chromium`, `firefox`, or `webkit`. |
| `--fix` | Apply mechanical fixes; write corrected package | — | Writes `<package>.scorm-fixed.zip`. |
| `--fix-dry-run` | Preview fixes without writing | — | |
| `--format <format>` | Report format (legacy v2 flag) | `md` | `md` or `txt`. Ignored in v3 (HTML is always generated). |
| `--json` | Output JSON scorecard to stdout only | — | Suppresses spinner and file output. |
| `--max-violations <n>` | Fail if violation count exceeds threshold | — | For CI gates. |
| `--output <dir>` | Output directory (legacy v2 flag) | — | Ignored in v3 (output always goes under `./engagements/<id>/`). |
| `--package-type <type>` | Package format: `scorm12`, `scorm2004`, `aicc`, `xapi`, `auto` | `auto` | Auto-detection is usually correct. |
| `--timeout-dynamic <ms>` | Timeout per SCO for dynamic checks | `30000` | |
| `-v, --version` | Print version | — | |

## Output structure

v3 organizes all output under engagement-namespaced directories to prevent cross-client data co-mingling:

```
./engagements/<engagement-id>/
├── <package-name-1>/
│   ├── report.html          (primary deliverable)
│   ├── report.md            (alternative, editable)
│   └── results.json         (byproduct for automation)
├── <package-name-2>/
│   ├── report.html
│   ├── report.md
│   └── results.json
└── _library-rollup.html     (batch mode only; aggregated view)
    (+ _library-rollup.md)
```

The **HTML report is the primary deliverable**, matching the visual contract in `mockups/assessment-mock-v1.html`. It includes:

- Cover with engagement metadata (engagement ID, package name, date, WCAG version)
- Executive summary with pass/fail, score, top stats
- Triage breakdown (counts by action category: auto-fix safe, auto-fix assisted, author rework, content rework, retire)
- Scope recommendation (estimated hours to remediate)
- Top three risks (critical findings ranked by impact, with Section 508 reference and regulated-learner framing)
- Findings grouped by severity (Critical, Serious, Moderate, Minor)
- Per-package detail appendix
- Section 508 mapping table
- Method and scope note

The **Markdown report** is generated alongside HTML for consultants who edit in Word before final PDF. Same content structure.

The **JSON scorecard** is available as a byproduct (no longer the headline output). Includes the same findings plus machine-readable triage, effort estimates, and Section 508 mappings for tooling and diff workflows.

## Local-first, consent-driven

Open Pathways produces zero outbound network traffic during audit, with two exceptions:

1. **One-time Playwright install** (v2 behavior, unchanged): `npx playwright install chromium` on first run if the binary is missing.
2. **LLM-assisted findings** (optional, v3-only): only when both `--llm-provider` and `--llm-key-from-env` are set. Defaults to off. Every assisted finding records provenance (provider, model, engagement ID, timestamp) in JSON output.

No firm-wide LLM provider default exists. Each engagement explicitly configures its own provider and credentials.

## Triage taxonomy

Every finding receives both a **severity** (from axe-core: Critical, Serious, Moderate, Minor) and a **triage action**:

| Triage tag | Meaning | Est. effort |
|---|---|---|
| `auto-fix safe` | Deterministic patch applied by the tool; consultant reviews diff | 2–10 min |
| `auto-fix assisted` | Tool generates candidate (alt text, label); consultant or author confirms | 5–20 min |
| `author rework` | Requires authoring-tool access or judgment a tool shouldn't make alone | 30–90 min |
| `content rework` | New content required (captions, transcripts, partial re-record) | 2–8 hours |
| `recommend retire` | Remediation cost exceeds rebuild-in-Galaxy cost | n/a |

Effort estimates are derived from effort-calibration.json and roll up at package and library level.

## Commands

### `audit <package.zip>`

Single-package audit. Primary command for kickoff scoping.

```bash
node src/cli.js audit ./legacy-course.zip --engagement SL-2026-0418
```

Produces:
- `./engagements/SL-2026-0418/legacy-course/report.html`
- `./engagements/SL-2026-0418/legacy-course/report.md`
- `./engagements/SL-2026-0418/legacy-course/results.json`

Exit codes: 0 = no violations, 1 = violations found, 2 = tool error or audit incomplete.

### `audit-library <directory>`

Batch mode. Iterates directory, audits all `.zip` files, produces per-package reports and a library-level rollup.

```bash
node src/cli.js audit-library ./client-library/ --engagement SL-2026-0418
```

Produces per-package outputs (as above) plus:
- `./engagements/SL-2026-0418/_library-rollup.html`
- `./engagements/SL-2026-0418/_library-rollup.md`

The rollup report includes:
- Total package count
- Distribution across triage categories (counts and percentages)
- Total scope-estimate hours
- Recommended engagement shape (sentence-only, e.g., "three-month engagement, ~22 hours/month")
- Top three risks aggregated across the library
- Per-package summary table

## Configuration

### Brand assets (`config/brand.json`)

Default brand config shipped with the tool. Overridable per engagement with `--brand-config <path>`.

```json
{
  "name": "Skill Loop",
  "tagline": "Cornerstone OnDemand specialists",
  "logoMark": "SL",
  "colors": {
    "paper": "#f3efe6",
    "accent": "#2f7d72",
    "cta": "#f28619"
  },
  "fonts": {
    "jersey": "Archivo Black",
    "display": "Space Grotesk",
    "sans": "Inter",
    "mono": "JetBrains Mono"
  }
}
```

### Effort calibration (`config/effort-calibration.json`)

Default effort ranges per triage category and criterion. Loaded by the scope estimator. Overridable per engagement in future versions.

```json
{
  "auto-fix safe": { "default": 5, "byCriterion": { "1.1.1": 3 } },
  "author rework": { "default": 60, "byCriterion": { "2.4.6": 45 } }
}
```

## Examples

Audit a single package for a new client kickoff:

```bash
node src/cli.js audit acme-safety-training.zip --engagement SL-2026-0418
```

Audit a library and use 2.2 standards:

```bash
node src/cli.js audit-library ./legacy-library/ --engagement SL-2026-0418 --standard wcag22
```

Audit with LLM-assisted findings enabled:

```bash
node src/cli.js audit course.zip --engagement SL-2026-0418 \
  --llm-provider openai \
  --llm-key-from-env OPENAI_API_KEY
```

Redact client name in the draft (for internal review before delivery):

```bash
node src/cli.js audit course.zip --engagement SL-2026-0418 --engagement-redact
```

Apply safe-tier mechanical fixes:

```bash
node src/cli.js audit course.zip --engagement SL-2026-0418 --fix
```

## Distribution

This tool runs locally from source only. No npm publishing, no public adoption.

- **From source**: `node src/cli.js audit <file.zip>`
- **Global shorthand** (one-time setup): `npm link` from the project folder creates a symlink; then `open-pathways audit <file.zip>` works globally. Code changes take effect immediately — no re-linking needed.
- **Dependencies**: `npm install` pulls all required packages. First run auto-installs Playwright chromium if missing.

Requires Node.js 18+.
