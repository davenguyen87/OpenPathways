# PRD v5: Full-Tier Rebuild

**Status:** Draft
**Date:** 2026-05-08
**Author:** Dave Nguyen
**Built by:** Claude (autonomous, parallel terminals)
**Supersedes nothing.** Extends [PRD v4](../v4/PRD_v4_Rebuild.md) with the full tier. v4's safe-tier rebuild and v4.1's assisted-tier rebuild remain authoritative; v5 adds a third tier that handles structural rework.

---

## Problem statement

v4 closed the gap between audit findings and per-file mechanical remediation. v4.1 closes the gap on content-judgment items inside a single file (alt text, ARIA labels, plain-language rewrites). The gap that remains is **structural**: pages whose markup never had landmarks, custom widgets built before ARIA patterns were standardized, and SCO files so long that 2.4.1 ("Bypass Blocks") and 3.3.x ("Error Identification") cannot be satisfied without splitting them up.

Today, structural findings fall through every fixer and end up in the audit's "author rework" bucket. For a Skill Loop engagement of 50–300 packages, this bucket is where the consultant's hours actually live. v3 estimates them, v4 deflects the easy ones, v4.1 deflects the content-judgment ones, and v5 finally addresses the structural ones.

v5 introduces a third rebuild tier — **full** — that operates on coordinated bundles of changes called **transforms**. A transform spans multiple files, can edit `imsmanifest.xml`, and must pass a human checkpoint gate before its output is promoted to the final `rebuilt.zip`. v5 ships three transform families: landmark insertion, widget replacement, and page splitting.

---

## Goals

1. **Resolve structural findings that current tiers can't touch.** Landmarks, custom widgets, and overflowing SCOs are the long tail that drives the rework hours.
2. **Make every transform fully reviewable.** A transform is a bundle of patches, each with file/line/before/after, plus a side-by-side rendered preview at the page level so the consultant can see what the rebuilt page actually looks like next to the original.
3. **Make every transform fully reversible.** Transforms revert atomically — undoing one transform undoes every patch in its bundle in a single operation.
4. **Gate every full-tier rebuild behind a human checkpoint.** Full mode stages output rather than overwriting; promotion to `rebuilt.zip` requires `prism rebuild-checkpoint approve`. This gate is non-optional in the default flow.
5. **Hold the v3 / v4 / v4.1 contract.** Rebuild lives alongside audit at `engagements/<id>/<package>/`. Audit output is unchanged. Brand system, isolation rules, no-telemetry posture, and exit codes carry over.

## Non-goals

