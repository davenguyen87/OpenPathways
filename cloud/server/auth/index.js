/**
 * Auth factory (Phase 9B).
 *
 * Returns an auth adapter based on mode:
 *   - local mode → NoneAuth (single-tenant, no auth)
 *   - hosted mode → MagicLinkAuth (magic-link via SMTP / capture)
 *
 * The factory also returns the Allowlist instance so callers can validate
 * inbound emails consistently.
 */

const { Allowlist } = require('./allowlist');
const { NoneAuth } = require('./none');
const { MagicLinkAuth } = require('./magic-link');

function createAuth({ mode, store }) {
  if (mode === 'local') {
    return { auth: new NoneAuth(), allowlist: null };
  }
  if (mode === 'hosted') {
    // TEMPORARY DEVIATION (testing window): AUTH_ADAPTER=none disables auth in
    // hosted mode. This is a conscious deviation from CLAUDE.md's locked-in decision
    // that auth is mandatory in hosted mode. Re-evaluate before opening to users.
    // Flip back: remove or unset AUTH_ADAPTER, set ALLOWLIST + SMTP, redeploy.
    if (process.env.AUTH_ADAPTER === 'none') {
      console.warn('[auth] AUTH_ADAPTER=none — authentication is DISABLED. All requests are unauthenticated. Anyone with the URL can use this instance.');
      return { auth: new NoneAuth(), allowlist: null };
    }

    const allowlist = Allowlist.fromEnv();
    if (allowlist.isEmpty()) {
      throw new Error(
        'OPEN_PATHWAYS_MODE=hosted requires ALLOWLIST_EMAIL_DOMAINS or ALLOWLIST_EMAILS'
      );
    }
    // SMTP env required UNLESS MAIL_CAPTURE_DIR is set (test/dev path).
    const captureMode = !!process.env.MAIL_CAPTURE_DIR;
    if (!captureMode && !process.env.SMTP_HOST) {
      throw new Error(
        'OPEN_PATHWAYS_MODE=hosted requires SMTP_HOST (or MAIL_CAPTURE_DIR for tests)'
      );
    }
    const auth = MagicLinkAuth.fromEnv({ store, allowlist });
    return { auth, allowlist };
  }
  throw new Error(`createAuth: unknown mode ${mode}`);
}

module.exports = { createAuth };
