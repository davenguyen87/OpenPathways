# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [5.2.1] - 2026-05-09

### Added

- **OpenRouter as an alternative LLM provider** — same Claude models (Haiku 4.5 / Sonnet 4.6 / Opus 4.7), ~5% gateway markup. Selectable per-workspace via the Settings page provider picker, or server-wide via `LLM_PROVIDER=openrouter` env var. OpenRouter keys (`sk-or-v1-...`) pass the existing `sk-` prefix validation without modification. The engine auto-prefixes bare model aliases (`claude-haiku-4-5` → `anthropic/claude-haiku-4-5`) so no CLI flag changes are needed. Docs: `cloud/DEPLOY.md` § OpenRouter, `docs/STAGING_TEST_LLM_ACTIVATION.md` § Alternative: OpenRouter.

## [5.2.0] - 2026-05-08

### Added

**Cloud rebuild surface (Phase 12)**
- `POST /api/jobs/:id/rebuild` — queues a rebuild job (safe / assisted / full) against the audit's uploaded package. Rate limit: 10/min.
- `GET /api/rebuilds/:id`, `GET /api/rebuilds/:id/sse` — rebuild detail + SSE progress.
- `GET /api/jobs/:id/checkpoint`, `POST /api/jobs/:id/checkpoint` — staged transform list and per-transform approve/reject decisions. Rate limit: 60/min.
- `POST /api/jobs/:id/checkpoint/promote` — promote staged artifacts. Re-runs `verify()`, validates manifest XML, checks SCO sequence; rolls back atomically on failure. Rate limit: 5/min.
- `POST /api/jobs/:id/undo` — atomic transform undo. Rate limit: 10/min.
- Worker dispatches a second `runRebuild` pg-boss queue. `WORKER_REBUILD_CONCURRENCY=2` default; separate from the audit queue.
- `cloud/server/storage/staging.js` — staging storage adapter. 7-day TTL on un-decided staging dirs enforced by `cloud/server/lib/staging-retention.js`.
- New job statuses: `staged`, `expired`, `promoted`.
- Frontend: "Rebuild this audit" CTA + tier-picker modal (`cloud/public/app.js`). Rebuild detail view at `/rebuild/:id` with SSE progress. Full-tier checkpoint review UI: iframe preview + per-transform approve/reject sidebar + Promote button. Undo controls in the actions menu.
- Integration tests covering safe + full + promote-failure rollback paths.
- Migration 0007: `jobs.kind`, `jobs.parent_job_id`, `jobs.mode` columns.
- New env vars: `WORKER_REBUILD_CONCURRENCY` (default `2`), `QUOTA_CONCURRENT_REBUILDS` (default `1`).

**Per-workspace LLM keys (Phase 12.5)**
- `GET/PUT/DELETE /api/workspace/llm-config` — workspace LLM key CRUD. `POST /api/workspace/llm-config/test` — live connectivity check.
- `cloud/server/lib/crypto.js` — AES-256-GCM helpers for key encryption at rest.
- `cloud/server/lib/llm-key-resolver.js` — resolves the LLM key for a request: workspace key (decrypted) takes precedence over server `LLM_KEY_FROM_ENV`. Injects as `PRISM_RESOLVED_LLM_KEY` sentinel env var for the audit/rebuild call.
- `cloud/server/lib/llm-cost.js` — Anthropic pricing table for Haiku 4.5 / Sonnet 4.6 / Opus 4.7.
- `cloud/server/lib/llm-usage-recorder.js` — walks provenance objects from audit/rebuild output and persists token-usage rows.
- Settings page at `/settings` (`cloud/public/settings.html`, `cloud/public/settings.js`): provider picker, key input, last-4-digit redacted display, save / test / delete, rolling 30-day cost widget.
- Migration 0009: `workspace_llm_config` table (`user_id`, `provider`, `model`, `encrypted_api_key`, `key_last4`).
- Migration 0010: `workspace_llm_usage` table (`user_id`, `date`, `input_tokens`, `output_tokens`, `estimated_cost_usd`).
- New env var: `DATA_ENCRYPTION_KEY` (required in hosted mode; 32+ byte hex).