1. **No SCORM modernization.** SCORM 1.2 → 2004 / cmi5 / xAPI is its own workstream (`prism modernize`). v5 preserves the input package's manifest version exactly.
2. **No new tiers.** safe / assisted / full is the closed set. Anything that doesn't fit becomes a deferred finding or a v5+ workstream.
3. **No automatic deployment.** The promoted `rebuilt.zip` is an artifact in the engagement directory. A human ships it.
4. **No changes to web/ or cloud/.** v5 is engine and CLI only. Hosted adoption follows.
5. **No widget framework.** The `src/widgets/` library ships as vanilla HTML/CSS/JS. No React, no Stencil, no build step. The point is that a transformed page must work standalone inside a SCO with no runtime support beyond what SCORM 1.2 already gives you.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  pkg.zip ──► extract ──► parse ──► AUDIT ──► triage ──► report.html          │  v3
└──────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       │  audit-results.json
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  REBUILD                                                                     │
│  ┌────────────┐  ┌────────────┐  ┌─────────────┐  ┌───────────┐              │
│  │ orchestra- │─►│ tier disp. │─►│ apply       │─►│ repackage │─► verify    │
│  │ tor        │  │ safe/ass./ │  │ (per fixer  │  │           │              │
│  │            │  │  full      │  │  + per      │  │           │              │
│  │            │  │            │  │  trans-     │  │           │              │
│  │            │  │            │  │  former)    │  │           │              │
│  └────────────┘  └────────────┘  └─────────────┘  └───────────┘              │
│         │                                │                                   │
│         │                full mode only: │                                   │
│         │           ┌──────────────────────────┐                             │
│         │           │  CHECKPOINT (v5)         │                             │
│         │           │  stage to                │                             │
│         │           │  .rebuild-staging/       │                             │
│         │           │  render preview.html     │                             │
│         │           │  await operator approve  │                             │
│         │           └────────────┬─────────────┘                             │
│         │                        │                                            │
│         │                        ▼                                            │
│         │                  rebuilt.zip                                        │
│         │                                                                     │
│         ▼                                                                     │
│   rebuild-manifest.json (v2.0.0 — adds transforms[])                          │
│         │                                                                     │
│         ├─► rebuild-diff.html      (v4)                                      │
│         ├─► rebuild-summary.html   (v4 + v5 transform stats)                 │
│         └─► rebuild-preview.html   (v5 — side-by-side per-transform)         │
└──────────────────────────────────────────────────────────────────────────────┘
```

### New components in v5

- **`src/transformers/*.js`** — full-tier transformers, one per transform family (or one per concrete transform within a family). New module.
- **`src/widgets/*/`** — vetted ARIA-compliant component library. One subfolder per widget (`tabs/`, `accordion/`, `carousel/`, `dialog/`, `tooltip/`), each containing `template.html`, `styles.css`, `script.js`, and `axe-baseline.json`.
- **`src/rebuild/checkpoint.js`** — staging area lifecycle: stage, list pending, approve, reject.
- **`src/reporter/rebuild-preview.js`** — side-by-side per-transform HTML rendering with checkpoint approval form.

### Extended components in v5

- **`src/rebuild/index.js`** — full-tier dispatch added (chunk 01).
- **`src/rebuild/manifest.js`** — schema bumped to 2.0.0; `transforms[]` block added (chunk 00).
- **`src/rebuild/types.js`** — `Transform` typedef + `transformId` field on `Patch` (chunk 00).
- **`src/rebuild/undo.js`** — transform-atomic revert (chunk 08).
- **`src/reporter/rebuild-summary.js`** — transform counts in the scoreboard (chunk 06).

`src/reporter/rebuild-diff.js` is **not** modified. The patch-level diff stays patch-level. Transform-level UI lives in the new `rebuild-preview.html`.

---

## Tier definitions (v5 closes the system)

### Safe tier (v4 — implemented)

Unchanged. Deterministic, single-file, mechanical.

### Assisted tier (v4.1 — implemented)

Unchanged. LLM-generated content for single-file content-judgment items: alt text, ARIA labels, plain-language rewrites, transcripts, captions.

### Full tier (v5 — this PRD)

Coordinated, package-scoped rewrites that span multiple files. Each transform produces 1..N patches plus optionally edits to `imsmanifest.xml`. Three families ship in v5:

| Transform family | Criteria | What it does |
|---|---|---|
| `landmark-insertion` | 1.3.1, 2.4.1, 4.1.2 | Promote inferred regions to `<header>`, `<nav>`, `<main>`, `<footer>` based on layout, heading, and ID/class signals. Label landmarks with `aria-label` when multiple of the same role exist on the page. |
| `widget-replacement` | 1.3.1, 2.1.1, 2.4.3, 4.1.2 | Detect div-soup carousels, tabs, accordions, and dialogs by DOM signature. Replace with the matching widget from `src/widgets/` rewritten to preserve the original content (tab labels, panel content, etc.) but wrapped in ARIA-compliant markup. |
| `page-split` | 2.4.1, 3.3.x, 1.3.1 | When a single SCO HTML file exceeds a configurable size or contains structural breakpoints (top-level `<h1>`s, explicit `<hr role="separator">` boundaries), split into multiple HTML files and rewrite `imsmanifest.xml` to register them as new SCOs in the original sequence. |

**Provenance.** Landmark insertion and widget replacement are `provenance: 'rule-based'` — deterministic from the input. Page splitting has two modes:

- **Heuristic mode** (`provenance: 'rule-based'`) — split at top-level `<h1>` boundaries only. Ships in v5.
- **LLM mode** (`provenance: 'llm'`) — chooses split points using v4.1's assisted-tier provider abstraction. Lights up when v4.1 is present; otherwise the transformer falls back to heuristic mode.

Every full-tier transform must satisfy:

- Both rule-based and LLM transforms produce stable, replayable output for the same input. LLM mode caches by `(input zip sha256, transformer id, prompt template hash)` so the same engagement re-running rebuild produces the same transforms.
- Round-trip: applying then reverting a transform produces a package whose contained file bytes are identical to the original.
- Verification's "no new findings" invariant from v4 still holds. A full-tier rebuild that introduces a violation is staged but cannot be approved — the checkpoint command refuses the promotion.

---

## Transformer interface

Transformers are a separate interface from Fixers. Where a Fixer's `apply(file, violations)` operates on a single file, a Transformer's `apply(packageContext)` operates on the whole extracted package.

```js
module.exports = {
  id: 'landmark-insertion',
  name: 'Insert ARIA landmarks',
  family: 'landmark',                  // landmark | widget | page-split
  supported: ['scorm12', 'scorm2004'],
  criteria: ['1.3.1', '2.4.1', '4.1.2'],
  triage: 'author rework',             // matches v3 triage taxonomy
  tier: 'full',
  provenance: 'rule-based',            // rule-based | llm

  // Package-level claim. Returns boolean.
  canTransform(packageContext) { ... },

  // Package-level apply. Returns ONE Transform plus its child Patches.
  // The Transform itself is bookkeeping; the Patches are what gets written
  // to file content and what undo operates on.
  async apply(packageContext) {
    return {
      transform: Transform,
      patches: Patch[],     // each patch carries transformId === transform.id
      log: string[]
    };
  },

  // Atomic revert: undoes every patch in the transform in reverse application
  // order. The orchestrator calls this once per transform during undo, never
  // per individual patch.
  async revert(packageContext, transform) {
    return {
      patches: Patch[],     // updated with status: 'reverted'
      log: string[]
    };
  }
};
```

**Why transforms aren't just patch arrays.** A patch array can already represent multi-file changes — but the consultant needs to approve the *intent* (this carousel becomes a tab panel) not 14 individual character-range edits. The Transform is the unit the preview renders, the unit the operator approves or rejects, and the unit undo operates on. The patches still exist; they're how the bytes actually move.

---

## Manifest schema v2.0.0

Backward-compatible additions only. v4 manifests (`schemaVersion: "1.0.0"`) load without modification. v5 manifests carry the new `transforms[]` block and an additional field on each Patch.

```jsonc
{
  "schemaVersion": "2.0.0",
  "engagementId": "acme-2026",
  "packageName": "compliance-101.zip",
  "inputZipSha256": "…",
  "outputZipSha256": "…",
  "mode": "full",
  "standard": "wcag22",
  "createdAt": "2026-05-08T14:22:11Z",
  "tool": { "name": "prism", "version": "5.0.0" },

  "patches": [
    {
      "id": "patch-0042",
      "fixer": "landmark-insertion",     // for full-tier patches, this is the transformer id
      "transformId": "transform-0003",   // NEW in v5: links patch to its parent transform
      "criterion": "1.3.1",
      "triage": "author rework",
      "tier": "full",
      "confidence": "likely",
      "provenance": {
        "source": "rule-based",
        "timestamp": "2026-05-08T14:22:09Z"
      },
      "file": "shared/page-3.html",
      "range": { "startLine": 12, "startCol": 1, "endLine": 12, "endCol": 38 },
      "before": "<div class=\"main-content\">",
      "after":  "<main class=\"main-content\">",
      "rationale": "Promoted .main-content div to <main> based on layout and heading signals.",
      "reversible": true,
      "status": "applied"
    }
  ],

  "transforms": [                        // NEW in v5
    {
      "id": "transform-0003",
      "transformer": "landmark-insertion",
      "family": "landmark",
      "criteria": ["1.3.1", "2.4.1", "4.1.2"],
      "tier": "full",
      "scope": {
        "files": ["shared/page-3.html", "shared/page-4.html", "shared/page-5.html"],
        "manifestEdited": false
      },
      "patchIds": ["patch-0042", "patch-0043", "patch-0044"],
      "provenance": {
        "source": "rule-based",
        "timestamp": "2026-05-08T14:22:09Z"
        // llm-mode transforms additionally carry:
        // "model": "claude-opus-4-7", "promptHash": "…", "modelConfidence": 0.84
      },
      "rationale": "3 pages share a common layout. Promoted top-level wrapper to <main> on each.",
      "previewPath": "rebuild-preview.html#transform-0003",   // anchor in preview report
      "requiresCheckpointApproval": true,
      "status": "applied",                                     // applied | reverted | rejected | pending-checkpoint
      "checkpointApprovedBy": "dnguyen",                       // populated when status flips from pending
      "checkpointApprovedAt": "2026-05-08T15:11:02Z"
    }
  ],

  "deferred": [ /* unchanged from v4 */ ],

  "verification": { /* unchanged from v4 */ }
}
```

Validation rules:

- `schemaVersion` >= `"2.0.0"` is required when `transforms` is non-empty.
- Every `Patch.transformId` must reference a real transform in `transforms[]`. Conversely, every `Transform.patchIds` entry must reference a real patch.
- Every transform with `requiresCheckpointApproval: true` must be in `status: pending-checkpoint`, `applied`, `reverted`, or `rejected` — never any other state. The checkpoint command is the only writer of `applied` for these.
- A transform with `manifestEdited: true` must include the `imsmanifest.xml` path in its `scope.files`.

---

## Checkpoint lifecycle

Full-tier rebuilds default to checkpoint mode. The flow:

1. **Stage.** Orchestrator writes outputs to `engagements/<id>/<package>/.rebuild-staging/` instead of the package root. Staged outputs:
   - `rebuilt-staged.zip`
   - `rebuild-manifest-staged.json` (transforms in `status: pending-checkpoint`)
   - `rebuild-preview.html` (renders only the pending transforms)
2. **Render preview.** The new preview reporter renders side-by-side: original page render vs. transformed page render, plus an approval form per transform.
3. **Operator reviews.** The consultant opens `rebuild-preview.html`, reviews each transform, and decides per-transform: approve or reject.
4. **Promote.** `prism rebuild-checkpoint approve --engagement <id> --package <name> [--transform <id>...]` reads the preview's saved state file (or accepts `--transform` flags) and promotes the staged outputs:
   - Approved transforms flip to `status: applied`
   - Rejected transforms flip to `status: rejected`; their patches are reversed before the final zip is written
   - The result is moved out of `.rebuild-staging/` and replaces the package's `rebuilt.zip` and `rebuild-manifest.json`
5. **Verify post-promotion.** A final `verify()` runs against the promoted zip to confirm no regressions slipped through. If verification fails, the promotion is rolled back and the staging area is preserved.

Operator-triggered abandonment: `prism rebuild-checkpoint reject --engagement <id> --package <name>` discards the staging area entirely. No effect on the existing `rebuilt.zip` (which may have been produced by a prior safe-tier rebuild).

`--no-checkpoint` is available as a flag on `prism rebuild --mode full` for CI scenarios where a separate review process exists. **Default is always checkpoint-on.** A worker that defaults this flag to off will fail review.

---

## File map

v5 doesn't add any new top-level directories beyond `v5/`. `src/transformers/` and `src/widgets/` are new top-level subdirectories of `src/`.

### Planning artifacts (committed)

```
v5/
├── CLAUDE.md                        ← context for Claude Code workers; scoped to v5 only
├── PRD_v5_FullTier.md               ← this document
└── build/
    ├── README.md                    ← orchestration
    ├── 00-foundation.md             ← sequential prerequisite
    ├── 01-orchestrator.md           ┐
    ├── 02-component-library.md      │
    ├── 03-transformers-landmarks.md │  parallel wave 1
    ├── 04-transformers-widgets.md   │  (run in separate terminals after 00)
    ├── 05-transformer-page-split.md │  04 additionally depends on 02
    ├── 06-preview-renderer.md       ┘
    ├── 07-cli.md                    ┐
    ├── 08-checkpoint-undo.md        │  parallel wave 2 (after wave 1)
    └── 09-integration.md            ┘ final
