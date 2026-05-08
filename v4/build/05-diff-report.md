# Chunk 05 — Per-fix Diff Report Renderer

**Workstream:** Prism v4 Rebuild
**Depends on:** 00-foundation
**Parallel-safe with:** 01, 02, 03, 04, 06

---

You are building the consultant's review surface. Before you write any code:

1. Read `v4/CLAUDE.md`
2. Read `v4/PRD_v4_Rebuild.md` — focus on **Diff report**
3. Read `src/reporter/html.js` to learn the existing brand-matched HTML renderer's patterns (CSS, fonts, palette, layout primitives)
4. Read `config/brand.json` to know the palette and font stack
5. Read `src/rebuild/types.js` and `src/rebuild/manifest.js` from chunk 00

## Files to create

### `src/reporter/rebuild-diff.js`

Exports `async function renderRebuildDiff(manifest, brandConfig, outputPath)`. Produces a single self-contained HTML file at `outputPath`.

The page must:

1. **Match the v3 brand exactly.** Same Archivo Black headers, same Space Grotesk + Inter + JetBrains Mono stack, same paper / ink / teal / orange palette. Reuse `src/reporter/html.js`'s style blocks if it exports them, or copy the styles block-for-block to keep it self-contained. Do not invent new visual primitives.

2. **Print to PDF cleanly.** Page-break-inside: avoid on patch rows. Form fields must render as fillable in PDF (use `<input type="checkbox">` not styled `<div>`s).

3. **Have these sections in order:**
   - Header card: engagement, package, mode, standard, tool version, manifest hash, generation timestamp
   - Summary strip: patches applied, patches rejected (always 0 in v4 initial render — populated after reject loop), deferred findings, verification before/after
   - Filter bar: chips for tier (safe/assisted/full), triage tag, criterion, "needs sign-off only"
   - Patch list

4. **Patch row layout, one row per patch:**
   - Top line: file path · line number · criterion chip · triage chip · confidence · provenance pill
   - Body: before / after side-by-side. Two `<pre><code>` blocks; left rendered with reasonable line-level highlighting, right same. Show only the diff range plus ~3 lines of context above and below — never the full file.
   - Rationale: one short line of body text.
   - Sign-off control: real `<input type="checkbox" name="approve-patch-NNNN">`, label "Approved by [consultant]". Adjacent text input for consultant initials.
   - Reject control: a button labeled "Reject" that flips the row's local state to `rejected` via inline JavaScript. The state is also written to a hidden `<input type="hidden" name="rejected" value="patch-NNNN">` so a consultant could "Save Page As" and the state persists in the saved HTML — and so a future enhancement could parse the saved state file.

5. **Filtering** is handled by inline JavaScript. No external runtime dependencies. The chips toggle classes on the patch list; CSS hides non-matching rows. JavaScript inlined in a single `<script>` tag.

## Constraints

- **Self-contained.** No external CSS, no external JS, no external fonts (inline @font-face data or rely on the same CDN/local font setup the v3 report uses — match v3's choice exactly).
- **Copyright safety.** The `before` and `after` rendering shows only the diff range plus a few context lines. Do not render whole source files. The `manifest.patches[].before` / `.after` fields already capture this; just don't expand them.
- **No outbound network calls.** This is a pure-function HTML renderer.
- **Determinism.** Same manifest → same HTML byte-for-byte. No timestamps, random ids, or ordering instability inside the renderer.

## Tests

Create `test/reporter/rebuild-diff.test.js`:

- Render a manifest with 3 patches across 2 criteria → assert the HTML contains all 3 patch rows, all 2 criteria, the summary strip numbers match.
- Render a manifest with 0 patches and 5 deferred → assert the empty state renders correctly with a clear message.
- Render twice with the same manifest → byte-identical output (determinism).
- The output validates as well-formed HTML (use `cheerio` to parse and assert no parse errors).
- Sign-off checkboxes render as `<input type="checkbox">` (test with cheerio: count of checkboxes equals patch count).

## Acceptance criteria

- `npm test` passes for `test/reporter/rebuild-diff.test.js`.
- `npm run check-no-network` passes.
- The output for a 3-patch manifest, opened in a browser, displays all rows correctly with working filter chips.
- Print preview shows clean page breaks and the checkboxes are interactive in the PDF.

## Out of scope

- Do not write the summary report. That's chunk 06.
- Do not implement the reject-state file consumption. The `<input type="hidden" name="rejected">` writes the state; consuming it (either via `rebuild-undo --patch <id>` or a future `--reject-state <file>` flag) is outside this chunk.
- Do not modify `src/reporter/html.js`. If you need to share styles, copy them; the v3 reporter is intentionally untouched.
- Do not modify the orchestrator. The orchestrator will eventually call `renderRebuildDiff`; chunk 07 wires that up.
- Do not touch the CLI.