**Parallel browser upload (Phase 8b)**
- Browser uploader runs N concurrent uploads (configurable; default 4) with sequential fallback.
- Per-file progress bars; completion order preserved in the batch rollup.
- 413 `batch_count_exceeded` message reflects the current `PRISM_MAX_BATCH_COUNT` value, not a baked-in constant.

**Cloud LLM coverage follow-up**
- `cloud/server/routes/reports.js` `report.md` endpoint now forwards `LLM_PROVIDER` / `LLM_KEY_FROM_ENV` / `LLM_MODEL` environment vars, closing a Wave 1 gap where `report.html` had the v3.1 narrative but `report.md` did not.

## [5.1.0] - 2026-05-08

### Added

**v3.1 — Audit Narrative**
- New `src/lib/audit-narrative.js` generates three LLM-drafted prose sections (executive narrative, per-criterion remediation guides, recommended remediation order) from the audit scorecard. Output shape: `AuditNarrative` JSON, schema 1.0.0.
- Library audits (`audit-library`) get a `generateLibrarySynthesis()` call that produces a cross-package synthesis block at the top of both rollup renderers.
- `src/reporter/html.js`, `src/reporter/markdown-v3.js`, and `src/lib/library-rollup.js` render the new "Section 01a — Engagement Narrative" slot with a brand-matched provenance pill (`AI-DRAFTED · <model> · <timestamp> · review before sharing`).
- `src/reporter/index.js` (`writeReports`) accepts and forwards the `narrative` field to renderers.
- `src/index.js` calls `generateNarrative()` after audit, before `writeReports`. Gated on `options.llmProvider` and `options.llmNarrative !== false`.
- New CLI flags on `audit` and `audit-library`: `--llm-model <id>`, `--no-llm-narrative`, `--llm-narrative-token-budget <n>` (default 30000), `--llm-narrative-criterion-cap <n>` (default 12). Default model alias: `claude-haiku-4-5`.
- `results.json` carries an `auditNarrative` object when narrative ran; field absent otherwise. Reports without narrative remain byte-identical to v3 output.

**v4.1 — Assisted-Tier Rebuild**
- New runtime dependency: `@anthropic-ai/sdk`.
- New `src/lib/llm-provider.js` — provider abstraction. `getProvider('anthropic', apiKey, opts)` returns `{ name, model, generate(opts) }`. OpenAI/Azure-OpenAI stubs reserved for v4.2.
- `src/lib/llm-provenance.js` replaces `stubAssistedSuggestion()` with a real `generateAssistedSuggestion()`; adds `hashPrompt` and `buildProviderFromOptions` helpers. Deprecated stub alias kept for one release.
- Three new assisted-tier fixers: `src/fixers/generate-alt-text.js` (1.1.1), `src/fixers/rewrite-link-text.js` (2.4.4), `src/fixers/generate-form-label.js` (3.3.2). Each defers cleanly when LLM is off. Every assisted patch carries `tier: 'assisted'`, `confidence: 'needs-review'`, and full LLM provenance (`source`, `model`, `promptHash`, `usage`, `latencyMs`).
- New check `src/checks/2-4-4-link-purpose.js` (vague link text; no check existed before v4.1).
- `src/rebuild/index.js`: `loadFixers` now accepts a `tiers[]` array; early-exit assisted stub removed; provider threaded into fixer context via `packageContext.provider`.
- `src/lib/rebuild-cli.js`: early-exit assisted stub removed; `--llm-provider` and `--llm-key-from-env` forwarded.
- New CLI flags on `rebuild` and `rebuild-library`: `--llm-provider`, `--llm-key-from-env`, `--llm-model` (already existed on `audit`), `--llm-token-budget <n>` (default 50000). Manifest schema stays 1.0.0.

