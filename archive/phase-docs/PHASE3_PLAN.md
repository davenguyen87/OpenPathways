# PHASE 3 (v2.0) IMPLEMENTATION PLAN: Screen Reader Simulation + Auto-Fix

**Status:** DRAFT v1  
**Date:** 2026-04-30  
**Target Completion:** 4–6 weeks (parallel subagent dispatch)  
**Scope:** Two P2 PRD items from Future Considerations

---

## 1. ARCHITECTURE DECISIONS

### 1.1 Headless Browser Library Choice

**Decision: Playwright over Puppeteer**

Reasoning:
- **Playwright** provides superior cross-browser support (Chromium, Firefox, WebKit). SCORM packages run in diverse LMS contexts (Moodle, Cornerstone, Canvas, iSpring); Playwright's multi-browser capability enables more comprehensive dynamic checks.
- **Puppeteer** is Chrome-only and deeply tied to a single browser engine, limiting coverage for SCORM packages tested in Safari/Firefox LMS environments.
- Playwright has a mature Accessibility Tree API (`page.accessibility.snapshot()`) that returns a structured JSON-like tree matching AIA spec. Puppeteer offers no equivalent; the deprecated `accessibility` module was removed from jsdom.
- Playwright integrates cleanly with existing CLI orchestration (no global browser manager required) and has lower startup overhead per-SCO than Puppeteer.
- **Package.json**: Add `playwright@^1.40.0` as a peer dependency; add `optional` tag so installs without native bindings if desired (lightweight download). Keep `puppeteer` out of core deps.

### 1.2 How Dynamic Checks Plug In

**Decision: New `src/dynamic-checks/` directory + parallel runner stage**

Architecture:
- **Static checks** (`src/checks/*.js`) continue unchanged — they run against cheerio-parsed HTML and CSS.
- **New dynamic checks** live in `src/dynamic-checks/` with the same CONTRACT.md module shape (same `run(ctx)` signature, same violation shape). Naming: `<criterion>-<name>-dynamic.js` to distinguish from static versions.
- **Two-phase orchestration** in `src/index.js`:
  - **Phase 1 (static):** Run all static checks via current loader → accumulate violations.
  - **Phase 2 (dynamic):** For each HTML entry point, spawn a Playwright browser instance, load the SCO, walk the Accessibility Tree, run dynamic checks. Collect additional violations.
  - Both phases output compatible violation objects; violations are merged and deduplicated (by file + line + message hash) before scorecard generation.
