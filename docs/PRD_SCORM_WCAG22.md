# PRD: SCORM / AICC WCAG 2.2 AA Accessibility Reviewer

**Status:** Draft  
**Date:** 2026-04-30  
**Author:** Dave Nguyen  
**Built by:** Claude (autonomous)

---

## Problem statement

Instructional designers and L&D teams publish SCORM 1.2, SCORM 2004, and AICC packages without a reliable way to verify WCAG 2.2 AA compliance before delivery. No dedicated tool exists for auditing these package formats — existing general-purpose auditors (axe-core, WAVE, Pa11y) require manual extraction of the ZIP archive and provide no understanding of SCORM/AICC manifest structure, media tracks, or e-learning interaction patterns. As a result, organizations routinely ship inaccessible courseware that exposes them to legal risk (ADA, Section 508, EN 301 549, European Accessibility Act) and fails learners who rely on assistive technology. WCAG 2.2, published as a W3C Recommendation in October 2023 and ISO/IEC standard in 2025, is the current regulatory target under the EAA and the de facto standard for new accessibility audits globally.

---

## Goals

1. **Reduce time-to-audit to under 60 seconds** for a standard SCORM package via a single CLI command — no manual extraction or environment setup required.
2. **Surface at least 80% of automatically detectable WCAG 2.2 AA violations** within a package, covering the 20 highest-impact criteria identified for e-learning content.
3. **Produce a structured, actionable report** (JSON scorecard + human-readable full report) that an instructional designer or developer can act on without accessibility expertise.
4. **Establish a repeatable baseline** so teams can track accessibility improvement across package revisions over time (via exit code + JSON diff).
5. **Integrate cleanly into existing CI/CD pipelines** via a zero-dependency CLI with a predictable exit code (0 = pass, 1 = violations found).

---

## Non-goals

1. **No auto-fixing of violations.** The tool flags and explains issues; remediation is the author's responsibility. Auto-fixing HTML inside a compiled SCORM package risks breaking runtime behavior and is deferred to a future version.
2. **No xAPI / Tin Can or cmi5 support (v1).** xAPI packages and cmi5 (the modern xAPI profile) have different manifests and launch structures. The scope is SCORM 1.2, SCORM 2004, and AICC only. *(addressed in v2.0)*
3. **No manual-review items in the automated report.** Criteria that cannot be evaluated without human judgment (1.2.5 audio description accuracy, 2.4.3 focus order semantics, 3.2.4 consistent identification, 4.1.3 status messages, 3.3.7 redundant entry) will be flagged as "requires manual review" in a separate checklist section — they will not generate pass/fail scores.
4. **No LMS integration (v1).** The tool operates on the package file directly; it does not connect to an LMS, pull content remotely, or track results across deployments.

---

## User stories

### Instructional designer / course author

- As an instructional designer, I want to run a single command against a `.zip` file and receive a plain-English report of accessibility violations so that I can fix issues before submitting the course to my LMS.
- As a course author, I want the report to tell me exactly which file and line number contains each violation so that I don't have to hunt through extracted package files manually.
- As an instructional designer with no accessibility expertise, I want each violation to include a plain-English explanation and a link to the relevant WCAG criterion so that I understand what the issue means and why it matters.

### Developer / QA engineer

- As a developer, I want the tool to return a non-zero exit code when violations are found so that I can fail a CI build automatically without writing custom wrapper logic.
- As a QA engineer, I want a machine-readable JSON scorecard output so that I can diff results between package versions and measure accessibility regression or improvement over a sprint.
- As a developer, I want to run the tool via `npx` with no global install required so that I can use it in any project without managing dependencies.

### L&D manager / compliance officer

