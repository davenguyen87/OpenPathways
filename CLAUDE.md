# CLAUDE.md

## Project: Prism

A SCORM 1.2 / SCORM 2004 / AICC / xAPI accessibility **auditor + rebuilder** scoped for Skill Loop, Cornerstone OnDemand's consulting practice. Audits a `.zip` package against **WCAG 2.1 AA + Section 508** (the firm's published baseline; WCAG 2.2 remains opt-in). Produces a brand-matched HTML report, a Markdown variant, and a JSON scorecard, with triage tagging and consultant-hour scope estimates. Optionally rebuilds the package end-to-end across three tiers (safe / assisted / full). Three LLM-activation phases (v3.1 audit narrative, v4.1 assisted-tier rebuild, v5.1 transformer judgment) round out the reporting and rebuild story when `--llm-provider` is supplied.

The repo ships three surfaces:

1. **CLI** (`src/`) — primary interface. Subcommands:
   - Audit: `audit <pkg.zip>`, `audit-library <dir>`
   - Rebuild: `rebuild <pkg.zip> --mode safe|assisted|full`, `rebuild-library <dir>`
   - Checkpoint (v5 full mode): `rebuild-checkpoint approve|reject|list`
   - Undo: `rebuild-undo <package> [--patch <id>] [--transform <id>]`
2. **Local web UI** (`web/`) — drop-a-zip browser tool. `npm run serve`. Calls `src/index.js` as a library. Audit-only; rebuild surfaces are CLI for now.
3. **Hosted multi-tenant service** (`cloud/`) — magic-link auth, S3 storage, worker queue, Coolify deploy. `npm run cloud`. Exposes audit, rebuild (safe / assisted / full), full-tier checkpoint review UI, and undo. Per-workspace BYO LLM keys via `/settings`. Shipped 2026-05-08 (Phases 12, 12.5, 8b).

Current specs:
- `archive/workstreams/PRD_v3_SkillLoop_Scoping.md` — audit deliverable spec (shipped 2026-05-05)
- `archive/workstreams/v3.1-narrative/PRD_v3.1_Narrative.md` — LLM-generated audit narrative sections (shipped 2026-05-08)
- `archive/workstreams/v4-rebuild/PRD_v4_Rebuild.md` — safe-tier rebuild spec (shipped 2026-05-07)
- `archive/workstreams/v4.1-assisted/PRD_v4.1_AssistedTier.md` — assisted-tier rebuild with LLM-generated alt text, link text, and form labels (shipped 2026-05-08)
- `archive/workstreams/v5-full-tier/PRD_v5_FullTier.md` — full-tier rebuild + checkpoint lifecycle spec (shipped 2026-05-08)
- `archive/workstreams/v5.1-judgment/PRD_v5.1_TransformerJudgment.md` — LLM widget classification for full-tier transformer candidates (shipped 2026-05-08, current)

Workstream PRDs and per-chunk build prompts live in `archive/workstreams/` once shipped — they're historical reference, not active reading.

Check author contract: `docs/CONTRACT.md`. Dynamic checks design: `docs/DYNAMIC_CHECKS.md`. Older phase docs are in `archive/phase-docs/`.

---

## Folder structure

