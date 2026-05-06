# V3 Contract Notes (for the parallel agent team)

**Purpose:** shared reference for all parallel agents building Open Pathways v3.0. Read this before touching anything else. The PRD lives in `docs/PRD_v3_SkillLoop_Scoping.md`. The brand mockup is `mockups/assessment-mock-v1.html`.

---

## 1. Audit result shape (returned by `audit()` in `src/index.js`)

```js
{
  packageType: 'scorm12' | 'scorm2004' | 'aicc' | 'cmi5' | 'xapi',
  complete: boolean,            // false when dynamic checks were skipped
  incompleteReason: string|null,
  scorecard: { /* see §2 */ },
  violations: [ /* see §3 */ ],
  scos: [ { id, title, entryFile } ],
  manualReview: [ /* WCAG criteria flagged for human review */ ],
  dynamicReport: { skipped, reason, iframeWarnings, dynamicViolationsCount },
  fixesApplied: { count, applied, skipped, dryRun, outputPath, bytes } | null
}
```

## 2. Scorecard shape (returned by `buildScorecard()` in `src/reporter/json.js`)

```js
{
  wcagVersion: '2.1' | '2.2',
  passed: boolean,
  score: number | null,         // 0-100, 1 decimal place
  totalCriteria, passedCriteria, failedCriteria, totalViolations,
  criteriaResults: [
    { id, name, level, wcagIntroduced, url,
      evaluationMode: 'static' | 'dynamic',
      evaluated: boolean,
      passed: boolean | null,
      violationCount: number }
  ]
  // v3 will append: triageRollup, scopeEstimate, section508, topRisks
}
```

## 3. Violation shape (emitted by every check in `src/checks/*.js`)

```js
{
  file: 'content/lesson1.html',
  line: 42,
  column: null,
  snippet: '<img src="logo.png">',
  message: 'Image is missing an alt attribute…',
  severity: 'critical' | 'serious' | 'moderate' | 'minor',
  criterion: '1.1.1',           // WCAG ref, dot-separated
  sco: { id, title } | null,    // attached by orchestrator
  confidence: 'definitive' | 'heuristic'   // optional
  // v3 will append: triage, effortMinutes, section508
}
```

## 4. Check module shape (`src/checks/*.js` and `src/dynamic-checks/*.js`)

```js
module.exports = {
  id: '1.1.1',
  name: 'Non-text content',
  level: 'A' | 'AA',
  wcagIntroduced: '2.0' | '2.1' | '2.2',
  url: 'https://www.w3.org/WAI/WCAG22/Understanding/...',
  async run(ctx) { return [ /* violations */ ]; }
};
```

## 5. CLI surface today (`src/cli.js`, commander-based)

Single command, single positional arg `<package>`. Flags: `--baseline`, `--browser`, `--fix`, `--fix-dry-run`, `--format`, `--json`, `--max-violations`, `--output`, `--package-type`, `--standard` (default `wcag22`), `--timeout-dynamic`. Exit codes: 0 clean, 1 violations, 2 tool error or INCOMPLETE.

**v3 changes the integration agent will land** (do NOT touch these files in parallel agents — write new modules; integration agent wires them):
- New required flag `--engagement <id>` for v3 deliverable commands
- New flag `--engagement-redact`
- New flag `--brand-config <path>`
- New flags `--llm-provider <provider>` and `--llm-key-from-env <env-var>`
- Flip `--standard` default from `wcag22` → `wcag21`
- New subcommand `audit-library <directory>`
- Output routing: `./engagements/<id>/<package-name>/{report.html,report.md,results.json}`
- Library rollup output: `./engagements/<id>/_library-rollup.{html,md}`

## 6. Reporter pipeline (`src/reporter/index.js`)

`writeReports({ scorecard, violations, manualReview, options, scos, dynamicReport, fixesApplied })` returns `{ jsonPath, mdPath, jsonString, htmlPath }` (htmlPath is new in v3).

The integration agent will:
1. Compute v3 enrichments (triage, scope, 508, top-risks) before serializing the scorecard
2. Add an `htmlPath` branch that calls the new `renderHtml(scorecard)` from `src/reporter/html.js`
3. Route output paths through engagement namespacing when `options.engagementId` is set

