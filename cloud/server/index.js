#!/usr/bin/env node

/**
 * Open Pathways Cloud — server entry point (Phase 5).
 *
 * Forked from /web/server/index.js. The Phase 5 difference vs /web is
 * persistence: jobs survive a server restart. Mode-aware hardening,
 * auth, S3, pg-boss, and quotas all land in Phase 9.
 *
 * Boot sequence:
 *   1. Parse CLI flags / env (port, --no-open, DB driver, retention).
 *   2. Construct the store (sqlite by default, postgres if configured).
 *   3. init() → applies any un-applied numbered migration files.
 *   4. markInterrupted() → flips orphaned pending/running rows to error.
 *   5. Construct the JobManager with the store; attach the audit() runner.
 *   6. Start the retention worker (no-op when OPEN_PATHWAYS_RETENTION_DAYS=0).
 *   7. Express app + audit router; bind to 127.0.0.1.
 *   8. SIGINT/SIGTERM → drain JobManager pending writes → close server →
 *      close store.
 */

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { launch } = require('./lib/launch');
const { createAuditRouter } = require('./routes/audits');
const { createAuthRouter } = require('./routes/auth');
const { createStore } = require('./store');
const { createStorage } = require('./storage');
const { createAuth } = require('./auth');
const { attachUser, requireAuth } = require('./auth/middleware');
const { buildCsrf } = require('./auth/csrf');
const { JobManager } = require('./job-manager');
const { RetentionWorker } = require('./lib/retention');
const { createQueue } = require('./lib/queue');
const modeLib = require('./lib/mode');
const { audit } = require('../../src/index');

const pkg = require('../package.json');

const DEFAULT_PORT = 4280;
// Bind interface — defaults to 0.0.0.0 so containers + reverse proxies
// can reach us. Override with OPEN_PATHWAYS_HOST=127.0.0.1 for the
// loopback-only behavior /web/server/index.js uses.
const HOST = process.env.OPEN_PATHWAYS_HOST || '0.0.0.0';

function parseArgs(argv) {
  const args = { port: null, open: null, help: false, version: false };
  const underNpm = !!process.env.npm_lifecycle_event;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--version' || arg === '-v') {
      args.version = true;
    } else if (arg === '--no-open') {
      args.open = false;
    } else if (arg === '--open') {
      args.open = true;
    } else if (arg === '--port') {
      args.port = parseInt(argv[++i], 10);
    } else if (arg.startsWith('--port=')) {
      args.port = parseInt(arg.slice('--port='.length), 10);
    } else if (underNpm) {
      console.warn(
        `(ignoring stray arg "${arg}" forwarded by npm; ` +
          `use --port=<n> or "npm run cloud -- --port <n>")`
      );
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  return args;
}

function readNpmConfigFallbacks() {
  const out = { port: null, open: null };

  if ('npm_config_port' in process.env) {
    const raw = process.env.npm_config_port;
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed)) out.port = parsed;
  }

  if ('npm_config_open' in process.env) {
    const raw = process.env.npm_config_open;
    out.open = !(raw === '' || raw === 'false');
  }

  return out;
}

function printHelp() {
  console.log(`open-pathways-cloud v${pkg.version}

Hosted multi-tenant version of the Open Pathways SCORM/AICC accessibility
auditor. In Phase 5 this runs locally with persistent SQLite-backed jobs.

Usage:
  node cloud/server/index.js [options]
  npm run cloud [-- options]

Options:
  --port <n>      Port to listen on (default: ${DEFAULT_PORT}, or $OPEN_PATHWAYS_PORT)
  --no-open       Do not auto-launch a browser
  -v, --version   Print version and exit
  -h, --help      Print this help and exit

Environment:
  OPEN_PATHWAYS_PORT             Port override (lower priority than --port)
  DB_DRIVER                      'sqlite' (default) or 'postgres'
  SQLITE_PATH                    SQLite file path (default: cloud/.tmp/op.sqlite)
  DATABASE_URL                   Postgres connection string (required when DB_DRIVER=postgres)
  OPEN_PATHWAYS_RETENTION_DAYS   Retention in days (default: 0 = forever)
`);
}

