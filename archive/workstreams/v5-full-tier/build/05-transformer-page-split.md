# Chunk 05 — Transformer: Page Splitting + Manifest XML Editor

**Workstream:** Prism v5 Full Tier
**Depends on:** 00-foundation
**Parallel-safe with:** 01, 02, 03, 04, 06

---

You are building the riskiest transformer in v5: page splitting. It edits `imsmanifest.xml`, creates new HTML files, and changes the SCO sequence the LMS will play back. Before you write any code:

1. Read `v5/CLAUDE.md` — and read it twice. The "conservative wins over clever" rule applies to every other chunk; for this one it is the prime directive.
2. Read `v5/PRD_v5_FullTier.md` — focus on **Tier definitions: Full tier** (the `page-split` family), **Verification** (the manifest XML well-formedness invariant), and **Risks and mitigations**.
3. Read `src/parser/scorm.js` end-to-end. The SCORM 1.2 / 2004 manifest structure is non-trivial and your edits must not break it.
4. Read `src/parser/aicc.js` and `src/parser/cmi5.js` — even if page-split declines AICC and cmi5 packages (it does), your code path must detect them and exit cleanly.
5. Read `src/checks/2-4-1-bypass-blocks.js` and any 3.3.x checks that produce findings page-split would resolve.

## Files to create

### `src/lib/manifest-xml-editor.js`

A pure helper module. Exports:

- `parseManifest(xmlString)` — returns a structured AST. Use Node's built-in XML parsing (`xml2js` is NOT a runtime dep — confirm; if it isn't, find another way without adding deps. The repo's own `src/parser/scorm.js` already parses imsmanifest; reuse its parser if exposed, or factor a small reusable parse function out of it).
- `serializeManifest(ast)` — round-trips the AST back to XML, preserving formatting (indentation, attribute order, namespace declarations) as closely as possible. Round-trip determinism is a hard requirement: parse(serialize(parse(x))) === parse(x).
- `splitResource(ast, resourceIdentifier, splits)` — given a manifest AST and a target `<resource>` `identifier`, replace the single resource with N resources whose `href` and `file` lists match the new split files. Updates the corresponding `<item>` in `<organization>` to reference the new resources in order. `splits` is `[{ identifier, href, files: string[], title }]`.
- `validateManifest(ast)` — schema validation against SCORM 1.2 or 2004 (whichever the manifest declares). Use the existing parser's validation paths; do not reimplement.

### `src/transformers/page-split.js`

Follows the Transformer interface from chunk 00. Properties:

