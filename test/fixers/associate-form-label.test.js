import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { assertPatchShape, assertRoundTrip, assertFixShimLegacy } from './_assert-patch.js';

const require = createRequire(import.meta.url);
const fixer = require('../../src/fixers/associate-form-label.js');

describe('associate-form-label — apply()', () => {
  it('pairs a single <label>/<input> in a block and emits a stable generated id', async () => {
    const file = {
      path: 'page.html',
      content:
        '<form>\n  <p>\n    <label>Email</label>\n    <input name="email">\n  </p>\n</form>',
      isHtml: true
    };
    const violations = [
      { criterion: '3.3.2', message: 'Form input lacks a label.', file: 'page.html', line: 4 }
    ];

    const first = await fixer.apply(file, violations);
    expect(first.changed).toBe(true);
    expect(first.patches).toHaveLength(1);
    assertPatchShape(first.patches[0], {
      fixer: 'associate-form-label',
      criterion: '3.3.2',
      confidence: 'definitive',
      file: 'page.html'
    });

    // The new content carries both attributes, with matching values.
    const idMatch = first.newContent.match(/id="(prism-label-[0-9a-f]{8})"/);
    expect(idMatch, 'expected generated id in newContent').not.toBeNull();
    const generatedId = idMatch[1];
    expect(first.newContent).toContain(`for="${generatedId}"`);
    expect(first.newContent).toContain(`id="${generatedId}"`);

    // Stability: re-running on the same input produces the same id.
    const second = await fixer.apply(file, violations);
    expect(second.newContent).toBe(first.newContent);
    expect(second.patches).toHaveLength(1);
    expect(second.patches[0].before).toBe(first.patches[0].before);
    expect(second.patches[0].after).toBe(first.patches[0].after);
  });

  it('emits one patch per criterion when both 1.3.1 and 3.3.2 fire on the same input', async () => {
    const file = {
      path: 'page.html',
      content:
        '<form>\n  <div>\n    <label>Username</label>\n    <input name="user">\n  </div>\n</form>',
      isHtml: true
    };
    const violations = [
      { criterion: '1.3.1', message: 'Info & relationships', file: 'page.html', line: 4 },
      { criterion: '3.3.2', message: 'Labels or instructions', file: 'page.html', line: 4 }
    ];

    const result = await fixer.apply(file, violations);
    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(2);

    const criteria = result.patches.map((p) => p.criterion).sort();
    expect(criteria).toEqual(['1.3.1', '3.3.2']);

    // Both patches reference the same byte span — only criterion differs.
    expect(result.patches[0].before).toBe(result.patches[1].before);
    expect(result.patches[0].after).toBe(result.patches[1].after);
    expect(result.patches[0].range).toEqual(result.patches[1].range);

    for (const p of result.patches) {
      assertPatchShape(p, { fixer: 'associate-form-label' });
    }

    // The underlying edit is applied exactly once, so newContent contains a
    // single id="..." / for="..." pair. Round-trip is byte-identical even
    // though there are two patches: revertPatch is a safe no-op when the
    // after-text can no longer be located after the first revert restores it.
    const idCount = (result.newContent.match(/id="prism-label-/g) || []).length;
    const forCount = (result.newContent.match(/for="prism-label-/g) || []).length;
    expect(idCount).toBe(1);
    expect(forCount).toBe(1);

    await assertRoundTrip(fixer, file, result);
  });

  it('declines when the block contains multiple labels (ambiguous)', async () => {
    const file = {
      path: 'p.html',
      content:
        '<form>\n  <div>\n    <label>First</label>\n    <label>Second</label>\n    <input name="x">\n  </div>\n</form>',
      isHtml: true
    };
    const result = await fixer.apply(file, [
      { criterion: '3.3.2', message: 'lacks a label', file: 'p.html', line: 5 }
    ]);
    expect(result.changed).toBe(false);
    expect(result.patches).toEqual([]);
  });

  it('declines when the input already has an id', async () => {
    const file = {
      path: 'p.html',
      content:
        '<form>\n  <p>\n    <label>Email</label>\n    <input name="email" id="email-field">\n  </p>\n</form>',
      isHtml: true
    };
    const result = await fixer.apply(file, [
      { criterion: '3.3.2', message: 'lacks a label', file: 'p.html', line: 4 }
    ]);
    expect(result.changed).toBe(false);
    expect(result.patches).toEqual([]);
  });

  it('declines when the label already has a for attribute', async () => {
    const file = {
      path: 'p.html',
      content:
        '<form>\n  <p>\n    <label for="someother">Email</label>\n    <input name="email">\n  </p>\n</form>',
      isHtml: true
    };
    const result = await fixer.apply(file, [
      { criterion: '3.3.2', message: 'lacks a label', file: 'p.html', line: 4 }
    ]);
    expect(result.changed).toBe(false);
    expect(result.patches).toEqual([]);
  });

  it('emits non-overlapping patches for two independent unambiguous blocks on one file', async () => {
    const file = {
      path: 'page.html',
      content:
        '<form>\n  <p>\n    <label>Email</label>\n    <input name="email">\n  </p>\n  <p>\n    <label>Comments</label>\n    <textarea name="comments"></textarea>\n  </p>\n</form>',
      isHtml: true
    };
    const violations = [
      { criterion: '3.3.2', message: 'email lacks label', file: 'page.html', line: 4 },
      { criterion: '3.3.2', message: 'comments lacks label', file: 'page.html', line: 8 }
    ];

    const result = await fixer.apply(file, violations);
    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(2);

    const a = result.patches[0].range;
    const b = result.patches[1].range;
    // Ranges shouldn't overlap on line numbers.
    const overlap =
      !(a.endLine < b.startLine || (a.endLine === b.startLine && a.endCol <= b.startCol)) &&
      !(b.endLine < a.startLine || (b.endLine === a.startLine && b.endCol <= a.startCol));
    expect(overlap).toBe(false);

    // Distinct generated ids — derived from per-input position + name.
    const ids = result.newContent.match(/id="(prism-label-[0-9a-f]{8})"/g) || [];
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);

    await assertRoundTrip(fixer, file, result);
  });
});

describe('associate-form-label — revert() round-trip', () => {
  it('reverts byte-identically to the original content', async () => {
    const file = {
      path: 'page.html',
      content:
        '<form>\n  <p>\n    <label>Email</label>\n    <input name="email" />\n  </p>\n</form>',
      isHtml: true
    };
    const violations = [
      { criterion: '3.3.2', message: 'lacks a label', file: 'page.html', line: 4 }
    ];
    const result = await fixer.apply(file, violations);
    expect(result.changed).toBe(true);
    await assertRoundTrip(fixer, file, result);
  });
});

describe('associate-form-label — fix() shim', () => {
  it('returns the legacy { changed, newContent, log } shape', async () => {
    const file = {
      path: 'page.html',
      content:
        '<form>\n  <p>\n    <label>Email</label>\n    <input name="email">\n  </p>\n</form>',
      isHtml: true
    };
    const result = await assertFixShimLegacy(fixer, file, [
      { criterion: '3.3.2', message: 'lacks a label', file: 'page.html', line: 4 }
    ]);
    expect(result.changed).toBe(true);
    expect(result.newContent).toMatch(/for="prism-label-[0-9a-f]{8}"/);
  });
});

describe('associate-form-label — stability', () => {
  it('produces identical patch sequences on repeated runs', async () => {
    const file = {
      path: 'page.html',
      content:
        '<form>\n  <p>\n    <label>Email</label>\n    <input name="email">\n  </p>\n  <p>\n    <label>Comments</label>\n    <textarea name="comments"></textarea>\n  </p>\n</form>',
      isHtml: true
    };
    const violations = [
      { criterion: '3.3.2', message: 'one', file: 'page.html', line: 4 },
      { criterion: '3.3.2', message: 'two', file: 'page.html', line: 8 }
    ];

    const a = await fixer.apply(file, violations);
    const b = await fixer.apply(file, violations);

    expect(b.newContent).toBe(a.newContent);
    expect(b.patches.length).toBe(a.patches.length);
    for (let i = 0; i < a.patches.length; i++) {
      expect(b.patches[i].before).toBe(a.patches[i].before);
      expect(b.patches[i].after).toBe(a.patches[i].after);
      expect(b.patches[i].range).toEqual(a.patches[i].range);
      expect(b.patches[i].criterion).toBe(a.patches[i].criterion);
    }
  });
});