## 7. Brand system (lifted from `mockups/assessment-mock-v1.html`)

```css
--paper:   #f3efe6;  --paper-2: #ebe5d6;  --paper-3: #e3dcc8;
--ink:     #111633;  --ink-2:   #2a3158;  --ink-3:   #55597a;
--rule:    #c8bfa8;  --rule-2:  #948a74;
--accent:  #2f7d72;  --accent-deep: #1d4f48;  --accent-soft: rgba(47,125,114,0.14);
--cta:     #f28619;  --ok:      #1b7a3d;
--sev-critical: #c46a14;  --sev-serious: #de8a2e;
--sev-moderate: #55597a;  --sev-minor:   #948a74;
```

Fonts: Archivo Black (`--font-jersey`), Space Grotesk (`--font-display`), Inter (`--font-sans`), JetBrains Mono (`--font-mono`).

The mockup is the visual contract. Read it directly when building the HTML report.

## 8. Triage taxonomy (PRD §Requirements)

| Tag | Default effort range |
|---|---|
| `auto-fix safe` | 2–10 min |
| `auto-fix assisted` | 5–20 min |
| `author rework` | 30–90 min |
| `content rework` | 2–8 hours (120–480 min) |
| `recommend retire` | n/a |

Each finding gets BOTH a triage tag (action) and a severity (axe-core `critical|serious|moderate|minor` mapped to consultant-facing Critical/Serious/Moderate/Minor).

## 9. Section 508 minimum coverage

501.1 (Operable without specialized input), 501.5 (Captions for synchronized media), 502 (Interoperability with AT), 503 (Applications). Other 508 references covered as applicable. Every finding gets a `section508` field; HTML and Markdown reports render a 508 mapping table with finding counts per reference.

## 10. Output isolation contract

- All v3 deliverable output under `./engagements/<id>/<package-name>/` (per-package) or `./engagements/<id>/_library-rollup.{html,md}` (library mode).
- No two engagements share an output directory.
- Integration test (`test/engagement-isolation.test.js`) runs two audits with different `--engagement` IDs and asserts no shared files and no cross-references.

## 11. Local-first contract

- No outbound network calls during audit, except the existing one-time `npx playwright install chromium`.
- LLM-assisted findings only when both `--llm-provider` and `--llm-key-from-env` are set.
- Every assisted finding records `{ provider, model, engagementId, timestamp }` provenance in JSON.
- Network-traffic CI check fails the build on unexpected outbound traffic during a representative audit.

## 12. Files the integration agent owns (do not modify in parallel agents)

- `src/cli.js`
- `src/index.js`
- `src/reporter/index.js`
- `README.md`
- `package.json` (only the integration agent bumps version to 3.0.0)
- Anything in `test/` that exercises the wired-up CLI

## 13. Files parallel agents own (each agent writes new files only)

- HTML report generator: `src/reporter/html.js` (new)
- Markdown v3 report: `src/reporter/markdown-v3.js` (new — integration agent points old markdown.js at this)
- Triage tagger: `src/lib/triage.js` (new)
- Scope estimator: `src/lib/scope-estimator.js` (new)
- 508 mapping: `src/lib/section508.js` (new)
- Top-3 risks: `src/lib/top-risks.js` (new)
- Library batch: `src/lib/audit-library.js` (new)
- Library rollup renderer: `src/lib/library-rollup.js` (new)
- LLM provenance: `src/lib/llm-provenance.js` (new)
- Configs: `config/brand.json`, `config/effort-calibration.json` (new)
- README v3 draft: `docs/V3_README_DRAFT.md` (new — integration agent merges into README.md)
- CLI help draft: `docs/V3_CLI_HELP_DRAFT.md` (new — integration agent applies to commander config)

## 14. Test fixtures available

`test/fixtures/` has `scorm12-clean.zip`, `scorm12-violations.zip`, `scorm12-aria-dynamic.zip`, `scorm12-articulate-style.zip`, `scorm12-violations.scorm-fixed.zip`, `scorm2004-captivate-style.zip`, `aicc-profile1.zip`, `cmi5-violations.zip`, `xapi-violations.zip`, `expected.json`. Integration agent uses these for smoke tests.

---

*End of contract notes. The parallel agent team builds against this document; the integration agent wires everything together at the end.*
