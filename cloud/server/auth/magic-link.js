/**
 * Magic-link auth adapter (Phase 9B).
 *
 * Flow:
 *   1. POST /api/auth/request {email}
 *      → generate a 32-byte random token; store its sha256 in
 *        magic_link_tokens; email the user a link containing the raw token.
 *   2. GET /api/auth/verify/:token
 *      → hash the inbound token; atomically consume the row; create or
 *        look up the user; create a session; set a signed cookie; redirect.
 *   3. POST /api/auth/logout
 *      → revoke the session; clear the cookie.
 *
 * Tokens are 256 bits of entropy; even without expiry the lookup space is
 * effectively infinite. We still enforce a 15-minute TTL and consume-once
 * semantics. Sessions are 30 days; the cookie is httpOnly, signed via
 * SESSION_SECRET, and SameSite=Lax; Secure is set when the request was
 * made over TLS (in front of Coolify+Caddy/Traefik this is automatic via
 * X-Forwarded-Proto when trust-proxy is enabled).
 *
 * Email transport:
 *   - Production: SMTP via nodemailer using SMTP_HOST/PORT/USER/PASS/FROM.
 *   - Tests / dev: set MAIL_CAPTURE_DIR=<path>; we write each "sent" email
 *     to <path>/<token-id>.json. The smoke test reads these files to
 *     extract the verification URL.
 *
 * The same code path runs in either case; only the transport differs.
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const nodemailer = require('nodemailer');

const TOKEN_TTL_MS = 15 * 60 * 1000;       // 15 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOKEN_BYTES = 32;
const SESSION_BYTES = 32;

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function makeRandom(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function buildTransport({ captureDir, smtpHost, smtpPort, smtpUser, smtpPass, smtpSecure }) {
  if (captureDir) {
    // Test/dev capture: write each message to disk as JSON. The actual
    // nodemailer call still goes through the standard sendMail path; we
    // just intercept by using nodemailer's "stream" transport semantics
    // via a minimal custom transport.
    return {
      sendMail: async (message) => {
        await fs.mkdir(captureDir, { recursive: true });
        const filename = path.join(
          captureDir,
          `${Date.now()}-${makeRandom(4)}.json`
        );
        await fs.writeFile(filename, JSON.stringify(message, null, 2), 'utf8');
        return { messageId: filename };
      },
    };
  }
  return nodemailer.createTransport({
    host: smtpHost,
    port: Number(smtpPort) || 587,
    secure: !!smtpSecure,
    auth: smtpUser ? { user: smtpUser, pass: smtpPass } : undefined,
  });
}

class MagicLinkAuth {
  /**
   * @param {object} opts
   * @param {object} opts.store - SqliteStore | PostgresStore
   * @param {object} opts.allowlist - Allowlist instance
   * @param {object} opts.transport - { sendMail: async (message) => ... }
   * @param {string} opts.from - From-address for outgoing magic-link mail.
   * @param {string} opts.publicBaseUrl - e.g. "https://op.example.com".
   *                                       Used to build the verify URL.
   */
  constructor({ store, allowlist, transport, from, publicBaseUrl }) {
    if (!store) throw new Error('MagicLinkAuth: store is required');
    if (!allowlist) throw new Error('MagicLinkAuth: allowlist is required');
    if (!transport) throw new Error('MagicLinkAuth: transport is required');
    this.store = store;
    this.allowlist = allowlist;
    this.transport = transport;
    this.from = from || 'Prism <noreply@example.com>';
    this.publicBaseUrl = (publicBaseUrl || '').replace(/\/$/, '');
  }

  static fromEnv({ store, allowlist }) {
    const captureDir = process.env.MAIL_CAPTURE_DIR;
    const transport = buildTransport({
      captureDir,
      smtpHost: process.env.SMTP_HOST,
      smtpPort: process.env.SMTP_PORT,
      smtpUser: process.env.SMTP_USER,
      smtpPass: process.env.SMTP_PASS,
      smtpSecure: process.env.SMTP_SECURE === 'true',
    });
    return new MagicLinkAuth({
      store,
      allowlist,
      transport,
      from: process.env.SMTP_FROM,
      publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    });
  }

  driver() { return 'magic-link'; }
  isEnabled() { return true; }

  /**
   * Issue a magic-link token + send the email. Returns nothing useful — the
   * caller responds 200 to avoid leaking whether the address was accepted
   * (when used outside the allowlist gate). The route handler decides
   * whether to call this method based on allowlist.allows().
   */
  async issueToken({ email }) {
    const rawToken = makeRandom(TOKEN_BYTES);
    const tokenHash = sha256Hex(rawToken);
    const now = Date.now();
    await this.store.createMagicLinkToken({
      id: tokenHash,
      email,
      createdAt: now,
      expiresAt: now + TOKEN_TTL_MS,
    });
    const verifyUrl = `${this.publicBaseUrl || ''}/api/auth/verify/${rawToken}`;
    await this.transport.sendMail({
      from: this.from,
      to: email,
      subject: 'Sign in to Prism',
      text: [
        'Click the link below to sign in. The link is valid for 15 minutes.',
        '',
        verifyUrl,
        '',
        "If you didn't request this, ignore this message.",
      ].join('\n'),
      html:
        `<p>Click the link below to sign in. The link is valid for 15 minutes.</p>` +
        `<p><a href="${verifyUrl}">Sign in to Prism</a></p>` +
        `<p>If you didn't request this, ignore this message.</p>`,
    });
  }

  /**
   * Consume an inbound token. Returns { sessionId, sessionRaw, user } on
   * success; null on failure (invalid token, expired, already consumed).
   */
  async verifyToken(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') return null;
    const tokenHash = sha256Hex(rawToken);
    const consumed = await this.store.consumeMagicLinkToken(tokenHash);
    if (!consumed) return null;
    const email = consumed.email;

    // Find or create the user.
    let user = await this.store.getUserByEmail(email);
    if (!user) {
      const id = crypto.randomUUID();
      await this.store.createUser({ id, email, createdAt: Date.now() });
      user = await this.store.getUserByEmail(email);
    }

    // Create a session.
    const sessionRaw = makeRandom(SESSION_BYTES);
    const sessionId = sha256Hex(sessionRaw);
    const now = Date.now();
    await this.store.createSession({
      id: sessionId,
      userId: user.id,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });

    return { sessionId, sessionRaw, user };
  }

  async revokeSessionRaw(rawSession) {
    if (!rawSession) return;
    await this.store.revokeSession(sha256Hex(rawSession));
  }

  async getUserBySessionRaw(rawSession) {
    if (!rawSession) return null;
    const session = await this.store.getSession(sha256Hex(rawSession));
    if (!session) return null;
    return this.store.getUserById(session.userId);
  }
}

module.exports = {
  MagicLinkAuth,
  buildTransport,
  sha256Hex,
  TOKEN_TTL_MS,
  SESSION_TTL_MS,
};
