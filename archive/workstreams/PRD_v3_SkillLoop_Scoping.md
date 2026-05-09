# PRD v3: Skill Loop Internal Scoping & Remediation

**Status:** Draft
**Date:** 2026-05-05
**Author:** Dave Nguyen
**Built by:** Claude (autonomous)
**Supersedes:** [PRD v2.0](../archive/phase-docs/PRD_SCORM_WCAG22.md) (2026-04-30). The v1/v2 audit engine, dynamic checks, and mechanical auto-fix all remain in scope. v3 reframes the deliverable, defaults, and primary user without rebuilding the engine underneath.

---

## Problem statement

Skill Loop is a Cornerstone OnDemand consulting practice on a monthly retainer for regulated clients (government, healthcare, education, financial services). New engagements begin with a kickoff call followed by a written assessment delivered within five business days. Each kickoff includes auditing the client's existing SCORM library — typically 50 to 300 packages of mixed vintage, vendor authorship, and accessibility quality — to scope the remediation work and feed the broader engagement assessment. Today this audit costs two to three days of senior-consultant time and produces a JSON file plus a generic Markdown report that doesn't match the firm's deliverable format. Prism v2 catches the violations correctly; the gap is that the output isn't shaped for the actual workflow.

v3 reshapes the tool around the senior consultant: a brand-matched assessment-ready deliverable, a defensible scope estimate, multi-engagement isolation, and defaults that match the firm's published compliance posture (WCAG 2.1 AA + Section 508). The engine and the dynamic checks shipped in v2 are reused; the report layer and the CLI surface are what changes.

---

## Goals

1. **Compress library scoping from 2–3 senior-consultant days to under 2 hours** per kickoff engagement.
2. **Produce an assessment-ready deliverable** (brand-matched HTML and Markdown) on every audit, paste-in compatible with the broader engagement assessment template.
3. **Generate defensible scope estimates** in consultant hours, rolled up at package and library level, broken down by triage category.
4. **Support multi-engagement workflows** with strict per-client output isolation and no risk of cross-client data co-mingling.
5. **Default to the firm's published compliance posture**: WCAG 2.1 AA and Section 508, with WCAG 2.2 as an opt-in upgrade for forward-looking work.
6. **Stay local-first**: no telemetry, no third-party AI calls without explicit per-engagement opt-in, no outbound traffic except the existing one-time Playwright install.

---

## Non-goals

1. **No npm publishing.** Tool runs locally from source per the existing distribution model. No public adoption metrics, no telemetry, no public documentation.
2. **No external SaaS, web UI, watched-folder service, or hosted dashboard.** All v3 work is CLI. Future productization paths remain explicitly out of scope.
3. **No customer-facing self-service.** The tool is for skill-loop senior consultants; clients never run it directly.
4. **No multi-language audit.** English-only. Localization is a separate workstream if/when it appears.
5. **No replacement for the broader engagement assessment.** Prism generates the accessibility section that drops *into* that document; the document itself remains a consultant deliverable.
6. **No format conversion in v3.** Modernization to cmi5/xAPI for Galaxy is Phase 5, after v3 ships and is in use.
7. **No WBT (web-based training) export.** Removed from the roadmap; Galaxy is the deployment target.

---

## User stories

### Senior Cornerstone consultant — kickoff scoping (primary)

- As a senior consultant, I want to point Prism at a directory of legacy SCORM packages from a new client and receive a brand-matched HTML assessment within minutes, so that I can deliver the kickoff assessment inside the firm's five-business-day SLA without sacrificing a full day of audit time.
- As a senior consultant, I want every finding tagged with a triage category and a defensible effort estimate, so that I can scope the engagement in hours and propose a monthly retainer shape grounded in real numbers rather than guesswork.
- As a senior consultant, I want the report to auto-extract the top three risks in language fit for a regulated-client conversation, so that I can paste them directly into the engagement assessment's "top three risks" section.

### Senior consultant — mid-engagement remediation pass

- As a consultant on an active engagement, I want the report to clearly distinguish auto-fix safe items from items requiring author judgment, so that I can run the safe-tier fixes without pulling content authors into every minor change.
- As a consultant working multiple engagements, I want each engagement's audits, fixes, and reports to live in a clearly namespaced directory with no risk of cross-engagement data exposure, so that I can confidently run audits for government client A and healthcare client B in the same week.

### Senior consultant — Saba/SumTotal-to-Galaxy migration handoff

- As a consultant scoping a migration, I want a library-level rollup that shows the distribution across triage categories and total estimated hours, so that the migration team can sequence which courses move first and which courses are better off retired and rebuilt in Galaxy.

