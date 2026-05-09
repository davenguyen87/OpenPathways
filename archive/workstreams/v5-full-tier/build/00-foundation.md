# Chunk 00 — Foundation: Transform type, manifest schema 2.0.0, Patch.transformId

**Workstream:** Prism v5 Full Tier
**Depends on:** v4 merged, v4.1 merged (the assisted tier glue is already in place from v4.1 and v5 must not regress it)
**Blocks:** every other v5 chunk
**Parallel-safe with:** nothing — this is sequential

---

You are picking up the foundation chunk of the Prism v5 Full-Tier workstream. Before you write any code:

1. Read `v5/CLAUDE.md`
2. Read `v5/PRD_v5_FullTier.md` — pay particular attention to **Transformer interface** and **Manifest schema v2.0.0**
3. Read `src/rebuild/types.js` end-to-end to understand the v4 typedefs and helpers you'll extend
4. Read `src/rebuild/manifest.js` end-to-end to understand the v4 manifest read/write/validate surface
5. Read one v4 fixer (e.g., `src/fixers/add-alt-decorative.js`) to confirm the fixer interface you must NOT alter — v5 adds a parallel Transformer interface; fixers are unchanged

This chunk does three things, and nothing else:

1. Adds the `Transform` typedef and the `Transformer` interface contract to `src/rebuild/types.js`.
2. Bumps `src/rebuild/manifest.js` to schema 2.0.0 with a `transforms[]` block, plus `addTransform` / `linkPatchToTransform` helpers.
3. Adds the `transformId` field to the `Patch` typedef (optional; required only when `tier === 'full'`).

It is the only chunk in v5 that modifies the shared types and manifest modules. Every later chunk creates new files only (with the documented exceptions for chunks 01, 06, 07, 08).

## Files to modify

### `src/rebuild/types.js`

Add typedefs for the new shapes. Match `PRD_v5_FullTier.md` § "Manifest schema v2.0.0" verbatim:

- `Transform` — `{ id, transformer, family, criteria, tier, scope, patchIds, provenance, rationale, previewPath, requiresCheckpointApproval, status, checkpointApprovedBy?, checkpointApprovedAt? }`
- `TransformScope` — `{ files: string[], manifestEdited: boolean }`
- Extend `Patch` with `transformId?: string` (optional). Existing v4 / v4.1 patches that lack this field continue to validate.

Also add a small runtime helper:

- `linkPatchToTransform(patch, transformId)` — pure function. Returns a new patch object with `transformId` set. Does not mutate.

Do NOT change any existing v4 helper. `offsetToLineCol`, `captureContext`, `buildPatch`, `revertPatch`, `applyMods`, `PATCH_CONTEXT_CHARS` stay byte-identical. v4.1 added at most a `provenance.model` field on the `Provenance` typedef — leave that alone.

### `src/rebuild/manifest.js`

Bump `schemaVersion` writing default to `"2.0.0"`. Manifests that read `"1.0.0"` continue to validate (treat `transforms` as optional and default to `[]` on read).

Add:

- `addTransform(manifest, transform)` — appends a transform, assigns it the next sequential id (`transform-0001` format), validates required fields. Adds the transform's `id` to every patch listed in `transform.patchIds` via `linkPatchToTransform` (fail if any of those patch ids don't exist).
- Extend `validateManifest`:
  - When `schemaVersion >= "2.0.0"` and `transforms` is non-empty:
    - Every `Transform.patchIds` entry must reference a real patch in `patches[]`.
    - Every `Patch.transformId` must reference a real transform.
    - A transform with `requiresCheckpointApproval: true` must have `status` in `{ pending-checkpoint, applied, reverted, rejected }`.
    - A transform with `scope.manifestEdited: true` must include an `imsmanifest.xml` path in `scope.files`.
  - All v4 validations continue to apply.
- `readManifest` accepts both `"1.0.0"` and `"2.0.0"` schemaVersions. A 1.0.0 manifest is read as if `transforms = []`. Writing always emits the highest version that the manifest's content requires (1.0.0 if no transforms; 2.0.0 if `transforms` is non-empty).

Do NOT change `createManifest` callers. Add a new optional argument `opts.schemaVersion` defaulting to the right version based on whether the rest of the orchestrator wants 2.0.0 — but the safe path is: `createManifest` defaults to 1.0.0 (so v4 / v4.1 callers keep their byte-identical output), and chunk 01 bumps to 2.0.0 by passing the option when full-tier transforms are dispatched.

## Files to create

None. This chunk is purely modifications to existing files.

## Implementation notes

- The Transformer interface is documented in `PRD_v5_FullTier.md` § "Transformer interface" but is not implemented as a runtime base class. There is no `class Transformer` in this chunk. Like fixers, transformers are duck-typed objects that the orchestrator's registry walks — this chunk only documents the shape via JSDoc.
- The `Transform` shape MUST match the PRD verbatim on field names. Schemas are contracts; do not improvise.
- `linkPatchToTransform` is pure (returns a new object). The mutation happens inside `addTransform` after collecting the new patch references.
- The schema-version-bump logic must be testable: a manifest with no transforms writes as `"1.0.0"`; the same manifest with one transform appended via `addTransform` writes as `"2.0.0"`.
- v4 / v4.1 tests must keep passing byte-identical — if any v4 test reads back a manifest and asserts `schemaVersion === "1.0.0"`, your changes must not break it.

## Tests

Update `test/rebuild/manifest.test.js`:

- New test: `addTransform` assigns sequential ids, links every listed patch via `transformId`, validates required fields.
- New test: validation rejects a transform whose `patchIds` references a missing patch with a specific error.
- New test: validation rejects a patch whose `transformId` references a missing transform.
- New test: `validateManifest` rejects a transform with `requiresCheckpointApproval: true` in status `applied-direct` (an invalid status).
- New test: a manifest with `manifestEdited: true` but no `imsmanifest.xml` in `scope.files` fails validation.
- New test: round-trip — a manifest with one transform writes and reads back equal, schemaVersion `"2.0.0"`.
- New test: a manifest with zero transforms writes as `schemaVersion "1.0.0"` and reads back equal (back-compat invariant).
- All existing v4 / v4.1 tests still pass.

Add a small standalone test for the new `types.js` helpers if it doesn't already exist (`test/rebuild/types.test.js`):

- `linkPatchToTransform` is pure: input patch is unchanged; output has the new `transformId`.

## Acceptance criteria

- `npm test` passes — including every existing v4 and v4.1 manifest test, byte-identical where deterministic.
- `npm run check-no-network` passes.
- The PRD's manifest schema v2.0.0 and the actual `addTransform` + `validateManifest` behaviour match field-for-field.
- A manifest with no transforms writes byte-identical output to v4 (schema 1.0.0). v4.1's manifest tests still pass byte-identical.
- A manifest with one transform writes a 2.0.0 manifest that validates clean and reads back equal.

## Out of scope

- Do not write the orchestrator's full-tier dispatch. That's chunk 01.
- Do not write any transformer. Chunks 03, 04, 05 do that.
- Do not write the checkpoint module. That's chunk 08.
- Do not write the preview renderer. That's chunk 06.
- Do not modify `src/cli.js` or `src/index.js`. Chunk 07 owns those.
- Do not modify any fixer. v5 does not change the fixer interface.
- Do not introduce a runtime base class for transformers. Duck-typed objects only.