- As an L&D manager, I want a summary scorecard (overall score, pass/fail per WCAG criterion, total violation count) so that I can assess a course's compliance posture at a glance.
- As a compliance officer, I want the report to clearly identify which issues are auto-detected vs. which require manual review so that I can build an accurate audit process that addresses both categories.
- As an L&D manager evaluating a vendor-supplied course, I want to run the tool on a package I didn't author so that I can verify it meets our organization's accessibility standards before publishing.

---

## Requirements

### Must-have — P0

These are the minimum requirements for v1 to be viable.

**Package parsing**
- Accept a `.zip` file as input and correctly identify SCORM 1.2 (`imsmanifest.xml`), SCORM 2004 (`imsmanifest.xml` with `schemaversion`), and AICC (`.crs` / `.au` / `.des` files) packages.
- Extract the package to a temporary directory, identify all HTML entry points from the manifest, and clean up temp files on exit.
- Return a clear error with a descriptive message if the input is not a valid SCORM or AICC package.

**Automated WCAG 2.2 checks (20 criteria — Level A and AA)**

The following criteria must be checked automatically against all HTML/JS/CSS files in the package. Both Level A and AA criteria are required for WCAG 2.2 AA conformance. Criteria marked *(2.1+)* were introduced in WCAG 2.1; those marked *(2.2+)* are new in WCAG 2.2. Note: WCAG 2.2 removed 4.1.1 Parsing as obsolete — it is not included.

| Criterion | Level | Check |
|-----------|-------|-------|
| 1.1.1 Non-text content | A | `<img>` without `alt`, `<area>` without `alt`, decorative images missing `role="presentation"` or `alt=""` |
| 1.2.1 Audio/Video-only (prerecorded) | A | `<audio>` or `<video>` elements without an accompanying transcript link |
| 1.2.2 Captions (prerecorded) | A | `<video>` without a `<track kind="captions">` child element |
| 1.3.4 Orientation | AA *(2.1+)* | CSS or JS that locks layout to a single orientation (`screen.orientation.lock()`, or `orientation` media query used to hide/disable content) |
| 1.3.5 Identify input purpose | AA *(2.1+)* | `<input>` fields collecting personal data (name, email, tel, address) that lack a valid `autocomplete` attribute from the WCAG input purposes list |
| 1.4.1 Use of color | A | Instructions that reference color as the sole means of conveying information (heuristic: text like "click the red button" without a non-color identifier) |
| 1.4.2 Audio control | A | `<audio autoplay>` or `<video autoplay muted="false">` playing for >3 seconds without a visible pause/stop/volume control in the DOM |
| 1.4.3 Contrast (minimum) | AA | Text/background color pairs below 4.5:1 (normal text) or 3:1 (large text ≥18pt or 14pt bold), where colors are statically determinable from CSS |
| 1.4.4 Resize text | AA | Viewport meta tags that block user scaling (`user-scalable=no` or `maximum-scale=1`) |
| 1.4.10 Reflow | AA *(2.1+)* | `overflow: hidden` or `overflow: scroll` on fixed-pixel-height containers likely to clip content at 320px width; viewport meta that prevents zooming |
| 1.4.11 Non-text contrast | AA *(2.1+)* | UI component boundaries (buttons, inputs, checkboxes) and informational graphics where the indicator color has < 3:1 contrast ratio against adjacent color, where statically determinable |
| 2.1.1 Keyboard | A | Interactive custom elements (`div`/`span` with `onclick`) lacking `tabindex` and keyboard event handlers (`onkeydown`/`onkeypress`/`onkeyup`) |
| 2.1.2 No keyboard trap | A | Modals/overlays with `role="dialog"` or common modal class names that lack a detectable close/escape handler |
| 2.4.7 Focus visible | AA | CSS rules that set `outline: none` or `outline: 0` without a detectable replacement focus style on the same or descendant selector |
| 2.4.11 Focus not obscured (minimum) | AA *(2.2+)* | Sticky/fixed-position elements (headers, footers, course nav bars) where a focused component could be entirely hidden — detected via `position: fixed` or `position: sticky` elements that overlap the interactive area |
| 2.5.7 Dragging movements | AA *(2.2+)* | Drag-based interactions (`dragstart`, `mousedown`+`mousemove` without a click/tap alternative, sortable lists, slider widgets) that have no single-pointer non-drag equivalent |
| 2.5.8 Target size (minimum) | AA *(2.2+)* | Interactive targets (buttons, links, quiz options) with computed CSS dimensions below 24×24 CSS pixels, unless spacing exception applies |
| 3.2.6 Consistent help | A *(2.2+)* | Help mechanisms (links, buttons, or elements with "help", "support", "contact" in label/text) that appear inconsistently across SCOs in the same package |
| 3.3.2 Labels or instructions | A | `<input>`, `<select>`, `<textarea>` without an associated `<label for>`, `aria-label`, or `aria-labelledby` |
| 3.3.8 Accessible authentication (minimum) | AA *(2.2+)* | Authentication flows (login forms, CAPTCHA, puzzle interactions) that require a cognitive function test without providing an object-recognition or personal-content alternative — detected via common CAPTCHA patterns and password fields lacking `autocomplete="current-password"` |
| 4.1.2 Name, role, value | A | Custom interactive elements (non-semantic tags with `onclick` or `tabindex`) missing `role`, `aria-label`, or `aria-labelledby` |

