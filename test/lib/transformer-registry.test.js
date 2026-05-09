/**
 * Tests for the v5 transformer registry.
 *
 * Covers exactly the four behaviors documented in chunk 01:
 *
 *   1. Loads only modules with `tier: 'full'`.
 *   2. Sorts by id.
 *   3. Skips files that don't expose both `canTransform` and `apply`.
 *   4. Bypasses require-cache (rewriting the file changes what's loaded).
 *
 * The registry tolerates a missing `transformers/` directory (the early
 * build stages don't ship the directory at all). That edge case is
 * exercised via a fifth test alongside the four above.
 */

import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';

const require = createRequire(import.meta.url);
const { loadTransformers } = require('../../src/lib/transformer-registry.js');

const tmpDirs = [];
function makeTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch (_) {
      // best-effort
    }
  }
});

const FULL_TIER_BODY = (id, family = 'landmark') => `
module.exports = {
  id: ${JSON.stringify(id)},
  name: ${JSON.stringify(`mock ${id}`)},
  family: ${JSON.stringify(family)},
  supported: ['scorm12'],
  criteria: ['1.3.1'],
  triage: 'author rework',
  tier: 'full',
  provenance: 'rule-based',
  canTransform() { return false; },
  async apply() { return { transform: undefined, patches: [], log: [] }; },
  async revert() { return { patches: [], log: [] }; }
};
`;

const SAFE_TIER_BODY = `
module.exports = {
  id: 'mock-safe-fixer',
  name: 'mock safe',
  tier: 'safe',
  canFix() { return false; },
  async apply() { return { changed: false, newContent: '', patches: [], log: [] }; }
};
`;

const PARTIAL_INTERFACE_BODY_NO_APPLY = `
module.exports = {
  id: 'mock-partial-no-apply',
  name: 'partial — no apply',
  tier: 'full',
  canTransform() { return false; }
  // missing apply
};
`;

const PARTIAL_INTERFACE_BODY_NO_CAN = `
module.exports = {
  id: 'mock-partial-no-can',
  name: 'partial — no canTransform',
  tier: 'full',
  // missing canTransform
  async apply() { return { transform: undefined, patches: [], log: [] }; }
};
`;

describe('loadTransformers()', () => {
  it('loads only modules with tier:full', () => {
    const dir = makeTmp('tr-only-full');
    fs.writeFileSync(path.join(dir, 'a-full.js'), FULL_TIER_BODY('a-full'), 'utf8');
    fs.writeFileSync(path.join(dir, 'b-safe.js'), SAFE_TIER_BODY, 'utf8');

    const transformers = loadTransformers(dir);
    expect(transformers).toHaveLength(1);
    expect(transformers[0].id).toBe('a-full');
    expect(transformers[0].tier).toBe('full');
  });

  it('returns transformers sorted by id', () => {
    const dir = makeTmp('tr-sort');
    // Write in unsorted order; the loader must sort by id.
    fs.writeFileSync(path.join(dir, 'z.js'), FULL_TIER_BODY('zeta'), 'utf8');
    fs.writeFileSync(path.join(dir, 'a.js'), FULL_TIER_BODY('alpha'), 'utf8');
    fs.writeFileSync(path.join(dir, 'm.js'), FULL_TIER_BODY('mu'), 'utf8');

    const transformers = loadTransformers(dir);
    expect(transformers.map((t) => t.id)).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('skips files that lack canTransform or apply', () => {
    const dir = makeTmp('tr-partial');
    fs.writeFileSync(path.join(dir, 'good.js'), FULL_TIER_BODY('good'), 'utf8');
    fs.writeFileSync(path.join(dir, 'no-apply.js'), PARTIAL_INTERFACE_BODY_NO_APPLY, 'utf8');
    fs.writeFileSync(path.join(dir, 'no-can.js'), PARTIAL_INTERFACE_BODY_NO_CAN, 'utf8');

    const transformers = loadTransformers(dir);
    expect(transformers).toHaveLength(1);
    expect(transformers[0].id).toBe('good');
  });

  it('bypasses require-cache between calls', () => {
    const dir = makeTmp('tr-cache');
    const filePath = path.join(dir, 'mod.js');
    fs.writeFileSync(filePath, FULL_TIER_BODY('first-id'), 'utf8');

    const first = loadTransformers(dir);
    expect(first).toHaveLength(1);
    expect(first[0].id).toBe('first-id');

    // Rewrite the same file with a different id. A cached require would
    // return the old value; the loader must invalidate the cache.
    fs.writeFileSync(filePath, FULL_TIER_BODY('second-id'), 'utf8');
    const second = loadTransformers(dir);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe('second-id');
  });

  it('returns [] when the directory does not exist', () => {
    const root = makeTmp('tr-missing');
    const missing = path.join(root, 'does-not-exist');
    expect(loadTransformers(missing)).toEqual([]);
  });
});
