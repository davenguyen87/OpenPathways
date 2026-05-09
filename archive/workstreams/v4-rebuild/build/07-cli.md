# Chunk 07 — CLI Integration

**Workstream:** Prism v4 Rebuild
**Depends on:** 00, 01, 02, 03, 04, 05, 06 (all of wave 1)
**Parallel-safe with:** 08

---

You are wiring the rebuild stage into the CLI. **You are the only chunk in v4 that modifies `src/cli.js` and `src/index.js`.** Before you write any code:

1. Read `v4/CLAUDE.md`
2. Read `v4/PRD_v4_Rebuild.md` — focus on **CLI surface**, **File map**, and **Output layout**
3. Read `src/cli.js` end-to-end — understand the existing `audit` and `audit-library` action functions
4. Read `src/index.js` end-to-end — understand the `audit()` library entry
5. Read `src/rebuild/index.js` (chunk 01), `src/rebuild/verify.js` (chunk 02), `src/reporter/rebuild-diff.js` (chunk 05), `src/reporter/rebuild-summary.js` (chunk 06)

## Files to modify

- `src/cli.js` — add `rebuild` and `rebuild-library` subcommands. Do not modify the existing `audit` and `audit-library` action functions in any way other than what's strictly required for shared helpers. If you must extract a helper that both old and new actions use, put it in a new file under `src/lib/`.
- `src/index.js` — export `rebuild` from `./rebuild/index.js` so the library entry surface includes it for `web/` and `cloud/` future adoption.

## Files to create

- `src/lib/rebuild-cli.js` — the action functions for `rebuild` and `rebuild-library`. Mirrors the structure of the existing `auditAction` / `auditLibraryAction` functions in `src/cli.js`. Putting them in their own file keeps `cli.js` from bloating and lets you unit-test the actions independently.

## CLI surface

Match the PRD exactly:

```
prism rebuild <pkg.zip> --engagement <id> [--mode safe|assisted|full] [--standard wcag21|wcag22] [--brand-config <path>] [--browser ...] [--package-type ...] [--timeout-dynamic ...]
prism rebuild-library <dir> --engagement <id> [--mode ...] [--standard ...] [--brand-config ...] [...]
```

Defaults:

- `--mode` defaults to `safe`
- `--standard` defaults to `wcag22` (rebuild's target — different from audit's `wcag21` default; document this in the help text)
- `--engagement` is required for both rebuild commands
- All audit-pass-through flags (`--browser`, `--package-type`, `--timeout-dynamic`) match the existing `audit` flag defaults

## Action behavior

### `rebuild` action

