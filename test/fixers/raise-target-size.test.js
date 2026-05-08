import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { assertPatchShape, assertRoundTrip, assertFixShimLegacy } from './_assert-patch.js';

const require = createRequire(import.meta.url);
const fixer = require('../../src/fixers/raise-target-size.js');

// Minimal valid HTML skeleton so cheerio's parse5 backend assigns reliable
// startOffset/endOffset to every tag we care about. Content stays compact so
// expectations are easy to read.
const PAGE_NO_STYLE_BLOCK = [
  '<!doctype html>',
  '<html>',
  '<head>',
  '  <title>Demo</title>',
  '</head>',
  '<body>',
  '  <button style="width:16px;height:16px">A</button>',
  '</body>',
  '</html>'
].join('\n');

const PAGE_WITH_STYLE_BLOCK = [
  '<!doctype html>',
  '<html>',
  '<head>',
  '  <title>Demo</title>',
  '  <style id="prism-target-size">',
  '.preexisting { color: red; }',
  '  </style>',
  '</head>',
  '<body>',
  '  <button style="width:16px;height:16px">A</button>',
  '</body>',
  '</html>'
].join('\n');

const PAGE_TWO_BUTTONS = [
  '<!doctype html>',
  '<html>',
  '<head>',
  '  <title>Demo</title>',
  '</head>',
  '<body>',
  '  <button style="width:16px;height:16px">A</button>',
  '  <button style="width:18px;height:18px">B</button>',
  '</body>',
  '</html>'
].join('\n');

