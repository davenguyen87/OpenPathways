# CLAUDE.md

## Project: Open Pathways

A SCORM 1.2 / SCORM 2004 / AICC / xAPI accessibility auditor scoped for Skill Loop, Cornerstone OnDemand's consulting practice. Audits a `.zip` package against **WCAG 2.1 AA + Section 508** (the firm's published baseline; WCAG 2.2 remains opt-in). Produces a brand-matched HTML report, a Markdown variant, and a JSON scorecard, with triage tagging and consultant-hour scope estimates.

The repo ships three surfaces:

1. **CLI** (`src/`) — primary interface. `node src/cli.js audit <pkg.zip> --engagement <id>` and `audit-library <dir>` for batch.
2. **Local web UI** (`web/`) — drop-a-zip browser tool. `npm run serve`. Calls `src/index.js` as a library.
3. **Hosted multi-tenant service** (`cloud/`) — magic-link auth, S3 storage, worker queue, Coolify deploy. `npm run cloud`.

Current spec: `docs/PRD_v3_SkillLoop_Scoping.md`. Check author contract: `docs/CONTRACT.md`. Dynamic checks design: `docs/DYNAMIC_CHECKS.md`. Older phase docs are in `archive/phase-docs/`.

---

## Folder structure

```
src/
├── cli.js              ← entry point; commander v12, two subcommands (audit, audit-library)
├── index.js            ← audit() — the library entry called by web/ and cloud/
├── parser/             ← SCORM/AICC/cmi5/xAPI manifest parsing + entry-point detection
├── checks/             ← one file per WCAG criterion (e.g. 1-1-1-non-text-content.js)
├── dynamic-checks/     ← Playwright-based checks against the live AX tree
├── fixers/             ← --fix mode mechanical repairs (alt="", lang, title, etc.)
├── reporter/           ← html.js (primary), markdown-v3.js, markdown.js (legacy), json.js, sarif.js, text.js
└── lib/                ← audit-library, triage, scope-estimator, section508,
                          top-risks, library-rollup, ax-tree-adapter, baseline,
                          ensure-playwright, llm-provenance, etc.

web/                    ← v1 local-only Express UI; frozen reference (see web/CLAUDE.md)
cloud/                  ← hosted multi-tenant; deploys on Coolify (see cloud/CLAUDE.md, cloud/ROADMAP.md)
config/                 ← brand.json, effort-calibration.json
scripts/                ← check-no-network, network-trap, self-audit-report
test/fixtures/          ← sample .zip packages with known violations
docs/                   ← living project documents (PRD v3, CONTRACT, DYNAMIC_CHECKS)
archive/                ← WCAG reference HTML, retired phase docs, early mockups
engagements/            ← per-client audit output (gitignored)
```

---

## Key decisions

- **Standard**: defaults to `wcag21` + Section 508 mapping. `--standard wcag21|wcag22` toggles.
- **v3 deliverable mode**: `--engagement <id>` is the v3 path. Output lands at `engagements/<id>/<package>/{report.html, report.md, results.json}`. Without `--engagement` the CLI runs in v2 backward-compat mode and writes to `./open-pathways-report/`.
- **Library mode**: `audit-library <dir>` audits an entire client library and writes a single rollup at `engagements/<id>/_library-rollup.{html,md}`.
- **Brand**: `config/brand.json` is the source of truth for HTML report colors; `--brand-config <path>` overrides per engagement.
- **Scope estimates**: `config/effort-calibration.json` defines hour-bands per disposition (auto-fix safe / assisted / author rework / content rework / recommend retire), with per-criterion overrides.
- **Contrast engine**: axe-core static CSS analysis (do not reimplement).
- **AICC**: profiles 1–2 only. Profiles 3–4 return a clear error.
- **External iframes**: warn with `iframeUrl` field — do not score as a violation.
- **Telemetry**: none. No outbound network calls except the one-time `npx playwright install chromium` on first run; `scripts/check-no-network.js` enforces this in CI.
- **LLM provenance**: optional, opt-in per engagement via `--llm-provider` + `--llm-key-from-env`. Logged in the report when used.
- **Exit codes**: 0 = no violations, 1 = violations found, 2 = tool error OR audit incomplete.
- **4.1.1 Parsing**: removed in WCAG 2.2 — do not implement this check.
- **Dynamic checks are mandatory** (since v2.0). Playwright + chromium are required dependencies; the audit runs `npx playwright install chromium` itself on first run if the binary is missing. If even auto-install can't recover (offline, locked-down CI), the audit completes with the report stamped INCOMPLETE and exits 2 — a partial audit must never be mistaken for a clean pass. The `--simulate` flag has been removed; static-only audits are no longer a supported mode. See `src/lib/ensure-playwright.js` and `src/dynamic-checks/`.

---

## Distribution

Not published to npm. Runs locally from source.

- Run directly: `node src/cli.js audit <file.zip> --engagement <id>`
- For the `open-pathways` shorthand globally on your Mac, `npm link` once from the project folder. The symlink points at the local source, so any code changes take effect immediately.
- If a new version adds a dependency, run `npm install` inside the project folder.
- `npm test` runs the vitest suite. `npm run check-no-network` runs the egress trap.
- Web: `npm run serve`. Cloud (local mode): `npm run cloud`.

---

## Coding guidelines

- Think before coding. State assumptions. Surface tradeoffs. Ask if unclear.
- Minimum code that solves the problem — no speculative features or abstractions.
- Touch only what the task requires. Match existing style.
- Define success criteria before implementing. Verify after.
- `web/` is intentionally frozen as the v1 reference. Do not modify it from `cloud/` work, and vice versa. If a piece of code becomes obviously identical in both for months, that's the time to extract a shared module — not before.
- `src/` is the shared audit core. Both `web/` and `cloud/` import from it; touch it only with explicit reason and document the change.
- Delegate to subagents using the best model (Opus, Sonnet, or Haiku) and run them in parallel whenever possible.