```
src/
├── cli.js              ← entry point; commander v12, six subcommand groups
│                          (audit, audit-library, rebuild, rebuild-library,
│                           rebuild-checkpoint, rebuild-undo)
├── index.js            ← library entry: audit(), rebuild(), checkpoint API,
│                          renderRebuildPreview — called by web/ and cloud/
├── parser/             ← SCORM/AICC/cmi5/xAPI manifest parsing + entry-point detection
├── checks/             ← one file per WCAG criterion (e.g. 1-1-1-non-text-content.js)
├── dynamic-checks/     ← Playwright-based checks against the live AX tree
├── fixers/             ← v2 --fix and v4 safe-tier mechanical repairs
│                          (alt="", lang, title, skip links, label associations, etc.)
│                          + v4.1 assisted: generate-alt-text.js, rewrite-link-text.js,
│                          generate-form-label.js (LLM-generated content)
├── transformers/       ← v5 full-tier package-scoped rewrites:
│                          landmark-insertion, landmark-labeling,
│                          widget-replacement-{tabs,accordion,carousel,dialog},
│                          page-split (edits imsmanifest.xml)
├── widgets/            ← v5 vetted ARIA component library (vanilla HTML/CSS/JS):
│                          tabs, accordion, carousel, dialog, tooltip
├── rebuild/            ← v4/v5 rebuild orchestrator: index.js (dispatch), manifest.js
│                          (schema 1.0.0 / 2.0.0), packager, types, undo, verify,
│                          checkpoint (v5 staging lifecycle)
├── reporter/           ← writeReports() orchestrator + renderers: html.js (primary
│                          audit), markdown-v3.js, markdown.js (legacy), json.js,
│                          sarif.js, text.js, rebuild-diff.js (v4 patch-level),
│                          rebuild-summary.js, rebuild-preview.js (v5 transform-level)
└── lib/                ← audit-library, triage, scope-estimator, section508,
                          top-risks, library-rollup, ax-tree-adapter, baseline,
                          ensure-playwright, llm-provenance, transformer-registry,
                          manifest-xml-editor, rebuild-cli, checkpoint-cli,
                          audit-narrative.js (v3.1 narrative generation),
                          llm-provider.js (v4.1 provider abstraction),
                          transformer-judgment.js (v5.1 widget classification), etc.

web/                    ← v1 local-only Express UI; frozen reference (see web/CLAUDE.md)
cloud/                  ← hosted multi-tenant; deploys on Coolify (see cloud/CLAUDE.md, cloud/ROADMAP.md)
archive/workstreams/    ← shipped workstream PRDs + per-chunk build prompts (v3, v3.1, v4, v4.1, v5, v5.1)
config/                 ← brand.json, effort-calibration.json
scripts/                ← check-no-network, network-trap, self-audit-report,
                          build-fixtures, build-fixtures-v5
test/fixtures/          ← sample .zip packages with known violations,
                          plus v4 rebuild-* and v5 rebuild-{landmark-needed,
                          tabs-divsoup,overflowing-page,full-mixed} fixtures
docs/                   ← living project documents (PRD v3, CONTRACT, DYNAMIC_CHECKS)
archive/                ← WCAG reference HTML, retired phase docs, early mockups
engagements/            ← per-client audit + rebuild output (gitignored)
```

---

## Key decisions

