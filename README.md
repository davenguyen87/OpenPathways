# Prism

WCAG 2.1 AA + Section 508 accessibility audits **and rebuilds** for SCORM 1.2, SCORM 2004, AICC, and xAPI/Tin Can packages. Produces brand-matched HTML reports with triage-tagged findings, scope estimates, and — when audit findings are mechanically resolvable — a rebuilt `.zip` plus a per-patch diff, summary, and (for full-tier rebuilds) a side-by-side preview gated behind a human checkpoint.

Prism ships one product with two pipelines:

- **Audit.** Brand-matched HTML / Markdown / JSON reports with triage taxonomy and consultant-hour scope estimates. Engagement-namespaced output for multi-client isolation.
- **Rebuild** (three tiers, opt-in via `--mode`):
  - **Safe** (default) — deterministic mechanical fixes inside a single file (alt text scaffolding, `lang`, `title`, skip links, form labels, etc.).
  - **Assisted** — safe + LLM-generated content for single-file judgment items (alt text, ARIA labels, plain-language rewrites). Requires a configured LLM provider.
  - **Full** — safe + assisted + coordinated, package-scoped rewrites: ARIA landmark insertion + labeling, custom-widget replacement (tabs / accordion / carousel / dialog from a vetted ARIA library), and SCO page splitting with `imsmanifest.xml` edits. Staged under `.rebuild-staging/` and gated behind `prism rebuild-checkpoint approve`.

This README covers the **CLI** (the primary surface). Two adjacent surfaces share the same audit core under `src/`:

- **Local web UI** (`web/`) — drop a `.zip` in a browser. `npm run serve`. Audit-only. See [`web/README.md`](web/README.md).
- **Hosted multi-tenant service** (`cloud/`) — magic-link auth, S3 storage, Coolify deploy. Exposes audit, rebuild (safe / assisted / full), full-tier checkpoint review, undo, and per-workspace LLM key management at `/settings`. See [`cloud/README.md`](cloud/README.md) and [`cloud/DEPLOY.md`](cloud/DEPLOY.md).

---

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

Rebuild a package once an audit exists:

```bash
# Safe tier — deterministic, single-file mechanical fixes
node src/cli.js rebuild my-course.zip --engagement SL-2026-0418 --mode safe

# Full tier — safe + assisted + transforms; staged for review
node src/cli.js rebuild my-course.zip --engagement SL-2026-0418 --mode full
node src/cli.js rebuild-checkpoint approve --engagement SL-2026-0418 --package my-course --all
```

Safe-tier writes `rebuilt.zip` + `rebuild-manifest.json` + `rebuild-diff.html` + `rebuild-summary.html` directly. Full-tier stages outputs under `.rebuild-staging/` and waits for explicit operator approval before promoting; the preview report (`rebuild-preview.html`) renders side-by-side per-transform with an interactive approval form.

---

## Compliance baseline

Prism defaults to **WCAG 2.1 AA + Section 508** compliance, aligned with Cornerstone's published minimum standards for regulated clients (government, healthcare, education, financial services). This is the baseline; WCAG 2.2 remains available as an opt-in upgrade for forward-looking work.

---

## Skill Loop scoping

This tool is designed for Skill Loop, Cornerstone OnDemand's consulting practice on a monthly retainer for regulated clients. New engagements begin with a kickoff call followed by a written assessment delivered within five business days. Each kickoff includes auditing the client's existing SCORM library — typically 50 to 300 packages of mixed vintage, vendor authorship, and accessibility quality — to scope the remediation work and feed the broader engagement assessment.

Prism is shaped around the senior consultant: a brand-matched assessment-ready deliverable, a defensible scope estimate, multi-engagement isolation, defaults that match the firm's published compliance posture, and an opt-in rebuild pipeline that automates every finding with a deterministic right answer.

**Goals:**
1. Compress library scoping from 2–3 senior-consultant days to under 2 hours per kickoff engagement.
2. Produce an assessment-ready deliverable (brand-matched HTML and Markdown) on every audit, paste-in compatible with the broader engagement assessment template.
3. Generate defensible scope estimates in consultant hours, rolled up at package and library level.
4. Support multi-engagement workflows with strict per-client output isolation.
5. Default to the firm's published compliance posture: WCAG 2.1 AA and Section 508.
6. Stay local-first: no telemetry, no outbound AI calls without explicit per-engagement opt-in.