---

## Requirements

### Must-have — P0

#### Assessment generator (primary deliverable)

- HTML report is the primary output, matching the visual contract in [`mockups/assessment-mock-v1.html`](../mockups/assessment-mock-v1.html). Brand system: skill-loop paper / ink / accent teal / CTA orange / Archivo Black + Space Grotesk + Inter + JetBrains Mono.
- Markdown report is generated alongside HTML for consultants who edit in Word before final PDF.
- Report sections, in order: cover and engagement metadata, executive summary, library health rollup, scope recommendation, top-three-risks cards, findings by severity, per-package detail (appendix), Section 508 mapping, method and scope note.
- Brand assets (logo mark, palette, fonts) loaded from a config file at `config/brand.json`. Defaults ship with the tool. Per-engagement overrides supported.
- JSON scorecard remains available as a byproduct for tooling and diff workflows. The deliverable is the HTML/Markdown report; JSON is not the headline output anymore.

#### Triage taxonomy

Every finding receives one of five triage tags:

| Tag | Meaning | Default effort range |
|---|---|---|
| `auto-fix safe` | Deterministic patch applied by the tool; consultant reviews the diff before deployment | 2–10 min |
| `auto-fix assisted` | Tool generates a candidate (alt text, label, etc.); consultant or author confirms | 5–20 min |
| `author rework` | Change requires authoring-tool access or judgment a tool shouldn't make alone | 30–90 min |
| `content rework` | Net-new content required (captions, transcripts, partial re-record) | 2–8 hours |
| `recommend retire` | Remediation cost exceeds rebuild-in-Galaxy cost; flagged for the migration plan | n/a |

axe-core's severity taxonomy (`critical|serious|moderate|minor`) is retained internally for the JSON scorecard but is mapped onto the consultant-facing severity (Critical / Serious / Moderate / Minor) used in the report. Severity answers "how bad is it"; triage answers "what action is needed." Both ride along on every finding.

#### Scope estimate

- Each finding emits an estimated effort in minutes, derived from its triage tag and category-level calibration.
- Effort rolls up at package level (per-package total) and library level (sum across packages in batch mode).
- Library-level breakdown by category: Auto-fix tier, Author rework, Content rework, QA re-audit, Migration handoff.
- Calibration values live in `config/effort-calibration.json` and are overridable per engagement.

#### Section 508 mapping

- Every finding includes a `section508` field in the JSON output, mapped from its WCAG criterion.
- HTML and Markdown reports include a Section 508 mapping table with finding counts per reference.
- Minimum coverage: 501.1 (Operable without specialized input), 501.5 (Captions for synchronized media), 502 (Interoperability with assistive tech), 503 (Applications). Other 508 references covered as applicable.

#### WCAG 2.1 AA default

- `--standard` flag default flips from `wcag22` to `wcag21`. Existing flag wiring is reused.
- `--standard wcag22` continues to produce a 2.2-scoped report.
- README, CLI help text, and example commands updated to reflect 2.1 as the firm baseline.

#### Engagement namespacing

- New required flag for v3 deliverable commands: `--engagement <id>` (e.g., `SL-2026-0418`).
- All output (report, JSON, fixes, audit logs, screenshots) written to `./engagements/<id>/<package-name>/`.
- Library-level rollup output: `./engagements/<id>/_library-rollup.html` and `_library-rollup.md`.
- No two engagements share an output directory. Verified by an integration test that runs two audits with different engagement IDs and asserts directory isolation.
- `--engagement-redact` option: replaces client name with engagement ID throughout the deliverable, for cases where the draft circulates internally before client review.

#### Top-three-risks extraction

- After audit completes, the report auto-promotes the three highest-impact Critical findings to a "Top three risks" section.
- Format and layout match the broader engagement assessment's existing top-three-risks section, paste-in compatible.
- Each risk card includes the 508 reference, the WCAG criterion, the affected package count, and a one-sentence regulated-learner framing.
- If fewer than three Critical findings exist, the section degrades gracefully ("No critical-tier findings; top serious-tier risks are…") rather than padding.

#### Library rollup (batch mode)

- New command: `prism audit-library <directory> --engagement <id>`.
- Iterates the directory, audits each `.zip`, produces per-package reports and a single library-level rollup report.
- Library report includes: package count, distribution across triage tags (counts and percentages), total scope-estimate hours, recommended engagement shape (sentence-only — "three-month engagement, ~22 hours/month"; no pricing), top three risks aggregated across the library.

