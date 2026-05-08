import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { assertPatchShape, assertRoundTrip, assertFixShimLegacy } from './_assert-patch.js';

const require = createRequire(import.meta.url);
const fixer = require('../../src/fixers/add-iframe-title.js');

describe('add-iframe-title — apply()', () => {
  it('emits one v4 patch per iframe needing a title', async () => {
    const file = {
      path: 'p.html',
      content:
        '<body>\n' +
        '  <iframe src="https://www.youtube.com/embed/abc"></iframe>\n' +
        '  <iframe src="local/video.html"></iframe>\n' +
        '  <iframe src="x" title="already-there"></iframe>\n' +
        '</body>',
      isHtml: true
    };
    const result = await fixer.apply(file, []);
    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(2);
    for (const p of result.patches) {
      assertPatchShape(p, { fixer: 'add-iframe-title', criterion: '4.1.2', confidence: 'definitive', file: 'p.html' });
      expect(p.after).toMatch(/title="Embedded /);
    }
    expect(result.newContent).toMatch(/title="Embedded youtube\.com content"/);
    expect(result.newContent).toMatch(/title="Embedded video content"/);
    expect(result.newContent).toMatch(/title="already-there"/);
  });

  it('reports changed=false when every iframe has a title', async () => {
    const file = {
      path: 'p.html',
      content: '<iframe src="x" title="t"></iframe>',
      isHtml: true
    };
    const result = await fixer.apply(file, []);
    expect(result.changed).toBe(false);
    expect(result.patches).toEqual([]);
  });
});

describe('add-iframe-title — revert() round-trip', () => {
  it('reverts byte-identically across multiple patches', async () => {
    const file = {
      path: 'p.html',
      content:
        '<body>\n' +
        '  <iframe src="https://www.youtube.com/embed/abc"></iframe>\n' +
        '  <iframe src="local/video.html"></iframe>\n' +
        '</body>',
      isHtml: true
    };
    const result = await fixer.apply(file, []);
    await assertRoundTrip(fixer, file, result);
  });
});

describe('add-iframe-title — fix() shim', () => {
  it('returns the legacy shape', async () => {
    const file = {
      path: 'p.html',
      content: '<iframe src="https://example.com/embed"></iframe>',
      isHtml: true
    };
    const result = await assertFixShimLegacy(fixer, file, []);
    expect(result.newContent).toMatch(/title="/);
  });
});
