import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { assertPatchShape, assertRoundTrip, assertFixShimLegacy } from './_assert-patch.js';

const require = createRequire(import.meta.url);
const fixer = require('../../src/fixers/add-html5-doctype.js');

describe('add-html5-doctype — apply()', () => {
  it('prepends DOCTYPE and emits a v4 patch', async () => {
    const file = {
      path: 'p.html',
      content: '<html>\n<head><title>T</title></head>\n<body></body></html>\n',
      isHtml: true
    };
    const result = await fixer.apply(file, []);
    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(1);
    assertPatchShape(result.patches[0], { fixer: 'add-html5-doctype', confidence: 'definitive', file: 'p.html' });
    expect(result.newContent).toMatch(/^<!DOCTYPE html>\n/);
  });

  it('reports changed=false when DOCTYPE is already present', async () => {
    const file = {
      path: 'p.html',
      content: '<!DOCTYPE html>\n<html></html>',
      isHtml: true
    };
    const result = await fixer.apply(file, []);
    expect(result.changed).toBe(false);
    expect(result.patches).toEqual([]);
  });

  it('strips a leading BOM and round-trip restores the original including the BOM', async () => {
    const file = {
      path: 'p.html',
      content: '﻿<html><head></head><body></body></html>',
      isHtml: true
    };
    const result = await fixer.apply(file, []);
    expect(result.changed).toBe(true);
    expect(result.newContent.startsWith('<!DOCTYPE html>\n')).toBe(true);
    await assertRoundTrip(fixer, file, result);
  });
});

describe('add-html5-doctype — revert() round-trip', () => {
  it('reverts byte-identically', async () => {
    const file = {
      path: 'p.html',
      content: '<html>\n<head><title>T</title></head>\n<body></body></html>',
      isHtml: true
    };
    const result = await fixer.apply(file, []);
    await assertRoundTrip(fixer, file, result);
  });
});

describe('add-html5-doctype — fix() shim', () => {
  it('returns the legacy shape', async () => {
    const file = {
      path: 'p.html',
      content: '<html><head></head><body></body></html>',
      isHtml: true
    };
    const result = await assertFixShimLegacy(fixer, file, []);
    expect(result.newContent).toMatch(/^<!DOCTYPE html>/);
  });
});