**v5.1 — Transformer Judgment**
- New `src/lib/transformer-judgment.js` — exports `classifyWidget` (strict-JSON-output LLM widget classification) and `parseAndValidateVerdict`. Returns `{ ok, verdict, confidence, rationale, provenance }` per candidate.
- All four widget-replacement transformers (`src/transformers/widget-replacement-{tabs,accordion,carousel,dialog}.js`) call `classifyWidget` per heuristic candidate when `packageContext.provider` is set. Candidates the LLM rejects (`verdict: 'no-match'`) are skipped; a deferred entry records the reason.
- `src/rebuild/types.js` and `src/rebuild/manifest.js` extended: Transform record gains optional `judgment` field. Manifest schema stays 2.0.0; v5.0 readers ignore the unknown field.
- `src/reporter/rebuild-preview.js` renders `AI-CONFIRMED`/`AI-UNCERTAIN` pill (with confidence %) and AI rationale row beneath each transform card. Deferred-list section shows LLM-rejected candidates so consultants can re-run with `--no-llm-judgment` if the rejection looks wrong.
- `src/rebuild/index.js` now (a) copies the optional `judgment` field through `transformRecord` and (b) propagates `result.deferred` from transformers (both were v5 leaks fixed as a side effect of this workstream).
- New CLI flags on `rebuild` and `rebuild-library`: `--no-llm-judgment` (default on when `--llm-provider` set), `--llm-judgment-token-budget <n>` (default 20000), `--llm-judgment-confidence-threshold <0..1>` (default 0.7).

**Cloud (Prism.skill-loop.com)**
- `cloud/server/routes/audits.js` forwards `LLM_PROVIDER` / `LLM_KEY_FROM_ENV` / `LLM_MODEL` from the server's environment into `writeReports`, activating v3.1 engagement narratives server-wide when those vars are set.
- `cloud/server/routes/batches.js` `MAX_BATCH_COUNT` is now env-configurable via `PRISM_MAX_BATCH_COUNT`; default raised from 50 to 200.
- `cloud/ROADMAP.md` adds Phase 12.5 (per-workspace BYO LLM keys, ~4 days), Phase 8b (parallel upload, ~1 day), and a measured Capacity baseline for the CX31 (audit ~1–20 s/pkg; full rebuild ~8–75 s/pkg; v3.1 narrative ~$0.054/pkg at Haiku 4.5 defaults).

## [5.0.0] - 2026-05-08

### Added
- **Full-tier rebuild.** Third and final rebuild tier. Coordinated, package-scoped rewrites via Transformers (separate interface from Fixers) that span multiple files and can edit `imsmanifest.xml`. Three transform families ship: landmark insertion + labeling, widget replacement (tabs / accordion / carousel / dialog), and page splitting. Run with `prism rebuild --mode full`.
- **Vetted ARIA component library** at `src/widgets/`. Five widgets — tabs, accordion, carousel, dialog, tooltip — as vanilla HTML/CSS/JS fragments matching W3C ARIA Authoring Practices Guide patterns. Each ships with a print-clean stylesheet, idempotent IIFE-scoped script, and an axe-baseline.json proving zero violations.
- **Checkpoint lifecycle.** Full-tier rebuilds stage outputs under `.rebuild-staging/` rather than overwriting. Promotion requires explicit operator approval via `prism rebuild-checkpoint approve`. New `rebuild-preview.html` renders side-by-side per-transform with a real approval form. New CLI commands: `rebuild-checkpoint approve|reject|list`. `--no-checkpoint` flag bypasses staging for CI scenarios; default is checkpoint-on.
- **Atomic transform undo.** `prism rebuild-undo --transform <id>` reverts every patch in a transform together via the transformer's `revert()`. Mixed `--patch <id> --transform <id>` invocations are also supported. Undoing a single patch that belongs to a transform without including the transform is refused with a clear error.
- **Manifest schema 2.0.0.** Adds the `transforms[]` block; each Patch gains an optional `transformId` that links it to its parent transform. v4 manifests (1.0.0) load unchanged; manifests with no transforms still emit as 1.0.0 byte-identical to v4.
- **Promotion-time invariants.** Checkpoint promote re-runs `verify()`, validates rewritten `imsmanifest.xml` against the SCORM schema for any approved transform with `manifestEdited:true`, and walks the new `<organization>` to confirm SCO sequence integrity. Failure of any invariant rolls back the promotion atomically; the staging area is preserved.

