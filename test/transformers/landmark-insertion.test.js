import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const transformer = require('../../src/transformers/landmark-insertion.js');

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
  expect(patch.fixer).toBe('landmark-insertion');
  expect(patch.provenance.source).toBe('rule-based');
  expect(typeof patch.provenance.timestamp).toBe('string');
  expect(patch.reversible).toBe(true);
  expect(patch.status).toBe('applied');
  expect(['definitive', 'likely', 'needs-review']).toContain(patch.confidence);
  expect(patch.before).not.toBe(patch.after);
  if (expected.confidence) expect(patch.confidence).toBe(expected.confidence);
  if (expected.file) expect(patch.file).toBe(expected.file);
  if (expected.criterion) expect(patch.criterion).toBe(expected.criterion);
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
  // Build the post-apply package context as the orchestrator would.
  const updatedByPath = new Map();
  for (const u of result.updatedFiles) updatedByPath.set(u.path, u.newContent);
  const postApplyFiles = input.files.map((f) =>
    updatedByPath.has(f.path)
      ? { path: f.path, content: updatedByPath.get(f.path), isHtml: f.isHtml }
      : f
  );
  // Revert.
  const revertResult = await transformer.revert(
    { files: postApplyFiles },
    { ...result.transform, patches: result.patches }
  );
  const revertedByPath = new Map();
  for (const u of revertResult.updatedFiles) revertedByPath.set(u.path, u.newContent);
  // Compare each touched file to the pre-apply original.
  for (const f of input.files) {
    const after = revertedByPath.has(f.path) ? revertedByPath.get(f.path) : f.content;
    expect(after, `revert mismatch for ${f.path}`).toBe(f.content);
  }
  return { result, revertResult };
}

describe('landmark-insertion — class-based detection', () => {
  it('promotes a div with class="main-content" to <main>', async () => {
    const input = pkg([
      {
        path: 'page.html',
        content: [
          '<!doctype html>',
          '<html><body>',
          '  <div class="main-content">',
          '    <h1>Lesson 1</h1>',
          '    <p>Body</p>',
          '  </div>',
          '</body></html>'
        ].join('\n')
      }
    ]);
    expect(transformer.canTransform(input)).toBe(true);
    const { result } = await applyAndRevert(input);
    // Each landmark promotion emits two patches: opening tag and closing tag.
    expect(result.patches).toHaveLength(2);
    for (const p of result.patches) assertFullTierPatch(p, { confidence: 'definitive', file: 'page.html' });
    expect(result.updatedFiles[0].newContent).toContain('<main class="main-content">');
    expect(result.updatedFiles[0].newContent).toContain('</main>');
  });

  it('promotes a div with class="navigation" to <nav>', async () => {
    const input = pkg([
      {
        path: 'page.html',
        content: '<!doctype html>\n<html><body>\n  <div class="navigation"><a href="next.html">Next</a></div>\n  <div class="main-content"><h1>X</h1></div>\n</body></html>'
      }
    ]);
    expect(transformer.canTransform(input)).toBe(true);
    const { result } = await applyAndRevert(input);
    const navPatch = result.patches.find((p) => p.after.includes('<nav'));
    expect(navPatch).toBeDefined();
    expect(navPatch.confidence).toBe('definitive');
  });

  it('drops a redundant role attribute when promoting via role signal', async () => {
    const input = pkg([
      {
        path: 'page.html',
        content: '<!doctype html>\n<html><body>\n  <div role="main"><h1>X</h1></div>\n</body></html>'
      }
    ]);
    const { result } = await applyAndRevert(input);
    // Opening + closing patches.
    expect(result.patches).toHaveLength(2);
    expect(result.updatedFiles[0].newContent).toContain('<main>');
    expect(result.updatedFiles[0].newContent).toContain('</main>');
    expect(result.updatedFiles[0].newContent).not.toContain('role="main"');
  });
});

describe('landmark-insertion — id-based detection', () => {
  it('promotes a div with id="footer" to <footer>', async () => {
    const input = pkg([
      {
        path: 'page.html',
        content: [
          '<!doctype html><html><body>',
          '  <div class="main-content"><h1>X</h1></div>',
          '  <div id="footer">Copyright 2026 ACME Corp</div>',
          '</body></html>'
        ].join('\n')
      }
    ]);
    const { result } = await applyAndRevert(input);
    const footerPatch = result.patches.find((p) => p.after.includes('<footer'));
    expect(footerPatch).toBeDefined();
    expect(footerPatch.confidence).toBe('definitive');
    expect(result.updatedFiles[0].newContent).toMatch(/<footer id="footer">/);
  });
});