---

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

### `rebuild <package.zip>`

Apply fixers and transformers to produce a rebuilt package. Defaults to `--mode safe` (deterministic mechanical fixes). `--mode full` adds transforms (landmarks, widget replacement, page splitting) and stages outputs for review unless `--no-checkpoint` is passed.

```bash
node src/cli.js rebuild ./legacy-course.zip --engagement SL-2026-0418 --mode full
```

Produces (mode safe):
- `./engagements/SL-2026-0418/legacy-course/rebuilt.zip`
- `./engagements/SL-2026-0418/legacy-course/rebuild-manifest.json` (every patch with file/line/before/after)
- `./engagements/SL-2026-0418/legacy-course/rebuild-diff.html` (per-patch reviewable diff)
- `./engagements/SL-2026-0418/legacy-course/rebuild-summary.html` (scoreboard with verification numbers)

Mode full additionally stages under `.rebuild-staging/` and requires `rebuild-checkpoint approve` before promotion. After approval, all five rebuild artifacts (`rebuilt.zip`, `rebuild-manifest.json`, `rebuild-diff.html`, `rebuild-summary.html`, `rebuild-preview.html`) land at the package root.

### `rebuild-library <directory>`

Batch rebuild. Mirrors `audit-library`. Each package gets its own staging directory (full mode) or its own rebuilt artifacts (safe mode). Approve every package's staged transforms with `rebuild-checkpoint approve` per package.

### `rebuild-checkpoint approve|reject|list`

Lifecycle commands for full-tier staged rebuilds.

```bash
# List every package with a pending checkpoint under an engagement
node src/cli.js rebuild-checkpoint list --engagement SL-2026-0418

# Approve every staged transform for a package
node src/cli.js rebuild-checkpoint approve --engagement SL-2026-0418 --package legacy-course --all

# Approve a specific transform (rejecting the rest)
node src/cli.js rebuild-checkpoint approve --engagement SL-2026-0418 --package legacy-course --transform transform-0001

# Discard the staging directory entirely (no effect on any prior rebuilt.zip)
node src/cli.js rebuild-checkpoint reject --engagement SL-2026-0418 --package legacy-course --force
```

Promotion runs `verify()`, validates rewritten `imsmanifest.xml` against the SCORM schema (when a transform edited it), and checks SCO sequence integrity. Any failure rolls back atomically; the staging area is preserved for re-attempt.

### `rebuild-undo <package>`

Atomic revert. Pass either `--patch <id>` (individual patches) or `--transform <id>` (every patch in the transform reverts together). Mixing is supported; passing a patch that belongs to a transform without including the transform is refused.

```bash
node src/cli.js rebuild-undo legacy-course --engagement SL-2026-0418 --transform transform-0001
```

Re-runs `verify()` after undo and updates the manifest with a `revertHistory` entry.

---

## LLM features

Three opt-in LLM features complete the audit + rebuild story. All three are off unless `--llm-provider` is set; all three activate automatically once it is, with per-feature opt-outs for cost control.

**(a) Audit narrative** (v3.1) — the HTML and Markdown reports gain a "Section 01a — Engagement Narrative" between the cover and Section 01. Three prose blocks: executive narrative, per-criterion remediation guides for the top failing criteria, and a prioritized scope memo. Library mode adds a cross-package synthesis block at the top of the rollup. Each block carries a provenance pill ("AI-DRAFTED — review before sharing") and is independent — if one block fails, the others still render. Opt out per run with `--no-llm-narrative`.

**(b) Assisted-tier fixers** (v4.1) — `--mode assisted` (or `--mode full`) generates candidate content for single-file judgment items: alt text for content images (1.1.1), link text rewrites for vague anchors (2.4.4), and form labels for unlabeled controls (3.3.2). Without `--llm-provider`, these violations defer cleanly with reason `--llm-provider not set`. No flag needed to opt out — removing `--llm-provider` is the off switch.

