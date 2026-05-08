# PRD v4: Rebuild Stage

**Status:** Draft
**Date:** 2026-05-07
**Author:** Dave Nguyen
**Built by:** Claude (autonomous, parallel terminals)
**Supersedes nothing.** Extends [PRD v3](../PRD_v3_SkillLoop_Scoping.md) with a Rebuild stage. v3's audit, triage, scoping, and brand-matched deliverable remain authoritative; v4 adds a stage that consumes their output.

---

## Problem statement

v3 closed the gap between audit findings and consultant deliverable. The next gap is between deliverable and remediated package. Today a senior consultant reads the v3 report, opens the original SCORM `.zip`, and either makes the changes by hand or hands a list to a content author. For libraries of 50–300 packages this is the dominant cost in the engagement. The existing `--fix` mode in v2/v3 patches nine surface-level issues but stops there; everything else falls back on human work.

v4 introduces a Rebuild stage that takes the audit's findings and the original `.zip` and produces a remediated `.zip`, a manifest of every change, a per-fix diff report for consultant sign-off, and a re-audit that verifies the rebuilt package against WCAG 2.2 AA + Section 508. v4 ships the **safe** tier (deterministic mechanical fixes) and the diff report scaffolding. **Assisted** (LLM-generated content) and **full** (structural rework) are deferred to later releases that build on the same scaffolding.

---

## Goals

1. **Cut author-rework hours per engagement** by automating every WCAG 2.2 AA / Section 508 finding that has a deterministic right answer.
2. **Make every rebuild fully reviewable.** Each change is a discrete patch with file, line, before, after, criterion, confidence, and provenance. The diff report is the consultant's review surface.
3. **Make every rebuild fully reversible.** Patches define both `apply` and `revert`. A consultant can re-emit a rebuilt `.zip` excluding any subset of patches.
4. **Verify rebuilds against the standard.** Every rebuilt package re-runs through the audit; the deliverable carries a before/after compliance summary.
5. **Hold the v3 contract.** Rebuild lives alongside audit at `engagements/<id>/<package>/`. Audit output is unchanged. Brand system, isolation rules, no-telemetry posture, and exit codes carry over.

## Non-goals

1. **No assisted or full tier in v4.** The CLI accepts `--mode assisted|full` but exits cleanly with a deferred-feature notice. Architecture is in place so v4.1 / v5 add only new fixers and LLM glue, not orchestrator rework.
2. **No SCORM modernization.** SCORM 1.2 stays SCORM 1.2; SCORM 2004 stays 2004. Manifest version stays the input version.
3. **No customer-facing surface.** Rebuild is CLI for the senior consultant, same posture as v3.
4. **No automatic deployment.** The rebuilt `.zip` is an artifact in the engagement directory. A human ships it.
5. **No changes to web/ or cloud/.** v4 is engine and CLI only. The hosted service can adopt rebuild later by importing the new `src/rebuild` module.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  pkg.zip ──► extract ──► parse ──► AUDIT ──► triage ──► report.html │  v3 (unchanged)
└─────────────────────────────────────────────────────────────────────┘
                                       │
                                       │  audit-results.json
                                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│  REBUILD                                                            │
