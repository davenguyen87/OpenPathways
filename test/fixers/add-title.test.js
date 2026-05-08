import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { assertPatchShape, assertRoundTrip, assertFixShimLegacy } from './_assert-patch.js';

const require = createRequire(import.meta.url);
const fixer = require('../../src/fixers/add-title.js');

describe('add-title — apply()', () => {
  it('replaces an empty <title> and emits a v4 patch', async () => {
    const file = {
      path: 'p.html',
      content: '<html>\n<head>\n  <title></title>\n</head>\n<body></body>\n</html>',
      isHtml: true
    };
    const result = await fixer.apply(file, []);
    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(1);
    assertPatchShape(result.patches[0], { fixer: 'add-title', criterion: '2.4.2', file: 'p.html' });
    expect(result.newContent).toContain('<title>Untitled Course</title>');
  });

  it('inserts a <title> into <head> when missing entirely', async () => {
    const file = {
      path: 'p.html',
      content: '<html>\n<head>\n  <meta charset="utf-8">\n</head>\n<body></body>\n</html>',
      isHtml: true
    };
    const result = await fixer.apply(file, []);
    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(1);
    expect(result.newContent).toContain('<title>Untitled Course</title>');
  });
});

describe('add-title — revert() round-trip', () => {
  it('reverts byte-identically when replacing empty title', async () => {
    const file = {
      path: 'p.html',
      content: '<html>\n<head>\n  <title></title>\n</head>\n<body></body>\n</html>',
      isHtml: true
    };
    const result = await fixer.apply(file, []);
    await assertRoundTrip(fixer, file, result);
  });

  it('reverts byte-identically when inserting into head', async () => {
    const file = {
      path: 'p.html',
      content: '<html>\n<head>\n  <meta charset="utf-8">\n</head>\n<body></body>\n</html>',
      isHtml: true
    };
    const result = await fixer.apply(file, []);
    await assertRoundTrip(fixer, file, result);
  });
});

describe('add-title — fix() shim', () => {
  it('returns the legacy shape', async () => {
    const file = {
      path: 'p.html',
      content: '<html><head></head><body></body></html>',
      isHtml: true
    };
    const result = await assertFixShimLegacy(fixer, file, []);
    expect(result.newContent).toContain('<title>Untitled Course</title>');
  });
});
