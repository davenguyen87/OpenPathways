# Open Pathways — Cloud

The hosted, multi-tenant version of the Open Pathways SCORM/AICC accessibility auditor. Same audit core as the local CLI and the local web tool, with persistent storage, magic-link auth, a worker queue, S3-compatible object storage, and a deploy target of Coolify on a self-hosted VPS.

> **Status:** Phases 5–10 shipped. Deployable end-to-end to Coolify (see [`DEPLOY.md`](DEPLOY.md)). `/web` keeps working as the lightweight local single-user reference.

## What this is

Same audit core as the local CLI and the local web UI in `/web`, but with:

- **Persistent storage.** Reports survive a server restart. Shareable URLs that work tomorrow.
- **Magic-link auth.** Public-internet exposure with no random sign-ups — email allowlist required. (`AUTH_ADAPTER=none` is supported in hosted mode for the current testing window — see `CLAUDE.md`.)
- **Worker queue.** Audits run in a separate process so a slow audit can't block uploads or the UI. pg-boss on Postgres; no Redis.
- **S3-compatible object storage.** MinIO by default, but the same code works with Garage, R2, B2, AWS, etc.
- **Self-hostable.** Deploys to **Coolify on your own VPS**. Fully OSS stack.

## What this is **not**

- Not a fork of the audit core — `/src` stays shared with `/web` and the CLI. Each touch on `/src` is logged in `CLAUDE.md`.
- Not a replacement for `/web`. `/web` keeps working as the lightweight local single-user tool.
- Not published to npm. Not standalone.

## How to read this directory

- **`README.md`** (this file) — overview and pointers.
- **`CLAUDE.md`** — context for AI coding sessions in this folder. Locked-in decisions, tech stack, coding guidelines, the log of touches on `/src`.
- **`ROADMAP.md`** — the original multi-phase build plan (Phases 5–11). Phases 5–10 are shipped; later phases preserved as historical context.
- **`DEPLOY.md`** — operational runbook for deploying to Coolify.
- **`server/`, `worker/`, `public/`, `Dockerfile`, `docker-compose.yml`** — the actual app.

## Deploy target

- **Coolify** on a self-hosted VPS (8 GB RAM, 2–4 vCPU baseline).
- **Postgres** (Coolify-managed) + **MinIO** (in the compose stack) alongside the app.
- **Caddy/Traefik** for reverse proxy + Let's Encrypt TLS (Coolify default).
- **Public-internet exposed**, hardened with `helmet`, `express-rate-limit`, magic-link auth, email allowlist.

Full operational steps in [`DEPLOY.md`](DEPLOY.md).

## Running it

**Local (cloud-mode against the bundled compose stack):**

```bash
# from the project root
npm install --prefix cloud
docker compose -f cloud/docker-compose.yml up -d   # postgres + minio + mail-capture
node cloud/server/index.js                          # or: npm run cloud (from project root)
```

**Local (hosted-mode-lite against external Postgres + S3):**

```bash
OPEN_PATHWAYS_MODE=hosted DATABASE_URL=... S3_ENDPOINT=... node cloud/server/index.js
```

**Production (Coolify):** see [`DEPLOY.md`](DEPLOY.md). Uses the root `docker-compose.yaml` (web + worker + minio share a stack; Postgres is a separate Coolify resource).

The worker runs as a separate process from the same image:

```bash
node cloud/worker/index.js
```