│  ┌────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
│  │ orchestra- │─►│   apply     │─►│  repackage  │─►│  re-audit   │  │
│  │ tor (tier  │  │   patches   │  │  to .zip    │  │             │  │
│  │ dispatch)  │  │ (per fixer) │  │             │  │             │  │
│  └────────────┘  └─────────────┘  └─────────────┘  └─────────────┘  │
│         │               │                  │              │         │
│         └───────────────┴──────────────────┴──────────────┘         │
│                              ▼                                       │
│                     rebuild-manifest.json                            │
│                              │                                       │
│              ┌───────────────┴────────────────┐                      │
│              ▼                                ▼                      │
│       rebuild-diff.html               rebuild-summary.html           │  v4
└─────────────────────────────────────────────────────────────────────┘
```

### Components

- **`src/rebuild/index.js`** — orchestrator. Reads audit results, dispatches findings to fixers per tier, collects patches, drives repackaging, invokes re-audit.
- **`src/rebuild/manifest.js`** — `RebuildManifest` shape, read/write, schema validation.
- **`src/rebuild/packager.js`** — wraps `adm-zip` (already a dep). Round-trips an extracted package back to a `.zip`, preserving manifest entry order and binary file integrity.
- **`src/rebuild/verify.js`** — re-runs `audit()` against the rebuilt `.zip`, returns before/after summary.
- **`src/rebuild/undo.js`** — reads a manifest, applies a subset (or inverse subset) of patches, repackages.
- **`src/fixers/*.js`** — extended interface (see § "Fixer interface v2"). The 9 existing fixers gain `revert()`. New mechanical fixers added in v4 sit alongside them.
- **`src/reporter/rebuild-diff.js`** — brand-matched HTML diff report with sign-off checkboxes, filter chips, before/after rendering.
- **`src/reporter/rebuild-summary.js`** — brand-matched HTML rebuild summary: before/after compliance, manifest stats, deferred findings.

### Tier dispatch

The orchestrator's signature:

```js
async function rebuild(packagePath, auditResults, opts) {
  // opts.mode: 'safe' (default) | 'assisted' | 'full'
  // opts.engagement: required
  // opts.brandConfig, opts.standard, opts.timeoutDynamic: pass-through
  ...
}
```

Internally it routes each finding to a fixer by `(criterion, triage, mode)`. v4 only registers safe-tier fixers. Assisted and full registries are empty stubs that print a deferred-feature notice.

---

## Tier definitions

### Safe tier (v4 — implemented)

Deterministic. Right answer is provable from the source plus the criterion. No content judgment.

The 9 existing fixers stay safe-tier. New safe-tier fixers added in v4:

| Fixer | Criterion | What it does |
|---|---|---|
| `normalize-heading-order` | 1.3.1 | Insert `h1` if missing on a page; demote orphan `h1` to `h2` when a sibling `h1` already exists. Refuses to act when ambiguous. |
| `associate-form-label` | 1.3.1, 3.3.2 | Pair `<label>` with `<input>` via `for`/`id` when proximity is unambiguous (single label, single input within parent block). |
| `raise-target-size` | 2.5.8 | Rewrite computed CSS for elements below 24×24 to meet 24×24, only when no overlap risk exists. |
| `rewrite-contrast-tokens` | 1.4.3, 1.4.11 | When CSS uses palette tokens (custom properties), rewrite token values to the nearest compliant pair from the calibrated palette. Refuses to act on ad-hoc hex literals. |
| `wire-captions-track` | 1.2.2 | If a `.vtt` exists in the package alongside a `<video>` but isn't `<track>`'d, inject the `<track kind="captions">` element. |
| `inject-focus-polyfill` | 2.4.7, 2.4.11 | Inject a deterministic focus-indicator stylesheet (≥3:1 contrast, not obscured) when the existing styles are demonstrably absent. |

Each new fixer is a single file in `src/fixers/`, follows the existing fixer interface (extended per § below), and has Vitest coverage.

### Assisted tier (deferred to v4.1)

LLM-generated candidates for content-judgment items: alt text, ARIA labels, plain-language rewrites, transcripts, captions. Every change carries provenance (provider, model, prompt hash, timestamp, confidence). The diff report renders these with a `needs sign-off` chip and a sign-off checkbox. v4 puts the registry stub and the manifest fields in place; no fixers register here yet.

### Full tier (deferred to v5)

Structural rework: page splitting, landmark insertion, custom-widget replacement. v4 stubs the registry and exits cleanly when invoked.

---

## Fixer interface v2

The existing fixers expose `{ id, name, supported, confidence, criterion, canFix(file, violation), fix(file, violations) }`. v4 extends to:

```js
module.exports = {
  id: 'add-alt-decorative',
  name: 'Add alt="" to decorative images',
  supported: ['scorm12', 'scorm2004', 'aicc'],
  confidence: 'definitive',     // definitive | likely | needs-review
  criterion: '1.1.1',
  triage: 'auto-fix safe',      // matches v3 triage taxonomy
  tier: 'safe',                 // safe | assisted | full
  provenance: 'deterministic',  // deterministic | llm | rule-based

  canFix(file, violation) { ... },

  // RENAMED from fix(). Returns patches alongside the new content so
  // the orchestrator can collect them into the manifest.
  async apply(file, violations) {
    return {
      changed: boolean,
      newContent: string,
      patches: Patch[],   // one per discrete change
      log: string[]
    };
  },

  // NEW. Given a file's current content and a single Patch this fixer
  // emitted, return the content with that patch reversed.
  async revert(file, patch) {
    return {
      newContent: string,
      log: string[]
    };
  }
};
```

`apply` is the renamed `fix`. The orchestrator calls `apply` once per (fixer, file) pair with the violations that fixer claims, collects every emitted `Patch` into the manifest, and writes the result. `revert` lets the undo command and the reject-and-rerun loop reverse a single patch without re-running the rebuild.

---

## Manifest schema

`rebuild-manifest.json` lives at `engagements/<id>/<package>/rebuild-manifest.json`. Schema:

```jsonc
{
  "schemaVersion": "1.0.0",
  "engagementId": "acme-2026",
  "packageName": "compliance-101.zip",
  "inputZipSha256": "…",
  "outputZipSha256": "…",
  "mode": "safe",
  "standard": "wcag22",
  "createdAt": "2026-05-07T14:22:11Z",
  "tool": { "name": "prism", "version": "4.0.0" },

  "patches": [
    {
      "id": "patch-0001",
      "fixer": "add-alt-decorative",
      "criterion": "1.1.1",
      "triage": "auto-fix safe",
      "tier": "safe",
      "confidence": "definitive",
      "provenance": {
        "source": "deterministic",
        "timestamp": "2026-05-07T14:22:09Z"
        // assisted-tier patches additionally carry:
        // "model": "claude-opus-4-6", "promptHash": "…", "modelConfidence": 0.87
      },
      "file": "shared/img/page-3.html",
      "range": { "startLine": 47, "startCol": 12, "endLine": 47, "endCol": 89 },
      "before": "<img src=\"spacer.gif\">",
      "after":  "<img src=\"spacer.gif\" alt=\"\">",
      "rationale": "role=\"presentation\" detected on adjacent element; image is decorative.",
      "reversible": true,
      "status": "applied"  // applied | reverted | rejected
    }
  ],

  "deferred": [
    {
      "criterion": "1.1.1",
      "triage": "auto-fix assisted",
      "reason": "tier=assisted not enabled in mode=safe",
      "file": "shared/img/page-7.html",
      "line": 22
    }
  ],

  "verification": {
    "before": { "violations": 47, "criteriaFailed": 12, "section508Failed": 5 },
    "after":  { "violations": 9,  "criteriaFailed": 4,  "section508Failed": 1 },
    "resolved": 38,
    "introduced": 0,
    "remaining": 9
  }
}
```

Every field is required unless the comment marks it tier-conditional. Schema validation is part of the manifest module's contract — invalid manifests refuse to load.

---

## File map

v4 doesn't add any new top-level directories beyond `v4/`. Everything else extends an existing folder.

### Planning artifacts (committed)

```
v4/
├── CLAUDE.md                   ← context for Claude Code workers; scoped to v4 only
├── PRD_v4_Rebuild.md           ← this document
└── build/
    ├── README.md               ← orchestration
    ├── 00-foundation.md        ← sequential prerequisite
    ├── 01-orchestrator.md      ┐
    ├── 02-verify.md            │
    ├── 03-fixers-a.md          │  parallel wave 1
    ├── 04-fixers-b.md          │  (run in separate terminals after 00)
    ├── 05-diff-report.md       │
    ├── 06-summary-report.md    ┘
    ├── 07-cli.md               ┐
    ├── 08-undo.md              │  parallel wave 2 (after wave 1)
    └── 09-integration.md       ┘
```

### Source code (committed)

```
src/rebuild/                    ← NEW module (entire directory is v4)
├── index.js                    ← orchestrator
├── manifest.js                 ← RebuildManifest schema, read/write, validate
├── packager.js                 ← .zip round-trip preserving binary integrity
├── verify.js                   ← re-audit, before/after summary
└── undo.js                     ← reverse selected patches, repackage

src/fixers/                     ← existing dir; v4 adds new files only
├── (9 existing fixers)         ← gain revert() in chunk 00
├── normalize-heading-order.js  ← NEW (chunk 03)
├── associate-form-label.js     ← NEW (chunk 03)
├── raise-target-size.js        ← NEW (chunk 03)
├── rewrite-contrast-tokens.js  ← NEW (chunk 04)
├── wire-captions-track.js      ← NEW (chunk 04)
└── inject-focus-polyfill.js    ← NEW (chunk 04)

src/reporter/                   ← existing dir; v4 adds new files only
├── (existing reporters)
├── rebuild-diff.js             ← NEW (chunk 05) — brand-matched HTML diff with sign-off
└── rebuild-summary.js          ← NEW (chunk 06) — brand-matched before/after summary

src/cli.js                      ← MODIFIED in chunk 07 only — registers rebuild commands
src/index.js                    ← MODIFIED in chunk 07 only — exports rebuild API
```

### Tests (committed)

Mirrors source layout exactly.

```
test/rebuild/                   ← NEW
├── orchestrator.test.js
├── manifest.test.js
├── packager.test.js
├── verify.test.js
└── undo.test.js

test/fixers/                    ← existing dir; one new test per new fixer
test/reporter/                  ← existing dir
├── rebuild-diff.test.js
└── rebuild-summary.test.js

test/integration/
└── rebuild-pipeline.test.js    ← NEW — end-to-end audit → rebuild → re-audit

test/fixtures/                  ← existing dir; v4 adds rebuild-* fixtures
├── rebuild-decorative-imgs.zip
├── rebuild-form-labels.zip
└── rebuild-mixed-violations.zip
```

### Runtime output (gitignored; produced when a consultant runs the tool)

Per-package, alongside v3's existing files. v3 outputs are unchanged.

```
engagements/<id>/<package>/
├── original.zip                ← input (preserved by v3)
├── report.html                 ← v3 audit report
├── results.json                ← v3 audit JSON
├── rebuilt.zip                 ← v4: remediated package
├── rebuild-manifest.json       ← v4: every patch + provenance + verification
├── rebuild-diff.html           ← v4: per-fix diff report with sign-off
└── rebuild-summary.html        ← v4: before/after compliance summary
```

Library mode adds engagement-level rollups alongside v3's:

```
engagements/<id>/
├── _library-rollup.{html,md}   ← v3
└── _rebuild-rollup.{html,md}   ← v4
```

The `engagements/` directory is already in `.gitignore`. No client data ever lands in version control. Multi-engagement isolation is the same guarantee v3 makes: one client's rebuild artifacts never co-mingle with another's.

---

## CLI surface

```
prism rebuild <pkg.zip> --engagement <id> [--mode safe|assisted|full] [--standard wcag21|wcag22] [--brand-config <path>]
prism rebuild-library <dir> --engagement <id> [--mode ...] [--standard ...]
prism rebuild-undo --engagement <id> --package <name> --patch <id>...
```

- `--mode` defaults to `safe`. `assisted` and `full` print a deferred-feature notice and exit code 0 in v4.
- `--standard` defaults to `wcag22` for rebuild (the rebuild target is always 2.2 AA + Section 508; the audit upstream may have run as 2.1).
- `rebuild` requires a prior audit at the same `engagements/<id>/<package>/` location. If the audit is missing, rebuild runs it first.
- `rebuild-undo` accepts one or more `--patch` arguments. It loads the manifest, applies `revert()` for each, repackages, and writes `rebuilt.zip` plus updates the manifest with `status: "reverted"` for affected patches.

Exit codes: `0` = rebuild succeeded and re-audit passed (zero remaining violations); `1` = rebuild succeeded but re-audit shows remaining violations (expected on most real packages); `2` = tool error or rebuild incomplete.

---

## Diff report

Brand-matched HTML at `rebuild-diff.html`. Single-page, prints to PDF cleanly. Sections:

1. **Header card.** Engagement, package, mode, standard, tool version, manifest hash, generation timestamp.
2. **Summary strip.** Patches applied, patches rejected, deferred findings, verification before/after.
3. **Filter bar.** Tier (safe/assisted/full), triage tag, criterion, "needs sign-off only".
4. **Patch list.** One row per patch:
   - File · line · criterion chip · triage chip · confidence · provenance pill
   - Before / After side-by-side, line-level highlighting (only the diff range plus reasonable context — never the full source page)
   - Rationale (one line)
   - Real `<input type="checkbox">` labeled "Approved by [consultant]" — renders as a fillable form field when printed to PDF
   - "Reject" affordance — flips the row's local state to `rejected`; the consultant exports the resulting state file and re-runs `prism rebuild --reject-state <file>` (v4.1; for v4 the reject button updates a JSON state file that `rebuild-undo` consumes)

Rendering reuses `config/brand.json` exactly as v3's report does — same Archivo Black headers, same paper/ink/teal/orange palette, same Space Grotesk + Inter + JetBrains Mono stack.

---

## Verification

After repackaging, the orchestrator re-runs `audit()` against `rebuilt.zip` and writes the result to `verification` in the manifest. The summary report renders this as a before/after table with the same triage taxonomy. Two invariants the verification step enforces:

- **No new findings.** If the rebuilt package has any violation that wasn't in the input, the rebuild is flagged in the summary and exit code is `2`. Rebuilding must never *introduce* a violation.
- **Section 508 mapping holds.** Every patch must satisfy both the WCAG criterion and the Section 508 mapping. A patch that resolves 1.4.3 but breaks the 508-1194.22(c) mapping is rejected during apply.

---

## Acceptance criteria for v4

The release ships when all of the following are true:

1. `prism rebuild` and `prism rebuild-library` work end-to-end against the existing test fixtures in `test/fixtures/`.
2. `prism rebuild-undo` round-trips: rebuild → undo selected patches → re-audit shows the un-fixed findings restored.
3. The diff report renders for every test fixture and contains every patch from the manifest.
4. The summary report shows non-zero `resolved` and `introduced: 0` for every fixture.
5. `npm test` passes and `npm run check-no-network` passes.
6. `--mode assisted` and `--mode full` exit `0` with a deferred-feature notice and no side effects.
7. The 9 existing fixers all produce manifest patches that round-trip through `revert()`.
8. The PRD's manifest schema matches the actual emitted JSON byte-for-byte on field names and types.

---

## Risks and mitigations

- **Repackaging changes binary file integrity.** SCORM packages occasionally contain binary blobs that `adm-zip` can corrupt if the API is misused. Mitigation: integration test that round-trips every fixture and asserts that all unchanged binary files have identical SHA-256 before and after.
- **Patch ranges drift across multiple fixers on the same file.** Two fixers editing the same file in sequence can invalidate the second's offsets. Mitigation: orchestrator applies patches per-file in a single pass, recomputing offsets after each apply; or all fixers operate on parsed DOM (cheerio is already a dep) and serialize once at the end. The latter is the default; raw-string fixers are a fallback for cases cheerio can't represent.
- **Rebuild introduces a new violation.** Mitigation: the verification step's "no new findings" invariant is enforced at exit. If triggered, the rebuild fails and the rebuilt zip is not written.
- **Consultant rejects a patch and re-runs.** v4 ships the reject-state JSON write path and the `rebuild-undo --patch <id>` command; the full reject-then-rebuild loop with state file consumption is v4.1. v4 covers the realistic case where a consultant rejects a small number of patches by listing them.

---

## Sequencing

v4 is built across 10 prompts in `build/` (`00`–`09`). 00 is sequential. 01–06 run in parallel. 07–09 run after 01–06. See `build/README.md` for orchestration. `CLAUDE.md` (this folder) governs how each worker fits into the parallel build.
