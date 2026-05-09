import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const transformer = require('../../src/transformers/landmark-labeling.js');

const REQUIRED_PATCH_FIELDS = [
  'fixer',
  'criterion',
  'triage',
  'tier',
  'confidence',
  'provenance',
  'file',
  'range',
  'before',
  'after',
  'rationale',
  'reversible',
  'status'
];

function assertFullTierPatch(patch, expected = {}) {
  for (const f of REQUIRED_PATCH_FIELDS) {
    expect(patch, `patch missing ${f}`).toHaveProperty(f);
  }
  expect(patch.tier).toBe('full');
  expect(patch.triage).toBe('author rework');
  expect(patch.fixer).toBe('landmark-labeling');
  expect(patch.provenance.source).toBe('rule-based');
  expect(typeof patch.provenance.timestamp).toBe('string');
  expect(patch.reversible).toBe(true);
  expect(patch.status).toBe('applied');
  expect(['definitive', 'likely', 'needs-review']).toContain(patch.confidence);
  expect(patch.before).not.toBe(patch.after);
  if (expected.confidence) expect(patch.confidence).toBe(expected.confidence);
  if (expected.file) expect(patch.file).toBe(expected.file);
}

function pkg(files) {
  return {
    files: files.map((f) => ({
      path: f.path,
      content: f.content,
      isHtml: /\.x?html?$/i.test(f.path)
    }))
  };
}

async function applyAndRevert(input) {
  const result = await transformer.apply(input);
  const updatedByPath = new Map();
  for (const u of result.updatedFiles) updatedByPath.set(u.path, u.newContent);
  const postApplyFiles = input.files.map((f) =>
    updatedByPath.has(f.path)
      ? { path: f.path, content: updatedByPath.get(f.path), isHtml: f.isHtml }
      : f
  );
  const revertResult = await transformer.revert(
    { files: postApplyFiles },
    { ...result.transform, patches: result.patches }
  );
  const revertedByPath = new Map();
  for (const u of revertResult.updatedFiles) revertedByPath.set(u.path, u.newContent);
  for (const f of input.files) {
    const after = revertedByPath.has(f.path) ? revertedByPath.get(f.path) : f.content;
    expect(after, `revert mismatch for ${f.path}`).toBe(f.content);
  }
  return { result, revertResult };
}

describe('landmark-labeling — heading-based labels', () => {
  it('labels two unlabeled <nav> elements using their first heading', async () => {
    const input = pkg([
      {
        path: 'page.html',
        content: [
          '<!doctype html><html><body>',
          '  <nav>',
          '    <h2>Course Modules</h2>',
          '    <a href="m1.html">M1</a>',
          '  </nav>',
          '  <nav>',
          '    <h2>Resources</h2>',
          '    <a href="r.html">r</a>',
          '  </nav>',
          '</body></html>'
        ].join('\n')
      }
    ]);
    expect(transformer.canTransform(input)).toBe(true);
    const { result } = await applyAndRevert(input);
    expect(result.patches).toHaveLength(2);
    for (const p of result.patches) assertFullTierPatch(p, { confidence: 'definitive' });
    expect(result.updatedFiles[0].newContent).toContain('aria-label="Course Modules"');
    expect(result.updatedFiles[0].newContent).toContain('aria-label="Resources"');
  });

  it('truncates headings longer than 60 characters', async () => {
    const longHeading = 'A very long heading that easily exceeds the sixty character soft cap and should get truncated';
    const input = pkg([
      {
        path: 'p.html',
        content: [
          '<!doctype html><html><body>',
          `  <nav><h2>${longHeading}</h2><a href="x.html">x</a></nav>`,
          '  <nav><h2>Short</h2><a href="x.html">x</a></nav>',
          '</body></html>'
        ].join('\n')
      }
    ]);
    const { result } = await applyAndRevert(input);
    const longLabelPatch = result.patches.find((p) => /aria-label/.test(p.after));
    expect(longLabelPatch).toBeDefined();
    const labelMatch = longLabelPatch.after.match(/aria-label="([^"]+)"/);
    expect(labelMatch).not.toBeNull();
    expect(labelMatch[1].length).toBeLessThanOrEqual(60);
  });
});

