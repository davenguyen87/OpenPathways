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