1. Validate flags. Exit 2 with a clear message on missing required flags.
2. Resolve the engagement directory. Construct the per-package path: `engagements/<id>/<package-name>/`.
3. **Look for an existing audit at that path.** If `results.json` is present and not stale (timestamp newer than the input zip's mtime), reuse it. Otherwise run `audit()` first and store its outputs at the same path. Log the choice.
4. Call `rebuild(packagePath, auditResults, opts)` from chunk 01. This produces a `manifest` and a `rebuiltZipPath`.
5. If `mode` is `assisted` or `full`, the rebuild returned a deferred manifest with no rebuilt zip. Render only the summary report (no diff report, since there are no patches), log the deferred-feature notice, exit 0.
6. Otherwise: call `verify(rebuiltZipPath, originalAuditResults, opts)` from chunk 02. Populate `manifest.verification`. If `hasRegression: true`, log a clear error, write the manifest with the introduced findings, write the summary (which renders the regression banner), but **do not write the rebuilt.zip** (it's untrustworthy). Exit 2.
7. Render the diff report (`renderRebuildDiff` from chunk 05) to `engagements/<id>/<package>/rebuild-diff.html`.
8. Render the summary report (`renderRebuildSummary` from chunk 06) to `engagements/<id>/<package>/rebuild-summary.html`.
9. Write the rebuilt zip to `engagements/<id>/<package>/rebuilt.zip`.
10. Write the manifest to `engagements/<id>/<package>/rebuild-manifest.json`.
11. Print a concise summary (resolved/remaining/introduced) and the paths to the artifacts.
12. Exit 0 if `verification.remaining === 0`, else 1.

### `rebuild-library` action

Mirrors the v3 `audit-library` shape:

1. Find every `.zip` in the directory.
2. Run the per-package rebuild for each (sequentially is fine for v4; parallelism is a v4.1 concern).
3. After all packages, render a library-level rollup at `engagements/<id>/_rebuild-rollup.html` and `_rebuild-rollup.md`. The rollup shows per-package resolved / remaining / introduced totals and aggregated triage breakdowns.
4. Exit code: 0 if every package had `remaining === 0`; 1 if any had `remaining > 0`; 2 on any tool error or any package with `introduced > 0`.

The rollup renderer can live in the same `src/lib/rebuild-cli.js` file or in a new `src/reporter/rebuild-rollup.js` — your call. If you create a new reporter file, document it.

## Tests

Create `test/lib/rebuild-cli.test.js`:

- Action-function tests with mocked dependencies (mock `rebuild`, `verify`, the renderers). Assert the action resolves engagement paths correctly, decides whether to reuse the existing audit, and writes the correct artifacts in the correct order.
- Tier dispatch: `mode: 'assisted'` writes summary only, no zip, no diff.
- Regression handling: when `verify` returns `hasRegression: true`, no rebuilt.zip is written, exit code is 2.

CLI shape tests can be light — assert that `prism rebuild --help` lists the documented flags and defaults. The bulk of action behavior is tested via the unit tests on `src/lib/rebuild-cli.js`.

## Constraints

- Do not modify `src/cli.js`'s existing `auditAction` or `auditLibraryAction`. They stay as v3 left them.
- Do not change the v3 default `--standard` of the `audit` command (still `wcag21`). Only the new `rebuild` commands default to `wcag22`.
- Do not introduce new runtime dependencies.

## Acceptance criteria

- `npm test` passes.
- `npm run check-no-network` passes.
- `node src/cli.js rebuild --help` and `node src/cli.js rebuild-library --help` print the documented options.
- A manual run against a fixture: `node src/cli.js rebuild test/fixtures/<known-fixture>.zip --engagement smoketest` produces all four artifacts (rebuilt.zip, rebuild-manifest.json, rebuild-diff.html, rebuild-summary.html) at `engagements/smoketest/<package>/`.

## Notes carried forward from earlier chunks

These came out of the chunk 02 review. They aren't blockers for 02, but you are the chunk that has to act on them.

1. **Tighten verify's option allowlist when you call it.** `src/rebuild/verify.js` currently forwards every key in `opts` to `audit()` (see the catch-all loop near the top of `verify()`). If the orchestrator ever passes `fix: true` through to verify, verify's `audit()` call would write a `*.scorm-fixed.zip` and break the read-only invariant. When you wire the orchestrator → verify call, pass an explicit allowlist (`standard`, `packageType`, `browser`, `timeoutDynamic`, `signal`) and nothing else. If you'd rather harden verify itself, that's a one-line edit inside `verify.js` — drop the `for (const k of Object.keys(o))` loop. Either fix is fine; pick one.

2. **`resolved` / `introduced` semantics diverge between `verify()` and `setVerification()`.** `verify()` matches findings by the triple `(criterion, file, line)` and returns set-matched counts. `manifest.setVerification(manifest, before, after)` ignores those and recomputes via `Math.max(0, before.violations - after.violations)`. The set-matched numbers are strictly more accurate (they catch the case where a finding "moves" to a new line and is really a regression). Pick one of:
   - Extend `setVerification(manifest, before, after, deltas?)` to accept pre-computed `{ resolved, introduced, remaining }` and call it with verify's numbers. Smallest change. `manifest.js` is shared — touching it is allowed in chunk 07 since you're already the wiring chunk.
   - Drop the recompute from `setVerification` entirely and require callers to pass deltas. Cleaner but breaks the existing manifest tests; update them.
   - Skip `setVerification` and write `manifest.verification` directly from verify's return value.
   The summary report (chunk 06) reads `manifest.verification` — whichever route you pick, make sure 06's renderer sees set-matched numbers.

3. **Don't import `__setAuditForTest` from `verify.js`.** It's exported on the module surface as a test seam. Production code (your orchestrator wiring) imports `{ verify }` only.

4. **`test/auto-fix.test.js` (a v3 test) hardcodes `expect(fixers.length).toBe(9)`.** Chunks 03 and 04 add 6 more fixers under `src/fixers/`, so the v3 fixer loader now returns 12+ entries and that assertion fails. The v3 `--fix` mode still applies only the original 9 (the v4 fixers require the orchestrator to run, not the v3 loader), so the user-facing v3 surface is unchanged. Pick one:
   - **Update the assertion** to count only fixers without a `tier` field (v3 fixers don't declare `tier`; v4 ones do, since chunk 00 added `tier: 'safe'` to the existing 9 — so this filter no longer works) — or count fixers whose v3 `--fix` action is exercised by the existing v3 path.
   - **Migrate the test** to assert against a static list of the v3 fixer ids.
   - **Filter the v3 loader** to keep returning only the 9 originals (e.g., gate by an explicit `v3: true` field, or by a known-id allowlist).
   You're the wiring chunk; this is the right place to make the v3↔v4 boundary explicit.

## Out of scope

- Do not implement undo. That's chunk 08.
- Do not write the integration test. That's chunk 09.
- Do not modify any existing fixer. Do not write new fixers.
- Do not modify `src/reporter/html.js`.
