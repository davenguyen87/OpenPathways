# Chunk 08 — Checkpoint Module + Transform-Atomic Undo

**Workstream:** Prism v5 Full Tier
**Depends on:** 00-foundation, 01-orchestrator (you need the manifest schema 2.0.0 and the staging branch)
**Parallel-safe with:** 07

---

You are building the checkpoint module that promotes staged rebuilds to final and extending undo to handle transforms atomically. Before you write any code:

1. Read `v5/CLAUDE.md`
2. Read `v5/PRD_v5_FullTier.md` — focus on **Checkpoint lifecycle** and **Verification** (the new invariants enforced at promotion)
3. Read `src/rebuild/manifest.js` after chunk 00's modifications — you'll use `readManifest`, `writeManifest`, `validateManifest`, `addTransform`, and the new schema 2.0.0 helpers
4. Read `src/rebuild/packager.js` (v4) — you'll use `unpack` and `pack`
5. Read `src/rebuild/undo.js` (v4) — you're extending this file
6. Read `src/rebuild/verify.js` (v4) — promotion calls verify
7. Read one transformer from chunks 03 / 04 / 05 to confirm the `revert(packageContext, transform)` shape

## Files to create

### `src/rebuild/checkpoint.js`

Exports:

- `async function promote(engagementDir, packageName, decisions, opts)` — promotes a staged rebuild to final per the decisions object.
  - `decisions` is `{ [transformId]: 'approve' | 'reject' }`. Every pending transform must appear in decisions; if any are missing, the function throws.
  - Behavior:
    1. Load `<engagementDir>/<packageName>/.rebuild-staging/rebuild-manifest-staged.json`.
    2. Validate every decision targets a real transform in `status: 'pending-checkpoint'`. Throw on mismatch.
    3. Unpack `rebuilt-staged.zip` to a temp dir.
    4. **Process rejections.** For each rejected transform, call its `revert(packageContext, transform)` and write the reverted file content back to the temp dir. Update each affected patch's status to `'rejected'`.
    5. Re-pack the temp dir to a new `rebuilt.zip` candidate (still in temp).
    6. Run `verify()` on the candidate. If regressions exist or verification fails, abort: leave the staging directory intact, do not write final artifacts, return `{ promoted: false, reason }`.
    7. **Manifest XML well-formedness check.** For any transform with `scope.manifestEdited: true` that was approved, re-validate `imsmanifest.xml` against the SCORM schema. Failure = abort + rollback per (6).
    8. **SCO sequence integrity check.** For any approved page-split transform, validate the new SCO sequence per the PRD's invariant. Failure = abort + rollback.
    9. Move the candidate zip to `<engagementDir>/<packageName>/rebuilt.zip`.
    10. Update the manifest:
        - Approved transforms: `status: 'applied'`, populate `checkpointApprovedBy` (from `os.userInfo().username`) and `checkpointApprovedAt` (ISO timestamp).
        - Rejected transforms: `status: 'rejected'`, populate the same approval audit fields with the rejector's identity.
        - Patches' status updated accordingly.
    11. Write the final manifest to `<engagementDir>/<packageName>/rebuild-manifest.json`.
    12. Remove `.rebuild-staging/`.
    13. Return `{ promoted: true, approvedTransforms: [...], rejectedTransforms: [...], verificationAfter }`.

- `async function discard(engagementDir, packageName)` — removes `.rebuild-staging/` entirely. Idempotent: returns `{ discarded: false }` if no staging directory exists, `{ discarded: true }` after removal.

- `async function listPending(engagementDir)` — walks `engagementDir` for subdirs containing `.rebuild-staging/`, returns `[{ packageName, pendingCount, stagingPath }]`. Used by the `prism rebuild-checkpoint list` action.

- `async function readCheckpointState(stagingDir)` — reads `checkpoint-state.json` if present, returns `{ [transformId]: 'approve' | 'reject' }` or `null`. The state file format is documented below.

### `checkpoint-state.json` format

A small JSON file under `.rebuild-staging/` that the consultant can edit by hand or that future tooling can write:

```jsonc
{
  "stateVersion": "1.0.0",
  "manifestHash": "<sha256 of rebuild-manifest-staged.json at time of write>",
  "decisions": {
    "transform-0001": "approve",
    "transform-0002": "reject",
    "transform-0003": "approve"
  },
  "decidedBy": "dnguyen",
  "decidedAt": "2026-05-08T15:11:02Z"
}
```

Validation:

- `manifestHash` must match the current staged manifest's hash. If it doesn't, the state file is stale (the rebuild was re-run) — return `null` so the caller falls back to `--transform` flags or `--all`.
- Every key in `decisions` must reference a real transform.
- Every value must be `'approve'` or `'reject'`.

## Files to modify

