# Chunk 02 — Re-audit Verification

**Workstream:** Prism v4 Rebuild
**Depends on:** 00-foundation
**Parallel-safe with:** 01, 03, 04, 05, 06

---

You are building the verification step that re-runs the audit against the rebuilt zip and produces a before/after summary. Before you write any code:

1. Read `v4/CLAUDE.md`
2. Read `v4/PRD_v4_Rebuild.md` — focus on **Verification** and **Manifest schema** (the `verification` block)
3. Read `src/index.js` to see the `audit()` API surface
4. Read `src/rebuild/manifest.js` (chunk 00) — you'll call `setVerification`

## Files to create

### `src/rebuild/verify.js`

Exports:

- `async function verify(rebuiltZipPath, originalAuditResults, opts)` — runs `audit()` against the rebuilt zip with the same options the original audit used (standard, package-type, browser, timeout-dynamic), then returns:

  ```js
  {
    before: { violations, criteriaFailed, section508Failed },
    after:  { violations, criteriaFailed, section508Failed },
    resolved: number,    // findings present before but not after, matched by criterion+file+line
    introduced: number,  // findings present after but not before
    remaining: number,   // findings present after
    introducedFindings: AuditFinding[]   // for the summary report
  }
  ```

- `function compareFindings(before, after)` — pure helper. Matches findings across runs by `(criterion, file, line)` triple. Pure-function, fully unit-testable, no I/O.

### Behavior

- The verify step **must be idempotent and read-only on the rebuilt zip.** It does not write a fixed zip. It runs a clean audit and returns numbers.
- The "no new findings" invariant lives here: if `introduced > 0`, set a flag in the return value (`hasRegression: true`) so the orchestrator and CLI can fail loudly. Do not throw — return the flag and let the caller decide.
- Reuse `audit()` from `src/index.js` directly. Do not reimplement audit logic.

## Tests

Create `test/rebuild/verify.test.js`:

- A fixture with N known violations: rebuild → verify → before count = N, after count is lower, resolved = N - after, introduced = 0.
- A synthetic case where the rebuilt zip has a violation the original didn't: `hasRegression: true`, `introduced > 0`.
- `compareFindings` matches by criterion+file+line correctly across renamed-file edge cases (same criterion, different line: counts as resolved + introduced if not matched).

You may need to construct a synthetic regression case by hand-crafting two `AuditResults` objects rather than rebuilding a real fixture into a regression. That's fine — keep it as a pure-function test.

## Acceptance criteria

- `npm test` passes for `test/rebuild/verify.test.js`.
- `npm run check-no-network` passes.
- `verify()` does not write any files.
- `compareFindings` is a pure function and is exported separately for unit testing.

## Out of scope

- Do not modify the orchestrator. The orchestrator imports `verify` only after chunks 01 and 02 are both merged; for now your tests can call `verify` directly.
- Do not write reports. Chunks 05 and 06 do that.
- Do not touch the CLI.
- Do not add new fixers.