- **New loader:** `src/lib/load-dynamic-checks.js` — mirrors `load-checks.js` logic, auto-discovers `src/dynamic-checks/*.js`, validates contract, sorts by criterion.
- **New runner:** `src/lib/run-dynamic-checks.js` — orchestrates Playwright lifecycle (spawn browser, load each entry point HTML, navigate, snapshot accessibility tree, invoke each check's `run()` method, close). Handles errors gracefully (if Playwright fails, log warning, skip dynamic phase, continue with static results).

### 1.3 AuditContext Extension

**Decision: Extend existing AuditContext with new optional fields; no separate shape**

Why:
- Checks are already written to consume `ctx.files`, `ctx.packageRoot`, etc. Introducing a separate `DynamicAuditContext` would require branching loader logic and increase complexity.
- Extensions are backwards compatible: static checks ignore new fields.

**New fields on base AuditContext:**
- `ctx.pages` — Array of opened `Page` objects (one per entry point HTML). Each has `{ path, page, url, domSnapshot }` where `domSnapshot` is the result of `page.accessibility.snapshot()` (Playwright's Accessibility Tree JSON).
- `ctx.axTree` — Map from entry point file path → parsed Accessibility Tree object for convenience lookups.
- `ctx.playwrightConfig` — Object with `{ headless: true, timeout: 30000, browser: 'chromium' }` for dynamic checks to use if they spawn sub-instances (rare).

Static checks will not access these fields; they remain unaffected.

### 1.4 Auto-Fix Sandbox: Fixer Architecture

**Decision: `src/fixers/` directory with declarative fixer modules; `yazl` for zip rewriting**

Why `yazl` over `archiver`:
- `archiver` is higher-level but adds complexity (streaming, event handling). For SCORM packages (small, deterministic), `yazl` is more predictable.
- `yazl` is already a proven choice in Phase 1 test fixtures. Consistency matters.
- **Package.json**: Add `yazl@^2.10.0` (pure JS, no native dependencies).

**Fixer Module Shape:**
Each fixer in `src/fixers/<fixer-id>.js` exports:
```js
module.exports = {
  id: 'add-alt-to-decorative',  // kebab-case, unique
  name: 'Add alt="" to decorative images',
  supported: [ 'scorm12', 'scorm2004', 'aicc' ],
  confidence: 'definitive',  // 'definitive' | 'heuristic'
  
  // Declare what patterns it detects
  canFix(file, violation) {
    // Returns true if this fixer can repair the given violation.
    // file = { path, content, isHtml }
    // violation = { criterion, file, line, message, severity, ... }
    return violation.criterion === '1.1.1' && /spacer|decorative/.test(violation.message);
  },
  
  // Apply the fix; mutate file.content in-place
  async fix(file, violations) {
    // violations = array of violations this fixer can fix
    // Modify file.content, return { changed: true/false, log: string[] }
  }
};
```

**Registry & Orchestration** in `src/lib/auto-fix.js`:
- Load all fixers from `src/fixers/`.
- For each violation, try fixers in order. First match wins.
- Track which violations were fixed vs. skipped (manual).
- Rewrite modified HTML files, then rebuild the zip using `yazl`.

**Safety guardrails:**
- Do NOT modify JavaScript or compiled assets (only HTML/CSS).
- Do NOT change manifest or package structure.
- Do NOT execute runtime code (static text mutations only).
- Output: `<original>.scorm-fixed.zip` and `fixes-applied.json` (detailed log of applied fixes).

### 1.5 Manual Review Interaction

**Decision: All 6 manual-review items stay manual; focus dynamic checks on 4 automatable criteria**

Mapping:
- **1.2.3 Audio description** — Too subjective (is the description accurate?). Stay manual.
- **1.2.5 Audio description (AA)** — Same. Stay manual.
- **2.4.3 Focus order** — **REPLACE with dynamic check.** Use `page.accessibility.snapshot()` to build tabindex/focus order graph, detect logical flow violations. Confidence: heuristic (may flag false positives if focus is dynamically manipulated via JS; user must verify).
- **3.2.4 Consistent identification** — **REPLACE with dynamic check.** Walk Accessibility Tree across all SCOs, extract button/link labels, compare for consistency. Flag inconsistent labels (e.g., "Next" vs. "Continue"). Confidence: definitive if labels match exactly; heuristic if fuzzy matching needed.
- **3.3.7 Redundant entry** — Manual only (requires semantic understanding of form flow). Stay manual.
- **4.1.3 Status messages** — **REPLACE with dynamic check.** Scan Accessibility Tree for `role="status"`, `aria-live` attributes. Confidence: definitive (element has the attribute) or heuristic (check if announced in practice). May require interaction simulation for some quizzes.

**Outcome:** 2 dynamic checks created (2.4.3, 3.2.4) + 1 advanced (4.1.3 with interactivity). 3 manual items remain. Manual review section shrinks; scorecard reflects auto-detected violations only.

---

## 2. FILE-LEVEL WORK BREAKDOWN

| File Path | Purpose | Complexity | Tier | Notes |
|-----------|---------|-----------|------|-------|
| `src/lib/load-dynamic-checks.js` | Auto-discover & validate dynamic checks | S | Sonnet | Mirrors load-checks.js; reuse same validation logic |
| `src/lib/run-dynamic-checks.js` | Orchestrate Playwright, load pages, invoke checks | M | Opus | Handles browser lifecycle, page loading, error recovery |
| `src/lib/ax-tree-adapter.js` | Parse & query Playwright accessibility snapshot | M | Opus | Builds a normalized tree from `page.accessibility.snapshot()`; provides convenience queries (findByLabel, findByRole, etc.) |
| `src/dynamic-checks/2-4-3-focus-order-dynamic.js` | Dynamic focus order check | M | Sonnet | Uses ax-tree to validate tab order; detect cycles, backwards jumps |
| `src/dynamic-checks/3-2-4-consistent-identification-dynamic.js` | Cross-SCO label consistency check | L | Sonnet | Scan all entry points, extract labels, report inconsistencies |
| `src/dynamic-checks/4-1-3-status-messages-dynamic.js` | aria-live & role="status" check | M | Sonnet | Scan tree for status roles; optional: trigger interactions to test announcements |
| `src/fixers/add-alt-decorative.js` | Add alt="" to clearly decorative images | S | Sonnet | Pattern match `role="presentation"`, spacer filenames, then add alt="" |
| `src/fixers/add-tabindex-keyboard.js` | Add tabindex="0" to interactive divs with handlers | S | Sonnet | Detect `onclick` + `onkeydown`, add tabindex if missing |
| `src/fixers/add-lang-attribute.js` | Add lang="" to <html> | S | Haiku | Simple: check if <html lang="..."> exists, add if missing |
| `src/fixers/add-title.js` | Add <title> when empty or missing | S | Haiku | Check <title>, add default if blank |
| `src/fixers/add-autocomplete-password.js` | Add autocomplete="current-password" | S | Haiku | Detect password inputs, add if missing |
| `src/fixers/repair-viewport-scale.js` | Remove user-scalable=no | S | Haiku | Strip from viewport meta tag |
| `src/lib/auto-fix.js` | Fixer orchestration, zip rewriting | M | Opus | Load fixers, run against violations, rewrite zip using yazl |
| `src/index.js` | Add --fix, --fix-dry-run support; integrate dynamic phase | M | Opus | Extend audit() to accept `fix` option; call runDynamicChecks() and applyFixes() in sequence |
| `src/cli.js` | Add --fix, --fix-dry-run, --simulate flags | S | Sonnet | Parse new flags, pass to audit() |
| `src/reporter/index.js` | Add fixes-applied.json output | S | Haiku | When fixes applied, write fixes-applied.json with details |
| `docs/DYNAMIC_CHECKS.md` | CONTRACT for dynamic checks | S | Haiku | Document how to write new dynamic checks; example using ax-tree |
| `test/dynamic-checks.test.js` | Unit tests for dynamic checks | M | Sonnet | Test focus order, label consistency, status messages against fixtures |
| `test/fixtures/scorm-aria-dynamic.zip` | SCORM package with dynamic ARIA issues | S | Haiku | New fixture with status messages, focus issues, label inconsistencies |
| `test/auto-fix.test.js` | Tests for fixers | M | Sonnet | Test each fixer independently; test zip rewrite |

**Total: 21 files (1 new dir = src/fixers/, 1 new subdir = src/dynamic-checks/)**

---

## 3. DEPENDENCY / PARALLELIZATION GRAPH

### Critical Path (blocks many others)
1. **`ax-tree-adapter.js`** (Opus) — Must exist before any dynamic check can run. No dependencies.
2. **`load-dynamic-checks.js`** (Sonnet) — Must exist before runner; depends on CONTRACT clarity.
3. **`run-dynamic-checks.js`** (Opus) — Must exist before testing dynamic checks; depends on adapter, load-dynamic-checks.

### First Parallel Wave (can start immediately, no blockers)
- `add-alt-decorative.js` (Sonnet) — Independent fixer
- `add-tabindex-keyboard.js` (Sonnet) — Independent fixer
- `add-lang-attribute.js`, `add-title.js`, `add-autocomplete-password.js`, `repair-viewport-scale.js` (Haiku x4) — All independent fixers
- `DYNAMIC_CHECKS.md` (Haiku) — Documentation, no code dependency
- `scorm-aria-dynamic.zip` fixture (Haiku) — Can be created in parallel with code

### Second Wave (depends on critical path)
- `2-4-3-focus-order-dynamic.js` (Sonnet) — Depends on ax-tree-adapter, load-dynamic-checks
- `3-2-4-consistent-identification-dynamic.js` (Sonnet) — Depends on ax-tree-adapter
- `4-1-3-status-messages-dynamic.js` (Sonnet) — Depends on ax-tree-adapter
- `auto-fix.js` (Opus) — Depends on fixer modules (all done in wave 1)

### Third Wave (integration & testing)
- `src/index.js` (Opus) — Depends on run-dynamic-checks.js, auto-fix.js
- `src/cli.js` (Sonnet) — Depends on updated index.js
- `dynamic-checks.test.js` (Sonnet) — Depends on dynamic checks + test fixture
- `auto-fix.test.js` (Sonnet) — Depends on fixers and auto-fix.js
- `src/reporter/index.js` (Haiku) — Depends on auto-fix outputs

**Longest chain:** ax-tree → run-dynamic-checks → integrate into index.js → CLI → test (4 sequential blocks).

**Parallelization potential:** 10 files can start in wave 1 (all fixers + docs + fixture). 3 checks start in wave 2 after adapter completes. Full integration occurs last.

---

## 4. NEW CLI FLAGS & ACCEPTANCE CRITERIA

### New Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--simulate` | boolean | false | Enable dynamic (screen reader simulation) checks. Requires Playwright. |
| `--fix` | boolean | false | Write mechanical fixes back to package; output `*.scorm-fixed.zip`. Requires explicit user confirmation in CI. |
| `--fix-dry-run` | boolean | false | Preview fixes without modifying package; output `fixes-applied.json` only. |
| `--browser` | enum | 'chromium' | Browser for dynamic checks: `chromium`, `firefox`, `webkit`. Ignored if `--simulate` not set. |
| `--timeout-dynamic` | number | 30000 | Timeout (ms) per SCO for dynamic checks. |

### Usage Examples
```bash
# Static checks only (v1.0 behavior)
npx open-pathways course.zip

# With dynamic checks
npx open-pathways course.zip --simulate

# Auto-fix preview
npx open-pathways course.zip --fix-dry-run

# Auto-fix and output fixed package
npx open-pathways course.zip --fix

# Combined: dynamic + fix
npx open-pathways course.zip --simulate --fix
```

### Acceptance Criteria (Phase 3)

#### Dynamic Checks
- [ ] Given a SCORM package with `role="status"` or `aria-live` elements, the tool detects 4.1.3 violations or passes when appropriate (definitive detection).
- [ ] Given a package with inconsistent button labels ("Next" on page 1, "Continue" on page 2), the tool flags a 3.2.4 violation (cross-SCO analysis).
- [ ] Given an HTML file with logical focus order problems (tabindex: 10, 5, 3), the tool flags a 2.4.3 violation (definitive or heuristic).
- [ ] Dynamic checks produce the same violation shape as static checks (file, line, message, severity, confidence).
- [ ] If Playwright fails to start or load an SCO, the tool logs a warning and continues with static results only (graceful degradation).

#### Auto-Fix Mode
- [ ] Given an HTML file with `<img role="presentation" src="spacer.gif">` (no alt), `--fix-dry-run` reports it can be fixed.
- [ ] Given the same file with `--fix`, the output `*.scorm-fixed.zip` contains `<img role="presentation" alt="" src="spacer.gif">`.
- [ ] Given a `<div onclick="...">` with no `tabindex` and an `onkeydown` handler, `--fix` adds `tabindex="0"`.
- [ ] Given an empty or missing `<title>`, `--fix` adds a default `<title>Untitled Course</title>`.
- [ ] Given a `<meta name="viewport" content="user-scalable=no">`, `--fix` outputs `<meta name="viewport" content="initial-scale=1.0">` (removes scaling lock).
- [ ] Output file is a valid SCORM zip; manifest unchanged; all non-HTML files identical to original.
- [ ] `fixes-applied.json` logs each fixer run, violations fixed, and confidence level.
- [ ] Exit code 0 when all fixes applied; exit code 1 if fixes rejected or violations remain.

#### Integration
- [ ] `--simulate` flag works with `--output`, `--json`, `--format` flags (no conflicts).
- [ ] `--fix` and `--fix-dry-run` are mutually exclusive; tool errors clearly if both set.
- [ ] Manual review checklist shrinks by 3 items (2.4.3, 3.2.4, 4.1.3 move to auto-detected); remaining 3 stay manual.
- [ ] Scorecard JSON includes `dynamicChecksRun: true/false` and `fixesApplied: { count, details[] }`.
- [ ] Tool completes within 90 seconds for a standard SCORM package with --simulate enabled (timeout: 30s per SCO × ~3 SCOs = 90s).

---

## 5. RISKS & OPEN QUESTIONS

### Risks

1. **Playwright Installation in CI/Headless Environments**
   - **Risk:** Playwright requires browser binaries (Chromium ~100 MB). CI environments may have network constraints or missing system libraries (libssl, libc).
   - **Mitigation:** Make Playwright an `optionalDependency` in package.json. If dynamic checks are requested and Playwright is missing, provide a clear error message with install instructions. Provide a `--no-playwright` flag to skip dynamic checks in locked-down environments.

2. **False Positives in Dynamic Checks**
   - **Risk:** 3.2.4 label consistency check may flag legitimate variations ("Next" vs. "Next Slide") or dynamic labels generated at runtime.
   - **Mitigation:** Set confidence to `'heuristic'`. Document that dynamic checks should be used with `--review-manual` flag in CI to allow human review before failing the build. Provide a baseline mode (`--baseline-dynamic results.json`) to suppress known false positives.

3. **Performance: Browser Startup Overhead**
   - **Risk:** Spawning a Playwright browser per SCO could take 5–10 seconds per instance, delaying large packages.
   - **Mitigation:** Reuse a single browser instance across all SCOs (one context per SCO to isolate state). Add progress spinner showing "Loading SCO 2/5..." and a `--timeout-dynamic` flag so users can customize patience thresholds.

4. **SCORM Packages with External iframes**
   - **Risk:** Dynamic checks run against entry-point HTML; external iframes (e.g., `<iframe src="https://example.com/...">`) cannot be inspected without additional permissions.
   - **Mitigation:** Detect external iframes, flag as `iframeUrl` coverage gap (not a violation), same as Phase 1. Document this limitation in manual review.

### Open Questions (For User Input Before Dispatch)

1. **Fixer Safety & Scope**
   - **Q:** Should fixers also repair invalid ARIA (e.g., `role="button"` on elements without click handlers)? Or only the 6 mechanical ones listed?
   - **A Required:** Mechanical only (6 listed). Invalid ARIA is beyond "trivial unambiguous fixes" per PRD. Defer advanced remediation to Phase 3.1 or v2.1.

2. **Dynamic Check Interactivity**
   - **Q:** Should the 4.1.3 status messages check simulate user interactions (click a button, trigger quiz feedback) to detect dynamic announcements, or only scan static `aria-live` attributes?
   - **A Required:** Start with static attribute scan (high confidence, fast). Optional: add interaction simulation via a separate `--test-interactive-aria` flag in a post-Phase-3 release.

3. **Cross-SCO Analysis: Shared Label Dictionary**
   - **Q:** For 3.2.4 consistent identification, should the tool maintain a shared label dictionary across all SCOs (report once per unique label pair), or report every inconsistency found?
   - **A Required:** Report every inconsistency (pages 1 and 3 use "Next", page 2 uses "Continue" → 2 violations: one per page pairing). Clearer for authors to fix.

4. **Baseline Diffing for Dynamic Violations**
   - **Q:** Should `--baseline results.json` work with dynamic violations, or only static ones?
   - **A Required:** Support both. If dynamic checks are added, old baselines (static only) should still be readable; dynamic violations are always "new" when compared to a static-only baseline.

5. **Browser Choice: Default to Chromium or Auto-Detect LMS?**
   - **Q:** If a SCORM package was authored for Firefox (WebKit features), should `--browser firefox` be required, or auto-detect from package metadata?
   - **A Required:** Default to Chromium (most common). User can override via `--browser`. No auto-detection (too fragile). Document this explicitly.

---

## TIMELINE

- **Phase 3a (1 week):** Implement critical path (ax-tree-adapter, run-dynamic-checks, load-dynamic-checks). Parallel: all fixers + docs + test fixture.
- **Phase 3b (2 weeks):** Implement the 3 dynamic checks. Parallel: auto-fix.js orchestration.
- **Phase 3c (1 week):** Integrate into index.js and cli.js. Add tests.
- **Phase 3d (1 week):** User acceptance testing, documentation, release v2.0.

---

## SUCCESS METRICS (Phase 3)

- All new CLI flags parse correctly and don't conflict with existing flags.
- Dynamic checks produce violations with the same structure as static checks; both integrate into a single scorecard.
- `--fix` mode rewrites valid SCORM zips; downstream LMS can consume fixed packages without errors.
- False positive rate on dynamic checks ≤ 15% (heuristic checks inherently have higher variance).
- Tool completes within 90 seconds for a 3-SCO standard package with `--simulate --fix` enabled.
- No breaking changes to Phase 1 API or outputs; existing CI pipelines continue to work unchanged.

---

*End of Phase 3 Plan — Ready for user review and subagent dispatch.*
