# Prism v5 Full-Tier Rebuild — Prompt Orchestration

Each file in this folder is a self-contained Claude Code prompt. Open it, copy the contents, paste into a fresh Claude Code terminal at the repo root, and let it run.

**Read these once before you start any prompt:**

1. `v5/CLAUDE.md` — scoped context for v5 work
2. `v5/PRD_v5_FullTier.md` — the spec
3. `v4/CLAUDE.md` and `v4/PRD_v4_Rebuild.md` — v5 extends v4; the v4 spec is still in force
4. The repo's top-level `CLAUDE.md`

## Run order

```
                                 ┌─────────────────┐
                                 │ 00-foundation   │   sequential — must complete first
                                 └────────┬────────┘
                ┌────────────┬────────────┼────────────┬─────────────┬───────────────┐
                ▼            ▼            ▼            ▼             ▼               ▼
       ┌──────────────┐┌─────────┐┌─────────────┐┌────────────┐┌─────────────┐┌────────────────┐
       │01-orchestra- ││02-comp- ││03-trans-    ││04-trans-   ││05-trans-    ││06-preview-     │
       │tor           ││onent-   ││formers-     ││formers-    ││former-      ││renderer        │
       │              ││library  ││landmarks    ││widgets     ││page-split   ││                │
       └──────┬───────┘└────┬────┘└─────┬───────┘└─────┬──────┘└──────┬──────┘└────────┬───────┘
              │             │           │      ▲       │              │                │
              │             │           │      │ 04 also depends on 02 │                │
              │             └───────────┼──────┘       │              │                │
              └─────────────────────────┴──────────────┴──────────────┴────────────────┘
                                                  ▼
                                          (wave 1 complete)
                                                  ▼
                              ┌───────────────────┴────────────────┐
                              ▼                                    ▼
                       ┌──────────────┐                    ┌─────────────────┐
                       │  07-cli      │ ◄── parallel ───► │  08-checkpoint- │
                       └──────┬───────┘                    │     undo        │
                              │                            └────────┬────────┘
                              └────────────────┬───────────────────┘
                                               ▼
                                       ┌───────────────┐
                                       │ 09-integration│
                                       └───────────────┘
```

### Sequential

- **00-foundation** must complete and merge before anything else runs. It defines the `Transform` typedef, bumps the manifest schema to 2.0.0, and adds `transformId` to `Patch`. Every later chunk imports from it.

### Parallel wave 1 (after 00)

Run these six in separate terminals. Five of the six don't touch the same files. The sixth dependency:

- **04-transformers-widgets needs 02-component-library merged first.** The widget transformers consume templates from `src/widgets/`; until that directory exists their tests can't run. If you start them concurrently, expect 04 to block on its first widget-loading test.

Files each chunk owns:

- **01-orchestrator** — `src/rebuild/index.js` (extends), no other shared file
- **02-component-library** — `src/widgets/**`, `test/widgets/**` (entirely new)
- **03-transformers-landmarks** — `src/transformers/landmark-insertion.js`, `src/transformers/landmark-labeling.js`
- **04-transformers-widgets** — `src/transformers/widget-replacement-*.js` (one file per widget family)
- **05-transformer-page-split** — `src/transformers/page-split.js`, `src/lib/manifest-xml-editor.js` (helper)
- **06-preview-renderer** — `src/reporter/rebuild-preview.js`, plus a small extension to `src/reporter/rebuild-summary.js` (single-line addition; the only shared edit in wave 1)

### Parallel wave 2 (after wave 1 merges)

- **07-cli** — registers `--mode full` and `prism rebuild-checkpoint` subcommands. Touches `src/cli.js` and `src/index.js`. Single owner of those files.
- **08-checkpoint-undo** — `src/rebuild/checkpoint.js` (new) and extends `src/rebuild/undo.js` to handle transform-atomic revert. 08 owns the undo extension; 07 must not touch undo.

These two run in parallel because 07 owns the CLI surface and 08 only adds new modules + extends undo.

### Final

- **09-integration** — fixtures + end-to-end test. Run after 07 and 08 merge.

## File-conflict rules (this is what makes parallelism safe)

- Only **00** modifies `src/rebuild/types.js` and `src/rebuild/manifest.js`.
- Only **01** modifies `src/rebuild/index.js`.
- Only **06** modifies `src/reporter/rebuild-summary.js` (single-line transform-counts addition).
- Only **07** modifies `src/cli.js` and `src/index.js`.
- Only **08** modifies `src/rebuild/undo.js`.
- Every other prompt creates new files only. No exceptions.
- If a worker thinks it needs to edit a shared file outside its declared ownership, stop and surface it to the human running the build. The prompt is wrong, not the rule.

## How to launch a prompt

```bash
# In a fresh terminal at the repo root
cat v5/build/00-foundation.md | pbcopy
# then paste into Claude Code
```

Or just open the file and copy it manually. Same outcome.

## Acceptance bar across all prompts

- `npm test` passes
- `npm run check-no-network` passes
- Files created/modified match the prompt's stated list exactly
- Public shapes match the manifest schema in `PRD_v5_FullTier.md` § "Manifest schema v2.0.0" byte-for-byte on field names
- Transforms round-trip atomically (apply → revert → byte-identical original) on every fixture
- The default checkpoint gate stays on for `--mode full`. A worker that defaults `--no-checkpoint` to true fails review.