```

### Source code (committed)

```
src/transformers/                    ← NEW directory (entire dir is v5)
├── landmark-insertion.js            ← chunk 03
├── landmark-labeling.js             ← chunk 03
├── widget-replacement-tabs.js       ← chunk 04
├── widget-replacement-accordion.js  ← chunk 04
├── widget-replacement-carousel.js   ← chunk 04
├── widget-replacement-dialog.js     ← chunk 04
└── page-split.js                    ← chunk 05

src/widgets/                         ← NEW directory (entire dir is v5)
├── tabs/{template.html, styles.css, script.js, axe-baseline.json}
├── accordion/{...}
├── carousel/{...}
├── dialog/{...}
└── tooltip/{...}                    ← shipped as a primitive used by carousel/dialog

src/rebuild/                         ← existing dir; v5 adds + extends
├── (v4 files unchanged in shape)
├── checkpoint.js                    ← NEW (chunk 08)
├── index.js                         ← MODIFIED (chunk 01) — adds full-tier dispatch
├── manifest.js                      ← MODIFIED (chunk 00) — adds transforms[] support
├── types.js                         ← MODIFIED (chunk 00) — adds Transform typedef + Patch.transformId
└── undo.js                          ← MODIFIED (chunk 08) — adds transform-atomic revert

