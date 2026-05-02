/**
 * Cross-platform browser launcher.
 *
 * Wraps the `open` package (pinned to ^8 — the last CommonJS-compatible
 * release; v9+ is ESM-only). Failure to launch is non-fatal: the URL is
 * already printed to the console, so the user can click or paste it.
 */

async function launch(url) {
  // Lazy-require so unit tests / --no-open paths don't pull in the dep.
  const open = require('open');
  return open(url);
}

module.exports = { launch };
