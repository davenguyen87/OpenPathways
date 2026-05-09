# Chunk 06 — Rebuild Summary Report Renderer

**Workstream:** Prism v4 Rebuild
**Depends on:** 00-foundation
**Parallel-safe with:** 01, 02, 03, 04, 05

---

You are building the before/after compliance summary that ships alongside the diff report. Before you write any code:

1. Read `v4/CLAUDE.md`
2. Read `v4/PRD_v4_Rebuild.md` — focus on **Verification** and **File map**
3. Read `src/reporter/html.js` to learn the existing brand-matched HTML primitives
4. Read `config/brand.json`
5. Read `src/rebuild/types.js` and `src/rebuild/manifest.js` from chunk 00

## Files to create

### `src/reporter/rebuild-summary.js`

Exports `async function renderRebuildSummary(manifest, brandConfig, outputPath)`. Produces a single self-contained HTML file at `outputPath`.

The page is shorter than the diff report — it's a one-page consultant-facing summary suited to dropping into the firm's broader engagement assessment.

Sections in order:

1. **Header card.** Engagement, package, mode, standard, generation timestamp.
2. **Compliance scoreboard.** A two-column table:
   - Left column: "Before rebuild" — total violations, criteria failed, Section 508 mappings failed
   - Right column: "After rebuild" — same metrics
   - Big delta number: "X findings resolved" rendered prominently in brand accent
3. **Standards-met chips.** WCAG 2.2 AA met: ☐ / ☑. Section 508 met: ☐ / ☑. (Determined by `verification.after` — checked when `criteriaFailed === 0` and `section508Failed === 0`.)
4. **Triage breakdown.** A small bar showing how many findings were resolved by each triage category. Same triage taxonomy as v3 (auto-fix safe, auto-fix assisted, author rework, content rework, recommend retire). v4 will mostly resolve auto-fix safe; the others all show 0 in safe-tier mode.
5. **Deferred findings table.** Every entry from `manifest.deferred` rendered as a row with criterion, file, line, reason. Grouped by reason for readability.
6. **Regression banner.** If `manifest.verification.introduced > 0`, render a loud red banner at the top: "⚠ Rebuild introduced N new findings — DO NOT SHIP. See: <link to introduced findings>". List the introduced findings inline.
7. **Method note.** Three sentences max: which fixers ran, which audit standard the verify step used, and a pointer to `rebuild-diff.html` for per-patch detail.

## Constraints

Same as the diff renderer:

- Self-contained, no external assets.
- Match v3 brand exactly. Reuse `src/reporter/html.js` styles if exported; otherwise copy.
- No outbound network calls.
- Deterministic: same manifest → byte-identical output.
- Print-to-PDF clean.

## Tests

Create `test/reporter/rebuild-summary.test.js`:

- Render a manifest with `verification.resolved = 38, introduced = 0, remaining = 9` → assert the scoreboard shows those numbers and the standards-met chips reflect `criteriaFailed > 0` (unchecked).
- Render a manifest with `verification.introduced > 0` → assert the regression banner is present and contains the introduced findings.
- Render a manifest with `criteriaFailed: 0` and `section508Failed: 0` → assert both standards-met chips are checked.
- Determinism: same input → byte-identical output across runs.
- Output is well-formed HTML (cheerio parse).

## Acceptance criteria

- `npm test` passes for `test/reporter/rebuild-summary.test.js`.
- `npm run check-no-network` passes.
- Print preview shows a single-page or short-multi-page document that consultants can paste into the engagement assessment.

## Out of scope

- Do not write the diff report. That's chunk 05.
- Do not modify `src/reporter/html.js`.
- Do not modify the orchestrator. Chunk 07 wires the call.
- Do not touch the CLI.
- Do not implement the regression-blocks-deploy logic on the orchestrator side (that's chunk 01's responsibility — your renderer just shows the banner).