src/reporter/                        ← existing dir; v5 adds + extends
├── (existing v4 reporters)
├── rebuild-preview.js               ← NEW (chunk 06)
└── rebuild-summary.js               ← MODIFIED (chunk 06) — adds transform counts

src/cli.js                           ← MODIFIED in chunk 07 only — adds full-mode + checkpoint commands
src/index.js                         ← MODIFIED in chunk 07 only — exports checkpoint API
```

### Tests (committed)

```
test/transformers/                   ← NEW
├── landmark-insertion.test.js
├── landmark-labeling.test.js
├── widget-replacement-tabs.test.js
├── widget-replacement-accordion.test.js
├── widget-replacement-carousel.test.js
├── widget-replacement-dialog.test.js
└── page-split.test.js

test/widgets/                        ← NEW — verifies each shipped widget passes axe baseline
└── (one test per widget — loads the template, asserts axe-baseline.json holds)

test/rebuild/                        ← existing dir; v5 adds
├── checkpoint.test.js               ← NEW (chunk 08)
└── undo-transforms.test.js          ← NEW (chunk 08) — atomic transform revert

test/reporter/                       ← existing dir; v5 adds
└── rebuild-preview.test.js          ← NEW (chunk 06)

test/integration/
├── rebuild-pipeline.test.js         ← v4 — left alone
└── rebuild-full-pipeline.test.js    ← NEW (chunk 09) — full-mode end-to-end with checkpoint