### Changed
- `src/rebuild/index.js` — orchestrator now dispatches full-tier transformers after fixers, validates per-transform output, and handles the staging branch when full mode is active.
- `src/rebuild/undo.js` — accepts both the legacy positional patch-ids form and the new `{ patches, transforms }` shape. v4 callers continue to work.
- `src/reporter/rebuild-summary.js` — adds a transform stats section when transforms are present; back-compat byte-identical for manifests with no transforms.

## [Unreleased - 4.x]

### Changed
- **Renamed**: project renamed from Open Pathways to Prism. Internal-only rename; no functional changes. Package names: `prism` (root), `prism-web`, `prism-cloud`. CLI binary: `prism` (was `open-pathways`); re-run `npm link` from the project folder to refresh the global shorthand.
- The JSON `tool` field and SARIF `tool.driver.name` now report `"prism"` (was `"open-pathways"`). Any downstream tooling parsing stored reports keyed on the old value will need updating.
- Default v2-mode output directory renamed from `./open-pathways-report/` to `./prism-report/`. Engagement-mode output paths under `./engagements/<id>/<package>/` are unchanged.
- Hosted-mode env vars renamed from `OPEN_PATHWAYS_*` to `PRISM_*` (e.g. `PRISM_MODE`, `PRISM_PORT`, `PRISM_RETENTION_DAYS`, `PRISM_BEHIND_TLS`, `PRISM_HOST`). Existing deployments must update their env or compose files before redeploy.
- Documentation now refers to "accessibility" instead of "a11y" throughout.

## [3.0.1] - 2026-05-05

### Added
- `audit-library` library-rollup HTML/Markdown polish: triage distribution percentages, total scope hours, recommended engagement shape, top-three risks aggregated across the library.
- Cloud UI surface (multi-tenant hosted version) shipped under `cloud/`. Magic-link auth, S3-compatible storage, pg-boss worker queue, helmet + rate-limit hardening, Coolify deploy via `cloud/Dockerfile` + root `docker-compose.yaml`. See `cloud/DEPLOY.md`.

### Fixed
- Accessibility polish in the brand-matched HTML report.
- `audit-library` edge cases in the per-package iteration and rollup aggregation.

## [3.0.0] - 2026-05-05

### Added
- **Skill Loop scoping deliverable.** Brand-matched HTML report (primary), Markdown (alternative for editing), JSON (byproduct) for every audit. Cover with engagement metadata, executive summary, triage breakdown, scope recommendation, top risks, findings by severity, Section 508 mapping table.
- **Engagement isolation.** `--engagement <id>` namespaces output under `engagements/<id>/<package>/`. Prevents cross-client data co-mingling.
- **Library mode.** New `audit-library <directory>` subcommand audits every `.zip` in a directory and emits a single library-level rollup at `engagements/<id>/_library-rollup.{html,md}`.
- **Triage taxonomy.** Every finding tagged `auto-fix safe`, `auto-fix assisted`, `author rework`, `content rework`, or `recommend retire`.
- **Scope estimates.** Per-finding consultant-hour estimates from `config/effort-calibration.json`, rolled up at package and library level.
- **Section 508 mapping.** Every WCAG criterion mapped to the corresponding Section 508 paragraph.
- **Brand config.** `config/brand.json` (flat key/value, maps onto CSS custom properties); `--brand-config <path>` override per engagement.
- **LLM provenance** (opt-in). `--llm-provider` + `--llm-key-from-env` to enable; provider/model/timestamp logged in JSON output. Off by default.
- **`--engagement-redact`** flag to replace client name with engagement ID in the report (for confidential drafts circulating internally).

