# Chunk 00 — Foundation: Patch types + Manifest + Fixer interface v2

**Workstream:** Prism v4 Rebuild
**Depends on:** nothing
**Blocks:** every other chunk
**Parallel-safe with:** nothing — this is sequential

---

You are picking up the foundation chunk of the Prism v4 Rebuild workstream. Before you write any code:

1. Read `v4/CLAUDE.md`
2. Read `v4/PRD_v4_Rebuild.md` — pay particular attention to **Fixer interface v2** and **Manifest schema**
3. Read `src/fixers/add-alt-decorative.js` to understand the existing fixer shape
4. Skim every other file in `src/fixers/` to understand the variations you'll need to update

This chunk does two things, and nothing else:

1. Defines the shared types every other rebuild chunk depends on (`Patch`, `RebuildManifest`).
2. Extends the fixer interface across **all 9 existing fixers** so they emit `Patch` objects and can `revert()` what they applied.

It is the only chunk in v4 that modifies existing fixer files. Every later chunk creates new files only. Get this right and the rest of the workstream parallelizes cleanly.

## Files to create

### `src/rebuild/types.js`

JSDoc typedefs for the shared shapes. No runtime code. Other modules `require` this file and reference the typedefs in JSDoc comments. Define `Patch`, `RebuildManifest`, `Provenance`, `Verification`, `DeferredFinding` matching the schema in the PRD § "Manifest schema" verbatim — same field names, same types, same nesting.

### `src/rebuild/manifest.js`

CommonJS module exporting:

- `createManifest(opts)` — returns a fresh `RebuildManifest` with empty `patches`, `deferred`, and `verification` populated from input zip hash, engagement, mode, standard, etc.
- `addPatch(manifest, patch)` — appends a patch, assigns it the next sequential id (`patch-0001` format), validates required fields.
- `addDeferred(manifest, finding)` — appends a deferred finding.
- `setVerification(manifest, before, after)` — populates the `verification` block, computes `resolved` / `introduced` / `remaining`.
- `writeManifest(manifest, path)` — serializes to JSON, pretty-printed, deterministic key order.
- `readManifest(path)` — loads, validates against the schema, throws on invalid.
- `validateManifest(manifest)` — pure validator. Returns `{ valid: boolean, errors: string[] }`.

Validation must reject manifests with missing required fields, wrong types, or unknown top-level keys. No third-party schema library — write the validator by hand against the PRD schema. It's small enough.

## Files to modify

Every fixer in `src/fixers/`:

- `add-alt-decorative.js`
- `add-autocomplete-password.js`
- `add-html5-doctype.js`
- `add-iframe-title.js`
- `add-lang-attribute.js`
- `add-skip-link.js`
- `add-tabindex-keyboard.js`
- `add-title.js`
- `repair-viewport-scale.js`

For each fixer:

1. **Rename `fix()` to `apply()`.** Same signature, same behavior, but in addition to `{ changed, newContent, log }` it now returns `patches: Patch[]` — one `Patch` per discrete change.
2. **Add `revert(file, patch)`.** Given the file's current content and a single Patch this fixer emitted, return `{ newContent, log }` with that change reversed. Use the patch's `before`/`after` and `range` to do the reversal.
3. **Add the new metadata fields:** `triage` (matches the v3 triage taxonomy — for the existing 9, all are `"auto-fix safe"`), `tier: 'safe'`, `provenance: 'deterministic'`.
4. **Backward compatibility:** keep a `fix()` shim that calls `apply()` and returns the legacy `{ changed, newContent, log }` shape. v3 callers (the existing audit `--fix` mode) keep working unchanged.

## Implementation notes

- Each `Patch` needs `range` with `startLine`, `startCol`, `endLine`, `endCol`. The current fixers operate on raw strings; you'll need to convert positions. Write a tiny helper in `src/rebuild/types.js` (`offsetToLineCol(content, offset)`) and use it.
- `apply()` must produce stable, replayable patches. If the same fixer runs twice on the same input, the resulting `Patch` ids and ranges must be identical. Don't include timestamps inside the patch body itself; timestamps live in `provenance`.
- `revert()` must round-trip: applying then reverting yields content byte-identical to the original. The integration test in chunk 09 will assert this.
- The `before` and `after` fields capture the local diff context (the changed range plus a few characters of leading/trailing context for the diff renderer). Don't embed entire files; the diff report must not become a copyright-reproduction surface.

## Tests

Create `test/rebuild/manifest.test.js`:

- `createManifest` returns a manifest that passes `validateManifest`.
- `addPatch` assigns sequential ids and validates required fields.
- `setVerification` computes derived fields correctly.
- `writeManifest` + `readManifest` round-trip.
- `validateManifest` rejects each missing required field with a specific error.

Update existing fixer tests to assert the new shape. For each fixer:

- `apply()` returns the new patch array with correctly populated fields.
- `revert()` round-trips: original → apply → revert → original (byte-identical).
- The `fix()` shim returns the legacy shape unchanged.

## Acceptance criteria

- `npm test` passes.
- `npm run check-no-network` passes.
- Every fixer in `src/fixers/` has `apply`, `revert`, and a `fix` shim.
- Every fixer's `apply()` emits at least one `Patch` per change with all required fields populated.
- `validateManifest` produces specific error messages for every required field.
- The PRD's manifest schema and the actual `createManifest` output match field-for-field.

## Out of scope

- Do not write the orchestrator. That's chunk 01.
- Do not write the verify, undo, or any reporter. Those are later chunks.
- Do not add new fixers. Chunks 03 and 04 do that.
- Do not touch `src/cli.js` or `src/index.js`. Chunk 07 owns those.
