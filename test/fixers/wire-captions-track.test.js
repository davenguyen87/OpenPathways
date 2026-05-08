/**
 * Tests for src/fixers/wire-captions-track.js
 *
 * No binary zip fixtures are used. The fixer's interface accepts a `siblings`
 * array on either `file.siblings` or `packageContext.siblings`. Tests inject
 * in-memory file lists so they don't depend on disk state.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { assertPatchShape, assertRoundTrip, assertFixShimLegacy } from './_assert-patch.js';

const require = createRequire(import.meta.url);
const fixer = require('../../src/fixers/wire-captions-track.js');

// ── Helpers ────────────────────────────────────────────────────────────────

function makeHtmlFile(content, siblings = [], path = 'content/page.html') {
  return {
    path,
    content,
    isHtml: true,
    siblings
  };
}

function makeViolation(overrides = {}) {
  return {
    criterion: '1.2.2',
    message: 'Video is missing captions.',
    file: 'content/page.html',
    line: 4,
    snippet: '<video src="intro.mp4">',
    ...overrides
  };
}

// ── 1. Happy path — matching .vtt in same directory ────────────────────────

describe('wire-captions-track — happy path: same-dir .vtt', () => {
  it('injects <track> when a matching .vtt exists in the same directory', async () => {
    const html = [
      '<!doctype html>',
      '<html lang="en">',
      '<body>',
      '  <video src="intro.mp4" controls>',
      '  </video>',
      '</body>',
      '</html>'
    ].join('\n');

    // Package contains a .vtt file alongside the HTML
    const siblings = [
      'content/page.html',
      'content/intro.mp4',
      'content/intro.vtt'
    ];

    const file = makeHtmlFile(html, siblings);
    const violations = [makeViolation()];

    expect(fixer.canFix(file, violations[0])).toBe(true);

    const result = await fixer.apply(file, violations);

    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(1);
    assertPatchShape(result.patches[0], {
      fixer: 'wire-captions-track',
      criterion: '1.2.2',
      confidence: 'definitive',
      file: 'content/page.html'
    });

    // The injected track element should be present
    expect(result.newContent).toContain('<track kind="captions"');
    expect(result.newContent).toContain('src="intro.vtt"');
    expect(result.newContent).toContain('srclang="en"');
    expect(result.newContent).toContain('default');
    // The </video> should still be present after the track
    expect(result.newContent).toContain('</video>');

    expect(result.deferred).toEqual([]);

    await assertRoundTrip(fixer, file, result);
  });
});

// ── 2. Happy path — matching .vtt in captions/ subdirectory ───────────────

describe('wire-captions-track — happy path: captions/ dir .vtt', () => {
  it('injects <track> when the .vtt is in a sibling captions/ directory', async () => {
    const html = [
      '<html><body>',
      '<video src="lesson.mp4"></video>',
      '</body></html>'
    ].join('\n');

    const siblings = [
      'videos/page.html',
      'videos/lesson.mp4',
      'videos/captions/lesson.vtt'
    ];

    const file = makeHtmlFile(html, siblings, 'videos/page.html');
    const violations = [makeViolation({ file: 'videos/page.html', snippet: '<video src="lesson.mp4">' })];

    const result = await fixer.apply(file, violations);

    expect(result.changed).toBe(true);
    expect(result.newContent).toContain('src="captions/lesson.vtt"');

    await assertRoundTrip(fixer, file, result);
  });
});

// ── 3. Decline — no matching .vtt file ────────────────────────────────────

describe('wire-captions-track — decline: no matching .vtt', () => {
  it('defers with "no matching .vtt file" reason when no .vtt exists', async () => {
    const html = [
      '<html><body>',
      '<video src="demo.mp4"></video>',
      '</body></html>'
    ].join('\n');

    const siblings = [
      'content/page.html',
      'content/demo.mp4'
      // No .vtt
    ];

    const file = makeHtmlFile(html, siblings);
    const violations = [makeViolation({ snippet: '<video src="demo.mp4">' })];

    const result = await fixer.apply(file, violations);

    expect(result.changed).toBe(false);
    expect(result.patches).toHaveLength(0);
    expect(result.deferred).toHaveLength(1);
    expect(result.deferred[0].reason).toMatch(/no matching \.vtt file/);
    expect(result.deferred[0].criterion).toBe('1.2.2');
  });
});

// ── 4. Decline — <track> already present (any kind) ───────────────────────

describe('wire-captions-track — decline: track already present', () => {
  it('skips the video when any <track> element is already present', async () => {
    const html = [
      '<html><body>',
      '<video src="course.mp4">',
      '  <track kind="subtitles" src="course-en.vtt" srclang="en">',
      '</video>',
      '</body></html>'
    ].join('\n');

    const siblings = [
      'content/page.html',
      'content/course.mp4',
      'content/course.vtt'
    ];

    const file = makeHtmlFile(html, siblings);
    const violations = [makeViolation({ snippet: '<video src="course.mp4">' })];

    const result = await fixer.apply(file, violations);

    expect(result.changed).toBe(false);
    expect(result.patches).toHaveLength(0);
    // A <track> is already there — no deferred entry either; this is a silent skip
    // (the author chose to include a different track kind).
  });
});

// ── 5. canFix guards ──────────────────────────────────────────────────────

describe('wire-captions-track — canFix', () => {
  it('returns false for non-HTML files', () => {
    const file = { path: 'foo.css', content: '', isCss: true, isHtml: false };
    expect(fixer.canFix(file, { criterion: '1.2.2' })).toBe(false);
  });

  it('returns false for unrelated criteria', () => {
    const file = makeHtmlFile('');
    expect(fixer.canFix(file, { criterion: '1.1.1' })).toBe(false);
  });

  it('returns false when violation is null', () => {
    const file = makeHtmlFile('');
    expect(fixer.canFix(file, null)).toBe(false);
  });

  it('returns true for HTML with 1.2.2 violation', () => {
    const file = makeHtmlFile('');
    expect(fixer.canFix(file, { criterion: '1.2.2' })).toBe(true);
  });
});

// ── 6. Round-trip ──────────────────────────────────────────────────────────

describe('wire-captions-track — round-trip', () => {
  it('apply then revert produces byte-identical original content', async () => {
    const html = [
      '<!doctype html>',
      '<html lang="en">',
      '<head><title>Test</title></head>',
      '<body>',
      '  <video src="clip.mp4" controls></video>',
      '</body>',
      '</html>'
    ].join('\n');

    const siblings = ['page.html', 'clip.mp4', 'clip.vtt'];
    const file = makeHtmlFile(html, siblings, 'page.html');
    const violations = [makeViolation({ file: 'page.html' })];

    const result = await fixer.apply(file, violations);
    expect(result.changed).toBe(true);

    await assertRoundTrip(fixer, file, result);
  });
});

// ── 7. packageContext.siblings takes precedence ───────────────────────────

describe('wire-captions-track — packageContext.siblings', () => {
  it('uses siblings from packageContext when provided', async () => {
    const html = '<html><body><video src="talk.mp4"></video></body></html>';
    const file = {
      path: 'media/page.html',
      content: html,
      isHtml: true
      // No siblings on file itself
    };
    const violations = [makeViolation({ file: 'media/page.html' })];
    const packageContext = {
      siblings: ['media/page.html', 'media/talk.mp4', 'media/talk.vtt']
    };

    const result = await fixer.apply(file, violations, packageContext);

    expect(result.changed).toBe(true);
    expect(result.newContent).toContain('src="talk.vtt"');
    await assertRoundTrip(fixer, file, result);
  });
});

// ── 8. fix() shim — legacy interface ─────────────────────────────────────

describe('wire-captions-track — fix() shim', () => {
  it('returns legacy { changed, newContent, log } with no patches field', async () => {
    const html = '<html><body><video src="x.mp4"></video></body></html>';
    const siblings = ['content/page.html', 'content/x.mp4', 'content/x.vtt'];
    const file = makeHtmlFile(html, siblings);
    const violations = [makeViolation({ snippet: '<video src="x.mp4">' })];

    const result = await assertFixShimLegacy(fixer, file, violations);
    expect(result.changed).toBe(true);
    expect(result.newContent).toContain('<track kind="captions"');
  });
});

// ── 9. Video with no src attribute ────────────────────────────────────────

describe('wire-captions-track — video with no src', () => {
  it('defers when <video> has no src and no <source> child', async () => {
    const html = '<html><body><video controls></video></body></html>';
    const siblings = ['page.html'];
    const file = makeHtmlFile(html, siblings, 'page.html');
    const violations = [makeViolation({ snippet: '<video controls>' })];

    const result = await fixer.apply(file, violations);

    expect(result.changed).toBe(false);
    expect(result.deferred).toHaveLength(1);
    expect(result.deferred[0].reason).toMatch(/no matching \.vtt file/);
  });
});

// ── 10. Video src via <source> child ─────────────────────────────────────

describe('wire-captions-track — video via <source> child', () => {
  it('detects stem from <source src="..."> when video has no src attribute', async () => {
    const html = [
      '<html><body>',
      '<video controls>',
      '  <source src="presentation.mp4" type="video/mp4">',
      '</video>',
      '</body></html>'
    ].join('\n');

    const siblings = ['page.html', 'presentation.mp4', 'presentation.vtt'];
    const file = makeHtmlFile(html, siblings, 'page.html');
    const violations = [makeViolation({ snippet: '<video controls>' })];

    const result = await fixer.apply(file, violations);

    expect(result.changed).toBe(true);
    expect(result.newContent).toContain('src="presentation.vtt"');
    await assertRoundTrip(fixer, file, result);
  });
});
