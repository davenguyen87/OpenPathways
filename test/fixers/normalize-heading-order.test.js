import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { assertPatchShape, assertRoundTrip, assertFixShimLegacy } from './_assert-patch.js';

const require = createRequire(import.meta.url);
const fixer = require('../../src/fixers/normalize-heading-order.js');

describe('normalize-heading-order — Pattern 1: missing <h1>', () => {
  it('promotes the first heading to <h1> when no h1 exists and the candidate is unambiguous', async () => {
    const file = {
      path: 'page.html',
      content: [
        '<!doctype html>',
        '<html lang="en">',
        '<body>',
        '  <h2>Course Overview</h2>',
        '  <h3>Section A</h3>',
        '  <p>Body text.</p>',
        '  <h3>Section B</h3>',
        '</body>',
        '</html>'
      ].join('\n'),
      isHtml: true
    };

    expect(fixer.canFix(file, { criterion: '1.3.1' })).toBe(true);

    const result = await fixer.apply(file, [
      { criterion: '1.3.1', message: 'page is missing an h1', file: 'page.html', line: 4 }
    ]);

    expect(result.changed).toBe(true);
    // One patch spans the entire heading element (open through close).
    expect(result.patches).toHaveLength(1);
    assertPatchShape(result.patches[0], {
      fixer: 'normalize-heading-order',
      criterion: '1.3.1',
      confidence: 'definitive',
      file: 'page.html'
    });

    // Promotion landed: the unique <h2> became an <h1>; the two <h3>s stay put.
    expect(result.newContent).toContain('<h1>Course Overview</h1>');
    expect(result.newContent).not.toMatch(/<h2>Course Overview<\/h2>/);
    expect(result.newContent.match(/<h3>/g)).toHaveLength(2);

    await assertRoundTrip(fixer, file, result);
  });
});

describe('normalize-heading-order — Pattern 2: orphan <h1>', () => {
  it('demotes a section/article-nested h1 when a sibling h1 exists outside', async () => {
    const file = {
      path: 'lesson.html',
      content: [
        '<!doctype html>',
        '<html>',
        '<body>',
        '  <h1>Module Title</h1>',
        '  <section>',
        '    <h1>Subsection Title</h1>',
        '    <p>Body.</p>',
        '  </section>',
        '</body>',
        '</html>'
      ].join('\n'),
      isHtml: true
    };

    expect(fixer.canFix(file, { criterion: '1.3.1' })).toBe(true);

    const result = await fixer.apply(file, [
      { criterion: '1.3.1', message: 'two h1s on page', file: 'lesson.html', line: 6 }
    ]);

    expect(result.changed).toBe(true);
    expect(result.patches).toHaveLength(1);
    assertPatchShape(result.patches[0], {
      fixer: 'normalize-heading-order',
      criterion: '1.3.1',
      confidence: 'definitive',
      file: 'lesson.html'
    });

    // Outer h1 stays; inner one becomes h2.
    expect(result.newContent).toContain('<h1>Module Title</h1>');
    expect(result.newContent).toContain('<h2>Subsection Title</h2>');
    expect(result.newContent).not.toMatch(/<h1>Subsection Title<\/h1>/);

    await assertRoundTrip(fixer, file, result);
  });
});

