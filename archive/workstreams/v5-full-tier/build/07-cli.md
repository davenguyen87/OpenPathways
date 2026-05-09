# Chunk 07 — CLI Integration: Full Mode + Checkpoint Commands

**Workstream:** Prism v5 Full Tier
**Depends on:** 00, 01, 02, 03, 04, 05, 06 (all of wave 1)
**Parallel-safe with:** 08

---

You are wiring the v5 surface into the CLI. **You are the only chunk in v5 that modifies `src/cli.js` and `src/index.js`.** Before you write any code:

1. Read `v5/CLAUDE.md`
2. Read `v5/PRD_v5_FullTier.md` — focus on **CLI surface**, **Checkpoint lifecycle**, and **File map**
3. Read `src/cli.js` end-to-end — understand the existing `audit`, `audit-library`, `rebuild`, `rebuild-library`, and `rebuild-undo` commands. Some of those were added in v4; v4.1 may have added flags. v5 must not regress any of them.
4. Read `src/index.js` end-to-end — understand the existing exports.
5. Read `src/lib/rebuild-cli.js` (v4) — you'll extend it.
6. Read `src/rebuild/index.js` after chunk 01's modifications, `src/reporter/rebuild-preview.js` from chunk 06.

## Files to modify

- `src/cli.js` — register `prism rebuild-checkpoint` as a parent command with `approve`, `reject`, and `list` subcommands. Do not touch any other command's action function. The existing `prism rebuild` already accepts `--mode full` (v4 stubbed it, v4.1 documented it); chunk 01 made full mode functional in the orchestrator. The CLI flag wiring needs to add `--no-checkpoint` to `rebuild` and `rebuild-library`. That is a single argument addition to existing commands; do not refactor the surrounding code.
- `src/index.js` — export `checkpoint` from `./rebuild/checkpoint.js` (chunk 08) so the library entry surface includes it for `web/` and `cloud/` future adoption. Also export the preview renderer so callers can render previews from the library.

## Files to create

- `src/lib/checkpoint-cli.js` — the action functions for `rebuild-checkpoint approve|reject|list`. Mirrors the structure of `src/lib/rebuild-cli.js` (v4). Putting them in their own file keeps `cli.js` from bloating and lets you unit-test the actions independently.

## CLI surface (additions only)

Match the PRD exactly:

```
# Existing rebuild commands (v4 / v4.1) gain --no-checkpoint
prism rebuild <pkg.zip> --engagement <id> [--mode safe|assisted|full] [--no-checkpoint] [...existing flags]
prism rebuild-library <dir> --engagement <id> [--mode ...] [--no-checkpoint] [...existing flags]

# New v5 commands
prism rebuild-checkpoint approve --engagement <id> --package <name> [--transform <id>...] [--all]
prism rebuild-checkpoint reject  --engagement <id> --package <name>
prism rebuild-checkpoint list    --engagement <id>
```

Defaults:

- `--no-checkpoint` defaults to `false`. Document explicitly in `--help`: "Skip the checkpoint gate and write directly to rebuilt.zip. Default off; the checkpoint gate is on by default for full mode."
- `rebuild-checkpoint approve` requires `--engagement` and `--package`. Either `--transform <id>` (one or more) OR `--all` is required; without one, exit 2 with a clear message.
- `rebuild-checkpoint list` requires only `--engagement` and lists every package under that engagement that has a `.rebuild-staging/` directory.

## Action behavior

### `rebuild` and `rebuild-library` action extensions

Most behavior is inherited from v4 / v4.1. v5 adds:

1. When `--mode full` is passed without `--no-checkpoint`:
   - Call `rebuild()` with `opts.noCheckpoint = false`.
   - The orchestrator stages outputs under `.rebuild-staging/` (chunk 01 owns this).
   - Render `rebuild-preview.html` from the staged manifest into `.rebuild-staging/rebuild-preview.html`.
   - Print a message: "Full-tier rebuild staged. Review at <path-to-preview>. Approve with `prism rebuild-checkpoint approve --engagement <id> --package <name>`."
   - Exit 0.

2. When `--mode full` is passed with `--no-checkpoint`:
   - Call `rebuild()` with `opts.noCheckpoint = true`.
   - The orchestrator writes directly to the package root.
   - Render diff, summary, and preview reports as usual.
   - Exit per the v4 contract (0 if `verification.remaining === 0`, else 1).

3. When `--mode safe` or `--mode assisted`: behavior is unchanged from v4 / v4.1.

### `rebuild-checkpoint approve` action