**(c) Transformer judgment** (v5.1) — `--mode full` runs an LLM classification pass alongside the heuristic widget detectors (tabs, accordion, carousel, dialog). The LLM confirms, rejects, or marks uncertain each heuristic candidate before the transform is staged. `no-match` verdicts are silently dropped (the deferred list records the reason); `uncertain` verdicts stage with an amber "AI-UNCERTAIN" pill for human scrutiny at the checkpoint. Opt out with `--no-llm-judgment`.

### Activation

Set `--llm-provider anthropic --llm-key-from-env ANTHROPIC_API_KEY` on `audit`, `audit-library`, `rebuild`, or `rebuild-library`. All three features activate automatically when the provider is configured:

```bash
# Audit with narrative
prism audit <pkg.zip> --engagement <id> --llm-provider anthropic --llm-key-from-env ANTHROPIC_API_KEY

# Assisted rebuild (judgment fixers)
prism rebuild <pkg.zip> --engagement <id> --mode assisted --llm-provider anthropic --llm-key-from-env ANTHROPIC_API_KEY

# Full rebuild (judgment fixers + transformer classification)
prism rebuild <pkg.zip> --engagement <id> --mode full --llm-provider anthropic --llm-key-from-env ANTHROPIC_API_KEY
```

Default model is `claude-haiku-4-5` (alias). Override with `--llm-model <id>` (e.g. `claude-sonnet-4-6`).

### Cost

Measured at default Haiku pricing: ~$0.05/package for narrative, ~$0.025/package additional for full-tier transformer judgment. A 200-package library costs roughly $11–16 total. Per-feature token budgets (`--llm-narrative-token-budget`, `--llm-judgment-token-budget`) are configurable and enforced per package.

### Provenance and review

Every LLM-generated artifact records provider, model, prompt hash, token usage, latency, and a `generatedAt` timestamp. Reports render an `AI-DRAFTED` (narrative) or `AI-CONFIRMED` / `AI-UNCERTAIN` (judgment) pill labeled "review before sharing." Consultant sign-off remains the contract: narrative blocks and assisted patches are first drafts, not final deliverables.

### Deferred fallback

Without `--llm-provider`, every assisted-tier violation defers with reason `--llm-provider not set`; reports render byte-identically to the pre-v3.1 path. No placeholder sections, no empty pills, no partial artifacts.

### Runtime dependency

`@anthropic-ai/sdk` (`^0.95.1`) is a runtime dependency, installed via `npm install`. It is loaded only when `--llm-provider anthropic` is active.

### Specs

- [PRD v3.1 — Audit Narrative](archive/workstreams/v3.1-narrative/PRD_v3.1_Narrative.md)
- [PRD v4.1 — Assisted Tier](archive/workstreams/v4.1-assisted/PRD_v4.1_AssistedTier.md)
- [PRD v5.1 — Transformer Judgment](archive/workstreams/v5.1-judgment/PRD_v5.1_TransformerJudgment.md)

---

## Key flags