test/fixtures/                       ← existing dir; v5 adds
├── rebuild-landmark-needed.zip
├── rebuild-tabs-divsoup.zip
├── rebuild-overflowing-page.zip
└── rebuild-full-mixed.zip
```

### Runtime output (gitignored)

Per-package, alongside v4's existing files. v3 and v4 outputs are unchanged.

```
engagements/<id>/<package>/
├── original.zip
├── report.html                      ← v3 audit
├── results.json                     ← v3 audit
├── rebuilt.zip                      ← v4 (or v5-promoted)
├── rebuild-manifest.json            ← v4 (v5 may bump schemaVersion to 2.0.0)
├── rebuild-diff.html                ← v4
├── rebuild-summary.html             ← v4 (v5 extends in place)
├── rebuild-preview.html             ← v5 — present after a full-mode run
└── .rebuild-staging/                ← v5 — present while a full-mode rebuild awaits checkpoint
    ├── rebuilt-staged.zip
    ├── rebuild-manifest-staged.json
    ├── rebuild-preview.html
    └── checkpoint-state.json        ← per-transform approve/reject decisions
```

---

## CLI surface

```
prism rebuild <pkg.zip> --engagement <id> --mode full [--no-checkpoint] [--standard wcag21|wcag22] [--brand-config <path>]
prism rebuild-library <dir> --engagement <id> --mode full [--no-checkpoint] [...]