#### Local-first stance (formalized)

- No outbound network calls during audit, except the existing one-time `npx playwright install chromium` documented in v2.
- LLM-assisted findings (assisted alt text, label inference) only run when both `--llm-provider <provider>` and `--llm-key-from-env <env-var>` are set explicitly. Off by default.
- Each assisted finding records provenance in the JSON: `{provider, model, engagementId, timestamp}`.
- A network-traffic CI check fails the build if any unexpected outbound connection occurs during a representative audit run.

### Nice-to-have — P1

- **Cornerstone fix guidance**: when an engagement config provides a path to the firm's CSOD wiki, findings link to the relevant runbook or wiki entry for the fix.
- **Confidence scoring on assisted fixes**: numeric 0–1 confidence on each LLM-generated candidate; below a configurable threshold (default 0.85) the candidate goes to the consultant review queue rather than auto-applying.
- **Engagement diff mode**: `--diff-against <prior-engagement-id>` reports only findings new since the prior audit, for tracking remediation progress mid-engagement.
- **DOCX export** alongside HTML/Markdown for consultants whose downstream workflow is Word-only.
- **Per-engagement effort calibration**: override the default calibration table for clients with known content-effort multipliers (e.g., heavy custom JS interactions take longer to remediate).

### Future — P2 (separate phases, explicitly stubbed)

#### Phase 4 (v3.1+) — Migration workflow

Saba/SumTotal-to-Galaxy migration content gate. The tool ingests the client's legacy library, audits, applies safe-tier fixes, and produces a migration-ready bundle of remediated packages.