function resolvePort(flagPort, npmConfigPort) {
  if (Number.isFinite(flagPort)) return flagPort;
  if (Number.isFinite(npmConfigPort)) return npmConfigPort;

  const envPort = process.env.OPEN_PATHWAYS_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!Number.isFinite(parsed)) {
      console.error(`Invalid OPEN_PATHWAYS_PORT: ${envPort}`);
      process.exit(2);
    }
    return parsed;
  }

  return DEFAULT_PORT;
}

function resolveOpen(flagOpen, npmConfigOpen) {
  if (flagOpen !== null) return flagOpen;
  if (npmConfigOpen !== null) return npmConfigOpen;
  return true;
}

function resolveRetentionDays() {
  const raw = process.env.OPEN_PATHWAYS_RETENTION_DAYS;
  if (raw === undefined || raw === '') return 0;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`Invalid OPEN_PATHWAYS_RETENTION_DAYS: ${raw}`);
    process.exit(2);
  }
  return parsed;
}

/**
 * Build the Express app. Exported for tests.
 *
 * @param {object} deps
 * @param {object} deps.jobs - JobManager
 * @param {object} [deps.config] - { mode, isHosted, ... } from lib/mode.validate()
 * @param {object} [deps.auth]  - auth adapter from createAuth() (hosted only).
 * @param {object} [deps.store] - store handle (used by auth middleware for /me).
 */
