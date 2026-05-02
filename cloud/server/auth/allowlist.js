/**
 * Email allowlist (Phase 9B).
 *
 * Hosted-mode boot requires at least one of:
 *   ALLOWLIST_EMAIL_DOMAINS=mycompany.com,otherco.com
 *   ALLOWLIST_EMAILS=alice@example.com,bob@example.com
 *
 * Comparison is case-insensitive on both inputs and the user-supplied email.
 *
 * The allowlist gates `POST /api/auth/request` — emails not in the list
 * receive a 403 (with a message that doesn't reveal whether the address
 * is registered, just that it's not permitted).
 */

function parseList(raw) {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

class Allowlist {
  /**
   * @param {object} opts
   * @param {string} [opts.domains] - comma-separated.
   * @param {string} [opts.emails]  - comma-separated.
   */
  constructor({ domains, emails } = {}) {
    this.domains = parseList(domains);
    this.emails = parseList(emails);
  }

  static fromEnv() {
    return new Allowlist({
      domains: process.env.ALLOWLIST_EMAIL_DOMAINS,
      emails: process.env.ALLOWLIST_EMAILS,
    });
  }

  isEmpty() {
    return this.domains.length === 0 && this.emails.length === 0;
  }

  /**
   * @param {string} email
   * @returns {boolean}
   */
  allows(email) {
    if (typeof email !== 'string') return false;
    const e = email.trim().toLowerCase();
    if (!e || !e.includes('@')) return false;
    if (this.emails.includes(e)) return true;
    const at = e.lastIndexOf('@');
    const domain = e.slice(at + 1);
    if (this.domains.includes(domain)) return true;
    return false;
  }
}

module.exports = { Allowlist, parseList };