describe('normalize-heading-order — declines', () => {
  it('declines on h1 -> h3 skip with no missing-h1 (h1 already present)', async () => {
    // h1 exists, then h3 appears with no h2 between. This is a heading-skip
    // pattern that requires human judgment — fixer must not act.
    const file = {
      path: 'p.html',
      content: [
        '<!doctype html>',
        '<html>',
        '<body>',
        '  <h1>Page Title</h1>',
        '  <h3>Skipped Level</h3>',
        '</body>',
        '</html>'
      ].join('\n'),
      isHtml: true
    };

    expect(fixer.canFix(file, { criterion: '1.3.1' })).toBe(false);

    const result = await fixer.apply(file, [
      { criterion: '1.3.1', message: 'h1 -> h3 skip', file: 'p.html', line: 5 }
    ]);
    expect(result.changed).toBe(false);
    expect(result.patches).toEqual([]);
    expect(result.newContent).toBe(file.content);
  });

  it('declines when the missing-h1 candidate is ambiguous (multiple peers at the same top level)', async () => {
    // Three h2s, no h1. We can't pick "the page title" — decline.
    const file = {
      path: 'amb.html',
      content: [
        '<!doctype html>',
        '<html>',
        '<body>',
        '  <h2>Section A</h2>',
        '  <p>...</p>',
        '  <h2>Section B</h2>',
        '  <p>...</p>',
        '  <h2>Section C</h2>',
        '</body>',
        '</html>'
      ].join('\n'),
      isHtml: true
    };

    expect(fixer.canFix(file, { criterion: '1.3.1' })).toBe(false);

    const result = await fixer.apply(file, [
      { criterion: '1.3.1', message: 'no h1', file: 'amb.html', line: 4 }
    ]);
    expect(result.changed).toBe(false);
    expect(result.patches).toEqual([]);
    expect(result.newContent).toBe(file.content);
  });
});

describe('normalize-heading-order — multiple orphans', () => {
  it('emits non-overlapping patches for each orphan and round-trips byte-identically', async () => {
    const file = {
      path: 'multi.html',
      content: [
        '<!doctype html>',
        '<html>',
        '<body>',
        '  <h1>Top of Page</h1>',
        '  <section>',
        '    <h1>Orphan One</h1>',
        '  </section>',
        '  <article>',
        '    <h1>Orphan Two</h1>',
        '  </article>',
        '</body>',
        '</html>'
      ].join('\n'),
      isHtml: true
    };

    const result = await fixer.apply(file, [
      { criterion: '1.3.1', message: 'multi orphans', file: 'multi.html', line: 6 }
    ]);

    expect(result.changed).toBe(true);
    // Two orphans × one patch each = 2 patches total.
    expect(result.patches).toHaveLength(2);
    for (const p of result.patches) {
      assertPatchShape(p, {
        fixer: 'normalize-heading-order',
        criterion: '1.3.1',
        confidence: 'definitive',
        file: 'multi.html'
      });
    }

    // Patches should not overlap — every pair of (start,end) ranges is disjoint.
    const ranges = result.patches.map((p) => {
      const startKey = p.range.startLine * 100000 + p.range.startCol;
      const endKey = p.range.endLine * 100000 + p.range.endCol;
      return [startKey, endKey];
    });
    for (let i = 0; i < ranges.length; i += 1) {
      for (let j = i + 1; j < ranges.length; j += 1) {
        const [aStart, aEnd] = ranges[i];
        const [bStart, bEnd] = ranges[j];
        const disjoint = aEnd <= bStart || bEnd <= aStart;
        expect(disjoint, `patches ${i} and ${j} overlap`).toBe(true);
      }
    }

    expect(result.newContent).toContain('<h1>Top of Page</h1>');
    expect(result.newContent).toContain('<h2>Orphan One</h2>');
    expect(result.newContent).toContain('<h2>Orphan Two</h2>');
    expect(result.newContent).not.toMatch(/<h1>Orphan One<\/h1>/);
    expect(result.newContent).not.toMatch(/<h1>Orphan Two<\/h1>/);

    await assertRoundTrip(fixer, file, result);
  });
});

describe('normalize-heading-order — fix() shim', () => {
  it('returns the legacy { changed, newContent, log } shape with no patches field', async () => {
    const file = {
      path: 'page.html',
      content: '<html><body><h2>Only Heading</h2><p>x</p></body></html>',
      isHtml: true
    };
    const result = await assertFixShimLegacy(fixer, file, [
      { criterion: '1.3.1', message: 'no h1', file: 'page.html', line: 1 }
    ]);
    expect(result.changed).toBe(true);
    expect(result.newContent).toContain('<h1>Only Heading</h1>');
  });
});
