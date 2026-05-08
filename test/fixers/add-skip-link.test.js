import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { assertPatchShape, assertRoundTrip, assertFixShimLegacy } from './_assert-patch.js';

const require = createRequire(import.meta.url);
const fixer = require('../../src/fixers/add-skip-link.js');

describe('add-skip-link — apply()', () => {
  it('inserts a skip link after <body> and emits a v4 patch', async () => {
    const file = {
      path: 'p.html',
      content: '<html>\n<body>\n  <p>Content</p>\n</body>\n</html>',
      isHtml: true
    };
    const result = await fixer.apply(file, []);
    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(1);
    assertPatchShape(result.patches[0], {
      fixer: 'add-skip-link',
      criterion: '',
      file: 'p.html'
    });
    expect(['definitive', 'likely', 'needs-review']).toContain(result.patches[0].confidence);
    expect(result.newContent).toContain('href="#main-content"');
    expect(result.newContent).toContain('Skip to main content');
  });

  it('reports changed=false when no <body> tag exists', async () => {
    const file = { path: 'p.html', content: '<html><head></head></html>', isHtml: true };
    const result = await fixer.apply(file, []);
    expect(result.changed).toBe(false);
    expect(result.patches).toEqual([]);
  });
});

describe('add-skip-link — revert() round-trip', () => {
  it('reverts byte-identically', async () => {
    const file = {
      path: 'p.html',
      content: '<html>\n<body>\n  <p>Content</p>\n</body>\n</html>',
      isHtml: true
    };
    const result = await fixer.apply(file, []);
    await assertRoundTrip(fixer, file, result);
  });
});

describe('add-skip-link — fix() shim', () => {
  it('returns the legacy shape', async () => {
    const file = {
      path: 'p.html',
      content: '<html><body><p>x</p></body></html>',
      isHtml: true
    };
    const result = await assertFixShimLegacy(fixer, file, []);
    expect(result.newContent).toContain('skip-link');
  });
});