describe('landmark-insertion — heading-based inference (likely)', () => {
  it('promotes the h1-bearing wrapper to <main> with confidence likely when no class/id signal exists', async () => {
    const input = pkg([
      {
        path: 'page.html',
        content: [
          '<!doctype html><html><body>',
          '  <div class="wrap">',
          '    <h1>Title</h1>',
          '    <p>Body</p>',
          '  </div>',
          '</body></html>'
        ].join('\n')
      }
    ]);
    const { result } = await applyAndRevert(input);
    expect(result.patches).toHaveLength(2);
    for (const p of result.patches) expect(p.confidence).toBe('likely');
    expect(result.updatedFiles[0].newContent).toContain('<main class="wrap">');
    expect(result.updatedFiles[0].newContent).toContain('</main>');
  });
});

describe('landmark-insertion — position-based inference', () => {
  it('promotes the last wrapper to <footer> when it has copyright text', async () => {
    const input = pkg([
      {
        path: 'page.html',
        content: [
          '<!doctype html><html><body>',
          '  <div class="main-content"><h1>X</h1></div>',
          '  <div class="bottom">© 2026 ACME</div>',
          '</body></html>'
        ].join('\n')
      }
    ]);
    const { result } = await applyAndRevert(input);
    const footerPatch = result.patches.find((p) => p.after.includes('<footer'));
    expect(footerPatch).toBeDefined();
    expect(footerPatch.confidence).toBe('likely');
  });
});

describe('landmark-insertion — decline rules', () => {
  it('declines when the page already has a <main> element (no double-up)', async () => {
    const input = pkg([
      {
        path: 'page.html',
        content: '<!doctype html><html><body><main><h1>X</h1></main></body></html>'
      }
    ]);
    expect(transformer.canTransform(input)).toBe(false);
    const result = await transformer.apply(input);
    expect(result.patches).toEqual([]);
    expect(result.updatedFiles).toEqual([]);
  });

  it('emits a DeferredFinding when two wrappers compete for the same role', async () => {
    const input = pkg([
      {
        path: 'page.html',
        content: [
          '<!doctype html><html><body>',
          '  <div class="main"><h1>A</h1></div>',
          '  <div class="main"><h1>B</h1></div>',
          '</body></html>'
        ].join('\n')
      }
    ]);
    const result = await transformer.apply(input);
    expect(result.patches).toEqual([]);
    expect(result.deferred.length).toBeGreaterThan(0);
    const dec = result.deferred.find((d) => /compete/i.test(d.reason));
    expect(dec).toBeDefined();
    expect(dec.file).toBe('page.html');
  });

  it('does not promote inline wrappers like <span>', async () => {
    const input = pkg([
      {
        path: 'page.html',
        content: '<!doctype html><html><body><span class="main-content"><h1>X</h1></span></body></html>'
      }
    ]);
    expect(transformer.canTransform(input)).toBe(false);
  });
});

describe('landmark-insertion — multi-page transform', () => {
  it('produces one Transform whose scope.files covers every touched page and skips untouched pages', async () => {
    const input = pkg([
      {
        path: 'a.html',
        content: '<!doctype html><html><body>\n  <div class="main-content"><h1>A</h1></div>\n</body></html>'
      },
      {
        path: 'b.html',
        content: '<!doctype html><html><body>\n  <div class="main-content"><h1>B</h1></div>\n</body></html>'
      },
      {
        path: 'c.html',
        // c.html already has a <main>; no patches expected.
        content: '<!doctype html><html><body><main><h1>C</h1></main></body></html>'
      }
    ]);
    const { result } = await applyAndRevert(input);
    expect(result.transform.scope.files.sort()).toEqual(['a.html', 'b.html']);
    expect(result.transform.scope.manifestEdited).toBe(false);
    expect(result.transform.family).toBe('landmark');
    expect(result.transform.tier).toBe('full');
    expect(result.transform.criteria).toEqual(['1.3.1', '2.4.1', '4.1.2']);
    expect(result.transform.requiresCheckpointApproval).toBe(true);
    expect(result.transform.status).toBe('pending-checkpoint');
    // patchIds count matches patches count.
    expect(result.transform.patchIds).toHaveLength(result.patches.length);
    // c.html appears in neither updatedFiles nor patches.
    const touched = new Set(result.patches.map((p) => p.file));
    expect(touched.has('c.html')).toBe(false);
  });
});