- **Standard**: defaults to `wcag21` + Section 508 mapping. `--standard wcag21|wcag22` toggles.
- **v3 deliverable mode**: `--engagement <id>` is the v3 path. Output lands at `engagements/<id>/<package>/{report.html, report.md, results.json}`. Without `--engagement` the CLI runs in v2 backward-compat mode and writes to `./prism-report/`.
- **Library mode**: `audit-library <dir>` audits an entire client library and writes a single rollup at `engagements/<id>/_library-rollup.{html,md}`.
- **Rebuild tiers** (closed system): `safe` (v4 — deterministic mechanical fixes, default), `assisted` (v4.1 — LLM-generated content for single-file judgment items), `full` (v5 — landmark insertion, widget replacement, page splitting). `--mode` selects.
- **Checkpoint gate**: `--mode full` stages outputs under `.rebuild-staging/` and requires `prism rebuild-checkpoint approve` before final promotion. Default checkpoint-on; `--no-checkpoint` is the explicit opt-out for CI scenarios.
- **Rebuild manifest schema**: `1.0.0` for safe / assisted runs (no transforms), `2.0.0` when full-tier transforms are present. Backward-compatible — older manifests load unchanged. Schema details in `archive/workstreams/v5-full-tier/PRD_v5_FullTier.md` § "Manifest schema v2.0.0".
- **Brand**: `config/brand.json` is the source of truth for HTML report colors; `--brand-config <path>` overrides per engagement.
- **Scope estimates**: `config/effort-calibration.json` defines hour-bands per disposition (auto-fix safe / assisted / author rework / content rework / recommend retire), with per-criterion overrides.
- **Contrast engine**: axe-core static CSS analysis (do not reimplement).
- **AICC**: profiles 1–2 only. Profiles 3–4 return a clear error.
- **External iframes**: warn with `iframeUrl` field — do not score as a violation.
- **Telemetry**: none. No outbound network calls except the one-time `npx playwright install chromium` on first run; `scripts/check-no-network.js` enforces this in CI.
- **LLM provenance**: optional, opt-in per engagement via `--llm-provider` + `--llm-key-from-env`. Logged in the report when used. Three features are now wired:
  - **Audit narrative (v3.1)** — auto-on when `--llm-provider` set; opt out with `--no-llm-narrative`. Adds "Section 01a — Engagement Narrative" (executive, per-criterion guides, scope memo) to HTML/MD reports. Library mode adds a "Library Synthesis" block to the rollup.
  - **Assisted rebuild (v4.1)** — three fixers (`generate-alt-text`, `rewrite-link-text`, `generate-form-label`) run under `--mode assisted` or `full` when `--llm-provider` set. Each patch carries full provenance and requires sign-off in the diff report.
  - **Transformer judgment (v5.1)** — widget classification on full-tier rebuilds; LLM verdict (from `classifyWidget`) attaches to each Transform record and surfaces in the checkpoint preview as `AI-CONFIRMED`/`AI-UNCERTAIN` pills. Opt out with `--no-llm-judgment`.
  - Provider abstraction supports `anthropic` (direct) and `openrouter` (gateway, +5% markup). OpenRouter auto-prefixes model strings (`claude-haiku-4-5` → `anthropic/claude-haiku-4-5`) so the same `--llm-model claude-haiku-4-5` works for both providers.
  - Default model: `claude-haiku-4-5` (alias). Sonnet/Opus opt-in via `--llm-model`.
  - Per-feature token budgets enforced (`--llm-narrative-token-budget`, `--llm-token-budget`, `--llm-judgment-token-budget`); failures defer cleanly to existing programmatic templates.
  - **Cloud: per-workspace BYO keys (Phase 12.5, shipped 2026-05-08)** — the hosted service at `cloud/` supports per-workspace Anthropic or OpenRouter API keys via `/settings`. The provider picker lets users choose `anthropic` or `openrouter`; key takes precedence over the server-env `LLM_KEY_FROM_ENV`. All three LLM features (narrative, assisted fixers, transformer judgment) activate per user when their key is set. Key encrypted at rest via `DATA_ENCRYPTION_KEY`. Token spend rolls into `workspace_llm_usage`.
- **Exit codes**: 0 = no violations, 1 = violations found, 2 = tool error OR audit incomplete.
- **4.1.1 Parsing**: removed in WCAG 2.2 — do not implement this check.
- **Dynamic checks are mandatory** (since v2.0). Playwright + chromium are required dependencies; the audit runs `npx playwright install chromium` itself on first run if the binary is missing. If even auto-install can't recover (offline, locked-down CI), the audit completes with the report stamped INCOMPLETE and exits 2 — a partial audit must never be mistaken for a clean pass. The `--simulate` flag has been removed; static-only audits are no longer a supported mode. See `src/lib/ensure-playwright.js` and `src/dynamic-checks/`.

---

## Distribution

Not published to npm. Runs locally from source.

- Run directly: `node src/cli.js audit <file.zip> --engagement <id>`
- For the `prism` shorthand globally on your Mac, `npm link` once from the project folder. The symlink points at the local source, so any code changes take effect immediately.
- If a new version adds a dependency, run `npm install` inside the project folder. v4.1 added `@anthropic-ai/sdk` as a runtime dependency for the Anthropic LLM provider.
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
