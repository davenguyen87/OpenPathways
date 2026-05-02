# CLAUDE.md

## Project: Open Pathways

A CLI tool that audits SCORM 1.2, SCORM 2004, and AICC packages for WCAG 2.2 AA compliance. Accepts a `.zip` file, extracts it, runs static analysis against all HTML/CSS/JS, and produces a JSON scorecard and Markdown report.

Full spec: `docs/PRD_SCORM_WCAG22.md`

---

## Folder structure

```
src/parser/      ← SCORM/AICC manifest parsing and entry point extraction
src/checks/      ← one file per WCAG criterion (e.g. checks/1-1-1-non-text-content.js)
src/reporter/    ← JSON scorecard and Markdown report generators
src/cli.js       ← entry point, argument parsing, orchestration
test/fixtures/   ← sample .zip packages with known violations for testing
docs/            ← living project documents (PRD, decisions)
archive/         ← one-time reference material, not needed for implementation
```

---

## Key decisions (from PRD)

- **Standard**: WCAG 2.2 AA (default). `--standard wcag21|wcag22` flag filters by version.
- **Contrast engine**: axe-core (do not reimplement).
- **AICC**: profiles 1–2 only. Return a clear error for profiles 3–4.
- **External iframes**: warn with `iframeUrl` field — do not score as a violation.
- **Telemetry**: none. No outbound network calls from the tool, except the one-time `npx playwright install chromium` triggered on first run (see "Dynamic checks" below).
- **Exit codes**: 0 = no violations, 1 = violations found, 2 = tool error OR audit incomplete.
- **4.1.1 Parsing**: removed in WCAG 2.2 — do not implement this check.
- **Dynamic checks are mandatory** (as of v2.0). Playwright + chromium are required dependencies; the audit runs `npx playwright install chromium` itself on first run if the binary is missing. If even auto-install can't recover (offline, locked-down CI), the audit completes with the report stamped INCOMPLETE and exits 2 — a partial audit must never be mistaken for a clean pass. The `--simulate` flag has been removed; static-only audits are no longer a supported mode. See `src/lib/ensure-playwright.js` and `src/dynamic-checks/`.
- **Phase 3 (v2.0)**: dynamic screen-reader checks (Playwright + chromium AX tree) and auto-fix mode.

---

## Distribution

This tool is **not published to npm**. It runs locally from source only.

- No `npm install -g open-pathways` or registry publishing.
- Run directly: `node src/cli.js audit <file.zip>`
- Or, for the `open-pathways` shorthand globally on your Mac, run `npm link` once from the project folder. The symlink points at the local source, so any code changes take effect immediately — no re-linking needed.
- If a new version adds a dependency, run `npm install` inside the project folder to pull it in.

---

## Coding guidelines

- Think before coding. State assumptions. Surface tradeoffs. Ask if unclear.
- Minimum code that solves the problem — no speculative features or abstractions.
- Touch only what the task requires. Match existing style.
- Define success criteria before implementing. Verify after.
- Delegate to subagents using best model (Opus, Sonnet, or Haiku) to run the tasks and in parallel whenever possible
