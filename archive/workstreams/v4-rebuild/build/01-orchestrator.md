# Chunk 01 — Rebuild Orchestrator + Packager

**Workstream:** Prism v4 Rebuild
**Depends on:** 00-foundation (must be merged)
**Parallel-safe with:** 02, 03, 04, 05, 06

---

You are building the orchestrator that turns audit findings into a remediated `.zip`. Before you write any code:

1. Read `v4/CLAUDE.md`
2. Read `v4/PRD_v4_Rebuild.md` — focus on **Architecture**, **Tier dispatch**, **File map**
3. Read `src/index.js` to understand how `audit()` extracts and parses
4. Read `src/lib/extract.js` to understand zip handling
5. Read the now-modified `src/fixers/add-alt-decorative.js` to confirm the v2 fixer interface from chunk 00
6. Read `src/rebuild/types.js` and `src/rebuild/manifest.js` from chunk 00

## Files to create

### `src/rebuild/index.js`

Exports `async function rebuild(packagePath, auditResults, opts)`. Behavior:

1. **Tier dispatch.** Read `opts.mode` (default `'safe'`). If `assisted` or `full`, log a deferred-feature notice to stdout and return a manifest with empty `patches` and every audit finding listed in `deferred`. Exit cleanly with no `.zip` written.
2. **Extract** the input zip to a temp dir using the same approach as `src/lib/extract.js`. Reuse `extractZip` if its API fits; otherwise mirror the pattern.
3. **Build a fixer registry** by `require`-ing every file in `src/fixers/` whose `tier === 'safe'`. (Future tiers reuse the same registry pattern; just filter on tier.)
4. **For each finding** in the audit results:
   - Iterate fixers; the first whose `canFix(file, finding)` returns true claims it.
   - If no fixer claims it, append to `manifest.deferred` with a clear reason ("no fixer registered for criterion X" or "fixer Y declined").
5. **Per-file apply pass.** Group claimed findings by file. For each file, parse to a Cheerio DOM if possible (HTML files; the existing audit context already has `cheerio` available — see `src/lib/audit-context.js`), apply every claiming fixer's `apply()` in declared order, collect patches into the manifest. Serialize the DOM back once per file. Non-HTML files (CSS, JS, JSON) get raw-string apply.
6. **Refuse to introduce regressions.** After each fixer's `apply()`, validate that `newContent` is parseable (HTML re-parses, JSON parses, CSS doesn't error in a basic check). If invalid, drop the patch and log to `manifest.deferred` with reason "fixer produced invalid output".
7. **Repackage** via `src/rebuild/packager.js` (see below).
8. **Hash** the input and output zips (SHA-256), populate `inputZipSha256` and `outputZipSha256` on the manifest.
9. **Return** `{ manifest, rebuiltZipPath }`. The orchestrator does not run the re-audit; that's chunk 02's job, called separately by the CLI in chunk 07.

### `src/rebuild/packager.js`

Exports:

- `async function unpack(zipPath, destDir)` — extracts the zip to `destDir`. Wraps `adm-zip` (already a dep). Records original entry order so `pack` preserves it.
- `async function pack(srcDir, zipPath, manifest)` — writes a new zip from `srcDir`. Preserves binary file integrity (every byte that wasn't changed comes through identical). Preserves entry order from the original. The `manifest` argument is consulted only to know which files were modified.
- `async function sha256(filePath)` — file SHA-256, hex.

Round-trip invariant: `unpack(zip, dir)` then `pack(dir, zip2, emptyManifest)` produces a zip whose SHA-256 may differ (zip metadata) but whose contained file bytes are identical for every file.

## Tests

Create `test/rebuild/orchestrator.test.js`:

- Smoke test against a fixture in `test/fixtures/` with known violations a safe-tier fixer can resolve. Assert: manifest has patches, rebuilt.zip is written, output sha differs from input sha.
- Tier dispatch: `mode: 'assisted'` and `mode: 'full'` produce manifests with empty patches and full deferred lists. No zip is written.
- A finding with no claiming fixer lands in `manifest.deferred` with a reason.
- A fixer that produces invalid HTML is dropped; the patch goes to `deferred` with "fixer produced invalid output".

Create `test/rebuild/packager.test.js`:

- Round-trip: every file in a fixture zip survives unpack → pack with byte-identical content (binary-safe).
- Entry order is preserved.
- `sha256` matches `shasum -a 256` output for known fixtures.

## Acceptance criteria

- `npm test` passes for `test/rebuild/orchestrator.test.js` and `test/rebuild/packager.test.js`.
- `npm run check-no-network` passes.
- The rebuild output for a fixture matches a hand-verified expected manifest (snapshot test is fine if the snapshot is reviewable).
- No new runtime deps. Use `adm-zip`, `cheerio`, Node's `crypto`.

## Notes carried forward from earlier chunks

These came out of the chunk 03 review. Act on them when you implement the dispatch loop.

1. **Route findings by `canFix()`, not by a strict equality check on the fixer's module-level `criterion` field.** `associate-form-label` (chunk 03) declares `criterion: '3.3.2'` at module level but legitimately claims violations with `criterion: '1.3.1'` as well — its `canFix(file, violation)` accepts both. A future fixer may do the same. Your dispatch loop should iterate every safe-tier fixer and ask `canFix(file, finding)`; treat the module-level `criterion` field as metadata for reporting, not as a routing key. If you need a fast path, group fixers by the union of criteria their `canFix` accepts (introspect by calling `canFix` against synthetic violations) — but a linear scan is fine for v4's fixer count.

## Out of scope

- Do not implement re-audit verification. That's chunk 02.
- Do not implement undo. That's chunk 08.
- Do not write the diff or summary reports. Those are chunks 05 and 06.
- Do not register CLI commands. That's chunk 07.
- Do not add new fixers. Chunks 03 and 04 do that.
- Do not touch `src/cli.js` or `src/index.js`.