1. Validate flags. Exit 2 on missing required flags.
2. Resolve `<engagementDir>/<package>/.rebuild-staging/`. If it doesn't exist, exit 2 with "no staged rebuild found for <package>".
3. Read `rebuild-manifest-staged.json` and `checkpoint-state.json` (the latter may be absent if the consultant hasn't saved review state — fall back to `--transform` flags or `--all`).
4. Determine the approve / reject decision per transform:
   - With `--all`: every pending transform → approve.
   - With `--transform <id>...`: listed ids → approve; un-listed pending transforms → reject.
   - With `checkpoint-state.json` and no flag overrides: use the file's decisions.
   - Mixed (file + flags): flags override the file per-transform. Document this precedence.
5. Call `checkpoint.promote(engagementDir, packageName, decisions, opts)` from chunk 08.
6. The promote step:
   - Approves transforms: flips `status: 'pending-checkpoint'` to `'applied'`.
   - Rejects transforms: walks each rejected transform's patches in reverse and reverts via the transformer's `revert()`. Re-packages.
   - Re-runs `verify()` against the promoted zip. If verification has regressions, the promotion is rolled back and the staging area is preserved. Exit 2 with a clear error.
   - Moves the staged zip + manifest out of `.rebuild-staging/` and replaces the package root's `rebuilt.zip` and `rebuild-manifest.json`.
   - Re-renders `rebuild-diff.html`, `rebuild-summary.html`, and `rebuild-preview.html` (the last in archive mode, since no transforms are pending).
   - Removes `.rebuild-staging/`.
7. Print a concise summary: how many transforms approved / rejected, the new verification numbers, and the path to the final artifacts.
8. Exit 0 if `verification.remaining === 0`, 1 if remaining > 0, 2 on any tool error or rolled-back promotion.

### `rebuild-checkpoint reject` action

1. Validate flags. Exit 2 on missing required flags.
2. Resolve the staging directory. If it doesn't exist, exit 2.
3. Print a confirmation prompt unless `--force` is set: "This discards every pending transform for <package> without writing them to rebuilt.zip. Continue? (y/N)". On `n` or no response, exit 0 with no changes.
4. On confirmed reject: call `checkpoint.discard(engagementDir, packageName)`. The discard step removes `.rebuild-staging/` entirely. The package's existing `rebuilt.zip` (which may have been produced by a prior safe-tier rebuild) is untouched.
5. Exit 0.

### `rebuild-checkpoint list` action

1. Validate `--engagement`.
2. Walk `engagements/<id>/` looking for any subdir containing `.rebuild-staging/`.
3. For each, print the package name, the count of pending transforms, and the staging path.
4. Exit 0 (always — listing zero is not an error).

## Tests

Create `test/lib/checkpoint-cli.test.js`:

- Action-function tests with mocked dependencies (mock `checkpoint.promote`, `checkpoint.discard`, the renderers). Assert the actions resolve paths correctly, decide approve / reject correctly under each flag combination, and write the correct artifacts in the correct order.
- `--all` approves every pending; `--transform <id>` approves only listed; mixed flags-and-file precedence works.
- Promotion failure (verification regression): the action propagates the rollback and exits 2.
- `list` returns the correct set of packages with pending checkpoints.
- `reject` without `--force` aborts on non-confirmation.

Update `test/lib/rebuild-cli.test.js` (v4 file):

- New test: `--mode full` without `--no-checkpoint` produces a staging directory and exits 0 without promoting.
- New test: `--mode full` with `--no-checkpoint` produces final artifacts directly.
- All existing v4 / v4.1 tests continue to pass.

CLI shape tests can be light: assert that `prism rebuild-checkpoint --help`, `... approve --help`, `... reject --help`, `... list --help` print the documented options.

## Constraints

- Do not modify `src/cli.js`'s existing `audit`, `audit-library`, `rebuild`, `rebuild-library`, or `rebuild-undo` action functions beyond adding the `--no-checkpoint` flag where applicable. They stay as v4 / v4.1 left them.
- Do not modify the v4 default `--standard` of any command.
- Do not introduce new runtime dependencies.
- Default `--no-checkpoint` to false. A worker that defaults it to true fails review.

## Acceptance criteria

- `npm test` passes.
- `npm run check-no-network` passes.
- `node src/cli.js rebuild-checkpoint --help`, `... approve --help`, `... reject --help`, `... list --help` print the documented options.
- A manual run end-to-end:
  1. `node src/cli.js rebuild test/fixtures/<v5-fixture>.zip --engagement smoketest --mode full` — produces a staging directory, no final rebuilt.zip.
  2. `node src/cli.js rebuild-checkpoint list --engagement smoketest` — shows the package with pending count.
  3. `node src/cli.js rebuild-checkpoint approve --engagement smoketest --package <name> --all` — promotes, produces the final artifacts, removes staging.
  4. The final state is a working rebuilt.zip with manifest schema 2.0.0 transforms in `status: 'applied'`.

## Out of scope

- Do not implement the checkpoint module itself. That's chunk 08.
- Do not write the integration test. That's chunk 09.
- Do not modify any transformer or fixer.
- Do not modify any reporter.
- Do not change CSV / SARIF / Markdown output paths.