**Manual review checklist (not auto-scored)**

The following criteria cannot be reliably evaluated by static analysis alone. They will appear in a dedicated "Requires Manual Review" section of the report with plain-English guidance on how to test each:

- **1.2.3 Audio description or media alternative (prerecorded)** (A) — whether the audio description accurately describes the visual content of the video
- **1.2.5 Audio description (prerecorded)** (AA) — whether audio description tracks are present and adequate for all synchronized video
- **2.4.3 Focus order** (A) — whether tab order follows a logical reading sequence in dynamic and interactive content
- **3.2.4 Consistent identification** (AA) — whether components with the same function are labeled consistently across SCOs
- **3.3.7 Redundant entry** (A *(2.2+)*) — whether multi-step interactions (quizzes, forms) require re-entry of information already provided in the same session
- **4.1.3 Status messages** (AA) — whether dynamic status updates (quiz feedback, score display, progress indicators) are announced to screen readers via `aria-live` or `role="status"`

**Report outputs**
- Produce a **JSON scorecard** (`results.json`) containing: overall pass/fail, score (% criteria passed), per-criterion pass/fail, total violation count, and per-violation detail (file, line, criterion, severity, description).
- Produce a **human-readable full report** (plain text or Markdown, `report.md`) containing: summary scorecard, per-violation findings with plain-English explanations and WCAG 2.2 links, and a separate "manual review required" checklist for the 6 criteria not auto-checkable.
- Output the scorecard JSON to stdout when `--json` flag is passed, to support piping into other tools.

**CLI interface**
- Primary invocation: `npx open-pathways <path-to-package.zip> [options]`
- Options: `--output <dir>` (save report files), `--json` (stdout JSON only), `--format md|txt` (report format), `--package-type scorm12|scorm2004|aicc|auto` (default: auto-detect), `--standard wcag21|wcag22` (default: wcag22; filters report to criteria introduced up to that version).
- Exit code 0 when no violations found; exit code 1 when violations found; exit code 2 on tool error.
- Progress indicator (spinner or log lines) during analysis so users know the tool is running on large packages.

### Nice-to-have — P1

These significantly improve the experience but are not required for the first release.

- **Severity tagging**: classify each violation as `critical`, `serious`, `moderate`, or `minor` using axe-core's impact taxonomy, enabling teams to triage by severity.
- **Baseline file**: allow a `--baseline results.json` flag to diff against a prior scan and report only new violations, making it practical for iterative course revision workflows.
- **Threshold flag**: `--max-violations <n>` to set a custom pass/fail threshold (e.g., allow up to 5 minor violations before failing CI).
- **SARIF output**: `--format sarif` for compatibility with GitHub Code Scanning and other security/quality dashboards.
- **Per-SCO reporting**: when a SCORM package has multiple SCOs (Sharable Content Objects), report violations grouped by SCO so authors can identify which learning module is the source.