| Flag | Meaning | Default | Notes |
|------|---------|---------|-------|
| `--engagement <id>` | Engagement ID (required for the engagement deliverable; required for `audit-library`) | — | e.g., `SL-2026-0418`. All output isolated under `./engagements/<id>/`. |
| `--engagement-redact` | Replace client name with engagement ID in report | — | For confidential drafts circulating internally. |
| `--brand-config <path>` | Path to custom brand config | `config/brand.json` | Override colors and brand marks for white-label or co-branded deliverables. |
| `--standard <standard>` | WCAG version: `wcag21` or `wcag22` | `wcag21` | Default flipped from v2 to 2.1. Use `wcag22` for forward-looking audits. |
| `--baseline <path>` | Path to prior `results.json` | — | Suppress violations already present in the baseline (single-package `audit` only). |
| `--mode <tier>` | Rebuild tier: `safe`, `assisted`, or `full` | `safe` | `rebuild` / `rebuild-library` only. `safe` is deterministic; `assisted` requires an LLM provider; `full` adds package-scoped transforms behind a checkpoint gate. |
| `--no-checkpoint` | Skip the checkpoint gate; write final artifacts directly | (off — checkpoint is on by default) | `rebuild --mode full` only. Default off; staging gate is on by default for full mode. |
| `--transform <id>` | Specific transform id (repeatable) | — | `rebuild-checkpoint approve` (which transforms to approve), `rebuild-undo` (which transforms to revert). |
| `--all` | Approve every pending transform | — | `rebuild-checkpoint approve` only. |
| `--force` | Skip the confirmation prompt | — | `rebuild-checkpoint reject` only. |
| `--llm-provider <provider>` | LLM provider for all LLM features | — | Off by default. Both `--llm-provider` and `--llm-key-from-env` required to enable. Activates narrative (audit), assisted fixers (rebuild), and transformer judgment (full rebuild). |
| `--llm-key-from-env <env-var>` | Environment variable holding LLM API key | — | Off by default. No LLM features without both flags set. |
| `--llm-model <model-id>` | Override the provider default model | `claude-haiku-4-5` | Alias form, e.g. `claude-sonnet-4-6`. Applies to all LLM features. |
| `--no-llm-narrative` | Disable narrative generation | — | `audit` / `audit-library` only. Useful for CI speed when `--llm-provider` is set. |
| `--llm-narrative-token-budget <n>` | Per-package narrative token budget | `30000` | `audit` / `audit-library` only. |
| `--llm-narrative-criterion-cap <n>` | Max per-criterion guides to generate | `12` | `audit` / `audit-library` only. |
| `--no-llm-judgment` | Disable transformer judgment | — | `rebuild --mode full` only. Reverts to heuristic-only widget classification. |
| `--llm-judgment-token-budget <n>` | Per-package token budget for transformer judgment | `20000` | `rebuild --mode full` only. |
| `--llm-judgment-confidence-threshold <n>` | Confidence floor for `match` verdict | `0.7` | `rebuild --mode full` only. Below threshold, verdict is treated as `uncertain`. |
| `--browser <browser>` | Browser for dynamic checks | `chromium` | `chromium`, `firefox`, or `webkit`. |
| `--fix` | Apply mechanical fixes; write corrected package | — | Writes `<package>.scorm-fixed.zip`. Single-package `audit` only. Legacy v2 flag — prefer `rebuild --mode safe` for engagement work. |
| `--fix-dry-run` | Preview fixes without writing | — | Single-package `audit` only. |
| `--format <format>` | Report format (legacy fallback flag) | `md` | `md` or `txt`. Ignored when `--engagement` is set (HTML is always generated). |
| `--json` | Output JSON scorecard to stdout only | — | Suppresses spinner and file output. |
| `--max-violations <n>` | Fail if violation count exceeds threshold | — | For CI gates. |
| `--output <dir>` | Output directory (legacy v2 flag) | `./prism-report` | Ignored when `--engagement` is set. |
| `--package-type <type>` | Package format: `scorm12`, `scorm2004`, `aicc`, `cmi5`, `xapi`, `auto` | `auto` | Auto-detection is usually correct. |
| `--timeout-dynamic <ms>` | Timeout per SCO for dynamic checks | `30000` | |
| `-v, --version` | Print version | — | |

---

## Output structure

All output is namespaced by engagement to prevent cross-client data co-mingling:

```
./engagements/<engagement-id>/
├── <package-name-1>/
│   ├── report.html                  (primary audit deliverable)
│   ├── report.md                    (alternative, editable)
│   ├── results.json                 (audit byproduct)
│   ├── rebuilt.zip                  (present after rebuild)
│   ├── rebuild-manifest.json        (every patch + transform; manifest schema 2.0.0 when transforms are present)
│   ├── rebuild-diff.html            (per-patch reviewable diff)
│   ├── rebuild-summary.html         (rebuild scoreboard; includes transform stats when present)
│   ├── rebuild-preview.html         (full-mode — side-by-side per-transform with approval form)
│   └── .rebuild-staging/            (full-mode — present while a rebuild awaits checkpoint approval)
│       ├── rebuilt-staged.zip
│       ├── rebuild-manifest-staged.json
│       ├── rebuild-preview.html
│       └── checkpoint-state.json    (per-transform approve/reject decisions)
├── <package-name-2>/
│   └── ...
└── _library-rollup.html             (batch mode only; aggregated view)
    (+ _library-rollup.md)
```

The **HTML report is the primary deliverable**, matching the visual contract in `archive/mockups/assessment-mock-v1.html`. It includes:

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