function createApp({ jobs, config, auth, store, storage }) {
  const app = express();
  const cfg = config || { mode: 'local', isHosted: false, isLocal: true };

  // ---- Phase 9A hardening: helmet ----
  if (cfg.isHosted) {
    app.use(helmet({
      strictTransportSecurity: { maxAge: 60 * 60 * 24 * 180, includeSubDomains: true, preload: false },
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
        },
      },
    }));
  } else {
    app.use(helmet({
      strictTransportSecurity: false,
      contentSecurityPolicy: false,
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));
  }

  // ---- Phase 9B: cookie + auth + csrf middleware (hosted only) ----
  let csrf = null;
  let csrfProtect = null;
  if (cfg.isHosted) {
    app.use(cookieParser(process.env.SESSION_SECRET));
    app.set('trust proxy', 1); // Coolify+Caddy/Traefik sit in front
    csrf = buildCsrf({
      sessionSecret: process.env.SESSION_SECRET,
      cookieSecure: process.env.OPEN_PATHWAYS_BEHIND_TLS === 'true',
    });
    csrfProtect = csrf.doubleCsrfProtection;
    app.use(attachUser({ auth }));
  }

  app.get('/api/version', (_req, res) => {
    res.json({ name: pkg.name, version: pkg.version, mode: cfg.mode });
  });

  // Phase 10: /api/health pings DB + storage. Used by Coolify routing
  // and the Dockerfile HEALTHCHECK. 503 on any subsystem failure.
  app.get('/api/health', async (_req, res) => {
    const result = { mode: cfg.mode, db: 'unknown', storage: 'unknown' };
    let ok = true;
    try {
      if (store && typeof store.ping === 'function') {
        await store.ping();
      }
      result.db = 'ok';
    } catch (err) {
      ok = false;
      result.db = `error: ${err.message}`;
    }
    try {
      if (storage && typeof storage.usage === 'function') {
        // usage() also exercises the connection for s3 (ListObjectsV2);
        // for local-fs it's a directory walk, cheap.
        await storage.usage();
      }
      result.storage = 'ok';
    } catch (err) {
      ok = false;
      result.storage = `error: ${err.message}`;
    }
    res.status(ok ? 200 : 503).json(result);
  });

  // Auth routes (hosted only).
  if (cfg.isHosted) {
    const { router: authRouter } = createAuthRouter({
      auth,
      allowlist: auth.allowlist || null,
      csrf,
      store,
      cookieSecure: process.env.OPEN_PATHWAYS_BEHIND_TLS === 'true',
    });
    app.use('/api', authRouter);
  }

  const { router: auditRouter } = createAuditRouter({
    jobs,
    config: cfg,
    requireAuth: cfg.isHosted ? requireAuth() : null,
    csrfProtect,
    store,
  });
  app.use('/api', auditRouter);

  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir, { extensions: ['html'] }));

  // SPA catch-all for /job/:id and any future client-side routes.
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  return app;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) { printHelp(); process.exit(0); }
  if (args.version) { console.log(pkg.version); process.exit(0); }

  if (args.port !== null && !Number.isFinite(args.port)) {
    console.error('Invalid --port value (expected integer)');
    process.exit(2);
  }

  const npmConfig = readNpmConfigFallbacks();
  const port = resolvePort(args.port, npmConfig.port);
  const open = resolveOpen(args.open, npmConfig.open);
  const retentionDays = resolveRetentionDays();

  // ----- mode + env validation -----
  let config;
  try { config = modeLib.validate(); }
  catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  // ----- storage init -----
  const storage = createStorage();
  await storage.init();

  // ----- store init -----
  const store = createStore();
  await store.init();

  // ----- auth init -----
  let authBundle = { auth: null, allowlist: null };
  try { authBundle = createAuth({ mode: config.mode, store }); }
  catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  // Hand the allowlist back to the auth instance so /api/auth/me etc.
  // can reference it without re-parsing env vars.
  if (authBundle.auth && authBundle.allowlist) {
    authBundle.auth.allowlist = authBundle.allowlist;
  }
  const interrupted = await store.markInterrupted();
  if (interrupted.length > 0) {
    console.warn(
      `Marked ${interrupted.length} interrupted job(s) as error after restart.`
    );
  }

  // ----- job manager -----
  const log = (entry) => {
    // Phase 5: plain console.warn. Phase 9 swaps in pino structured logs.
    console.warn(`[job-manager] ${JSON.stringify(entry)}`);
  };
  const jobs = new JobManager({ store, log });
  jobs.setRunner(async (hot, emit) => {
    return audit(hot.uploadPath, {
      ...hot.options,
      packagePath: hot.uploadPath,
      onProgress: (ev) => emit(ev),
      // Phase 6: lets cancel() actually stop a mid-Playwright audit.
      signal: hot.signal,
    });
  });

  // ----- queue (Phase 9C) -----
  // In-process by default (zero behavior change). PgBossQueue ships ready
  // for Phase 10's docker-compose deploy; web container enqueues, worker
  // consumes. Even with pg-boss configured the web side passes runJob=null
  // so it never subscribes — only the worker dequeues.
  const queue = createQueue({ runJob: null });
  try { await queue.start(); }
  catch (err) {
    console.error(`Queue init failed: ${err.message}`);
    process.exit(2);
  }

  // ----- retention + 80%-cap eviction -----
  const quotaStoredBytesTotal = (() => {
    const raw = process.env.QUOTA_STORED_BYTES_TOTAL;
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  })();
  const retention = new RetentionWorker({
    store,
    storage,
    retentionDays,
    quotaStoredBytesTotal,
    log: (entry) => console.log(`[retention] ${JSON.stringify(entry)}`),
  });
  retention.start();

  // ----- HTTP -----
  const app = createApp({ jobs, config, auth: authBundle.auth, store, storage });
  const server = app.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}`;
    console.log(`Open Pathways Cloud v${pkg.version} listening on ${url}`);
    console.log(`(mode=${config.mode}, db=${store.driver()}, storage=${storage.driver()}, retentionDays=${retentionDays})`);
    if (open) {
      launch(url).catch((err) => {
        console.warn(`(could not auto-open browser: ${err.message})`);
      });
    } else {
      console.log('(--no-open: skipping browser launch)');
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `Port ${port} is already in use. ` +
          `Pick another with --port <n> or OPEN_PATHWAYS_PORT=<n>.`
      );
      process.exit(1);
    }
    console.error(`Server error: ${err.message}`);
    process.exit(1);
  });

  // ----- graceful shutdown -----
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down…`);

    // Drain progress writes BEFORE closing the server so any client mid-SSE
    // sees its in-flight events persisted to the row.
    try { await jobs.drainAll(); } catch (_) {}
    try { retention.stop(); } catch (_) {}

    server.close(async () => {
      try { await queue.stop(); } catch (_) {}
      try { await store.close(); } catch (_) {}
      try { await storage.close(); } catch (_) {}
      process.exit(0);
    });
    // Hard-exit safety net.
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Fatal: ${err.stack || err.message || err}`);
    process.exit(1);
  });
}

module.exports = { createApp, parseArgs, resolvePort, resolveOpen, readNpmConfigFallbacks };
