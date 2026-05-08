/**
 * Tests for src/fixers/rewrite-contrast-tokens.js
 *
 * Conventions mirror test/fixers/normalize-heading-order.test.js:
 *   - CommonJS fixer loaded via createRequire
 *   - ES-module import for the shared assertion helpers
 *   - Synthetic palette injected via file._palette so tests don't depend
 *     on disk state (config/brand.json)
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { assertPatchShape, assertRoundTrip, assertFixShimLegacy } from './_assert-patch.js';

const require = createRequire(import.meta.url);
const fixer = require('../../src/fixers/rewrite-contrast-tokens.js');

// ── Synthetic palette ──────────────────────────────────────────────────────
// Three token entries:
//   --color-text:    #767676 fails 4.5:1 on white (#fff); replace with #595959
//   --border-ui:     #bbbbbb fails 3:1 on white; replace with #767676
//   --no-replacement: no palette entry → decline

const SYNTHETIC_PALETTE = {
  '--color-text': {
    text: '#595959',    // ≥4.5:1 on #ffffff (~7.0:1)
    nonText: '#767676'  // ≥3:1 on #ffffff (~4.5:1)
  },
  '--border-ui': {
    nonText: '#767676'  // ≥3:1 on #ffffff
    // no `text` key — 1.4.3 for this token is unsupported
  }
  // --no-replacement intentionally absent
};

// ── Helpers ────────────────────────────────────────────────────────────────

function makeCssFile(content) {
  return {
    path: 'styles/main.css',
    content,
    isCss: true,
    isHtml: false,
    _palette: SYNTHETIC_PALETTE
  };
}

function makeViolation(criterion, tokenName, overrides = {}) {
  return {
    criterion,
    message: `Color pair using var(${tokenName}) has insufficient contrast`,
    snippet: `color: var(${tokenName})`,
    file: 'styles/main.css',
    line: overrides.line || 3,
    ...overrides
  };
}

// ── 1. Happy path — 1.4.3 text contrast rewrite ───────────────────────────

describe('rewrite-contrast-tokens — 1.4.3 happy path', () => {
  it('rewrites the token declaration and emits a valid patch', async () => {
    const css = [
      ':root {',
      '  --color-primary: #1a73e8;',
      '  --color-text: #767676;',
      '  --color-bg: #ffffff;',
      '}'
    ].join('\n');

    const file = makeCssFile(css);
    const violations = [makeViolation('1.4.3', '--color-text')];

    expect(fixer.canFix(file, violations[0])).toBe(true);

    const result = await fixer.apply(file, violations);

    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(1);
    assertPatchShape(result.patches[0], {
      fixer: 'rewrite-contrast-tokens',
      criterion: '1.4.3',
      confidence: 'definitive',
      file: 'styles/main.css'
    });

    // Token value rewritten
    expect(result.newContent).toContain('--color-text: #595959;');
    expect(result.newContent).not.toContain('--color-text: #767676;');

    // Rationale mentions token name
    expect(result.patches[0].rationale).toContain('--color-text');
    expect(result.patches[0].rationale).toContain('#767676');
    expect(result.patches[0].rationale).toContain('#595959');

    // No deferred entries for this case
    expect(result.deferred).toEqual([]);

    await assertRoundTrip(fixer, file, result);
  });
});

// ── 2. Happy path — 1.4.11 non-text contrast rewrite ──────────────────────

describe('rewrite-contrast-tokens — 1.4.11 happy path', () => {
  it('rewrites the nonText token value and emits a valid patch', async () => {
    const css = [
      ':root {',
      '  --border-ui: #bbbbbb;',
      '}'
    ].join('\n');

    const file = makeCssFile(css);
    const violations = [makeViolation('1.4.11', '--border-ui')];

    const result = await fixer.apply(file, violations);

    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(1);
    assertPatchShape(result.patches[0], {
      fixer: 'rewrite-contrast-tokens',
      criterion: '1.4.11',
      confidence: 'definitive'
    });

    expect(result.newContent).toContain('--border-ui: #767676;');
    expect(result.newContent).not.toContain('--border-ui: #bbbbbb;');

    await assertRoundTrip(fixer, file, result);
  });
});

// ── 3. Decline — ad-hoc hex literal (no token in violation) ───────────────

describe('rewrite-contrast-tokens — decline: ad-hoc hex literal', () => {
  it('emits a deferred entry and no patches when the violation has no token reference', async () => {
    const css = [
      'p { color: #aaaaaa; background: #ffffff; }'
    ].join('\n');

    const file = makeCssFile(css);
    const violation = {
      criterion: '1.4.3',
      message: 'Text (#aaaaaa) on background (#ffffff) has contrast ratio 2.32:1',
      snippet: 'color: #aaaaaa',
      file: 'styles/main.css',
      line: 1
    };

    const result = await fixer.apply(file, [violation]);

    expect(result.changed).toBe(false);
    expect(result.patches).toHaveLength(0);
    expect(result.deferred).toHaveLength(1);
    expect(result.deferred[0].reason).toMatch(/ad-hoc color literal/);
    expect(result.deferred[0].criterion).toBe('1.4.3');
  });
});

// ── 4. Decline — token has no palette entry ───────────────────────────────

describe('rewrite-contrast-tokens — decline: no palette entry', () => {
  it('emits a deferred entry when the token has no calibrated replacement', async () => {
    const css = [
      ':root {',
      '  --no-replacement: #cccccc;',
      '}'
    ].join('\n');

    const file = makeCssFile(css);
    const violations = [makeViolation('1.4.3', '--no-replacement')];

    const result = await fixer.apply(file, violations);

    expect(result.changed).toBe(false);
    expect(result.patches).toHaveLength(0);
    expect(result.deferred).toHaveLength(1);
    expect(result.deferred[0].reason).toMatch(/no calibrated replacement/);
    expect(result.deferred[0].reason).toContain('--no-replacement');
  });
});

// ── 5. Decline — palette entry lacks the required key (1.4.3 on nonText-only token) ──

describe('rewrite-contrast-tokens — decline: palette entry lacks required key', () => {
  it('defers when token has nonText but violation is 1.4.3 (needs text)', async () => {
    const css = ':root { --border-ui: #bbbbbb; }';
    const file = makeCssFile(css);
    // --border-ui only has `nonText` in SYNTHETIC_PALETTE; 1.4.3 needs `text`.
    const violations = [makeViolation('1.4.3', '--border-ui')];

    const result = await fixer.apply(file, violations);

    expect(result.changed).toBe(false);
    expect(result.patches).toHaveLength(0);
    expect(result.deferred).toHaveLength(1);
    expect(result.deferred[0].reason).toMatch(/no calibrated replacement/);
  });
});

// ── 6. canFix guards ──────────────────────────────────────────────────────

describe('rewrite-contrast-tokens — canFix', () => {
  it('returns false for non-CSS/HTML files', () => {
    const file = { path: 'foo.txt', content: '', isCss: false, isHtml: false };
    expect(fixer.canFix(file, { criterion: '1.4.3' })).toBe(false);
  });

  it('returns false for unrelated criteria', () => {
    const file = makeCssFile('');
    expect(fixer.canFix(file, { criterion: '1.1.1' })).toBe(false);
  });

  it('returns false when no violation provided', () => {
    const file = makeCssFile('');
    expect(fixer.canFix(file, null)).toBe(false);
  });

  it('returns true for CSS file with 1.4.3 violation', () => {
    const file = makeCssFile('');
    expect(fixer.canFix(file, { criterion: '1.4.3' })).toBe(true);
  });

  it('returns true for CSS file with 1.4.11 violation', () => {
    const file = makeCssFile('');
    expect(fixer.canFix(file, { criterion: '1.4.11' })).toBe(true);
  });
});

// ── 7. Round-trip — multiple patches on same file ─────────────────────────

describe('rewrite-contrast-tokens — round-trip with multiple patches', () => {
  it('reverts multiple patches back to byte-identical original', async () => {
    const css = [
      ':root {',
      '  --color-text: #767676;',
      '  --border-ui: #bbbbbb;',
      '}'
    ].join('\n');

    const file = makeCssFile(css);
    const violations = [
      makeViolation('1.4.3', '--color-text', { line: 2 }),
      makeViolation('1.4.11', '--border-ui', { line: 3 })
    ];

    const result = await fixer.apply(file, violations);
    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(2);

    await assertRoundTrip(fixer, file, result);
  });
});

// ── 8. fix() shim — legacy interface ─────────────────────────────────────

describe('rewrite-contrast-tokens — fix() shim', () => {
  it('returns legacy { changed, newContent, log } with no patches field', async () => {
    const css = ':root { --color-text: #767676; }';
    const file = makeCssFile(css);
    const violations = [makeViolation('1.4.3', '--color-text')];

    const result = await assertFixShimLegacy(fixer, file, violations);
    expect(result.changed).toBe(true);
    expect(result.newContent).toContain('#595959');
  });
});

// ── 9. packageContext.palette takes precedence over file._palette ─────────

describe('rewrite-contrast-tokens — packageContext.palette', () => {
  it('uses palette from packageContext when provided', async () => {
    const css = ':root { --custom-token: #eeeeee; }';
    const file = {
      path: 'styles/main.css',
      content: css,
      isCss: true,
      isHtml: false
      // No _palette on the file itself
    };
    const violations = [{
      criterion: '1.4.3',
      message: 'var(--custom-token) fails contrast',
      snippet: 'color: var(--custom-token)',
      file: 'styles/main.css',
      line: 1
    }];
    const packageContext = {
      palette: {
        '--custom-token': { text: '#333333' }
      }
    };

    const result = await fixer.apply(file, violations, packageContext);
    expect(result.changed).toBe(true);
    expect(result.newContent).toContain('--custom-token: #333333;');
    await assertRoundTrip(fixer, file, result);
  });
});