---

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

---

## Rebuild tiers

The rebuild system is closed at three tiers. Each is opt-in via `--mode`. Findings that no tier can resolve become deferred and stay in the audit's "author rework" / "content rework" / "recommend retire" buckets.

| Tier | Flag | What it does | Risk | Gate |
|------|------|--------------|------|------|
| **Safe** | `--mode safe` (default) | Deterministic, single-file mechanical patches: `alt=""` for decorative images, `<html lang>`, `<title>`, skip links, `<label for>` ↔ `<input id>` association, etc. | Low — every fix has a documented invariant | Patch-level diff at `rebuild-diff.html`. No staging. |
| **Assisted** | `--mode assisted` | Safe + LLM-generated content for single-file judgment items: alt text, ARIA labels, plain-language rewrites. Requires a configured LLM provider. | Medium — provenance logged per patch | Same as safe (patch-level diff). |
| **Full** | `--mode full` | Safe + assisted + transforms: ARIA landmark insertion + labeling, custom-widget replacement (tabs / accordion / carousel / dialog), and SCO page splitting (rewrites `imsmanifest.xml`). | Higher — rewriting can change meaning | Mandatory checkpoint at `.rebuild-staging/`; requires `rebuild-checkpoint approve` to promote. Promotion re-runs `verify()`, validates manifest XML against the SCORM schema, and walks the new SCO sequence. Rolls back atomically on any failure. |

Every patch — at any tier — is reversible. Single-patch revert via `rebuild-undo --patch <id>`; atomic transform revert (every patch in a transform reverts together) via `rebuild-undo --transform <id>`.

---

## Configuration

### Brand assets (`config/brand.json`)

Default brand config shipped with the tool. Overridable per engagement with `--brand-config <path>`. Flat key/value shape — keys map directly onto CSS custom properties in the HTML report.

```json
{
  "mark": "SL",
  "name": "Skill Loop",
  "tagline": "Cornerstone OnDemand specialists",
  "paper": "#f3efe6",
  "ink": "#111633",
  "accent": "#2f7d72",
  "cta": "#f28619",
  "sev-critical": "#c46a14",
  "sev-serious": "#de8a2e",
  "sev-moderate": "#55597a",
  "sev-minor": "#948a74"
}
```

See the shipped `config/brand.json` for the full set of supported keys (paper / ink / rule tonal scales, accent variants, severity colors).

### Effort calibration (`config/effort-calibration.json`)

Default effort ranges per triage category and criterion. Loaded by the scope estimator. Overridable per engagement in future versions.

```json
{
  "auto-fix safe": { "default": 5, "byCriterion": { "1.1.1": 3 } },
  "author rework": { "default": 60, "byCriterion": { "2.4.6": 45 } }
}
```

---

## Local-first, consent-driven

Prism produces zero outbound network traffic during audit, with two exceptions:

1. **One-time Playwright install** (v2 behavior, unchanged): `npx playwright install chromium` on first run if the binary is missing.
2. **LLM-assisted findings** (optional): only when both `--llm-provider` and `--llm-key-from-env` are set. Defaults to off. Every assisted finding records provenance (provider, model, engagement ID, timestamp) in JSON output. Same provider abstraction is used by `rebuild --mode assisted` when configured.

No firm-wide LLM provider default exists. Each engagement explicitly configures its own provider and credentials.

---

## Examples

Audit a single package for a new client kickoff:

```bash
node src/cli.js audit acme-safety-training.zip --engagement SL-2026-0418
```

Audit a library and use 2.2 standards:

```bash
node src/cli.js audit-library ./legacy-library/ --engagement SL-2026-0418 --standard wcag22
```

Audit with narrative enabled (v3.1):

```bash
node src/cli.js audit course.zip --engagement SL-2026-0418 \
  --llm-provider anthropic \
  --llm-key-from-env ANTHROPIC_API_KEY
```

Assisted rebuild with LLM-generated alt text, link text, and form labels (v4.1):

```bash
node src/cli.js rebuild course.zip --engagement SL-2026-0418 --mode assisted \
  --llm-provider anthropic \
  --llm-key-from-env ANTHROPIC_API_KEY
```

Full rebuild with transformer judgment enabled (v5.1):

