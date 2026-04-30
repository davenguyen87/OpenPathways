# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