describe('raise-target-size — apply()', () => {
  it('happy path: one violation with sufficient room → 2 patches and a new style block', async () => {
    const file = { path: 'page.html', content: PAGE_NO_STYLE_BLOCK, isHtml: true };
    const violations = [
      {
        criterion: '2.5.8',
        file: 'page.html',
        line: 7,
        snippet: '<button style="width:16px;height:16px">A</button>',
        boundingBox: { width: 16, height: 16, availableWidth: 200, availableHeight: 200 }
      }
    ];

    const result = await fixer.apply(file, violations);
    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(2);
    for (const p of result.patches) {
      assertPatchShape(p, {
        fixer: 'raise-target-size',
        criterion: '2.5.8',
        confidence: 'definitive',
        file: 'page.html'
      });
    }

    // Class added to the button.
    const classMatch = result.newContent.match(/<button[^>]*class="(prism-ts-[0-9a-f]{8})"/);
    expect(classMatch, 'expected generated class on the button').not.toBeNull();
    const className = classMatch[1];

    // Style block created in <head> with the matching rule.
    expect(result.newContent).toContain('<style id="prism-target-size">');
    expect(result.newContent).toMatch(
      new RegExp(`\\.${className}\\s*\\{\\s*min-width:\\s*24px;\\s*min-height:\\s*24px;\\s*\\}`)
    );

    await assertRoundTrip(fixer, file, result);
  });

  it('happy path: existing style block is appended to, not duplicated', async () => {
    const file = { path: 'page.html', content: PAGE_WITH_STYLE_BLOCK, isHtml: true };
    const violations = [
      {
        criterion: '2.5.8',
        file: 'page.html',
        line: 10,
        snippet: '<button style="width:16px;height:16px">A</button>',
        boundingBox: { width: 16, height: 16, availableWidth: 200, availableHeight: 200 }
      }
    ];

    const result = await fixer.apply(file, violations);
    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(2);

    // Exactly one style block with id=prism-target-size in the result.
    const blockOpens = result.newContent.match(/<style\b[^>]*\bid\s*=\s*["']prism-target-size["']/g) || [];
    expect(blockOpens).toHaveLength(1);

    // Both the pre-existing rule and the new rule appear inside it.
    const blockMatch = result.newContent.match(
      /<style\b[^>]*\bid\s*=\s*["']prism-target-size["'][^>]*>([\s\S]*?)<\/style>/i
    );
    expect(blockMatch, 'style block should still be findable').not.toBeNull();
    const blockBody = blockMatch[1];
    expect(blockBody).toContain('.preexisting { color: red; }');
    expect(blockBody).toMatch(/\.prism-ts-[0-9a-f]{8}\s*\{\s*min-width:\s*24px;\s*min-height:\s*24px;\s*\}/);

    await assertRoundTrip(fixer, file, result);
  });

  it('declines when the violation has no boundingBox (safe-tier; no guessing)', async () => {
    const file = { path: 'page.html', content: PAGE_NO_STYLE_BLOCK, isHtml: true };
    const violations = [
      {
        criterion: '2.5.8',
        file: 'page.html',
        line: 7,
        snippet: '<button style="width:16px;height:16px">A</button>'
        // boundingBox intentionally omitted
      }
    ];

    const result = await fixer.apply(file, violations);
    expect(result.changed).toBe(false);
    expect(result.patches).toEqual([]);
    expect(result.newContent).toBe(PAGE_NO_STYLE_BLOCK);
  });

  it('declines when boundingBox shows insufficient room for a 24x24 bump', async () => {
    const file = { path: 'page.html', content: PAGE_NO_STYLE_BLOCK, isHtml: true };
    const violations = [
      {
        criterion: '2.5.8',
        file: 'page.html',
        line: 7,
        snippet: '<button style="width:16px;height:16px">A</button>',
        // availableWidth (20) < 24 -> bump would overlap.
        boundingBox: { width: 16, height: 16, availableWidth: 20, availableHeight: 200 }
      }
    ];

    const result = await fixer.apply(file, violations);
    expect(result.changed).toBe(false);
    expect(result.patches).toEqual([]);
    expect(result.newContent).toBe(PAGE_NO_STYLE_BLOCK);
  });

  it('two violations on one file → 4 patches, distinct classes, round-trip byte-identical', async () => {
    const file = { path: 'page.html', content: PAGE_TWO_BUTTONS, isHtml: true };
    const violations = [
      {
        criterion: '2.5.8',
        file: 'page.html',
        line: 7,
        snippet: '<button style="width:16px;height:16px">A</button>',
        boundingBox: { width: 16, height: 16, availableWidth: 200, availableHeight: 200 }
      },
      {
        criterion: '2.5.8',
        file: 'page.html',
        line: 8,
        snippet: '<button style="width:18px;height:18px">B</button>',
        boundingBox: { width: 18, height: 18, availableWidth: 200, availableHeight: 200 }
      }
    ];

    const result = await fixer.apply(file, violations);
    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(4);

    for (const p of result.patches) {
      assertPatchShape(p, { fixer: 'raise-target-size', criterion: '2.5.8' });
    }

    // Two distinct generated class names appear in the result.
    const classes = (result.newContent.match(/class="(prism-ts-[0-9a-f]{8})"/g) || []);
    expect(classes).toHaveLength(2);
    expect(new Set(classes).size).toBe(2);

    // Both classes have rules in the (single) injected style block.
    const blockOpens = result.newContent.match(/<style\b[^>]*\bid\s*=\s*["']prism-target-size["']/g) || [];
    expect(blockOpens).toHaveLength(1);
    const ruleMatches = result.newContent.match(/\.prism-ts-[0-9a-f]{8}\s*\{[^}]*\}/g) || [];
    expect(ruleMatches).toHaveLength(2);

    await assertRoundTrip(fixer, file, result);
  });
});

describe('raise-target-size — fix() shim', () => {
  it('returns the legacy { changed, newContent, log } shape with no patches field', async () => {
    const file = { path: 'page.html', content: PAGE_NO_STYLE_BLOCK, isHtml: true };
    const result = await assertFixShimLegacy(fixer, file, [
      {
        criterion: '2.5.8',
        file: 'page.html',
        line: 7,
        snippet: '<button style="width:16px;height:16px">A</button>',
        boundingBox: { width: 16, height: 16, availableWidth: 200, availableHeight: 200 }
      }
    ]);
    expect(result.changed).toBe(true);
    expect(result.newContent).toContain('<style id="prism-target-size">');
  });
});

describe('raise-target-size — stability', () => {
  it('produces identical patches and class hashes across repeated runs', async () => {
    const file = { path: 'page.html', content: PAGE_TWO_BUTTONS, isHtml: true };
    const violations = [
      {
        criterion: '2.5.8',
        file: 'page.html',
        line: 7,
        boundingBox: { width: 16, height: 16, availableWidth: 200, availableHeight: 200 }
      },
      {
        criterion: '2.5.8',
        file: 'page.html',
        line: 8,
        boundingBox: { width: 18, height: 18, availableWidth: 200, availableHeight: 200 }
      }
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
