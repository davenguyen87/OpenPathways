# Chunk 01 — Orchestrator: Full-Tier Dispatch + Staging

**Workstream:** Prism v5 Full Tier
**Depends on:** 00-foundation (must be merged)
**Parallel-safe with:** 02, 03, 04, 05, 06

---

You are extending the rebuild orchestrator to dispatch full-tier transformers and to stage outputs when full mode is active. Before you write any code:

1. Read `v5/CLAUDE.md`
2. Read `v5/PRD_v5_FullTier.md` — focus on **Architecture**, **Transformer interface**, and **Checkpoint lifecycle**
3. Read `src/rebuild/index.js` end-to-end. v4's orchestrator is your starting point; v5 adds full-tier dispatch and staging.
4. Read `src/rebuild/manifest.js` after chunk 00's modifications to confirm the `addTransform` API
5. Read `src/rebuild/packager.js` (v4) — you'll reuse `unpack`, `pack`, `sha256`

## Files to modify

- `src/rebuild/index.js` — add full-tier dispatch and the staging branch.

You are the **only** chunk in v5 that modifies `src/rebuild/index.js`. Do not extract helpers into other files unless those helpers are pure and live in `src/lib/` — and even then, prefer keeping the orchestrator self-contained the way v4 left it.

## Files to create

- `src/lib/transformer-registry.js` — pure module that scans `src/transformers/` for full-tier transformers, deduplicates, and returns them sorted by id. Mirrors the fixer-loading pattern already inlined in `src/rebuild/index.js`'s `loadFixers`. Extracted because the orchestrator now loads two registries (fixers + transformers) and inlining both bloats the file.

## What to add to the orchestrator

### Tier dispatch (replaces the v4 stub)

The v4 orchestrator short-circuits on `mode: 'assisted'` and `mode: 'full'` with a deferred-feature notice. After v4.1 merged, `assisted` was wired up. v5 wires `full`:

1. **`mode === 'safe'`** — unchanged from v4.
2. **`mode === 'assisted'`** — unchanged from v4.1.
3. **`mode === 'full'`** — runs every safe + assisted fixer first, then every full-tier transformer, then enters the staging branch (unless `opts.noCheckpoint === true`).

Order matters. Transformers run *after* fixers because some transforms depend on the post-fix DOM (e.g., a landmark transformer reads the labels assisted-tier added). Document this order with a one-line code comment.

### Transformer dispatch

After fixers complete and the per-file apply pass finishes, run a transformer pass:

1. Load the transformer registry via `src/lib/transformer-registry.js`. Filter to `tier: 'full'` (it always is, but the filter is defensive).
2. Build a `packageContext` object capturing the extracted package state. Suggested shape:

   ```js
   {
     rootDir: string,            // path to the extracted package
     manifestXml: string,        // imsmanifest.xml content (parsed once and shared)
     manifestPath: string,       // absolute path inside rootDir
     packageType: 'scorm12'|'scorm2004'|...,
     files: { path, content, mime }[],   // every file under rootDir, post-fix
     auditFindings: AuditFinding[],
     log: (msg) => void
   }
   ```

3. For each transformer in the registry, call `canTransform(packageContext)`. If true, call `apply(packageContext)`.
4. Each transform's `apply` returns `{ transform, patches[], log[] }`. Add the transform via `addTransform(manifest, transform)`. Add each patch via `addPatch` — the patches' `transformId` is already populated by the transformer.
5. Write each patch's `after` content back to the file in the staging area.
6. **Validate per transform.** After each transform applies, re-parse every file the transform touched (HTML reparses, JSON parses, manifest XML parses). If any file is invalid, drop the entire transform: revert its patches by walking them in reverse and using the `before` strings, remove the transform from the manifest, and append a `DeferredFinding` with reason `"transformer produced invalid output"`.
7. If a transform sets `scope.manifestEdited: true`, validate the new `imsmanifest.xml` against the SCORM schema before accepting it. Use `src/parser/` modules (`scorm.js` and friends) — they already have validation paths. If the manifest is invalid, drop the transform per (6).

### Staging branch (new for v5)

When `mode === 'full'` and `opts.noCheckpoint !== true`:

