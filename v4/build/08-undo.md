# Chunk 08 — Undo Command and Module

**Workstream:** Prism v4 Rebuild
**Depends on:** 00-foundation, 01-orchestrator (you need the manifest format and the packager)
**Parallel-safe with:** 07

---

You are building the undo path that lets a consultant reverse selected patches without re-running the full rebuild. Before you write any code:

1. Read `v4/CLAUDE.md`
2. Read `v4/PRD_v4_Rebuild.md` — focus on **CLI surface** (`prism rebuild-undo`), **Manifest schema** (the `status` field on patches)
3. Read `src/rebuild/manifest.js` from chunk 00 — you'll use `readManifest`, `writeManifest`, `validateManifest`
4. Read `src/rebuild/packager.js` from chunk 01 — you'll use `unpack` and `pack`
5. Read any one of the modified fixers from chunk 00 to confirm the `revert(file, patch)` shape

## Files to create

### `src/rebuild/undo.js`

Exports `async function undo(engagementDir, packageName, patchIds, opts)`.

Behavior:

1. **Load** the manifest at `<engagementDir>/<packageName>/rebuild-manifest.json`.
2. **Validate** that every requested `patchIds` entry exists in the manifest with `status: 'applied'`. If any are already reverted or rejected, refuse with a clear error message that lists which.
3. **Unpack** the current `rebuilt.zip` into a temp dir.
4. **Group requested patches by file**, then iterate each affected file:
   - Load the file content
   - For each patch in *reverse application order*, look up the fixer by `patch.fixer`, call its `revert(file, patch)` method
   - Write the reverted content back
5. **Re-pack** the directory back to `rebuilt.zip`. Update `outputZipSha256` in the manifest.
6. **Update each patch's `status`** to `'reverted'`. Append a top-level `revertHistory` entry capturing what was reverted, when, and by which user (read `os.userInfo().username`).
7. **Re-run verification** by calling `verify` (from chunk 02) on the new rebuilt.zip. Update `manifest.verification`.
8. **Re-render** the diff and summary HTML so they reflect the new state.
9. Return `{ manifest, rebuiltZipPath, reverted: patchIds }`.

### CLI integration

This chunk also adds the `prism rebuild-undo` subcommand. **Coordinate with chunk 07** — chunk 07 owns `src/cli.js`. The agreed split:

- Chunk 07 reserves space for `rebuild-undo` registration and adds a single line: `require('./lib/rebuild-cli').registerUndo(program)` after the existing command registrations.
- Chunk 08 implements `registerUndo(program)` inside `src/lib/rebuild-cli.js` (the file chunk 07 created).

If chunk 07 hasn't merged yet when you start, write the implementation in a separate file `src/lib/rebuild-undo-cli.js` and document the merge step. The integration test in chunk 09 will surface the wiring.

CLI surface (matches the PRD):

```
prism rebuild-undo --engagement <id> --package <name> --patch <id> [--patch <id>...]
```

The action:

1. Validates required flags.
2. Calls `undo(engagementDir, packageName, patchIds, opts)`.
3. Logs a concise summary: which patches were reverted, the new verification numbers.
4. Exits 0 on success, 1 if the resulting rebuilt zip still has remaining violations (expected and not an error), 2 on tool error.

## Constraints

- **Round-trip integrity.** A patch applied then reverted must produce content byte-identical to the original. The integration test in chunk 09 will run apply → undo and assert this against fixtures.
- **No silent fixer drift.** If a patch references a fixer that no longer exists in `src/fixers/` (e.g., a fixer was renamed between rebuild and undo), refuse with a clear error rather than guessing. The manifest's `fixer` field is a hard reference.
- **Re-verify after undo.** Reverting patches changes the compliance state. Always re-run `verify` and update the manifest before exiting.
- **No outbound network calls.**

## Tests

Create `test/rebuild/undo.test.js`:

- Apply a fixture's rebuild → undo one patch → assert that patch's content reverts byte-identical to the original, the manifest's `status` is `'reverted'`, the verification numbers reflect the un-fix.
- Undo all patches → the rebuilt zip is byte-equivalent to the original input (use the packager's round-trip invariant: file bytes equal, zip metadata may differ).
- Refuse to undo a patch that's already reverted.
- Refuse to undo when the manifest references a fixer that doesn't exist.
- Multi-patch undo on the same file: revert in reverse application order produces the correct intermediate state.

## Acceptance criteria

- `npm test` passes for `test/rebuild/undo.test.js`.
- `npm run check-no-network` passes.
- `node src/cli.js rebuild-undo --help` documents the flags. (Requires chunk 07 to have merged; if it hasn't, document this dependency in the test plan.)

## Out of scope

- Do not modify the orchestrator (chunk 01).
- Do not modify any fixer.
- Do not implement consumption of the diff report's `<input type="hidden" name="rejected">` state file. v4.1 will add `--reject-state <file>` that builds on this command.
- Do not modify `src/cli.js` directly — work through `src/lib/rebuild-cli.js`'s exported `registerUndo` per the coordination with chunk 07.