describe('landmark-insertion — coordination with add-skip-link', () => {
  it('adds id="main-content" when a v4 skip link exists and the candidate <main> wrapper has no id', async () => {
    const input = pkg([
      {
        path: 'page.html',
        content: [
          '<!doctype html><html><body>',
          '    <a href="#main-content" class="skip-link" style="position:absolute;left:-10000px;">Skip to main content</a>',
          '  <div class="main-content"><h1>X</h1></div>',
          '</body></html>'
        ].join('\n')
      }
    ]);
    const { result } = await applyAndRevert(input);
    const mainPatch = result.patches.find((p) => p.after.includes('<main'));
    expect(mainPatch).toBeDefined();
    expect(mainPatch.after).toMatch(/<main class="main-content" id="main-content">/);
    expect(mainPatch.rationale).toMatch(/skip-to-main-content/i);
  });

  it('declines the <main> promotion when the candidate has a different id and a skip link exists', async () => {
    const input = pkg([
      {
        path: 'page.html',
        content: [
          '<!doctype html><html><body>',
          '    <a href="#main-content" class="skip-link">Skip</a>',
          '  <div id="lesson-body" class="main-content"><h1>X</h1></div>',
          '</body></html>'
        ].join('\n')
      }
    ]);
    const result = await transformer.apply(input);
    // No <main> patch.
    const mainPatch = result.patches.find((p) => p.after.includes('<main'));
    expect(mainPatch).toBeUndefined();
    // Deferred reason mentions skip-link / id mismatch.
    expect(result.deferred.some((d) => /skip-link|main-content/i.test(d.reason))).toBe(true);
  });

  it('proceeds without an extra id when wrapper already has id="main-content"', async () => {
    const input = pkg([
      {
        path: 'page.html',
        content: [
          '<!doctype html><html><body>',
          '    <a href="#main-content">Skip</a>',
          '  <div id="main-content" class="main-content"><h1>X</h1></div>',
          '</body></html>'
        ].join('\n')
      }
    ]);
    const { result } = await applyAndRevert(input);
    const mainPatch = result.patches.find((p) => p.after.includes('<main'));
    expect(mainPatch).toBeDefined();
    expect(mainPatch.after).toContain('id="main-content"');
    // Did not add a SECOND id="main-content".
    const idCount = (mainPatch.after.match(/id="main-content"/g) || []).length;
    expect(idCount).toBe(1);
  });
});

describe('landmark-insertion — round-trip determinism', () => {
  it('runs apply twice and produces identical patch ranges and rationale', async () => {
    const input = pkg([
      {
        path: 'page.html',
        content: [
          '<!doctype html><html><body>',
          '  <div class="header"><h1>Title</h1></div>',
          '  <div class="navigation"><a href="x.html">x</a></div>',
          '  <div class="main-content"><p>p</p></div>',
          '  <div class="footer">© 2026</div>',
          '</body></html>'
        ].join('\n')
      }
    ]);
    const r1 = await transformer.apply(input);
    const r2 = await transformer.apply(input);
    expect(r1.patches.length).toBe(r2.patches.length);
    expect(r1.patches.length).toBeGreaterThan(0);
    for (let i = 0; i < r1.patches.length; i++) {
      const a = r1.patches[i];
      const b = r2.patches[i];
      expect(b.range).toEqual(a.range);
      expect(b.before).toBe(a.before);
      expect(b.after).toBe(a.after);
      expect(b.rationale).toBe(a.rationale);
      expect(b.criterion).toBe(a.criterion);
      expect(b.confidence).toBe(a.confidence);
      // Provenance.timestamp is the only field allowed to differ.
    }
  });

  it('reverts byte-identically with multiple landmarks on one page', async () => {
    const input = pkg([
      {
        path: 'page.html',
        content: [
          '<!doctype html><html><body>',
          '  <div class="header"><h1>Title</h1></div>',
          '  <div class="navigation"><a href="x.html">x</a></div>',
          '  <div class="main-content"><p>p</p></div>',
          '  <div class="footer">© 2026</div>',
          '</body></html>'
        ].join('\n')
      }
    ]);
    await applyAndRevert(input); // assertion inside
  });
});

describe('landmark-insertion — interface conformance', () => {
  it('exports the documented Transformer interface', () => {
    expect(transformer.id).toBe('landmark-insertion');
    expect(transformer.family).toBe('landmark');
    expect(transformer.tier).toBe('full');
    expect(transformer.provenance).toBe('rule-based');
    expect(transformer.triage).toBe('author rework');
    expect(transformer.criteria).toEqual(['1.3.1', '2.4.1', '4.1.2']);
    expect(transformer.supported).toEqual(['scorm12', 'scorm2004']);
    expect(typeof transformer.canTransform).toBe('function');
    expect(typeof transformer.apply).toBe('function');
    expect(typeof transformer.revert).toBe('function');
  });
});
