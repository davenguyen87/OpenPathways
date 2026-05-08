import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { assertPatchShape, assertRoundTrip, assertFixShimLegacy } from './_assert-patch.js';

const require = createRequire(import.meta.url);
const fixer = require('../../src/fixers/add-lang-attribute.js');

describe('add-lang-attribute — apply()', () => {
  it('adds lang="en" and emits a v4 patch', async () => {
    const file = {
      path: 'p.html',
      content: '<!DOCTYPE html>\n<html>\n<head></head>\n<body></body>\n</html>',
      isHtml: true
    };
    const result = await fixer.apply(file, []);
    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(1);
    assertPatchShape(result.patches[0], {
      fixer: 'add-lang-attribute',
      criterion: '3.1.1',
      confidence: 'definitive',
      file: 'p.html'
    });
    expect(result.newContent).toContain('<html lang="en">');
  });

  it('reports changed=false when lang is already present', async () => {
    const file = {
      path: 'p.html',
      content: '<html lang="fr"></html>',
      isHtml: true
    };
    const result = await fixer.apply(file, []);
    expect(result.changed).toBe(false);
    expect(result.patches).toEqual([]);
  });
});

describe('add-lang-attribute — revert() round-trip', () => {
  it('reverts byte-identically', async () => {
    const file = {
      path: 'p.html',
      content: '<!DOCTYPE html>\n<html>\n<body></body>\n</html>',
      isHtml: true
    };
    const result = await fixer.apply(file, []);
    await assertRoundTrip(fixer, file, result);
  });
});

describe('add-lang-attribute — fix() shim', () => {
  it('returns the legacy shape', async () => {
    const file = {
      path: 'p.html',
      content: '<html><head></head><body></body></html>',
      isHtml: true
    };
    const result = await assertFixShimLegacy(fixer, file, []);
    expect(result.newContent).toContain('lang="en"');
  });
});