```bash
node src/cli.js rebuild course.zip --engagement SL-2026-0418 --mode full \
  --llm-provider anthropic \
  --llm-key-from-env ANTHROPIC_API_KEY
```

Redact client name in the draft (for internal review before delivery):

```bash
node src/cli.js audit course.zip --engagement SL-2026-0418 --engagement-redact
```

Apply safe-tier mechanical fixes (v2-style — produces `<package>.scorm-fixed.zip`):

```bash
node src/cli.js audit course.zip --engagement SL-2026-0418 --fix
```

Run a safe-tier rebuild instead — produces `rebuilt.zip` plus a per-patch diff:

```bash
node src/cli.js rebuild course.zip --engagement SL-2026-0418 --mode safe
```

Run a full-tier rebuild and approve every staged transform after review:

```bash
node src/cli.js rebuild course.zip --engagement SL-2026-0418 --mode full
# review engagements/SL-2026-0418/course/.rebuild-staging/rebuild-preview.html
node src/cli.js rebuild-checkpoint approve --engagement SL-2026-0418 --package course --all
```

Roll back a transform atomically:

```bash
node src/cli.js rebuild-undo course --engagement SL-2026-0418 --transform transform-0001
```

---

## Distribution

This tool runs locally from source only. No npm publishing, no public adoption.

- **From source**: `node src/cli.js audit <file.zip>`
- **Global shorthand** (one-time setup): `npm link` from the project folder creates a symlink; then `prism audit <file.zip>` works globally. Code changes take effect immediately — no re-linking needed.
- **Dependencies**: `npm install` pulls all required packages. First run auto-installs Playwright chromium if missing.

Requires Node.js 18+.

---

## Architecture

Prism operates in five layers:

1. **Parser** (`src/parser/`) — Detects SCORM 1.2, SCORM 2004, AICC, cmi5, xAPI manifests and extracts entry points.
2. **Checks** (`src/checks/`, `src/dynamic-checks/`) — 21 static WCAG criteria plus dynamic browser-based checks (focus order, focus visible, consistent identification, name/role/value, status messages) executed against the live accessibility tree. Powered by axe-core for contrast and semantic analysis.
3. **Reporter** (`src/reporter/`) — Converts findings into brand-matched HTML/Markdown reports, JSON scorecards, and Section 508 mapping tables. Includes triage taxonomy, scope estimation, multi-engagement output isolation, the per-patch rebuild diff, and the side-by-side preview renderer for full-tier transforms.
4. **Fixers** (`src/fixers/`) — Single-file deterministic mechanical patches (decorative-image alt, `lang`, `title`, skip links, form-label association, etc.). Each fixer is duck-typed (`canFix` + `fix`) and registered via directory scan.
5. **Transformers + widgets** (`src/transformers/`, `src/widgets/`) — Package-scoped rewrites. Transformers (`canTransform` + `apply` + `revert`) coordinate multi-file edits including `imsmanifest.xml` rewrites. Widgets ship as vetted ARIA-compliant HTML/CSS/JS fragments matching the W3C ARIA Authoring Practices Guide; widget-replacement transformers consume them. Every transform stages, renders side-by-side, and requires checkpoint approval before promotion.

The rebuild orchestrator (`src/rebuild/`) sits between layers 4 and 5: it dispatches fixers per-file then transformers per-package, validates output, stages full-tier results under `.rebuild-staging/`, and is the single writer of `rebuild-manifest.json` (schema 1.0.0 for safe / assisted runs, 2.0.0 when transforms are present).

---

## Legacy fallback (deprecated)

When `--engagement` is omitted, the CLI falls back to legacy behavior:
- Output to `./prism-report/` (default or `--output` flag)
- Default standard is `wcag21`
- Single-package mode only; no library rollup
- No rebuild access (rebuild commands always require `--engagement`)

This path is **deprecated** and prints a warning when used. It exists so existing CI and automation pipelines continue to work; new automation should pass `--engagement <id>` explicitly. Removal is targeted for a future major release.

---

## Development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Run the CLI locally:

```bash
node src/cli.js audit test/fixtures/scorm12-clean.zip --engagement TEST
```

---

## License

MIT (per `package.json`).
