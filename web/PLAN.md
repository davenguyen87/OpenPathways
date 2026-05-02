# Open Pathways Web — Build Plan

A local web UI on top of the existing CLI. Drop a SCORM/AICC `.zip` into a browser, watch progress stream in, read the report inline. No path typing, no hunting for output files.

This document is the canonical spec for the build. Phases are sized in working days for a single implementer.

---

## Goal

`npm run serve` (from project root) → opens `http://127.0.0.1:4280` → drop a `.zip` → see a live, collapsible WCAG 2.2 AA report. Existing CLI stays untouched.

---

## Architecture

```
Browser (public/)
   │  multipart upload → POST /api/audits
   │  SSE subscribe   ← GET  /api/audits/:id/events
   │  download        ← GET  /api/audits/:id/report.{json,md}
   ▼
Express server (server/)
   │
   ▼
audit() from ../src/index.js     ← reused as a library, not shelled out to
```

- Server: Express, bound to `127.0.0.1`, default port 4280.
- Job manager: in-memory `Map<jobId, { status, progress[], result, error }>`.
- Progress: Server-Sent Events. The audit pipeline accepts an `onProgress(event)` callback (added in Phase 2) and the server forwards each event over the SSE stream.
- Frontend: single `index.html`, vanilla JS, three states — idle, running, done.

---

## Phase 1 — Server skeleton (~½ day)

**Success criteria:** `npm run serve` starts the server, opens the browser to a placeholder page that says "Open Pathways Web — ready" with the current version. `--no-open` skips the launch. `--port 1234` and `OPEN_PATHWAYS_PORT=1234` both work.

Tasks:
1. `server/index.js` — Express app, bind to `127.0.0.1`, port resolution (flag > env > default 4280), graceful shutdown on SIGINT.
2. `server/lib/launch.js` — cross-platform browser launcher using the `open` package (CommonJS-compatible version pinned in `package.json`).
3. `public/index.html` + `public/styles.css` — placeholder page wired up so we can confirm static serving works.
4. Root `package.json` — add `"serve": "node web/server/index.js"` script. (This is the only edit outside `web/`.)
5. Smoke test: `npm run serve --no-open` exits cleanly when killed; `curl 127.0.0.1:4280` returns the placeholder page.

---

## Phase 2 — Upload + audit pipeline (~1 day)

**Success criteria:** A `.zip` uploaded via `curl -F` triggers a real audit. SSE stream emits stage events. Final result is fetchable as JSON and as Markdown.

Tasks:
1. Add `onProgress` hook to `../src/index.js` — non-invasive: if `options.onProgress` is a function, call it at each stage (`extracting`, `static-checks-start`, `static-check`, `dynamic-checks-start`, `dynamic-check`, `done`). The CLI ignores it. Document the event shape inline.
2. `server/routes/audits.js`:
   - `POST /api/audits` — multer multipart, 1 GB cap, write to `web/.tmp/uploads/<jobId>.zip`, kick off `audit()` in background, return `{ jobId }`.
   - `GET /api/audits/:id/events` — SSE stream of progress events plus a final `done` or `error` event.
   - `GET /api/audits/:id` — JSON snapshot (status + scorecard + violations).
   - `GET /api/audits/:id/report.json` — the full JSON scorecard (reuses existing reporter).
   - `GET /api/audits/:id/report.md` — the Markdown report (reuses existing reporter).
3. `server/job-manager.js` — `Map<jobId, Job>` with `create`, `update`, `get`, `subscribe(jobId, onEvent)`. No persistence.
4. Cleanup: delete the uploaded `.zip` and any extracted scratch dir when the job completes or 10 minutes after, whichever is later.
5. Smoke test: shell-only end-to-end run that uploads a fixture from `../test/fixtures/`, follows SSE, and downloads both reports.

---

## Phase 3 — Frontend (~1–2 days)

**Success criteria:** Drag a `.zip` from the desktop onto the page → progress log appears with current stage and SCO → results render with the scorecard, violations grouped by WCAG criterion, and download buttons. Works in Chrome, Firefox, Safari.

Tasks:
1. **Idle state.** Drop zone (full-page on hover), click-to-pick fallback, "Try a sample" button that fetches a fixture from the server and submits it as if dropped.
2. **Running state.** Progress log (live, append-only). Show the current stage and current file/SCO. Cancel button (POSTs `/api/audits/:id/cancel`; pipeline checks the flag between checks).
3. **Done state.**
   - Scorecard banner: score %, pass/fail, total violations, package type, WCAG standard.
   - Violation list grouped by criterion, collapsible. Each violation shows file + line, source snippet (already produced by `src/lib/snippet.js`), and the "what to do" hint.
   - Filters: by severity, by criterion, by file. Plain-text search.
   - Per-violation "copy as Markdown" button (Jira/GitHub paste).
   - Download buttons: Markdown, JSON.
4. **Routing.** No client-side router — `/` is idle, `/job/:id` reflects current state. Reload-safe.
5. **Style.** One `styles.css`, system font stack, no framework. Dark/light auto via `prefers-color-scheme`.

---

## Phase 4 — Polish (~½ day)

**Success criteria:** Returning users find the tool obviously useful on day two.

Tasks:
1. Recent audits panel — last 10 jobs in memory, click to re-open without re-uploading.
2. Persist last-used standard / package-type / browser in `localStorage`.
3. Empty-state CTA: the "Try a sample" button mentioned in Phase 3, wired to `../test/fixtures/`.
4. README in `web/` with a screenshot, the launch commands, and the port/no-open flags.
5. Optional: register `open-pathways-web` bin via `npm link` in `web/` for users who want a global shorthand.

---

## Out of scope for v1

- Authentication, multi-user, LAN exposure.
- Persistent job history across server restarts.
- Comparing two audit runs in the UI (CLI `--baseline` still works for that).
- Editing/auto-fix workflows in the browser (use `--fix` from the CLI).
- Publishing to npm.

---

## Open questions to resolve during implementation

- Concurrency: serialize audits or allow N in parallel? Default to serialize, with a setting if it becomes painful.
- SSE reconnection: replay buffered events on resubscribe, or fail closed? Start with fail-closed; revisit if flaky.
- Large uploads: progress for the upload itself? Phase 3 stretch goal.