1. The output directory is `<engagementDir>/<package>/.rebuild-staging/` instead of `<engagementDir>/<package>/`.
2. The output zip is named `rebuilt-staged.zip`.
3. The manifest is named `rebuild-manifest-staged.json`.
4. Every transform with `requiresCheckpointApproval: true` (which is every full-tier transform by default) is written with `status: 'pending-checkpoint'`, not `'applied'`.
5. The orchestrator does NOT call `verify()` against the staged zip. Verification runs at promotion time, owned by chunk 08's checkpoint module.
6. The orchestrator returns `{ manifest, stagedZipPath, stagingDir }` instead of `{ manifest, rebuiltZipPath }`.

When `mode === 'full'` and `opts.noCheckpoint === true`: skip the staging branch and write directly to the package root the same way safe / assisted modes do. Transforms are written with `status: 'applied'` directly.

When `mode !== 'full'`: skip the staging branch entirely. Output layout matches v4 / v4.1 byte-for-byte where deterministic.

### Schema version bump

Pass `{ schemaVersion: '2.0.0' }` to `createManifest` only when full-tier transforms are dispatched. For safe / assisted modes, `createManifest` continues to default to `1.0.0`. This preserves v4 / v4.1 byte-identical manifest output.

## Implementation notes

- **Order:** fixers run per-file (v4's pass), then transformers run per-package (v5's pass). Don't interleave.
- **Idempotency:** running rebuild twice on the same input produces the same staged zip and the same manifest (modulo timestamps in `provenance`). Cache transformer outputs the same way fixers cache — by `(transformer id, file content hashes, audit findings hash)`.
- **Manifest XML editor:** if a transformer needs to edit `imsmanifest.xml`, it does so via `src/lib/manifest-xml-editor.js` (chunk 05 ships this). Your orchestrator does not need to know about manifest edits beyond accepting that some transforms have `scope.manifestEdited: true`.
- **The orchestrator does NOT render any report.** Diff / summary / preview rendering is the CLI action's job (chunk 07). The orchestrator returns the manifest and the staged-or-final zip path; the CLI orchestrates the rest.
- **Deferred-feature notice removed.** v4's stub for `--mode full` (and v4.1's for assisted) printed a deferred-feature notice. v5 removes the full-tier notice. Do not delete the assisted notice — that path may still be deferred-feature for some installs without v4.1's optional providers; check what v4.1 left behind and preserve it.

## Tests

Update `test/rebuild/orchestrator.test.js`:

- Smoke: `mode: 'full'` against a fixture with violations a v5 transformer can resolve. Assert the staged zip is written under `.rebuild-staging/`, the manifest has `transforms[]` populated, and every transform is `status: pending-checkpoint`.
- `--no-checkpoint`: same fixture, `opts.noCheckpoint = true`. Assert the output lands at the package root with `status: applied` on transforms.
- Tier dispatch sanity: `mode: 'safe'` and `mode: 'assisted'` are byte-identical to v4 / v4.1 output (no transforms, no staging directory created).
- Invalid output: a hand-crafted transformer that produces invalid HTML is dropped; the transform is removed from the manifest and a deferred finding is appended.
- Manifest XML validation: a hand-crafted transformer that produces invalid `imsmanifest.xml` is dropped; the transform is removed.
- Order invariant: fixers run before transformers. Mock both with logging; assert the call order in the log.

Create `test/lib/transformer-registry.test.js`:

- Loads only `tier: 'full'` modules from a synthetic `transformers/` dir.
- Sorts by id.
- Skips files without both `canTransform` and `apply`.
- Bypasses require-cache the same way `loadFixers` does (the v4 pattern; assert behaviour with two test runs sharing a fresh dir).

## Acceptance criteria

- `npm test` passes.
- `npm run check-no-network` passes.
- A `mode: 'safe'` rebuild against an existing v4 fixture produces byte-identical output to v4.
- A `mode: 'full'` rebuild against `test/fixtures/rebuild-full-mixed.zip` (chunk 09 ships this fixture; until then, use a hand-built fixture in the test) produces a staged zip and a manifest with `transforms[]` populated.
- The PRD's `Transform` shape and the actual emitted JSON match field-for-field.

## Out of scope

- Do not implement the checkpoint module. That's chunk 08.
- Do not implement transformers. Chunks 03, 04, 05 do that.
- Do not write the preview renderer. That's chunk 06.
- Do not register CLI commands. Chunk 07 owns the CLI.
- Do not modify `src/rebuild/types.js`, `src/rebuild/manifest.js`, or `src/rebuild/undo.js`. Chunks 00 / 00 / 08 own those respectively.
- Do not introduce new runtime dependencies.
