#!/usr/bin/env node

/**
 * Open Pathways Web — server entry point.
 *
 * Local-only Express server that hosts the SPA in ../public and (in later
 * phases) accepts SCORM/AICC zip uploads, runs audit() from ../../src, and
 * streams progress over Server-Sent Events.
 *
 * Phase 1: serves a placeholder page and exposes /api/version. No upload yet.
 */

const path = require('path');
const express = require('express');
const { launch } = require('./lib/launch');
const { createAuditRouter } = require('./routes/audits');

const pkg = require('../package.json');

const DEFAULT_PORT = 4280;
const HOST = '127.0.0.1';

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
      // npm consumes flags like `--port` itself before forwarding (see
      // readNpmConfigFallbacks). When the user writes
      // `npm run serve --port 4296`, the bare `4296` arrives here as a stray
      // positional. Warn so the surprise is visible, but don't crash.
      console.warn(
        `(ignoring stray arg "${arg}" forwarded by npm; ` +
          `use --port=<n> or "npm run serve -- --port <n>")`
      );
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  return args;
}

/**
 * Read flags that npm forwarded via env vars.
 *
 * `npm run serve --no-open` doesn't pass `--no-open` through to the script
 * (npm consumes it before the script name), but it does export
 * `npm_config_open=""`. Same for `npm run serve --port 1234` →
 * `npm_config_port=1234`. We read those as a fallback so both forms work:
 *   npm run serve -- --no-open --port 4291
 *   npm run serve --no-open --port 4291
 *
 * Precedence (highest first): explicit CLI flag > npm_config_* > env > default.
 */
function readNpmConfigFallbacks() {
  const out = { port: null, open: null };

  if ('npm_config_port' in process.env) {
    const raw = process.env.npm_config_port;
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed)) out.port = parsed;
  }

  if ('npm_config_open' in process.env) {
    // `--no-open` → "" or "false"; `--open` → "true".
    const raw = process.env.npm_config_open;
    out.open = !(raw === '' || raw === 'false');
  }

  return out;
}

function printHelp() {
  console.log(`open-pathways-web v${pkg.version}

Local web UI for the Open Pathways SCORM/AICC accessibility auditor.

Usage:
  node web/server/index.js [options]
  npm run serve [-- options]

Options:
  --port <n>      Port to listen on (default: ${DEFAULT_PORT}, or $OPEN_PATHWAYS_PORT)
  --no-open       Do not auto-launch a browser
  -v, --version   Print version and exit
  -h, --help      Print this help and exit

Environment:
  OPEN_PATHWAYS_PORT   Port override (lower priority than --port)

Note on npm:
  \`npm run serve --no-open\` works directly (npm forwards it as config).
  For --port, use the equals form (\`npm run serve --port=4291\`) or the
  separator form (\`npm run serve -- --port 4291\`). The space form
  \`npm run serve --port 4291\` is a known npm wart — npm consumes --port
  before the script ever sees it.
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
  return true; // default: auto-open browser
}

function createApp() {
  const app = express();

  // Tiny version endpoint used by the placeholder page (and useful as a
  // health probe). Kept JSON-shaped so we can extend without breaking callers.
  app.get('/api/version', (_req, res) => {
    res.json({ name: pkg.name, version: pkg.version });
  });

  // Audit job routes (Phase 2): upload, SSE, JSON/MD downloads.
  const { router: auditRouter } = createAuditRouter();
  app.use('/api', auditRouter);

  // Static SPA assets.
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir, { extensions: ['html'] }));

  // SPA catch-all (Phase 3): any non-/api, non-static GET serves index.html
  // so /job/:id (and any future client-side routes) reload-safely. We avoid
  // using Express's '*' route here because path-to-regexp v6+ trips on it;
  // app.use with no path matches every method but we filter to GET ourselves.
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  return app;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.version) {
    console.log(pkg.version);
    process.exit(0);
  }

  if (args.port !== null && !Number.isFinite(args.port)) {
    console.error('Invalid --port value (expected integer)');
    process.exit(2);
  }

  const npmConfig = readNpmConfigFallbacks();
  const port = resolvePort(args.port, npmConfig.port);
  const open = resolveOpen(args.open, npmConfig.open);
  const app = createApp();

  const server = app.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}`;
    console.log(`Open Pathways Web v${pkg.version} listening on ${url}`);
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

  const shutdown = (signal) => {
    console.log(`\nReceived ${signal}, shutting down…`);
    server.close(() => process.exit(0));
    // Hard-exit safety net in case a hung connection prevents close().
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main();
}

module.exports = { createApp, parseArgs, resolvePort, resolveOpen, readNpmConfigFallbacks };