### `src/rebuild/undo.js`

Extend the v4 undo module to handle transform-atomic revert:

1. **New parameter shape.** `undo(engagementDir, packageName, ids, opts)` where `ids` is now either:
   - `{ patches: ['patch-0001', ...] }` — original v4 behavior, undoes individual patches
   - `{ transforms: ['transform-0001', ...] }` — undoes every patch in each named transform atomically
   - `{ patches: [...], transforms: [...] }` — both, in any combination

2. **Refuse mixed-state errors.** If `ids.patches` references a patch that belongs to a transform AND the transform isn't in `ids.transforms`, refuse. The caller must either undo the transform whole or none of it. Document this in the error message: "patch <id> belongs to transform <id>; pass --transform <transform-id> instead of --patch <patch-id>, or include all of the transform's other patches".

3. **Atomic transform revert.** For each transform id in `ids.transforms`:
   - Load the transformer module by `transform.transformer`.
   - Build a `packageContext` from the unpacked rebuilt zip.
   - Call `transformer.revert(packageContext, transform)`.
   - Update every patch's status to `'reverted'`.
   - Update the transform's status to `'reverted'`.

4. **Re-verify after undo** as v4 already does.

5. **Append a `revertHistory` entry** as v4 already does, with an additional field `revertedTransforms: [...]` listing transform ids that were reverted.

The v4 `undo` callers (passing `patchIds: [...]`) continue to work — preserve back-compat by accepting both the legacy positional form and the new object form. Document the deprecation path in a comment if you keep the legacy form, but don't break v4's tests.

## CLI integration with chunk 07

This chunk wires nothing into the CLI directly. Chunk 07 owns `src/cli.js`. The agreed split:

- Chunk 07 imports `require('./rebuild/checkpoint')` and uses it from `src/lib/checkpoint-cli.js`.
- Chunk 07 imports the extended `undo` from `./rebuild/undo` and updates `src/lib/rebuild-cli.js`'s undo action to accept `--transform <id>` flags in addition to `--patch <id>`.

If chunk 07 is in flight when you finish chunk 08, surface the import path you expect chunk 07 to use; do not modify `src/cli.js` from this chunk.

## Constraints

- **Round-trip integrity.** A transform applied then reverted must produce content byte-identical to the original. The integration test in chunk 09 will run apply → undo and assert this against fixtures.
- **No silent fixer / transformer drift.** If a transform references a transformer that no longer exists in `src/transformers/` (e.g., renamed between rebuild and promotion), refuse with a clear error.
- **Re-verify after every state change.** Promotion and undo both re-run `verify()` and update the manifest.
- **No outbound network calls.**
- **Manifest XML and SCO sequence checks at promotion are non-optional.** A worker that skips them fails review.

## Tests

Create `test/rebuild/checkpoint.test.js`:

- Promote with all-approve: every pending transform becomes `applied`, manifest is at the package root, staging directory is removed.
- Promote with mixed approve / reject: rejected transforms are reverted, approved ones are applied, the resulting zip's contained file bytes match what was approved minus what was rejected.
- Promotion fails verification: the staging directory is preserved, no final artifacts are written, the function returns `{ promoted: false, reason }`.
- Promotion fails manifest-XML well-formedness: same — preserve staging, return failure reason.
- Discard: idempotent, removes staging without touching the package root.
- `listPending`: returns every package with a staging dir under the engagement.
- `readCheckpointState`: stale state (manifestHash mismatch) returns `null`. Valid state returns parsed decisions.

Create `test/rebuild/undo-transforms.test.js`:

- Undo a transform: every patch in the transform reverts atomically; the rebuilt zip's contained file bytes for the transformed files equal the original.
- Refuse to undo a single patch that belongs to a transform without including the transform.
- Mixed undo: some patches (no transform) plus some transforms — both succeed in one call.
- Verification re-runs after undo and the manifest reflects the new state.
- v4 back-compat: calling `undo(engagementDir, packageName, ['patch-0001'])` (the legacy positional form) still works.

## Acceptance criteria

- `npm test` passes for both new test files and every existing v4 undo test.
- `npm run check-no-network` passes.
- A round-trip on a v5 fixture (rebuild → promote → undo every transform) yields a package whose contained file bytes equal the original input.
- The promotion path's verification, manifest-XML, and SCO-sequence invariants are exercised by tests; each invariant has a passing case and a failing case.

## Out of scope

- Do not modify the orchestrator (chunk 01).
- Do not modify any transformer or fixer.
- Do not implement the CLI commands. Chunk 07 owns the wiring.
- Do not implement consumption of the diff report's `<input type="hidden">` reject state file from v4. v5's checkpoint state file is a separate concern; the diff report's reject state file is unchanged.
- Do not modify `src/cli.js`. Chunk 07 owns it.
