import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { assertPatchShape, assertRoundTrip, assertFixShimLegacy } from './_assert-patch.js';

const require = createRequire(import.meta.url);
const fixer = require('../../src/fixers/add-tabindex-keyboard.js');

describe('add-tabindex-keyboard — apply()', () => {
  it('adds tabindex="0" and emits a v4 patch', async () => {
    const snippet = '<div role="button" onclick="go()" onkeydown="go()">Go</div>';
    const file = {
      path: 'p.html',
      content: `<body>\n  ${snippet}\n</body>`,
      isHtml: true
    };
    const violations = [{ criterion: '2.1.1', message: 'keyboard-aware', snippet, file: 'p.html', line: 2 }];
    const result = await fixer.apply(file, violations);
    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(1);
    assertPatchShape(result.patches[0], {
      fixer: 'add-tabindex-keyboard',
      criterion: '2.1.1',
      confidence: 'definitive',
      file: 'p.html'
    });
    expect(result.newContent).toMatch(/tabindex="0"/);
  });

  it('reports changed=false when the element already has tabindex', async () => {
    const snippet = '<div role="button" tabindex="0" onclick="go()" onkeydown="go()">Go</div>';
    const file = { path: 'p.html', content: snippet, isHtml: true };
    const result = await fixer.apply(file, [
      { criterion: '2.1.1', message: '', snippet, file: 'p.html', line: 1 }
    ]);
    expect(result.changed).toBe(false);
    expect(result.patches).toEqual([]);
  });
});

describe('add-tabindex-keyboard — revert() round-trip', () => {
  it('reverts byte-identically', async () => {
    const snippet = '<div role="button" onclick="go()" onkeydown="go()">Go</div>';
    const file = { path: 'p.html', content: `<body>\n  ${snippet}\n</body>`, isHtml: true };
    const violations = [{ criterion: '2.1.1', message: '', snippet, file: 'p.html', line: 2 }];
    const result = await fixer.apply(file, violations);
    await assertRoundTrip(fixer, file, result);
  });
});

describe('add-tabindex-keyboard — fix() shim', () => {
  it('returns the legacy shape', async () => {
    const snippet = '<div role="button" onclick="go()" onkeydown="go()">Go</div>';
    const file = { path: 'p.html', content: snippet, isHtml: true };
    const result = await assertFixShimLegacy(fixer, file, [
      { criterion: '2.1.1', message: '', snippet, file: 'p.html', line: 1 }
    ]);
    expect(result.newContent).toMatch(/tabindex="0"/);
  });
});