describe('landmark-labeling — positional fallback', () => {
  it('uses "Primary navigation" / "Secondary navigation" when no headings are inside', async () => {
    const input = pkg([
      {
        path: 'page.html',
        content: [
          '<!doctype html><html><body>',
          '  <nav><a href="a.html">a</a></nav>',
          '  <nav><a href="b.html">b</a></nav>',
          '</body></html>'
        ].join('\n')
      }
    ]);
    const { result } = await applyAndRevert(input);
    expect(result.patches).toHaveLength(2);
    expect(result.patches.every((p) => p.confidence === 'likely')).toBe(true);
    const labels = result.patches.map((p) => p.after.match(/aria-label="([^"]+)"/)[1]);
    expect(labels).toContain('Primary navigation');
    expect(labels).toContain('Secondary navigation');
  });
});

describe('landmark-labeling — declines', () => {
  it('declines (does not relabel) when aria-label is already present', async () => {
    const input = pkg([
      {
        path: 'p.html',
        content: [
          '<!doctype html><html><body>',
          '  <nav aria-label="Primary"><a href="a.html">a</a></nav>',
          '  <nav><h2>Resources</h2><a href="r.html">r</a></nav>',
          '</body></html>'
        ].join('\n')
      }
    ]);
    const { result } = await applyAndRevert(input);
    // Only the SECOND nav is relabeled.
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].after).toContain('aria-label="Resources"');
  });

  it('declines (does not relabel) when aria-labelledby is present', async () => {
    const input = pkg([
      {
        path: 'p.html',
        content: [
          '<!doctype html><html><body>',
          '  <nav aria-labelledby="h1"><h2 id="h1">Already</h2></nav>',
          '  <nav><h2>Other</h2><a href="x.html">x</a></nav>',
          '</body></html>'
        ].join('\n')
      }
    ]);
    const { result } = await applyAndRevert(input);
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].after).toContain('aria-label="Other"');
  });

  it('does NOT label when there is only one landmark of a role', async () => {
    const input = pkg([
      {
        path: 'p.html',
        content: '<!doctype html><html><body><nav><a href="x.html">x</a></nav></body></html>'
      }
    ]);
    expect(transformer.canTransform(input)).toBe(false);
    const result = await transformer.apply(input);
    expect(result.patches).toEqual([]);
  });

  it('emits a DeferredFinding when no heading and no positional fallback applies', async () => {
    // Construct a situation where positional fallbacks run out: e.g. four
    // <main> landmarks; we ship only two positional fallbacks.
    const input = pkg([
      {
        path: 'p.html',
        content: [
          '<!doctype html><html><body>',
          '  <main><p>1</p></main>',
          '  <main><p>2</p></main>',
          '  <main><p>3</p></main>',
          '  <main><p>4</p></main>',
          '</body></html>'
        ].join('\n')
      }
    ]);
    const result = await transformer.apply(input);
    // The first two get positional fallbacks; the third + fourth decline.
    expect(result.patches.length).toBe(2);
    expect(result.deferred.length).toBeGreaterThanOrEqual(2);
    for (const d of result.deferred) {
      expect(d.file).toBe('p.html');
      expect(d.reason).toMatch(/no inner heading|positional fallback/i);
    }
  });
});