### Future considerations — P2

These are explicitly out of scope for v1 but should inform architecture decisions now.

- **xAPI / Tin Can support**: the package parser should be architected as a plugin system so xAPI manifest parsing can be added without rewriting the core audit engine.
- **Auto-fix mode**: automated remediation for mechanical issues (adding `alt=""` to decorative images, adding `tabindex="0"` to keyboard-operable elements). Requires careful sandboxing to avoid breaking SCORM runtime behavior.
- **LMS integration**: a webhook or API mode that receives a package URL from an LMS and posts the report back, enabling pre-publish gates inside platforms like Cornerstone, Docebo, or Moodle.
- **Screen reader simulation**: integration with a headless browser + screen reader (e.g., NVDA via virtual machine, or Accessibility Tree inspection) to catch dynamic ARIA issues that static analysis misses.

---

## Success metrics

### Leading indicators (measurable within 4 weeks of release)

- **Adoption**: ≥50 npm installs in the first 30 days (tracked via public npm download counts — no telemetry required).
- **Report usefulness**: ≥80% of violations in automated test suite are correctly identified (validated against a manually curated set of 10 reference packages with known violations).
- **False positive rate**: ≤10% of flagged violations are false positives, measured against the same reference package suite.
- **CLI reliability**: tool completes without crashing on 100% of valid SCORM 1.2, SCORM 2004, and AICC packages in the test suite (20+ packages of varying complexity).

### Lagging indicators (measurable within 90 days)

- **Issue resolution rate**: teams that use the tool reduce violation counts by ≥40% on their second scan of the same course.
- **CI adoption**: ≥20% of active users add the tool to a CI pipeline (indicated by `--json` flag usage + non-interactive TTY detection).
- **Community trust**: ≥3 GitHub stars / external references within 60 days, indicating the tool is recognized as filling a real gap.

---

## Open questions

All open questions have been resolved. Decisions recorded below for implementation reference.

| Question | Decision |
|----------|----------|
| axe-core vs. custom contrast engine? | **Static CSS analysis** *(revised 2026-04-30 during build)*. Original decision was axe-core, but axe-core's `color-contrast` rule runs inside jsdom and depends on Canvas via `_isIconLigature` for glyph-rendering checks. jsdom ships no Canvas; the native `canvas` package requires a build toolchain that fails on locked-down user/CI environments. With Canvas missing, axe silently aborts the rule on text nodes that trigger ligature detection — legitimate violations were going undetected (e.g. `#888` on `#aaa` in the test fixture). Replaced with static CSS parsing using `@asamuzakjp/css-color` for color resolution and the W3C relative-luminance formula for contrast computation. Same coverage for the static-analysis use case (no JS-runtime contrast needed since we never render the page), zero native dependencies, deterministic results. `canvas` retained as `optionalDependencies` for future checks that may benefit. axe-core remains in `dependencies` but is not wired into any active check. |
| `<iframe>` with external URLs — warn or skip silently? | **Warn.** Surface as a distinct coverage gap entry in both JSON (`iframeUrl` field) and Markdown report. Not scored as a violation. |
| AICC profile levels — all 4 or just common profiles? | **Profiles 1–2 only.** Covers all major authoring tool output (Articulate, Lectora, Captivate). Profile 3–4 packages return a clear descriptive error. |
| Anonymous telemetry — opt-in, opt-out, or none? | **No telemetry at all.** Adoption tracked via public npm download counts instead. No outbound network calls from the tool. |
| Label WCAG 2.2-only violations distinctly? | **Yes.** Each violation in JSON includes a `wcagIntroduced` field (`"2.0"`, `"2.1"`, or `"2.2"`). CLI supports `--standard wcag21\|wcag22` flag (default: `wcag22`) to filter report scope. |

