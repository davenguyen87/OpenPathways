# Prism v4 Rebuild — Prompt Orchestration

Each file in this folder is a self-contained Claude Code prompt. Open it, copy the contents, paste into a fresh Claude Code terminal at the repo root, and let it run.

**Read these once before you start any prompt:**

1. `v4/CLAUDE.md` — scoped context for v4 work
2. `v4/PRD_v4_Rebuild.md` — the spec
3. The repo's top-level `CLAUDE.md`

## Run order

```
                                 ┌─────────────────┐
                                 │ 00-foundation   │   sequential — must complete first
                                 └────────┬────────┘
                ┌────────────┬────────────┼────────────┬─────────────┬───────────────┐
                ▼            ▼            ▼            ▼             ▼               ▼
       ┌──────────────┐┌─────────┐┌────────────┐┌────────────┐┌─────────────┐┌────────────────┐
       │01-orchestra- ││02-verify││03-fixers-a ││04-fixers-b ││05-diff-     ││06-summary-     │
       │tor           ││         ││            ││            ││report       ││report          │
       └──────┬───────┘└────┬────┘└─────┬──────┘└─────┬──────┘└──────┬──────┘└────────┬───────┘
              └─────────────┴───────────┴─────────────┴──────────────┴────────────────┘
                                                  ▼
                                          (wave 1 complete)
                                                  ▼
                              ┌───────────────────┴────────────────┐
                              ▼                                    ▼
                       ┌──────────────┐                    ┌───────────────┐
                       │  07-cli      │ ◄── must complete  │  08-undo      │
                       └──────┬───────┘     before 09       └───────┬───────┘
                              └────────────────┬───────────────────┘
                                               ▼
                                       ┌───────────────┐
                                       │ 09-integration│
                                       └───────────────┘
```

### Sequential

- **00-foundation** must complete and merge before anything else runs. It defines the shared types and modifies all 9 existing fixers. Every later chunk imports from it.

### Parallel wave 1 (after 00)

Run these six in separate terminals at the same time. None of them touch the same files.

- **01-orchestrator** — `src/rebuild/{index,packager}.js`
- **02-verify** — `src/rebuild/verify.js`
- **03-fixers-a** — three new mechanical fixers
- **04-fixers-b** — three more new mechanical fixers
- **05-diff-report** — `src/reporter/rebuild-diff.js`
- **06-summary-report** — `src/reporter/rebuild-summary.js`

### Parallel wave 2 (after wave 1 merges)

- **07-cli** — registers rebuild commands. Touches `src/cli.js` and `src/index.js`. Single owner of those files.
- **08-undo** — `src/rebuild/undo.js`. Does not touch the CLI.

These two can run in parallel because 07 owns the CLI surface and 08 only adds a new module 07 will import.

### Final

- **09-integration** — fixtures + end-to-end test. Run after 07 and 08 merge.

## File-conflict rules (this is what makes parallelism safe)

- Only **00** modifies existing fixer files (`src/fixers/*.js`).
- Only **07** modifies `src/cli.js` and `src/index.js`.
- Every other prompt creates new files only. No exceptions.
- If a worker thinks it needs to edit a shared file, stop and surface it to the human running the build. The prompt is wrong, not the rule.

## How to launch a prompt

```bash
# In a fresh terminal at the repo root
cat v4/build/00-foundation.md | pbcopy
# then paste into Claude Code
```

Or just open the file and copy it manually. Same outcome.

## Acceptance bar across all prompts

- `npm test` passes
- `npm run check-no-network` passes
- Files created/modified match the prompt's stated list exactly
- Public shapes match the manifest schema in `PRD_v4_Rebuild.md` byte-for-byte on field names
