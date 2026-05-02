/**
 * No-op auth adapter for local mode.
 *
 * In local mode there are no users, sessions, or magic links. The
 * middleware leaves req.user unset; routes operate as before. Trying to
 * exercise auth-only endpoints (e.g. POST /api/auth/request) returns 404
 * (the routes aren't mounted in local mode).
 */

class NoneAuth {
  driver() { return 'none'; }
  isEnabled() { return false; }

  attachUser() {
    return (_req, _res, next) => next();
  }

  requireAuth() {
    // In local mode, requireAuth is a no-op; routes implicitly act as a
    // single-tenant. The check is gated by the calling code which uses
    // mode-aware composition (see server/index.js).
    return (_req, _res, next) => next();
  }
}

module.exports = { NoneAuth };