- **Family:** `page-split`
- **Criteria:** 2.4.1, 3.3.x, 1.3.1
- **Triage:** `author rework`
- **Tier:** `full`
- **Provenance:** `rule-based` (heuristic mode) or `llm` (when v4.1's assisted-tier provider is configured and `opts.allowLLMSplit !== false`)

### Detection (heuristic mode)

`canTransform(packageContext)` returns true when at least one HTML file in the package matches the split-needed signature:

- File size > 50KB **or**
- Page contains > 1 top-level `<h1>` (suggesting multiple distinct topics) **or**
- Page contains an explicit split marker: `<hr role="separator" data-prism-split>` or `<!-- prism-split -->` **or**
- The audit's findings include 2.4.1 ("Bypass Blocks") for the page

Decline (canTransform returns false) when:

- The package is AICC or cmi5 (this transformer is SCORM-only).
- The page has `<form>` elements that span the proposed split boundaries — splitting would break form state.
- The page has inline scripts that reference DOM elements across the proposed split boundaries.
- The manifest's `<organization>` is in a non-standard structure the editor can't safely modify (declare what "non-standard" means in code).

### Apply

1. **Choose split points.**
   - Heuristic mode: split at every top-level `<h1>` boundary (or at every explicit `<!-- prism-split -->` marker if present and at least one is present). Each split becomes a new SCO.
   - LLM mode: send the page content to v4.1's assisted-tier provider with a prompt that asks for split points by line number; cache the response by `(input zip sha256, transformer id, prompt template hash)`. Fall back to heuristic mode if the provider isn't available or returns malformed output.
2. **Create new HTML files.** For each split N (1..k), write `<original-stem>-part-N.html` to the package directory next to the original. Each new file:
   - Inherits the original's `<head>` (link tags, scripts, styles).
   - Contains exactly one split's body content.
   - Includes a small navigation block at the bottom: "Previous part" / "Next part" links to siblings.
3. **Delete the original.** Or rather — since v5 transforms are reversible, the original is included in the patch's `before` and the file is removed from the staged package. Revert restores it.
4. **Edit `imsmanifest.xml`** via the editor:
   - Replace the original `<resource>` with N resources, one per split file.
   - Replace the original `<item>` with N items in the same `<organization>` position, preserving `parameters` / `prerequisites` / `masteryscore` per the original (split items inherit these).
5. **Emit one Transform** with `family: 'page-split'`, `scope.files` listing the original file, the N new files, and `imsmanifest.xml`. `scope.manifestEdited: true`. `patches[]` contains:
   - One patch per new file (the patch is "create file from empty"; `before: ""`, `after: <full new file content>`, range covers the whole file).
   - One patch deleting the original (`before: <full original>`, `after: ""`).
   - One patch editing `imsmanifest.xml` (`before` and `after` capture the diff range plus context, per the standard patch context contract).

Note: a single patch can have a 0-length `before` (file creation) or a 0-length `after` (file deletion). Confirm `src/rebuild/types.js` and the v4 packager handle these correctly. If they don't, this is a chunk 00 concern — surface a follow-up rather than working around it here.

### Revert

1. Recreate the original file from the deletion-patch's `before`.
2. Delete the new split files (each was created from `before: ""`).
3. Restore `imsmanifest.xml` to its pre-edit state from the manifest patch's `before`.

The atomic guarantee: every patch in the transform reverts together, or none. The orchestrator (chunk 01) and the undo extension (chunk 08) call `revert(packageContext, transform)` once per transform.

## Implementation notes

- **The manifest XML editor is a separate module** because chunk 09's integration test will exercise it directly with hand-crafted manifests, and it's testable in isolation.
- **Round-trip determinism is required**: parse → serialize must produce a byte-equal manifest unless `splitResource` was called. Document any namespace / attribute-order normalization the parse-serialize cycle does, and snapshot-test it.
- **Confidence:** `'needs-review'` on every page-split patch in heuristic mode (the heuristic is conservative but the consultant must confirm). `'likely'` in LLM mode when `provenance.modelConfidence >= 0.85`, else `'needs-review'`.
- **Title generation:** new SCO titles inherit the original's title with a part suffix ("Topic Overview" → "Topic Overview (Part 1 of 3)"). The exact format is documented in the file as a constant.
- **Resource identifiers:** generate stable identifiers from a hash of the original identifier + split index. Determinism across runs is required.
- **No silent drift on re-runs.** A second rebuild on the same input produces an identical split (same files, same identifiers, same imsmanifest patch).
- **LLM mode reuses v4.1's provider abstraction.** Do not introduce a new provider. If v4.1's provider isn't merged in this branch, the LLM path is dead code; document it and gate it with a clean fallback to heuristic mode.

## Tests

Create `test/transformers/page-split.test.js`:

- **Heuristic happy path:** a fixture with one HTML file containing 3 top-level `<h1>`s → page-split fires → 3 new files written → `imsmanifest.xml` has 3 resources where there was 1 → original is deleted.
- **Round-trip:** apply → revert produces a package whose contained file bytes (including imsmanifest.xml byte-equal) match the original.
- **Manifest XML well-formedness:** post-apply, `validateManifest` passes against the manifest's declared SCORM version.
- **SCO sequence integrity:** the 3 new items appear in the same position in `<organization>` that the original occupied, and unrelated items are unchanged.
- **Decline paths (one test per documented decline rule):** AICC package, cmi5 package, embedded form spanning splits, embedded script with cross-split DOM refs, non-standard `<organization>` structure.
- **Determinism:** two runs on the same input produce byte-identical splits and byte-identical manifest edits.
- **Explicit marker:** a fixture using `<!-- prism-split -->` markers splits at those points instead of at `<h1>` boundaries when both are present.

Create `test/lib/manifest-xml-editor.test.js`:

- Round-trip: parse → serialize is byte-equal on a panel of real-world manifests (small fixtures committed under `test/fixtures/manifests/`).
- `splitResource` produces a valid manifest; `validateManifest` passes after the edit.
- Hand-crafted invalid manifest fails validation with a specific error.
- The editor preserves namespace declarations and `xsi:schemaLocation` attributes byte-equal.

## Acceptance criteria

- `npm test` passes for both new test files.
- `npm run check-no-network` passes.
- Round-trip is byte-identical on every fixture.
- Manifest XML stays valid after every split fixture.
- The transformer follows the Transformer interface from chunk 00 exactly.
- LLM mode is gated cleanly: when v4.1's provider abstraction isn't available, the transformer falls back to heuristic mode without throwing.

## Out of scope

- Do not create landmark or widget transformers. Those are chunks 03 and 04.
- Do not modify the orchestrator, the CLI, or any reporter.
- Do not introduce a new XML parser dependency. Reuse what `src/parser/` already imports.
- Do not implement SCORM modernization (1.2 → 2004 / cmi5 / xAPI). That's a separate workstream entirely.
- Do not implement form-aware splitting or cross-split script analysis. Both are decline conditions in v5; the dynamic analysis is a v5.1+ concern.
- Do not write to `<organization>` structures the editor declines. Document the decline; ship the conservative version.