describe('landmark-labeling — multi-page transform', () => {
  it('emits one Transform whose scope covers every touched page', async () => {
    const input = pkg([
      {
        path: 'a.html',
        content: '<!doctype html><html><body>\n  <nav><h2>Aa</h2><a href="x.html">x</a></nav>\n  <nav><h2>Ab</h2><a href="y.html">y</a></nav>\n</body></html>'
      },
      {
        path: 'b.html',
        content: '<!doctype html><html><body>\n  <nav><h2>Ba</h2><a href="x.html">x</a></nav>\n  <nav><h2>Bb</h2><a href="y.html">y</a></nav>\n</body></html>'
      },
      {
        path: 'c.html',
        // single nav — untouched
        content: '<!doctype html><html><body><nav><a href="x.html">x</a></nav></body></html>'
      }
    ]);
    const { result } = await applyAndRevert(input);
    expect(result.transform.scope.files.sort()).toEqual(['a.html', 'b.html']);
    expect(result.transform.scope.manifestEdited).toBe(false);
    expect(result.transform.family).toBe('landmark');
    expect(result.transform.tier).toBe('full');
    expect(result.transform.criteria).toEqual(['1.3.1', '4.1.2']);
    expect(result.transform.requiresCheckpointApproval).toBe(true);
    expect(result.transform.status).toBe('pending-checkpoint');
    expect(result.transform.patchIds.length).toBe(result.patches.length);
    const touched = new Set(result.patches.map((p) => p.file));
    expect(touched.has('c.html')).toBe(false);
  });
});

describe('landmark-labeling — coordination with v4 fixers', () => {
  it('does not alter or interact with the add-skip-link skip link', async () => {
    // Skip link present; two navs need labels. The skip link itself must not
    // be touched (it is not a landmark).
    const input = pkg([
      {
        path: 'p.html',
        content: [
          '<!doctype html><html><body>',
          '    <a href="#main-content" class="skip-link" style="position:absolute;left:-10000px;">Skip</a>',
          '  <nav><h2>Modules</h2><a href="m1.html">M1</a></nav>',
          '  <nav><h2>Tools</h2><a href="t1.html">T1</a></nav>',
          '</body></html>'
        ].join('\n')
      }
    ]);
    const { result } = await applyAndRevert(input);
    expect(result.patches).toHaveLength(2);
    // Skip link survives untouched.
    for (const u of result.updatedFiles) {
      expect(u.newContent).toContain('href="#main-content"');
      expect(u.newContent).toContain('Skip');
    }
  });
});

describe('landmark-labeling — round-trip determinism', () => {
  it('runs apply twice and produces identical patch ranges and rationale', async () => {
    const input = pkg([
      {
        path: 'page.html',
        content: [
          '<!doctype html><html><body>',
          '  <nav><h2>One</h2><a href="x.html">x</a></nav>',
          '  <nav><h2>Two</h2><a href="x.html">x</a></nav>',
          '</body></html>'
        ].join('\n')
      }
    ]);
    const r1 = await transformer.apply(input);
    const r2 = await transformer.apply(input);
    expect(r1.patches.length).toBe(r2.patches.length);
    for (let i = 0; i < r1.patches.length; i++) {
      const a = r1.patches[i];
      const b = r2.patches[i];
      expect(b.range).toEqual(a.range);
      expect(b.before).toBe(a.before);
      expect(b.after).toBe(a.after);
      expect(b.rationale).toBe(a.rationale);
      expect(b.criterion).toBe(a.criterion);
      expect(b.confidence).toBe(a.confidence);
    }
  });
});

describe('landmark-labeling — interface conformance', () => {
  it('exports the documented Transformer interface', () => {
    expect(transformer.id).toBe('landmark-labeling');
    expect(transformer.family).toBe('landmark');
    expect(transformer.tier).toBe('full');
    expect(transformer.provenance).toBe('rule-based');
    expect(transformer.triage).toBe('author rework');
    expect(transformer.criteria).toEqual(['1.3.1', '4.1.2']);
    expect(transformer.supported).toEqual(['scorm12', 'scorm2004']);
    expect(typeof transformer.canTransform).toBe('function');
    expect(typeof transformer.apply).toBe('function');
    expect(typeof transformer.revert).toBe('function');
  });
});
