/**
 * Tests for src/fixers/inject-focus-polyfill.js
 *
 * All inputs are synthetic in-memory HTML strings. Tests cover:
 *   1. Happy path — polyfill injected when focus styles absent
 *   2. Decline path — polyfill deferred when focus styles already pass
 *   3. Round-trip — apply → revert → byte-identical original
 *   4. canFix guards
 *   5. Append-to-existing-block path
 *   6. Custom brand color via packageContext
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { assertPatchShape, assertRoundTrip, assertFixShimLegacy } from './_assert-patch.js';

const require = createRequire(import.meta.url);
const fixer = require('../../src/fixers/inject-focus-polyfill.js');

// ── Helpers ────────────────────────────────────────────────────────────────

function makeHtmlFile(content, overrides = {}) {
  return {
    path: 'content/page.html',
    content,
    isHtml: true,
    ...overrides
  };
}

function makeViolation(criterion = '2.4.7', overrides = {}) {
  return {
    criterion,
    message: `CSS rule removes focus indicator without replacement`,
    file: 'content/page.html',
    line: 5,
    ...overrides
  };
}

const MINIMAL_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '  <title>Test</title>',
  '</head>',
  '<body>',
  '  <p>Content.</p>',
  '</body>',
  '</html>'
].join('\n');

// ── 1. Happy path — 2.4.7 focus styles absent ─────────────────────────────

describe('inject-focus-polyfill — 2.4.7 happy path', () => {
  it('injects the polyfill style block and emits a valid patch', async () => {
    const file = makeHtmlFile(MINIMAL_HTML);
    const violations = [makeViolation('2.4.7')];

    expect(fixer.canFix(file, violations[0])).toBe(true);

    const result = await fixer.apply(file, violations);

    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(1);
    assertPatchShape(result.patches[0], {
      fixer: 'inject-focus-polyfill',
      criterion: '2.4.7',
      confidence: 'definitive',
      file: 'content/page.html'
    });

    // Polyfill block present in new content
    expect(result.newContent).toContain('<style id="prism-focus-polyfill">');
    expect(result.newContent).toContain(':focus-visible');
    expect(result.newContent).toContain('outline: 2px solid');
    expect(result.newContent).toContain('outline-offset: 2px');
    // Block is before </head>
    const headClose = result.newContent.indexOf('</head>');
    const styleBlock = result.newContent.indexOf('id="prism-focus-polyfill"');
    expect(styleBlock).toBeLessThan(headClose);

    expect(result.deferred).toEqual([]);

    await assertRoundTrip(fixer, file, result);
  });
});

// ── 2. Happy path — 2.4.11 ────────────────────────────────────────────────

describe('inject-focus-polyfill — 2.4.11 happy path', () => {
  it('injects the polyfill for a 2.4.11 violation', async () => {
    const file = makeHtmlFile(MINIMAL_HTML);
    const violations = [makeViolation('2.4.11')];

    const result = await fixer.apply(file, violations);

    expect(result.changed).toBe(true);
    expect(result.newContent).toContain('prism-focus-polyfill');

    await assertRoundTrip(fixer, file, result);
  });
});

// ── 3. Decline — focus styles already pass ────────────────────────────────

describe('inject-focus-polyfill — decline: focus styles already pass', () => {
  it('emits a deferred entry and no patches when focusStylesPresent=true', async () => {
    const file = makeHtmlFile(MINIMAL_HTML);
    const violation = makeViolation('2.4.7', { focusStylesPresent: true });

    const result = await fixer.apply(file, [violation]);

    expect(result.changed).toBe(false);
    expect(result.patches).toHaveLength(0);
    expect(result.deferred).toHaveLength(1);
    expect(result.deferred[0].reason).toMatch(/focus styles already meet 3:1/);
    expect(result.deferred[0].criterion).toBe('2.4.7');
  });

  it('canFix returns false when focusStylesPresent=true', () => {
    const file = makeHtmlFile(MINIMAL_HTML);
    expect(fixer.canFix(file, { criterion: '2.4.7', focusStylesPresent: true })).toBe(false);
  });
});

// ── 4. canFix guards ──────────────────────────────────────────────────────

describe('inject-focus-polyfill — canFix', () => {
  it('returns false for non-HTML files', () => {
    const file = { path: 'foo.css', content: '', isCss: true, isHtml: false };
    expect(fixer.canFix(file, { criterion: '2.4.7' })).toBe(false);
  });

  it('returns false for unrelated criteria', () => {
    const file = makeHtmlFile('');
    expect(fixer.canFix(file, { criterion: '1.4.3' })).toBe(false);
  });

  it('returns false when violation is null', () => {
    const file = makeHtmlFile('');
    expect(fixer.canFix(file, null)).toBe(false);
  });

  it('returns true for HTML with 2.4.7 violation (no focusStylesPresent)', () => {
    const file = makeHtmlFile('');
    expect(fixer.canFix(file, { criterion: '2.4.7' })).toBe(true);
  });

  it('returns true for HTML with 2.4.11 violation', () => {
    const file = makeHtmlFile('');
    expect(fixer.canFix(file, { criterion: '2.4.11' })).toBe(true);
  });
});

// ── 5. Round-trip ──────────────────────────────────────────────────────────

describe('inject-focus-polyfill — round-trip', () => {
  it('apply then revert restores byte-identical original', async () => {
    const file = makeHtmlFile(MINIMAL_HTML);
    const violations = [makeViolation('2.4.7')];

    const result = await fixer.apply(file, violations);
    expect(result.changed).toBe(true);

    await assertRoundTrip(fixer, file, result);
  });
});

// ── 6. Append to existing prism-focus-polyfill block ─────────────────────

describe('inject-focus-polyfill — append to existing block', () => {
  it('appends the rule before </style> when the block already exists', async () => {
    const html = [
      '<!doctype html>',
      '<html lang="en">',
      '<head>',
      '  <title>Test</title>',
      '  <style id="prism-focus-polyfill">',
      '  /* existing rule */',
      '  </style>',
      '</head>',
      '<body><p>Test</p></body>',
      '</html>'
    ].join('\n');

    const file = makeHtmlFile(html);
    const violations = [makeViolation('2.4.7')];

    const result = await fixer.apply(file, violations);

    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(1);

    // The :focus-visible rule was appended inside the existing block
    expect(result.newContent).toContain(':focus-visible');
    // Block appears only once
    const count = (result.newContent.match(/prism-focus-polyfill/g) || []).length;
    expect(count).toBe(1);

    await assertRoundTrip(fixer, file, result);
  });
});

