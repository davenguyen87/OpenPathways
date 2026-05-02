/**
 * CSRF protection (Phase 9B).
 *
 * Wraps `csrf-csrf` (double-submit cookie). The token is delivered as a
 * cookie on safe requests (GET /api/auth/me) and the SPA sends it back on
 * state-changing requests via the X-CSRF-Token header.
 *
 * In local mode this whole layer is skipped — there's no auth, no
 * meaningful user identity, and no public exposure to defend against.
 */

const { doubleCsrf } = require('csrf-csrf');

const CSRF_COOKIE = 'op_csrf';
const CSRF_HEADER = 'x-csrf-token';

function buildCsrf({ sessionSecret, cookieSecure }) {
  if (!sessionSecret) throw new Error('CSRF: sessionSecret is required');

  // csrf-csrf uses the secret to sign/verify; we reuse SESSION_SECRET
  // since both layers fail together if it leaks (so a separate secret
  // would be ergonomic theater).
  // The library exports `generateToken`. We re-export it under
  // `generateCsrfToken` so route code reads more clearly.
  const {
    doubleCsrfProtection,
    generateToken,
    invalidCsrfTokenError,
  } = doubleCsrf({
    getSecret: () => sessionSecret,
    getSessionIdentifier: (req) => {
      // Identify the "session" the token is bound to. Anonymous users get
      // a stable token rooted on the CSRF cookie itself; authenticated
      // users bind to req.user.id (so a stolen token from one user can't
      // be used against another).
      return (req.user && req.user.id) || 'anon';
    },
    cookieName: CSRF_COOKIE,
    cookieOptions: {
      httpOnly: true,
      sameSite: 'lax',
      secure: !!cookieSecure,
      path: '/',
    },
    size: 64,
    getCsrfTokenFromRequest: (req) => req.headers[CSRF_HEADER],
  });

  return {
    doubleCsrfProtection,
    generateCsrfToken: generateToken,
    invalidCsrfTokenError,
  };
}

module.exports = { buildCsrf, CSRF_COOKIE, CSRF_HEADER };
