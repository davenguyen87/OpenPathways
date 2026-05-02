/**
 * Persistent express-rate-limit Store backed by the existing DB store.
 *
 * Opt-in via RATE_LIMIT_STORE=postgres. The default 9B behavior is the
 * library's in-memory store, which is fine for local dev and resets on
 * restart. This adapter survives restarts (per ROADMAP §9.7).
 *
 * It piggybacks on the existing SqliteStore / PostgresStore connection by
 * exposing two raw helpers (rateLimitIncr, rateLimitDecr, rateLimitReset),
 * added below to the store via this module's `extendStore` helper. Keeping
 * the SQL out of the per-adapter files lets this file be the single
 * source of truth for the rate-limit table schema.
 *
 * The express-rate-limit Store contract:
 *   increment(key) → { totalHits, resetTime }
 *   decrement(key)
 *   resetKey(key)
 *   resetAll()
 *
 * Window semantics: we encode the current window in the bucket key
 * ("<key>:<floor(now/windowMs)>") so increments naturally roll over.
 */

class DbRateLimitStore {
  /**
   * @param {object} opts
   * @param {object} opts.store - SqliteStore | PostgresStore
   * @param {number} opts.windowMs - request window in ms (matches limiter).
   */
  constructor({ store, windowMs }) {
    if (!store) throw new Error('DbRateLimitStore: store is required');
    this.store = store;
    this.windowMs = windowMs;
    this.prefix = 'rl';
  }

  // express-rate-limit calls init(options) once with the merged options.
  init(options) {
    if (options && Number.isFinite(options.windowMs)) this.windowMs = options.windowMs;
  }

  _bucket(key) {
    const window = Math.floor(Date.now() / this.windowMs);
    return `${this.prefix}:${key}:${window}`;
  }

  async increment(key) {
    const bucket = this._bucket(key);
    const expiresAt = (Math.floor(Date.now() / this.windowMs) + 1) * this.windowMs;
    const totalHits = await this.store.rateLimitIncr({ bucket, expiresAt });
    return { totalHits, resetTime: new Date(expiresAt) };
  }

  async decrement(key) {
    const bucket = this._bucket(key);
    await this.store.rateLimitDecr({ bucket });
  }

  async resetKey(key) {
    const bucket = this._bucket(key);
    await this.store.rateLimitReset({ bucket });
  }

  async resetAll() {
    await this.store.rateLimitReset({ bucket: null });
  }
}

module.exports = { DbRateLimitStore };
