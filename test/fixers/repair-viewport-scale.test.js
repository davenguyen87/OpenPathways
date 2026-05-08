import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { assertPatchShape, assertRoundTrip, assertFixShimLegacy } from './_assert-patch.js';

const require = createRequire(import.meta.url);
const fixer = require('../../src/fixers/repair-viewport-scale.js');

describe('repair-viewport-scale — apply()', () => {
  it('replaces user-scalable=no and emits a v4 patch', async () => {
    const tag = '<meta name="viewport" content="width=device-width, user-scalable=no">';
    const file = {
      path: 'p.html',
      content: `<head>\n  ${tag}\n</head>`,
      isHtml: true
    };
    const violations = [{ criterion: '1.4.4', message: 'no scale', snippet: tag, file: 'p.html', line: 2 }];
    const result = await fixer.apply(file, violations);
    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(1);
    assertPatchShape(result.patches[0], {
      fixer: 'repair-viewport-scale',
      criterion: '1.4.4',
      confidence: 'definitive',
      file: 'p.html'
    });
    expect(result.newContent).not.toContain('user-scalable=no');
    expect(result.newContent).toContain('initial-scale=1.0');
  });

  it('reports changed=false when viewport is already safe', async () => {
    const tag = '<meta name="viewport" content="width=device-width, initial-scale=1.0">';
    const file = { path: 'p.html', content: tag, isHtml: true };
    const result = await fixer.apply(file, [{ criterion: '1.4.4', message: '', snippet: tag, file: 'p.html', line: 1 }]);
    expect(result.changed).toBe(false);
    expect(result.patches).toEqual([]);
  });
});

describe('repair-viewport-scale — revert() round-trip', () => {
  it('reverts byte-identically', async () => {
    const tag = '<meta name="viewport" content="width=device-width, user-scalable=no">';
    const file = { path: 'p.html', content: `<head>\n  ${tag}\n</head>`, isHtml: true };
    const violations = [{ criterion: '1.4.4', message: '', snippet: tag, file: 'p.html', line: 2 }];
    const result = await fixer.apply(file, violations);
    await assertRoundTrip(fixer, file, result);
  });
});

describe('repair-viewport-scale — fix() shim', () => {
  it('returns the legacy shape', async () => {
    const tag = '<meta name="viewport" content="width=device-width, maximum-scale=1.0">';
    const file = { path: 'p.html', content: tag, isHtml: true };
    const result = await assertFixShimLegacy(fixer, file, [
      { criterion: '1.4.4', message: '', snippet: tag, file: 'p.html', line: 1 }
    ]);
    expect(result.newContent).toContain('initial-scale=1.0');
    expect(result.newContent).not.toMatch(/maximum-scale=1\.0/);
  });
});
