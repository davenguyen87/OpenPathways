#!/usr/bin/env node
/**
 * Smoke test: v3.1 LLM activation wiring
 *
 * Validates without hitting the Anthropic API:
 *   1. src/lib/llm-provider.js loads and exports getProvider
 *   2. getProvider('anthropic', 'fake-key', ...) returns the expected shape
 *   3. cloud/server/routes/audits.js references all three LLM env vars
 *
 * Usage: node scripts/smoke-llm-activation.js
 * Exit 0 = all checks pass. Exit 1 = at least one failure.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;

// ---------------------------------------------------------------------------
// Check 1: llm-provider module loads and exports getProvider
// ---------------------------------------------------------------------------
let getProvider;
try {
  const mod = require(path.join(ROOT, 'src', 'lib', 'llm-provider.js'));
  if (typeof mod.getProvider !== 'function') {
    throw new Error(`getProvider is not a function (got ${typeof mod.getProvider})`);
  }
  getProvider = mod.getProvider;
  console.log('✓ llm-provider module loads');
} catch (err) {
  console.error(`✗ llm-provider module failed to load: ${err.message}`);
  failures++;
}

// ---------------------------------------------------------------------------
// Check 2: getProvider('anthropic', 'fake-key', opts) returns correct shape
//
// We pass a fake key. The Anthropic SDK client is instantiated synchronously
// but does not make any network calls until .generate() is invoked — so this
// is safe to call without a real key.
// ---------------------------------------------------------------------------
if (getProvider) {
  try {
    const provider = getProvider('anthropic', 'fake-key-smoke-test', {
      model: 'claude-haiku-4-5',
    });

    const missing = [];
    if (typeof provider.name !== 'string' || provider.name.length === 0) {
      missing.push('name (string)');
    }
    if (typeof provider.model !== 'string' || provider.model.length === 0) {
      missing.push('model (string)');
    }
    if (typeof provider.generate !== 'function') {
      missing.push('generate (function)');
    }

    if (missing.length > 0) {
      throw new Error(`provider object is missing: ${missing.join(', ')}`);
    }
    if (provider.name !== 'anthropic') {
      throw new Error(`expected provider.name === 'anthropic', got '${provider.name}'`);
    }
    if (provider.model !== 'claude-haiku-4-5') {
      throw new Error(`expected provider.model === 'claude-haiku-4-5', got '${provider.model}'`);
    }

    console.log('✓ getProvider returns a working provider shape');
  } catch (err) {
    console.error(`✗ getProvider shape check failed: ${err.message}`);
    failures++;
  }
} else {
  console.error('✗ getProvider shape check skipped (module did not load)');
  failures++;
}

// ---------------------------------------------------------------------------
// Check 3: cloud route reads LLM env vars
// ---------------------------------------------------------------------------
try {
  const routePath = path.join(ROOT, 'cloud', 'server', 'routes', 'audits.js');
  if (!fs.existsSync(routePath)) {
    throw new Error(`route file not found at ${routePath}`);
  }

  const src = fs.readFileSync(routePath, 'utf8');

  const required = ['LLM_PROVIDER', 'LLM_KEY_FROM_ENV', 'LLM_MODEL'];
  const missing = required.filter((token) => !src.includes(token));

  if (missing.length > 0) {
    throw new Error(
      `cloud route is missing references to: ${missing.join(', ')}. ` +
      `The env vars will not be forwarded to writeReports.`
    );
  }

  // Extra sanity: confirm they appear in a process.env context (not just comments).
  const envContextMissing = required.filter(
    (token) => !src.includes(`process.env.${token}`)
  );
  if (envContextMissing.length > 0) {
    throw new Error(
      `Env vars referenced but not read via process.env: ${envContextMissing.join(', ')}`
    );
  }

  console.log('✓ cloud route forwards LLM env vars to writeReports');
} catch (err) {
  console.error(`✗ cloud route env-var check failed: ${err.message}`);
  failures++;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('');
if (failures === 0) {
  console.log('All checks passed. LLM activation wiring looks correct.');
  process.exit(0);
} else {
  console.error(`${failures} check(s) failed. See errors above.`);
  process.exit(1);
}