---

## Timeline considerations

- **No hard deadline** specified. Recommend phasing as follows:
  - **Phase 1 (v1.0):** Core CLI with all P0 requirements — package parser, 20 automated checks + 6-item manual review checklist, JSON scorecard + Markdown report. Target: 4–5 weeks of build time.
  - **Phase 2 (v1.1):** P1 features — severity tagging, baseline diffing, per-SCO reporting. Target: 2 weeks after v1.0 ships and initial feedback is collected.
  - **Phase 3 (v2.0):** xAPI support and screen reader simulation. Target: informed by Phase 1 adoption data.

- **Dependency**: the AICC parser complexity is the highest-risk item in Phase 1. If AICC support significantly delays delivery, consider shipping v1.0 with SCORM only and adding AICC in v1.1.

---

## Acceptance criteria

**Package parsing**
- [x] Given a valid SCORM 1.2 `.zip`, the tool identifies the manifest and all HTML entry points without user configuration.
- [x] Given a valid SCORM 2004 `.zip`, same as above.
- [x] Given a valid AICC package `.zip` (containing `.crs`, `.au`, `.des`), the tool identifies the assignable unit entry point.
- [x] Given a non-SCORM `.zip`, the tool exits with code 2 and a message: "Could not detect a valid SCORM or AICC manifest."

**Automated checks**
- [x] Given an HTML file with `<img src="x.png">` (no alt), the tool flags a 1.1.1 violation with the file path and line number.
- [x] Given a `<video>` element without `<track kind="captions">`, the tool flags a 1.2.2 violation.
- [x] Given CSS containing `outline: none` with no replacement focus style, the tool flags a 2.4.7 violation.
- [x] Given a `<div onclick="...">` without `tabindex` and keyboard handlers, the tool flags a 2.1.1 violation.
- [x] Given text and background colors with contrast ratio < 4.5:1 in static CSS, the tool flags a 1.4.3 violation with the computed ratio.
- [x] Given a `position: fixed` header that covers the top of the viewport, the tool flags a potential 2.4.11 violation.
- [x] Given a button element with computed width and height below 24px, the tool flags a 2.5.8 violation.
- [x] Given a `dragstart` event handler with no single-pointer alternative, the tool flags a 2.5.7 violation.
- [x] Given a package with no violations, the tool exits with code 0.

**Report output**
- [x] `results.json` is valid JSON and contains: `wcagVersion: "2.2"`, `score`, `passed`, `violations[]` (each with `criterion`, `file`, `line`, `severity`, `description`), and `manualReviewRequired[]`.
- [x] `report.md` includes a human-readable summary, all violations with WCAG 2.2 links (https://www.w3.org/WAI/WCAG22/...), and a manual-review checklist.
- [x] `--json` flag prints only the JSON scorecard to stdout with no other output, enabling clean piping.

**Phase 3 (v2.0)**
- [x] `--simulate` runs dynamic checks against a Playwright accessibility tree; without Playwright, the audit gracefully degrades with a `dynamicCheckSkipReason`.
- [x] Three dynamic checks (2.4.3, 3.2.4, 4.1.3) detect violations in `test/fixtures/scorm12-aria-dynamic.zip`.
- [x] `--fix` writes a `<package>.scorm-fixed.zip` containing mechanical fixes (alt="", tabindex=0, lang, title, autocomplete, viewport scaling).
- [x] `--fix-dry-run` reports fixable violations without writing.
- [x] xAPI / Tin Can packages are detected and parsed alongside SCORM/AICC.
- [x] Scorecard JSON includes `dynamicChecksRun`, `fixesApplied`, and per-criterion `evaluated` + `evaluationMode`.

---

*End of PRD v2.0 — Phase 3 shipped 2026-04-30.*
