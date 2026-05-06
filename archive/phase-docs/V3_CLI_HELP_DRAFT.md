# Open Pathways v3 CLI Help Reference

## Main command

```
open-pathways <command> [options]

Audit SCORM 1.2, SCORM 2004, AICC, and xAPI packages for WCAG 2.1 AA + Section 508 compliance.
Produces brand-matched HTML reports, triage-tagged findings, and scope estimates.

Commands:
  audit <package>           Audit a single .zip package (primary command)
  audit-library <directory> Audit all .zip files in a directory and generate rollup

Options:
  -v, --version            Print tool version
```

---

## `audit <package.zip>` — Single-package audit

```
USAGE
  $ open-pathways audit <package.zip> [options]

ARGUMENTS
  <package.zip>  Path to .zip SCORM/AICC/xAPI package

DESCRIPTION
  Audit a single SCORM/AICC package and generate a brand-matched HTML report,
  Markdown alternative, and JSON scorecard. Output lands in
  ./engagements/<engagement-id>/<package-name>/.

  The engagement ID is required (--engagement) and organizes output to prevent
  cross-client data co-mingling.

EXAMPLES
  $ open-pathways audit my-course.zip --engagement SL-2026-0418
  
  $ open-pathways audit legacy-training.zip --engagement SL-2026-0418 --standard wcag22
  
  $ open-pathways audit course.zip --engagement SL-2026-0418 --fix
  
  $ open-pathways audit course.zip --engagement SL-2026-0418 \
      --llm-provider openai \
      --llm-key-from-env OPENAI_API_KEY

OPTIONS
  --engagement <id>                    (REQUIRED) Engagement ID; output isolated under ./engagements/<id>/
  
  --engagement-redact                  Replace client name with engagement ID throughout report (for confidential drafts)
  
  --brand-config <path>                Path to custom brand config (default: config/brand.json)
  
  --standard <wcag21|wcag22>           WCAG version to audit against (default: wcag21)
  
  --llm-provider <provider>            Enable LLM-assisted findings; requires --llm-key-from-env
  
  --llm-key-from-env <env-var>         Environment variable holding LLM API key; requires --llm-provider
  
  --browser <chromium|firefox|webkit>  Browser for dynamic checks (default: chromium)
  
  --fix                                Apply safe-tier mechanical fixes; writes <package>.scorm-fixed.zip
  
  --fix-dry-run                        Preview fixes without writing to disk
  
  --package-type <type>                Force package type: scorm12|scorm2004|aicc|xapi|auto (default: auto)
  
  --format <format>                    (Deprecated in v3; HTML always generated) md|txt (default: md)
  
  --json                               Output JSON scorecard to stdout only (suppresses spinner/logs)
  
  --max-violations <n>                 Fail if violation count exceeds threshold (for CI gates)
  
  --output <dir>                       (Deprecated in v3; ignored) Output directory
  
  --timeout-dynamic <ms>               Timeout per SCO for dynamic checks (default: 30000)
  
  -v, --version                        Print tool version
```

---

## `audit-library <directory>` — Batch audit + rollup

```
USAGE
  $ open-pathways audit-library <directory> [options]

ARGUMENTS
  <directory>  Directory containing .zip packages to audit

DESCRIPTION
  Audit all .zip files in a directory in a single pass and generate per-package
  reports plus a library-level rollup. Scope estimates and triage tags roll up
  to show library-wide distribution across categories and total effort.

  The engagement ID is required (--engagement) and organizes all output under
  ./engagements/<engagement-id>/.

EXAMPLES
  $ open-pathways audit-library ./client-library/ --engagement SL-2026-0418
  
  $ open-pathways audit-library ./legacy-saba/ --engagement SL-2026-0418 --standard wcag22

OPTIONS
  --engagement <id>                    (REQUIRED) Engagement ID; output isolated under ./engagements/<id>/
  
  --engagement-redact                  Replace client name with engagement ID throughout reports
  
  --brand-config <path>                Path to custom brand config (default: config/brand.json)
  
  --standard <wcag21|wcag22>           WCAG version to audit against (default: wcag21)
  
  --llm-provider <provider>            Enable LLM-assisted findings; requires --llm-key-from-env
  
  --llm-key-from-env <env-var>         Environment variable holding LLM API key; requires --llm-provider
  
  --browser <chromium|firefox|webkit>  Browser for dynamic checks (default: chromium)
  
  --package-type <type>                Force package type: scorm12|scorm2004|aicc|xapi|auto (default: auto)
  
  --timeout-dynamic <ms>               Timeout per SCO for dynamic checks (default: 30000)
  
  -v, --version                        Print tool version
```

---

## Output

### Single-package audit (`audit`)

```
./engagements/<engagement-id>/<package-name>/
├── report.html        (primary deliverable; brand-matched, PDF-print-ready)
├── report.md          (alternative; editable in Word/text editor)
└── results.json       (byproduct; machine-readable findings, triage, effort, 508 refs)
```

**report.html** includes:
- Cover with engagement metadata
- Executive summary (pass/fail, score, top stats)
- Triage breakdown
- Scope recommendation
- Top three risks
- Findings by severity
- Per-package detail
- Section 508 mapping table
- Method and scope note

### Library audit (`audit-library`)

Same per-package outputs as above, plus:

```
./engagements/<engagement-id>/
├── <package-1>/
│   ├── report.html
│   ├── report.md
│   └── results.json
├── <package-2>/
│   ├── report.html
│   ├── report.md
│   └── results.json
├── _library-rollup.html  (aggregated view across all packages)
└── _library-rollup.md    (alternative; editable)
```

**_library-rollup.html** includes:
- Package count and audit dates
- Distribution across triage categories
- Total estimated hours to remediate
- Recommended engagement shape
- Top three risks across the library
- Per-package summary table with links to individual reports

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | No violations found |
| 1 | Violations detected (or `--max-violations` threshold exceeded) |
| 2 | Tool error (invalid package, missing file, incomplete audit, etc.) |

An **INCOMPLETE audit** (when dynamic checks could not run) exits 2 regardless of violation count, ensuring a partial audit is never mistaken for a clean pass.

## Defaults (v3)

- **WCAG version**: 2.1 AA (firm baseline; 2.2 opt-in via `--standard wcag22`)
- **Browser**: chromium
- **Dynamic-check timeout**: 30000 ms
- **Brand config**: `config/brand.json` (Skill Loop house brand)
- **LLM-assisted findings**: OFF (requires both `--llm-provider` and `--llm-key-from-env`)
- **Package-type detection**: auto
- **Report format**: HTML + Markdown + JSON (v3 always generates all three)

## Environment

- **Node.js**: 18+ required
- **Playwright**: auto-installed on first run if dynamic checks are needed
- **LLM API keys**: sourced from environment variables only (never CLI args for security)

## Notes for consultants

- Always set `--engagement <id>` to an engagement code (e.g., `SL-2026-0418`). Output is isolated under that directory.
- Use `--engagement-redact` when drafting internal assessments before client delivery.
- The HTML report is your primary deliverable. Markdown is for editing; JSON is for automation.
- Triage tags (`auto-fix safe`, `author rework`, etc.) are action categories — use these to scope effort and conversation with the client.
- Section 508 refs on every finding. Use the mapping table in the report for regulated-client conversations.
- No outbound network calls. LLM assistance is strictly opt-in per engagement.