// ── 7. Custom brand color via packageContext ──────────────────────────────

describe('inject-focus-polyfill — custom brand color from packageContext', () => {
  it('uses the brand accent color when it achieves ≥3:1 against white', async () => {
    const file = makeHtmlFile(MINIMAL_HTML);
    const violations = [makeViolation('2.4.7')];
    // Brand accent #1a5276 (dark blue): luminance ≈ 0.034, vs white ≈ 1.0
    // contrast ≈ (1.05)/(0.084) ≈ 12.5:1 — well above 3:1
    const packageContext = { brandConfig: { accent: '#1a5276' } };

    const result = await fixer.apply(file, violations, packageContext);

    expect(result.changed).toBe(true);
    expect(result.newContent).toContain('#1a5276');
    await assertRoundTrip(fixer, file, result);
  });

  it('falls back to the default color when the brand color fails ≥3:1', async () => {
    const file = makeHtmlFile(MINIMAL_HTML);
    const violations = [makeViolation('2.4.7')];
    // Very light color: #e0e0e0 against white barely passes ~1.6:1 → should fall back
    const packageContext = { brandConfig: { accent: '#e0e0e0' } };

    const result = await fixer.apply(file, violations, packageContext);

    expect(result.changed).toBe(true);
    // Should use the hardcoded default (#2f7d72)
    expect(result.newContent).toContain('#2f7d72');
    await assertRoundTrip(fixer, file, result);
  });
});

// ── 8. No </head> in document ─────────────────────────────────────────────

describe('inject-focus-polyfill — no </head>', () => {
  it('returns unchanged when the document has no </head>', async () => {
    const html = '<html><body><p>No head element</p></body></html>';
    const file = makeHtmlFile(html);
    const violations = [makeViolation('2.4.7')];

    const result = await fixer.apply(file, violations);

    expect(result.changed).toBe(false);
    expect(result.patches).toHaveLength(0);
    expect(result.newContent).toBe(html);
  });
});

// ── 9. Multiple violations — only ONE patch emitted ──────────────────────

describe('inject-focus-polyfill — one patch covers multiple violations', () => {
  it('emits exactly one patch even when both 2.4.7 and 2.4.11 violations are present', async () => {
    const file = makeHtmlFile(MINIMAL_HTML);
    const violations = [
      makeViolation('2.4.7', { line: 5 }),
      makeViolation('2.4.11', { line: 8 })
    ];

    const result = await fixer.apply(file, violations);

    expect(result.changed).toBe(true);
    // Single style block patch handles both criteria.
    expect(result.patches).toHaveLength(1);

    await assertRoundTrip(fixer, file, result);
  });
});

// ── 10. fix() shim — legacy interface ────────────────────────────────────

describe('inject-focus-polyfill — fix() shim', () => {
  it('returns legacy { changed, newContent, log } with no patches field', async () => {
    const file = makeHtmlFile(MINIMAL_HTML);
    const violations = [makeViolation('2.4.7')];

    const result = await assertFixShimLegacy(fixer, file, violations);
    expect(result.changed).toBe(true);
    expect(result.newContent).toContain('prism-focus-polyfill');
  });
});
