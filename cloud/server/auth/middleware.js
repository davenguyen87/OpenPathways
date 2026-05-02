/**
 * Auth middleware (Phase 9B).
 *
 * attachUser: reads the signed session cookie and populates req.user. Runs
 *             on every request in hosted mode. Never throws — an invalid
 *             cookie just leaves req.user unset.
 *
 * requireAuth: 401s when req.user is unset. Mounted on protected routes
 *              in hosted mode.
 */

const SESSION_COOKIE = 'op_session';

function attachUser({ auth }) {
  return async (req, _res, next) => {
    try {
      // signedCookies present when cookie-parser was mounted with a secret.
      const raw = req.signedCookies && req.signedCookies[SESSION_COOKIE];
      if (!raw) return next();
      const user = await auth.getUserBySessionRaw(raw);
      if (user) req.user = user;
    } catch (_) { /* leave req.user unset */ }
    next();
  };
}

function requireAuth() {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    next();
  };
}

module.exports = { attachUser, requireAuth, SESSION_COOKIE };
