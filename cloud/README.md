# Open Pathways — Cloud

The hosted, multi-tenant version of the Open Pathways SCORM/AICC
accessibility auditor.

> **Status: scaffolding only.** Phase 5 (persistence) is the next step.
> Until then, this directory contains only the spec and the project
> skeleton. Use `/web` for the working local-only tool, or `/src/cli.js`
> for the CLI.

## What this is

Same audit core as the local CLI and the local web UI in `/web`, but with:

- **Persistent storage.** Reports survive a server restart. Shareable URLs
  that work tomorrow.
- **Magic-link auth.** Public-internet exposure with no random sign-ups —
  email allowlist required.
- **Worker queue.** Audits run in a separate process so a slow audit can't
  block uploads or the UI.
- **S3-compatible object storage.** MinIO by default, but the same code
  works with Garage, R2, B2, AWS, etc.
- **Self-hostable.** Deploys to **Coolify on your own VPS**. Fully OSS stack.

## What this is **not**

- Not a fork of the audit core — `/src` stays shared with `/web` and the
  CLI.
- Not a replacement for `/web` yet. `/web` keeps working as the lightweight
  local single-user tool.
- Not published to npm. Not standalone.

## How to read this directory

- **`CLAUDE.md`** — context for AI coding sessions in this folder. Locked-in
  decisions, tech stack, coding guidelines, the log of touches on `/src`.
- **`ROADMAP.md`** — the canonical multi-phase build plan (Phases 5–11).
- **`server/`, `worker/`, `public/`, etc.** — populated incrementally,
  one phase at a time.

## Phase 5 will install

When Phase 5 starts, `npm install --prefix cloud` will pull in:

- `express`, `multer`, `pg`, `better-sqlite3`, `pg-boss`,
  `@aws-sdk/client-s3`, `nodemailer`, `helmet`, `express-rate-limit`,
  `pino`, `@aws-sdk/lib-storage`, `cookie-parser`, `csurf`-equivalent.

All MIT / Apache 2.0 / BSD. See `CLAUDE.md` for the full table.

## Deploy target

- **Coolify** on a self-hosted VPS (8 GB RAM, 2–4 vCPU baseline).
- **Postgres** + **MinIO** as Coolify-managed services alongside the app.
- **Caddy/Traefik** for reverse proxy + Let's Encrypt TLS (Coolify default).
- **Public-internet exposed**, hardened with `helmet`,
  `express-rate-limit`, magic-link auth, email allowlist.

See `ROADMAP.md` Phase 10 for the full deploy spec.

## Running it (later)

Once Phase 5 lands:

```bash
# from the project root
npm install --prefix cloud
docker compose -f cloud/docker-compose.yml up -d   # postgres + minio
npm run cloud                                       # starts the dev server
```

Until then, `npm run cloud` is a stub.
