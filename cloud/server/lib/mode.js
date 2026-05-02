/**
 * Central deployment-mode + env validation.
 *
 * One module reads OPEN_PATHWAYS_MODE and validates that hosted mode has
 * the env vars it needs to start safely. Subsequent phases extend this
 * (auth + allowlist in 9B; pg-boss + quotas in 9C); for now the only
 * hosted-mode requirements are SESSION_SECRET and a recognized
 * STORAGE_DRIVER value.
 *
 * Behavior:
 *   - mode === 'local'  (default): single-user, no auth, no public exposure.
 *   - mode === 'hosted': multi-tenant; full hardening enforced. Refuses to
 *     start if required env is missing.
 *
 * Calling validate() is the boot-time gate. It throws on misconfiguration
 * with a single readable message; the caller (server/index.js) prints it
 * and exits non-zero rather than booting in a half-configured state.
 */

const VALID_STORAGE_DRIVERS = new Set(['local-fs', 's3']);
const VALID_MODES = new Set(['local', 'hosted']);

function readMode() {
  const raw = (process.env.OPEN_PATHWAYS_MODE || 'local').trim().toLowerCase();
  if (!VALID_MODES.has(raw)) {
    throw new Error(
      `Invalid OPEN_PATHWAYS_MODE=${raw} (expected 'local' or 'hosted')`
    );
  }
  return raw;
}

function readStorageDriver(mode) {
  // local-fs default keeps the Phase 5 disk layout working unchanged.
  // Hosted-mode default also stays local-fs so 9A can run end-to-end on
  // a single VPS without S3; production swaps to s3 in Phase 10.
  const raw = (process.env.STORAGE_DRIVER || 'local-fs').trim().toLowerCase();
  if (!VALID_STORAGE_DRIVERS.has(raw)) {
    throw new Error(
      `Invalid STORAGE_DRIVER=${raw} (expected 'local-fs' or 's3')`
    );
  }
  return raw;
}

/**
 * Validate the env at boot. Returns a frozen config object; throws on
 * misconfiguration. Caller's job to format the error and exit.
 */
function validate() {
  const mode = readMode();
  const isHosted = mode === 'hosted';
  const isLocal = mode === 'local';
  const storageDriver = readStorageDriver(mode);

  const errors = [];

  if (isHosted) {
    const sessionSecret = process.env.SESSION_SECRET || '';
    // 32 hex chars (~16 bytes) is the bare minimum for a signing secret
    // we'd ever want to rely on. Production SHOULD use 64+; this is the
    // floor for refuse-to-start.
    if (sessionSecret.length < 32) {
      errors.push(
        'OPEN_PATHWAYS_MODE=hosted requires SESSION_SECRET (>=32 chars)'
      );
    }
    if (storageDriver === 's3') {
      // Only validate s3 env when actually using s3. local-fs mode is
      // legitimate for hosted deployments without object storage.
      const need = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'];
      for (const k of need) {
        if (!process.env[k]) errors.push(`STORAGE_DRIVER=s3 requires ${k}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Refusing to start: invalid configuration\n  - ${errors.join('\n  - ')}`
    );
  }

  return Object.freeze({
    mode,
    isHosted,
    isLocal,
    storageDriver,
  });
}

module.exports = { validate, readMode, readStorageDriver };