- **Manifest identifier preservation contract**: when fixes-and-repackaging, original `identifier`, `version`, and resource hrefs are preserved unless explicitly overridden via `--allow-identifier-change`. This prevents orphaning learner records and assignments in the client's Cornerstone instance.
- **Pre/post migration verification**: re-audit the modernized package, confirm parity with the original (minus fixed violations).
- **Phase 4 explicit non-goals**: format conversion (Phase 5), customer-side LMS upload (consultant performs this manually inside the client's Cornerstone admin UI), automated learner-record migration.

#### Phase 5 (v4.0) — xAPI/cmi5 modernization for Galaxy

Modernize remediated SCORM packages to cmi5 targeting Cornerstone Galaxy's LRS. Requires Phase 4 complete.

- **cmi5 export** with Galaxy-aware capability detection.
- **Accessibility telemetry over xAPI**: emit verbs for caption-toggle, font-scale, keyboard-only navigation detected, screen reader inferred. Unique angle — "did our accessibility investments matter?" becomes measurable.
- **Galaxy LRS capability cache**: track which xAPI features each Galaxy release supports, since Galaxy is on a continuous release cadence.
- **Phase 5 explicit non-goals**: WBT export (removed from roadmap), web dashboard, anything implying external SaaS, conversion of SCORM 2004 sequencing graphs (cmi5 has no equivalent — surface as "non-trivial sequencing detected, manual decision required" rather than silent translation).

---

## Success metrics

### Leading indicators (within 30 days of v3.0 ship)

- **Library scoping time**: under 2 hours per kickoff engagement, end-to-end (from package handoff to assessment-ready report). Baseline: 2–3 senior-consultant days.
- **v3 adoption**: 100% of new-client kickoffs use Prism v3 by the end of Q3 2026.
- **Cross-engagement isolation**: zero instances of one engagement's content appearing in another engagement's output, verified by namespacing audit on every release.

### Lagging indicators (within 90 days)

- **Scope-estimate accuracy**: actual remediation hours within ±20% of estimated hours, measured across the first 5+ completed engagements where the tool's estimate was used to scope the contract.
- **Senior-consultant time-on-tool**: under 30 minutes of consultant attention per audit. Most consultant time goes to reviewing assisted fixes, not running the tool itself.
- **Repeat work-in-engagement**: clients whose initial library was audited via Prism return for a second remediation pass within the same retainer at higher rates than baseline.

---

## Open questions

| Question | Default decision (revisit if data shows otherwise) |
|---|---|
| Confidence threshold for auto-fix-assisted review queue | 0.85 — below threshold goes to consultant review, above threshold may auto-apply with provenance recorded |
| DOCX export priority | Defer to P1; HTML+Markdown sufficient for v3.0 |
| Default LLM provider for assisted fixes | None — every engagement explicitly configures provider and key. No firm-wide default until at least three engagements have opted in and we have signal on which provider fits best |
| Top-three-risks ranking algorithm | Severity (Critical only) → 508 reference category urgency → number of packages affected |
| Manifest identifier preservation default | On — require `--allow-identifier-change` to override |
| Brand asset distribution | Ship defaults with the repo; per-engagement overrides via `config/brand.json` for white-label or co-branded deliverables |

---

## Timeline considerations

- **No hard deadline.** Recommended phasing:
  - **v3.0** — assessment generator + brand templates + Section 508 mapping + WCAG 2.1 default + triage taxonomy + `--engagement` flag + top-three-risks extraction. Target: 3 weeks from PRD approval.
  - **v3.1** — library rollup + batch mode + scope-estimate calibration tables + Cornerstone wiki linking. Target: 2 weeks after v3.0 ships and the first one or two real engagements have used it.
  - **v3.2 / Phase 4** — migration workflow (identifier preservation, re-audit verification). Target: informed by Q3 engagement load; only if migration volume justifies it before Phase 5.
  - **v4.0 / Phase 5** — cmi5/xAPI modernization for Galaxy. Target: after Phase 4 has been used on at least two real migrations.

- **Highest-risk item in v3.0**: the brand-matched HTML report. Visual fidelity to the mockup is part of the contract; getting CSS print behavior right for PDF export is fiddly. If it slips, ship v3.0 with HTML + Markdown only and defer pixel-perfect print styling to v3.1.

---

## Acceptance criteria

### Assessment generator

- [ ] `prism audit <package.zip> --engagement <id>` produces an HTML report at `./engagements/<id>/<package-name>/report.html` matching the visual contract in `mockups/assessment-mock-v1.html`.
- [ ] The HTML report includes: cover with engagement metadata, executive summary with the four-stat block, library rollup (single-package mode shows package-only stats), scope recommendation card, top-three-risks (or graceful fallback), findings by severity, per-package detail, 508 mapping table, method and scope note.
- [ ] Markdown alternative output is generated alongside HTML at `./engagements/<id>/<package-name>/report.md` with the same content structure.
- [ ] Brand assets load from `config/brand.json`; per-engagement override via `--brand-config <path>`.

### Triage and scope estimate

- [ ] Every finding in the report includes a triage tag from the 5-tag taxonomy.
- [ ] Every finding includes an estimated effort (minutes); effort sums correctly at package and library level.
- [ ] Library-level rollup at `./engagements/<id>/_library-rollup.html` shows the triage distribution and total scope-estimate hours when run in batch mode.

### Section 508 mapping

- [ ] Every finding includes a `section508` field in JSON output, mapped from its WCAG criterion.
- [ ] HTML and Markdown reports include a 508 mapping table with finding counts per reference.
- [ ] Minimum mapped references covered: 501.1, 501.5, 502, 503.

### Default flip

- [ ] Running without `--standard` defaults to WCAG 2.1 AA.
- [ ] `--standard wcag22` produces a report scoped to 2.2 criteria (existing v2 behavior, just opted-in instead of default).
- [ ] README, CLI help text, and example commands reflect 2.1 as the firm baseline.

### Engagement namespacing

- [ ] `--engagement <id>` is required for any v3 command producing deliverables.
- [ ] Audit outputs land in `./engagements/<id>/...` and nowhere else.
- [ ] Integration test: running two audits with different engagement IDs produces no shared files and no cross-references between output directories.
- [ ] `--engagement-redact` produces a report with client name replaced by engagement ID throughout.

### Top-three-risks

- [ ] Critical-tier findings are ranked and the top three are promoted to a dedicated section.
- [ ] If fewer than three Critical findings exist, the section degrades gracefully and pulls from Serious tier with appropriate framing.
- [ ] Each risk card includes 508 reference, WCAG criterion, package count, and regulated-learner framing.

### Local-first

- [ ] Tool produces no outbound network traffic during audit, verified by network capture in CI on a representative fixture.
- [ ] LLM-assisted findings only run when `--llm-provider` and `--llm-key-from-env` are both set.
- [ ] Every assisted finding records provenance (provider, model, engagement ID, timestamp) in JSON output.

### Visual contract

- [ ] HTML report renders correctly in Chrome and Safari on macOS.
- [ ] HTML report prints to PDF with section breaks respecting the `break-inside: avoid` rules in the mockup.
- [ ] Color contrast inside the report itself passes WCAG 2.1 AA on every text element. (The accessibility tool's own deliverable must pass its own audit.)

---

*End of PRD v3 draft — supersedes v2.0 dated 2026-04-30. v1/v2 acceptance criteria remain valid for the audit engine; v3 is a layer on top.*
