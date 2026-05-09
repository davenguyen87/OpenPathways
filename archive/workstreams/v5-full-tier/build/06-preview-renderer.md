# Chunk 06 — Preview Renderer + Summary Extension

**Workstream:** Prism v5 Full Tier
**Depends on:** 00-foundation
**Parallel-safe with:** 01, 02, 03, 04, 05

---

You are building the side-by-side preview surface that the consultant uses to approve or reject staged transforms. Before you write any code:

1. Read `v5/CLAUDE.md`
2. Read `v5/PRD_v5_FullTier.md` — focus on **Preview report** and **Checkpoint lifecycle**
3. Read `src/reporter/rebuild-diff.js` (v4) to learn the brand-matched HTML primitives the v5 preview should reuse
4. Read `src/reporter/rebuild-summary.js` (v4) — you'll extend this with transform stats
5. Read `config/brand.json` for palette and font stack

## Files to create

### `src/reporter/rebuild-preview.js`

Exports `async function renderRebuildPreview(manifest, brandConfig, outputPath, opts)`. Produces a single self-contained HTML file at `outputPath`. The page is rendered for transforms only — patches without a `transformId` (i.e., safe / assisted patches) do not appear here; they remain in `rebuild-diff.html`.

The page must:

1. **Match the v3 / v4 brand exactly.** Same Archivo Black headers, same Space Grotesk + Inter + JetBrains Mono stack, same paper / ink / teal / orange palette. Reuse `src/reporter/rebuild-diff.js`'s style block — copy it verbatim or factor it into a small shared helper at `src/reporter/_brand-styles.js`. (If you create the helper, that's a small new shared file; document it in your PR. v4's diff renderer can be left untouched in this chunk — keep the copy local.)

2. **Print to PDF cleanly.** Page-break-inside: avoid on transform cards. Form fields render as fillable.

3. **Render checkpoint state prominently.** When `manifest.transforms` contains any transform with `status: 'pending-checkpoint'`, the page is in **review mode**: the approve / reject form is enabled, the header card shows "Pending review", and a banner at the top explains the next step (`prism rebuild-checkpoint approve --engagement <id> --package <name>`). When every transform has been approved or rejected, the page is in **archive mode**: forms are disabled, a banner shows the promotion outcome.

4. **Sections in order:**
   - **Header card** — engagement, package, mode, standard, tool version, manifest hash, generation timestamp, checkpoint state.
   - **Summary strip** — transforms staged, transforms approved, transforms rejected, deferred findings, verification before/after (only after promotion; pre-promotion shows a placeholder "Verification runs at promotion").
   - **Filter bar** — chips for transform family (landmark / widget / page-split), criterion, "needs review only" (default-on in review mode).
   - **Transform card list** — one card per transform.

5. **Transform card layout:**
   - **Top line:** family chip · criteria chips · transformer id · scope (files affected, "manifest edited" tag if applicable) · provenance pill (rule-based / llm with model name when llm).
   - **Side-by-side preview:** two iframes or two `<section>`s containing the rendered before/after fragments. Render only the changed region plus surrounding context — never the whole SCO. Source for the rendering: the patch `before` / `after` fields plus context (already scoped). For multi-file transforms (page-split), render the most representative file's diff at the top with collapsed accordions for the rest.
   - **Patch list:** every patch in the transform, rendered as compact rows (file:line, short before/after). Click expands to the full patch view (same compact format as the diff report uses). The rationale: this lets the consultant trust the side-by-side preview by inspecting the underlying patches if they want.
   - **Rationale:** one paragraph from the transformer.
   - **Approval form:**
     - `<input type="radio" name="transform-<id>" value="approve">` with label "Approve"
     - `<input type="radio" name="transform-<id>" value="reject">` with label "Reject"
     - `<input type="radio" name="transform-<id>" value="undecided" checked>` with label "Pending"
     - `<input type="text" name="approver-<id>">` with placeholder "Initials"
     - Mirroring `<input type="hidden" name="state-<id>" value="undecided">` updated by inline JS so a "Save Page As" preserves state.

6. **Filter behavior** is handled by inline JavaScript. No external runtime dependencies. Filter chips toggle classes; CSS hides non-matching cards.

7. **Save-state handoff.** Inline JavaScript writes the transform decisions to `localStorage` under a key keyed by manifest hash, AND keeps the hidden inputs in sync so a "Save Page As" preserves state. The CLI's `prism rebuild-checkpoint approve` reads from a separate `checkpoint-state.json` file (chunk 08 owns that file format), not from the HTML — but a future iteration could parse the saved HTML, so the dual write is intentional.

## Files to modify

### `src/reporter/rebuild-summary.js`

Add a small section to the existing summary report renderer that surfaces v5 transform statistics:

- "Transforms applied: X" / "Transforms pending: Y" / "Transforms rejected: Z" — only when `manifest.transforms` is non-empty.
- A pointer link to `rebuild-preview.html` when transforms exist.

The change is additive. v4 / v4.1 summary outputs (with no transforms) must remain byte-identical. Test the back-compat invariant with a determinism test against a v4 fixture.

You are the **only** chunk in v5 that modifies `src/reporter/rebuild-summary.js`.

## Constraints

- **Self-contained.** No external CSS, no external JS, no external fonts (inline @font-face data or rely on the same setup the v3 / v4 reports use — match v4's choice exactly).
- **Copyright safety.** The preview's side-by-side rendering MUST use only the patch `before` / `after` content + context. Do not read the source files and embed full pages. The renderer is a pure function of the manifest.
- **No outbound network calls.**
- **Determinism.** Same manifest → same HTML byte-for-byte (timestamps that differ between runs live only in `manifest.createdAt`, which the renderer pulls through verbatim).

## Tests

Create `test/reporter/rebuild-preview.test.js`:

- Render a manifest with 3 transforms (one per family) → assert all 3 transform cards present, family chips correct, side-by-side preview elements present.
- Render with all transforms in `pending-checkpoint` → assert review-mode banner and approval form enabled.
- Render with all transforms `applied` → assert archive-mode banner and forms disabled (or absent).
- Render a v4-shaped manifest with `transforms: []` → assert the page renders cleanly with a "no transforms" empty state.
- Determinism: same input → byte-identical output across runs.
- Output is well-formed HTML (cheerio parse).
- Approval form: count of radio groups equals transform count; each transform's three radio values are unique within the group.

Update `test/reporter/rebuild-summary.test.js`:

- New test: a manifest with transforms shows transform-counts section.
- Back-compat test: a manifest with `transforms: []` (or `undefined` for 1.0.0) renders byte-identical to the v4 baseline. Snapshot a v4 manifest, compare the v5 renderer's output to the v4 renderer's output for that manifest.

## Acceptance criteria

- `npm test` passes for both updated/new test files.
- `npm run check-no-network` passes.
- The output for a 3-transform manifest opened in a browser displays all cards correctly with working approval forms and filter chips.
- Print preview shows clean page breaks; the approval radios are interactive in the printed PDF.
- v4 / v4.1 summary outputs are byte-identical for manifests without transforms.

## Out of scope

- Do not modify `src/reporter/rebuild-diff.js`. The patch-level diff stays patch-level. Transform-level UI is preview-only.
- Do not implement the checkpoint state file format. Chunk 08 owns `checkpoint-state.json`.
- Do not implement the CLI. Chunk 07 wires `prism rebuild-checkpoint`.
- Do not modify the orchestrator. The orchestrator returns a manifest; chunk 07's CLI action calls the renderer.
- Do not introduce new runtime dependencies.
