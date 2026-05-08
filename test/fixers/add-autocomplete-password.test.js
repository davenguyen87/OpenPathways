import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { assertPatchShape, assertRoundTrip, assertFixShimLegacy } from './_assert-patch.js';

const require = createRequire(import.meta.url);
const fixer = require('../../src/fixers/add-autocomplete-password.js');

describe('add-autocomplete-password — apply()', () => {
  it('adds autocomplete="current-password" and emits a v4 patch', async () => {
    const file = {
      path: 'login.html',
      content: '<form>\n  <input type="password" name="pw">\n</form>',
      isHtml: true
    };
    const violations = [{
      criterion: '3.3.8',
      message: 'password input lacks autocomplete',
      snippet: '<input type="password" name="pw">',
      file: 'login.html',
      line: 2
    }];

    const result = await fixer.apply(file, violations);
    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(1);
    assertPatchShape(result.patches[0], {
      fixer: 'add-autocomplete-password',
      criterion: '3.3.8',
      confidence: 'definitive',
      file: 'login.html'
    });
    expect(result.newContent).toContain('autocomplete="current-password"');
  });

  it('reports changed=false when the input already has autocomplete', async () => {
    const file = {
      path: 'login.html',
      content: '<input type="password" autocomplete="current-password">',
      isHtml: true
    };
    const result = await fixer.apply(file, [{
      criterion: '3.3.8', message: '', snippet: '<input type="password" autocomplete="current-password">',
      file: 'login.html', line: 1
    }]);
    expect(result.changed).toBe(false);
    expect(result.patches).toEqual([]);
  });
});

describe('add-autocomplete-password — revert() round-trip', () => {
  it('reverts byte-identically', async () => {
    const file = {
      path: 'login.html',
      content: '<form>\n  <input type="password" name="pw">\n</form>',
      isHtml: true
    };
    const violations = [{
      criterion: '3.3.8', message: '', snippet: '<input type="password" name="pw">',
      file: 'login.html', line: 2
    }];
    const result = await fixer.apply(file, violations);
    await assertRoundTrip(fixer, file, result);
  });
});

describe('add-autocomplete-password — fix() shim', () => {
  it('returns the legacy shape', async () => {
    const file = {
      path: 'login.html',
      content: '<input type="password" name="pw">',
      isHtml: true
    };
    const result = await assertFixShimLegacy(fixer, file, [{
      criterion: '3.3.8', message: '', snippet: '<input type="password" name="pw">',
      file: 'login.html', line: 1
    }]);
    expect(result.newContent).toContain('autocomplete="current-password"');
  });
});