### Changed
- **Default standard flipped from WCAG 2.2 to WCAG 2.1 AA + Section 508**, aligned with Cornerstone's published baseline for regulated clients. WCAG 2.2 remains opt-in via `--standard wcag22`.
- **CLI restructured** into two subcommands: `audit <package>` and `audit-library <directory>`. Backward-compat: `audit` without `--engagement` still writes to `./open-pathways-report/` (v2 behavior) with a deprecation note.
- **Dynamic checks are now mandatory.** `--simulate` flag removed. Playwright + chromium are required deps; the audit auto-installs chromium on first run. If even auto-install can't recover, the report is stamped INCOMPLETE and the process exits 2.
- **HTML report** is the primary deliverable; JSON scorecard demoted to byproduct.

### Removed
- `--simulate` flag (dynamic checks are no longer optional).

## [2.0.0] - 2026-04-30

### Added
- Screen reader simulation via `--simulate` flag (Playwright-based; chromium-only for now). Adds 3 dynamic WCAG checks: 2.4.3 Focus Order, 3.2.4 Consistent Identification, 4.1.3 Status Messages.
- Auto-fix mode via `--fix` and `--fix-dry-run` flags. Six mechanical fixers: alt="" on decorative imgs, tabindex=0 on keyboard-handler divs, lang on `<html>`, default `<title>`, autocomplete on password inputs, repair `user-scalable=no`. Outputs `<package>.scorm-fixed.zip` plus a fixes log.
- New `--browser`, `--timeout-dynamic` flags for tuning the dynamic-check runner.
- Scorecard JSON now exposes `dynamicChecksRun`, `dynamicCheckSkipReason`, `fixesApplied`, and per-criterion `evaluationMode` + `evaluated`.
- xAPI / Tin Can package support (parser, detection, fixture).

### Changed
- **Renamed**: project renamed to Open Pathways (npm name `open-pathways`, was `scorm-a11y-check`).
- The JSON `tool` field and SARIF `tool.driver.name` now report `"open-pathways"` (was `"scorm-a11y-check"`). Downstream consumers (e.g. GitHub Code Scanning rules) may need updating.
- Manual review checklist shrunk from 6 → 3 criteria. 2.4.3, 3.2.4, 4.1.3 promoted to dynamic-check coverage when `--simulate` is enabled.
- `playwright` is now `optionalDependencies`; without it `--simulate` reports `dynamicCheckSkipReason` and continues with static analysis.
- Score denominator now excludes "not evaluated" criteria so users aren't rewarded for skipping `--simulate`.

### Fixed
- Replaced the broken `axe-core` contrast pipeline (jsdom + Canvas dependency) with static CSS analysis using `@asamuzakjp/css-color`.

## [1.1.0] - 2026-03-15

### Added
- Severity tagging: classify each violation as `critical`, `serious`, `moderate`, or `minor` using axe-core's impact taxonomy.
- Baseline diffing via `--baseline results.json` flag to diff against prior scans and report only new violations.
- Threshold flag `--max-violations <n>` to set custom pass/fail thresholds.
- SARIF output format via `--format sarif` for GitHub Code Scanning and other security dashboards.
- Per-SCO violation grouping when SCORM package has multiple Sharable Content Objects.

## [1.0.0] - 2026-02-15

### Added
- Initial release. CLI tool that audits SCORM 1.2, SCORM 2004, and AICC packages for WCAG 2.2 AA compliance.
- 20 automated static checks covering WCAG 2.2 Level A and AA criteria.
- 6-item manual-review checklist for criteria requiring human judgment (2.4.3, 3.2.4, 3.3.7, 4.1.3, 1.2.3, 1.2.5).
- JSON scorecard (`results.json`) with per-criterion pass/fail, violation count, and detailed findings.
- Markdown report (`report.md`) with human-readable explanations and WCAG 2.2 links.
- Package parsing for SCORM 1.2, SCORM 2004, and AICC (profiles 1–2).
- CLI options: `--output`, `--json`, `--format md|txt`, `--package-type`, `--standard wcag21|wcag22`.
- Exit codes: 0 (no violations), 1 (violations found), 2 (tool error).
