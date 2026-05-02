/**
 * Ensures Playwright + a usable Chromium binary are available before the
 * dynamic-check pass runs. Dynamic checks are mandatory in this build, so the
 * orchestrator calls this first and either proceeds, or marks the audit
 * INCOMPLETE if even an auto-install can't recover.
 *
 * Strategy:
 *   1. require('playwright')                       — is the package installed?
 *   2. chromium.executablePath() + fs.access       — is the browser binary on disk?
 *   3. If (2) fails, run `npx playwright install chromium` synchronously,
 *      streaming output so the user sees what's happening, then re-check.
 *   4. Return { ok, reason?, installed? }.
 *
 * We do NOT actually launch a browser here — that's the orchestrator's job.
 * This helper only proves the binary is reachable on disk. A failed launch
 * later (e.g. sandbox denies execve) still trips the INCOMPLETE path through
 * the orchestrator's catch block, which is fine.
 */

const fs = require('fs');
const { spawnSync } = require('child_process');

/**
 * @param {object} [options]
 * @param {boolean} [options.autoInstall=true] - Attempt `npx playwright install chromium` if binary missing.
 * @param {function} [options.log] - Optional logger (e.g. console.log). Defaults to a noop in JSON mode.
 * @returns {{ ok: boolean, reason?: string, installed?: boolean }}
 */
function ensurePlaywright(options = {}) {
  const { autoInstall = true, log = () => {} } = options;

  // Step 1: Is the package installed?
  let playwright;
  try {
    playwright = require('playwright');
  } catch (err) {
    return {
      ok: false,
      reason:
        'playwright package is not installed. Run `npm install` in the open-pathways folder to install it, then re-run the audit.',
    };
  }

  // Step 2: Is the chromium binary on disk?
  if (binaryPresent(playwright)) {
    return { ok: true };
  }

  // Step 3: Try to auto-install.
  if (!autoInstall) {
    return {
      ok: false,
      reason:
        'chromium browser binary is missing. Run `npx playwright install chromium` to install it.',
    };
  }

  log('Installing browser engine for accessibility checks (one-time, ~150MB)...');

  const result = spawnSync('npx', ['--yes', 'playwright', 'install', 'chromium'], {
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    return {
      ok: false,
      reason: `auto-install failed: ${result.error.message}. Run \`npx playwright install chromium\` manually.`,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `auto-install exited with status ${result.status}. Common causes: no network, restricted CI runner, or proxy. Run \`npx playwright install chromium\` manually with appropriate access.`,
    };
  }

  // Step 4: Re-check after install.
  if (binaryPresent(playwright)) {
    return { ok: true, installed: true };
  }

  return {
    ok: false,
    reason:
      'auto-install reported success but the chromium binary is still not reachable. Run `npx playwright install chromium` manually and verify the install path.',
  };
}

/**
 * Resolve playwright's chromium executablePath() and confirm the file exists.
 * executablePath() returns a string even if the file is missing, so we stat it.
 */
function binaryPresent(playwright) {
  try {
    const exePath = playwright.chromium.executablePath();
    if (!exePath) return false;
    fs.accessSync(exePath, fs.constants.X_OK);
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = { ensurePlaywright };
