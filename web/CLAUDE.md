# CLAUDE.md

## Project: Prism — Web

A local web UI on top of the Prism CLI. Runs an Express server on `127.0.0.1`, lets developers and QA drop a SCORM/AICC `.zip` into a browser, and streams audit results back as a collapsible report. Reuses the audit core from `../src` — it does not reimplement any checks.

Full build plan: `PLAN.md`

---

## Folder structure

```
web/
├── server/
│   ├── index.js       ← entry point, port + browser launch
│   ├── routes/        ← upload, SSE progress, JSON/MD downloads
│   ├── job-manager.js ← in-memory job lifecycle
│   └── lib/launch.js  ← cross-platform open-in-browser
└── public/            ← static SPA, no build step
    ├── index.html
    ├── app.js
    └── styles.css
```

---

## Key decisions

- **Local-only.** Binds to `127.0.0.1`. No auth, no LAN exposure in v1.
- **No build step.** Vanilla HTML/CSS/JS in `public/`. Reverse only if the UI outgrows it.
- **Reuse, don't fork.** The web app calls `audit()` from `../src/index.js`. It must never duplicate check logic. The one allowed touch on `../src` is an optional `onProgress` callback in `audit()` options, added in Phase 2.
- **Progress over SSE.** One-way stream from server to browser; no WebSocket.
- **In-memory jobs only.** Restart the server, jobs are gone. Reports can be downloaded while the process is alive; persistence is out of scope for v1.
- **Default port 4280**, override via `PRISM_PORT` or `--port`.
- **Auto-open the browser** on start. `--no-open` skips it (useful for CI smoke tests).
- **Auto-start audit on drop** — the drop is the intent; no extra "Audit" click.
- **Backward compat for the CLI.** `../src/cli.js` is not modified by this project.

---

## Distribution

Same as the CLI — runs locally from source, not published to npm.

- `npm install` once inside `web/` to pull web-only deps (`express`, `multer`, `open`).
- `npm run serve` from the project root (or `web/`) starts the server and opens a browser.
- Optional global shorthand: `npm link` from `web/` registers `prism-web`.

---

## Coding guidelines

- Same as root: think before coding, state assumptions, surface tradeoffs, ask if unclear.
- Minimum code that solves the problem — no speculative features or abstractions.
- Touch only what the task requires. Match existing style.
- Define success criteria before implementing. Verify after.
- Do not modify `../src` except for the documented hooks added by phases of the cloud roadmap: `onProgress` (Phase 2 of /web; consumes the SSE pipeline) and `signal` (Phase 6 of /cloud; AbortSignal for real cancellation). New hooks land via the cloud roadmap, never as ad-hoc /web edits.
- Frontend: vanilla JS, no framework, no bundler. If a feature seems to need React, raise it as a discussion before adding tooling.
- Server: Express only because it's already familiar; if we ever need more, reconsider rather than layering middleware.
- Delegate to subagents using best model (Opus, Sonnet, or Haiku) to run tasks in parallel whenever possible.
