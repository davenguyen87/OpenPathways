import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { assertPatchShape, assertRoundTrip, assertFixShimLegacy } from './_assert-patch.js';

const require = createRequire(import.meta.url);
const fixer = require('../../src/fixers/add-alt-decorative.js');

describe('add-alt-decorative — apply()', () => {
  it('emits a patch with the v4 schema fields populated', async () => {
    const file = {
      path: 'page.html',
      content: '<div>\n  <img role="presentation" src="spacer.gif">\n  <p>Hi</p>\n</div>',
      isHtml: true
    };
    const violations = [{ criterion: '1.1.1', message: 'role="presentation" img', file: 'page.html', line: 2 }];

    const result = await fixer.apply(file, violations);
    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(1);
    assertPatchShape(result.patches[0], {
      fixer: 'add-alt-decorative',
      criterion: '1.1.1',
      confidence: 'definitive',
      file: 'page.html'
    });
    expect(result.newContent).toContain('alt=""');
    expect(result.newContent).toContain('<p>Hi</p>');
  });

  it('reports changed=false when no decorative image matches', async () => {
    const file = {
      path: 'p.html',
      content: '<img src="photo.jpg">',
      isHtml: true
    };
    const result = await fixer.apply(file, [{ criterion: '1.1.1', message: 'photo', file: 'p.html', line: 1 }]);
    expect(result.changed).toBe(false);
    expect(result.patches).toEqual([]);
  });
});

describe('add-alt-decorative — revert() round-trip', () => {
  it('reverts byte-identically to the original content', async () => {
    const file = {
      path: 'page.html',
      content: '<div>\n  <img role="presentation" src="spacer.gif">\n  <p>Hi</p>\n</div>',
      isHtml: true
    };
    const violations = [{ criterion: '1.1.1', message: 'decorative', file: 'page.html', line: 2 }];
    const result = await fixer.apply(file, violations);
    await assertRoundTrip(fixer, file, result);
  });
});

describe('add-alt-decorative — fix() shim', () => {
  it('returns the legacy { changed, newContent, log } shape', async () => {
    const file = {
      path: 'page.html',
      content: '<img role="presentation" src="spacer.gif">',
      isHtml: true
    };
    const result = await assertFixShimLegacy(fixer, file, [
      { criterion: '1.1.1', message: 'decorative', file: 'page.html', line: 1 }
    ]);
    expect(result.changed).toBe(true);
    expect(result.newContent).toContain('alt=""');
  });
});