prism rebuild-checkpoint approve --engagement <id> --package <name> [--transform <id>...] [--all]
prism rebuild-checkpoint reject  --engagement <id> --package <name>
prism rebuild-checkpoint list    --engagement <id>           # lists all packages with pending checkpoints
```

- `--mode full` is the v5-specific entry. `safe` and `assisted` paths are unchanged; `full` runs every safe + assisted fixer plus every full-tier transformer, then enters checkpoint mode.
- `--no-checkpoint` skips staging and writes directly. Disabled by default; only honored when explicitly passed.
- `--all` on `approve` accepts every pending transform without reading the saved state file. Useful for dry-run smoke tests; production review should use the per-transform flow.

Exit codes:

- `0` — rebuild succeeded and (in checkpoint mode) is awaiting approval, or post-approval verification has zero remaining violations.
- `1` — rebuild succeeded but re-audit shows remaining violations (expected on most real packages).
- `2` — tool error, regression detected and rebuild halted, or checkpoint promotion failed verification.

---

## Preview report

Brand-matched HTML at `engagements/<id>/<package>/rebuild-preview.html`. Single-page, prints to PDF cleanly. Per-transform rendering, not per-patch.

Sections:

1. **Header card.** Engagement, package, mode, standard, tool version, manifest hash, generation timestamp, checkpoint state (pending / approved / rejected).
2. **Summary strip.** Transforms staged, transforms approved, transforms rejected, deferred findings, verification before/after.
3. **Filter bar.** Transform family (landmark / widget / page-split), criterion, "needs review only".
4. **Transform card list.** One card per transform:
   - Header: family chip, criteria chips, transformer id, scope (files affected, whether `imsmanifest.xml` was edited), provenance pill (rule-based / llm)
   - Side-by-side preview: rendered original on the left, rendered transformed on the right. Rendering is HTML-fragment-only — the page section that changed plus reasonable surrounding context, not the entire SCO.
   - Patch list: every patch in the transform, rendered as compact rows with file:line and a short before/after diff. Click expands to the full patch view.
   - Rationale: one paragraph from the transformer.
   - Approval form: real `<input type="radio">` for approve / reject / undecided, plus an initials text input. Saving the page persists state via `<input type="hidden">` mirrors of the radios — same pattern as v4's diff report's reject control.
5. **Method note.** Three sentences: which transformers ran, which audit standard verify used, link to `rebuild-diff.html` for per-patch detail.

**Copyright safety.** Side-by-side preview MUST render the same scoped fragment as the patches' `before` / `after` fields plus context — never the whole SCO. The renderer reads from the manifest, not from the source file.

**Self-contained.** No external CSS, JS, or fonts — same constraint as v4's reporters.

---

## Verification

v4's verify step runs unchanged. v5 adds two extra invariants enforced at checkpoint promotion:

- **Manifest XML well-formedness.** When `manifestEdited: true`, the staged `imsmanifest.xml` must parse as valid XML and validate against the SCORM 1.2 / 2004 manifest schema (whichever version the input package used). Failure aborts promotion.
- **SCO sequence integrity.** When page splitting added new SCOs, the new sequence must preserve the original's `<organization>` ordering relative to the unchanged SCOs. Failure aborts promotion.

Verification of an `imsmanifest.xml`-edited rebuild still uses the same `audit()` entry point — the audit reads the manifest from the rebuilt zip the same way it reads the input zip. No special handling.

---

## Acceptance criteria for v5

The release ships when all of the following are true:

1. `prism rebuild --mode full` and `prism rebuild-library --mode full` work end-to-end against `test/fixtures/rebuild-full-mixed.zip`. Output lands in `.rebuild-staging/`. `rebuild-preview.html` renders all three transform families.
2. `prism rebuild-checkpoint approve` promotes a staged rebuild and produces a final `rebuilt.zip` plus an updated `rebuild-manifest.json` with all approved transforms in `status: applied`.
3. `prism rebuild-checkpoint reject` discards staging without touching any prior `rebuilt.zip`.
4. `prism rebuild-undo` round-trips a v5 transform: rebuild → undo every transform → re-audit shows the un-fixed findings restored.
5. The preview report renders side-by-side for every transform in every test fixture, with rendered fragments scoped to the changed region.
6. Each `src/widgets/*` widget passes its own `axe-baseline.json` with zero violations on a static audit.
7. `npm test` passes and `npm run check-no-network` passes.
8. `--mode safe` and `--mode assisted` are unchanged in behavior — every v4 and v4.1 test still passes byte-identical output where deterministic.
9. The 9 v4 fixers and v4.1's assisted fixers all continue to produce manifest patches that round-trip through `revert()`. v5 transforms additionally round-trip through their atomic `revert()`.
10. The PRD's manifest schema v2.0.0 matches the actual emitted JSON byte-for-byte on field names and types. v4 (1.0.0) manifests still load unchanged.

---

## Risks and mitigations

- **A transform changes meaning.** Page splitting can break pacing; landmark insertion can mis-identify `<main>`; widget replacement can lose a custom interaction. Mitigation: every transform stages and renders side-by-side. The checkpoint gate is the answer; do not weaken the default.
- **`imsmanifest.xml` edits corrupt the package.** A page-split transform that drops a resource entry or breaks the organization tree produces a SCORM package the LMS can't load. Mitigation: post-promotion verification re-parses the manifest and validates against the SCORM schema; promotion is rolled back on failure. The page-split transformer's tests assert manifest well-formedness on every fixture.
- **Widget replacement loses content.** A custom carousel may have nested anchors or data-attribute-driven behavior the replacement doesn't preserve. Mitigation: each widget transformer extracts content into a structured intermediate (e.g., `[{tabLabel, panelHTML}]`) and asserts the count and HTML hashes round-trip. Failure declines the transform and emits a deferred finding.
- **LLM mode for page splitting drifts across runs.** Mitigation: cache by `(input zip sha256, transformer id, prompt template hash)` so the same engagement re-running rebuild produces identical splits. Same mechanism v4.1 introduces for assisted-tier provenance.
- **Checkpoint state file is fragile.** Operators may "Save Page As" the preview HTML at different stages; race conditions on concurrent approvals. Mitigation: state file lives in `.rebuild-staging/checkpoint-state.json`, not embedded in the HTML. The HTML is a renderer for a separate state file. The CLI command is the single writer.
- **Component library bit-rot.** Widgets ship as static templates. Browsers evolve. Mitigation: each widget includes an `axe-baseline.json` and a unit test that runs that baseline on every release of Prism. Drift fails CI.

---

## Sequencing

v5 is built across 10 prompts in `build/` (`00`–`09`). 00 is sequential. 01–06 run in parallel (with one extra dep: 04 needs 02). 07 and 08 run in parallel after wave 1 merges. 09 runs last. See `build/README.md` for orchestration. `CLAUDE.md` (this folder) governs how each worker fits into the parallel build.
