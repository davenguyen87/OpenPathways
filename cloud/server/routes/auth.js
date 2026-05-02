/**
 * Auth routes (Phase 9B). Mounted only in hosted mode.
 *
 *   POST /api/auth/request           {email}     Send a magic link.
 *   GET  /api/auth/verify/:token                  Consume token → session.
 *   POST /api/auth/logout                         Revoke session.
 *   GET  /api/auth/me                             { user, csrfToken } | 401
 *
 * The /request endpoint is rate-limited (memory store for now; the
 * Postgres-backed limiter lands in 9C). Failed and successful attempts
 * are recorded in login_attempts + auth_audit_log for forensics.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const { SESSION_COOKIE } = require('../auth/middleware');

// Permissive email shape check — the allowlist is the actual gate.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function createAuthRouter({ auth, allowlist, csrf, store, cookieSecure }) {
  const router = express.Router();

  // Opt-in DB-backed rate-limit store (Phase 9C). Survives server restart;
  // fall back to express-rate-limit's default memory store when unset.
  let rlStore;
  if ((process.env.RATE_LIMIT_STORE || '').toLowerCase() === 'postgres' ||
      (process.env.RATE_LIMIT_STORE || '').toLowerCase() === 'db') {
    const { DbRateLimitStore } = require('../auth/rate-limit-store');
    rlStore = new DbRateLimitStore({ store, windowMs: 15 * 60 * 1000 });
  }

  const requestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,                   // 5 requests / IP / 15 min
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Try again later.' },
    store: rlStore,
  });

  // ------------------------------------------------------------------
  // POST /api/auth/request
  // ------------------------------------------------------------------
  router.post('/auth/request', requestLimiter, express.json(), async (req, res) => {
    const email = (req.body && typeof req.body.email === 'string')
      ? req.body.email.trim().toLowerCase()
      : '';
    const ip = req.ip || (req.connection && req.connection.remoteAddress) || null;
    const ua = req.get('user-agent') || null;
    const now = Date.now();

    if (!EMAIL_RE.test(email)) {
      await store.recordLoginAttempt({ email, ip, success: false, attemptedAt: now });
      await store.logAuthEvent({
        eventType: 'auth.request.invalid_email', ip, userAgent: ua, occurredAt: now,
        details: { email },
      });
      return res.status(400).json({ error: 'Invalid email address' });
    }

    if (!allowlist.allows(email)) {
      await store.recordLoginAttempt({ email, ip, success: false, attemptedAt: now });
      await store.logAuthEvent({
        eventType: 'auth.request.not_allowed', ip, userAgent: ua, occurredAt: now,
        details: { email },
      });
      // Don't leak allowlist semantics; still 403 so legit users know.
      return res.status(403).json({ error: 'This address is not permitted to sign in.' });
    }

    try {
      await auth.issueToken({ email });
      await store.recordLoginAttempt({ email, ip, success: true, attemptedAt: now });
      await store.logAuthEvent({
        eventType: 'auth.request.issued', ip, userAgent: ua, occurredAt: now,
        details: { email },
      });
      res.json({ ok: true });
    } catch (err) {
      await store.logAuthEvent({
        eventType: 'auth.request.error', ip, userAgent: ua, occurredAt: now,
        details: { email, error: err.message },
      });
      res.status(500).json({ error: `Could not send magic link: ${err.message}` });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/auth/verify/:token
  //
  // On success: set the session cookie, then 302 redirect to '/'. Set-Cookie
  // is honored on 302 by all modern browsers, and 302 plays nicely with the
  // hosted-mode CSP (which forbids inline scripts).
  // On failure: 400 with a small static HTML page (no inline scripts; CSP-safe).
  // ------------------------------------------------------------------
  router.get('/auth/verify/:token', async (req, res) => {
    const ip = req.ip || (req.connection && req.connection.remoteAddress) || null;
    const ua = req.get('user-agent') || null;
    const now = Date.now();

    let result;
    try {
      result = await auth.verifyToken(req.params.token);
    } catch (err) {
      await store.logAuthEvent({
        eventType: 'auth.verify.error', ip, userAgent: ua, occurredAt: now,
        details: { error: err.message },
      });
      return res.status(500).send(htmlError('Sign-in failed.'));
    }

    if (!result) {
      await store.logAuthEvent({
        eventType: 'auth.verify.invalid', ip, userAgent: ua, occurredAt: now,
      });
      return res.status(400).send(htmlError(
        'This sign-in link is invalid, expired, or already used.'
      ));
    }

    res.cookie(SESSION_COOKIE, result.sessionRaw, {
      httpOnly: true,
      sameSite: 'lax',
      secure: !!cookieSecure,
      path: '/',
      signed: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,   // 30 days
    });

    await store.logAuthEvent({
      userId: result.user.id,
      eventType: 'auth.verify.success', ip, userAgent: ua, occurredAt: now,
    });

    res.redirect(302, '/');
  });

  // ------------------------------------------------------------------
  // POST /api/auth/logout
  // ------------------------------------------------------------------
  router.post('/auth/logout', async (req, res) => {
    const raw = req.signedCookies && req.signedCookies[SESSION_COOKIE];
    const ip = req.ip || null;
    const ua = req.get('user-agent') || null;
    if (raw) {
      try { await auth.revokeSessionRaw(raw); } catch (_) {}
    }
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    if (req.user) {
      await store.logAuthEvent({
        userId: req.user.id, eventType: 'auth.logout', ip, userAgent: ua,
        occurredAt: Date.now(),
      });
    }
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------
  // GET /api/auth/me
  // ------------------------------------------------------------------
  router.get('/auth/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    // CSRF token issued on /me; the SPA caches it and attaches it as
    // X-CSRF-Token on subsequent state-changing requests.
    let csrfToken = null;
    if (csrf && csrf.generateCsrfToken) {
      csrfToken = csrf.generateCsrfToken(req, res);
    }
    res.json({
      user: { id: req.user.id, email: req.user.email },
      csrfToken,
    });
  });

  return { router };
}

function htmlError(msg) {
  return `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>` +
    `<p>${msg}</p><p><a href="/">Back to home</a></p>`;
}

module.exports = { createAuthRouter };
