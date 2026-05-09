import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import axe from 'axe-core';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const transformer = require('../../src/transformers/widget-replacement-carousel.js');

const REQUIRED_PATCH_FIELDS = [
  'fixer', 'criterion', 'triage', 'tier', 'confidence', 'provenance',
  'file', 'range', 'before', 'after', 'rationale', 'reversible', 'status'
];

function assertWidgetPatch(patch) {
  for (const f of REQUIRED_PATCH_FIELDS) expect(patch).toHaveProperty(f);
  expect(patch.tier).toBe('full');
  expect(patch.fixer).toBe('widget-replacement-carousel');
  expect(patch.confidence).toBe('likely');
  expect(patch.provenance.source).toBe('rule-based');
  expect(patch.reversible).toBe(true);
  expect(patch.status).toBe('applied');
}

function pkg(files, opts = {}) {
  return {
    bypassAuditGate: opts.bypassAuditGate !== false,
    findings: opts.findings,
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

const CAR_FIXTURE = `<!doctype html>
<html><body>
<script>var x = 1;</script>
<div class="carousel">
  <div class="slides">
    <div class="slide">First slide content</div>
    <div class="slide">Second slide content</div>
    <div class="slide">Third slide content</div>
  </div>
  <button class="prev">Prev</button>
  <button class="next">Next</button>
</div>
</body></html>`;

describe('widget-replacement-carousel — interface', () => {
  it('exposes the documented Transformer interface', () => {
    expect(transformer.id).toBe('widget-replacement-carousel');
    expect(transformer.family).toBe('widget');
    expect(transformer.tier).toBe('full');
    expect(transformer.provenance).toBe('rule-based');
    expect(transformer.criteria).toEqual(['2.1.1', '2.4.3', '4.1.2']);
    expect(typeof transformer.canTransform).toBe('function');
    expect(typeof transformer.apply).toBe('function');
    expect(typeof transformer.revert).toBe('function');
  });
});

describe('widget-replacement-carousel — happy path', () => {
  it('claims and replaces a div-soup carousel with patches that revert byte-identically', async () => {
    const input = pkg([{ path: 'page.html', content: CAR_FIXTURE }]);
    expect(transformer.canTransform(input)).toBe(true);
    const { result } = await applyAndRevert(input);
    expect(result.patches).toHaveLength(1);
    assertWidgetPatch(result.patches[0]);
    expect(result.patches[0].before).toMatch(/<div class="carousel">/);
    expect(result.patches[0].after).toMatch(/<section[\s\S]*class="prism-widget-carousel"/);
    expect(result.transform.requiresCheckpointApproval).toBe(true);
    expect(result.transform.scope.manifestEdited).toBe(false);
  });
});

describe('widget-replacement-carousel — IR extraction', () => {
  it('preserves slide HTML content and slide count', async () => {
    const result = await transformer.apply(pkg([{ path: 'p.html', content: CAR_FIXTURE }]));
    expect(result.patches).toHaveLength(1);
    const after = result.patches[0].after;
    expect(after).toContain('First slide content');
    expect(after).toContain('Second slide content');
    expect(after).toContain('Third slide content');
    expect(after).toMatch(/Slide 1 of 3/);
    // Three data-prism-slide elements in the rendered fragment.
    const matches = after.match(/data-prism-slide/g) || [];
    expect(matches.length).toBe(3);
  });

  it('flags autoplay in the rationale when source carries autoplay markers', async () => {
    const fixture = `<!doctype html><html><body>
<script>var x=1;</script>
<div class="carousel autoplay" data-ride="carousel">
  <div class="slides">
    <div class="slide">A content</div>
    <div class="slide">B content</div>
  </div>
  <button class="prev">P</button><button class="next">N</button>
</div></body></html>`;
    const r = await transformer.apply(pkg([{ path: 'p.html', content: fixture }]));
    expect(r.patches).toHaveLength(1);
    expect(r.patches[0].rationale).toMatch(/autoplay/i);
  });
});

describe('widget-replacement-carousel — decline rules', () => {
  it('declines when the source contains a <form>', async () => {
    const fixture = `<!doctype html><html><body><script>var z=1;</script><div class="carousel">
      <div class="slides"><div class="slide"><form><input></form>One</div><div class="slide">Two</div></div>
    </div></body></html>`;
    const r = await transformer.apply(pkg([{ path: 'p.html', content: fixture }]));
    expect(r.patches).toHaveLength(0);
    expect(r.deferred.some((d) => /form-in-source/.test(d.reason))).toBe(true);
  });

  it('declines when nested <script> contains non-trivial logic', async () => {
    const fixture = `<!doctype html><html><body><div class="carousel">
      <div class="slides"><div class="slide">A<script>function bind(){if(true){return 1}}</script></div><div class="slide">B</div></div>
    </div></body></html>`;
    const r = await transformer.apply(pkg([{ path: 'p.html', content: fixture }]));
    expect(r.patches).toHaveLength(0);
    expect(r.deferred.some((d) => /nested-script/.test(d.reason))).toBe(true);
  });

  it('declines when slide count exceeds the cap', async () => {
    const slides = Array.from({ length: 21 }, (_, i) => `<div class="slide">S${i} content</div>`).join('');
    const fixture = `<!doctype html><html><body><script>var z=1</script><div class="carousel"><div class="slides">${slides}</div></div></body></html>`;
    const r = await transformer.apply(pkg([{ path: 'p.html', content: fixture }]));
    expect(r.patches).toHaveLength(0);
    expect(r.deferred.some((d) => /too-many-slides/.test(d.reason))).toBe(true);
  });

  it('declines when slides contain anchors with target="_self" to in-package routes', async () => {
    const fixture = `<!doctype html><html><body><script>var z=1;</script><div class="carousel">
      <div class="slides">
        <div class="slide"><a href="page2.html" target="_self">Go</a> One</div>
        <div class="slide">Two</div>
      </div>
    </div></body></html>`;
    const r = await transformer.apply(pkg([{ path: 'p.html', content: fixture }]));
    expect(r.patches).toHaveLength(0);
    expect(r.deferred.some((d) => /self-target-anchors/.test(d.reason))).toBe(true);
  });

  it('declines when the source is CSS-only (no JS anywhere)', async () => {
    const fixture = `<!doctype html><html><body><div class="carousel">
      <div class="slides">
        <div class="slide">One</div>
        <div class="slide">Two</div>
      </div>
    </div></body></html>`;
    const r = await transformer.apply(pkg([{ path: 'p.html', content: fixture }]));
    expect(r.patches).toHaveLength(0);
    expect(r.deferred.some((d) => /css-only-slideshow/.test(d.reason))).toBe(true);
  });

  it('declines when no audit finding matches', async () => {
    const input = {
      bypassAuditGate: false,
      findings: [],
      files: [{ path: 'p.html', isHtml: true, content: CAR_FIXTURE }]
    };
    expect(transformer.canTransform(input)).toBe(false);
    const r = await transformer.apply(input);
    expect(r.deferred.some((d) => /no-matching-finding/.test(d.reason))).toBe(true);
  });
});

describe('widget-replacement-carousel — multi-pattern page', () => {
  it('one Transform with two patches for two carousels', async () => {
    const car = (n, slides) => `<div class="carousel">
      <div class="slides">${slides.map((s) => `<div class="slide">${n}-${s} content</div>`).join('')}</div>
      <button class="prev">P</button><button class="next">N</button>
    </div>`;
    const fixture = `<!doctype html><html><body><script>var x=1;</script>${car('one', ['A', 'B'])}<hr>${car('two', ['A', 'B'])}</body></html>`;
    const { result } = await applyAndRevert(pkg([{ path: 'p.html', content: fixture }]));
    expect(result.patches).toHaveLength(2);
  });
});

describe('widget-replacement-carousel — round-trip determinism', () => {
  it('apply twice produces identical patches modulo provenance.timestamp', async () => {
    const r1 = await transformer.apply(pkg([{ path: 'p.html', content: CAR_FIXTURE }]));
    const r2 = await transformer.apply(pkg([{ path: 'p.html', content: CAR_FIXTURE }]));
    expect(r1.patches.length).toBe(r2.patches.length);
    for (let i = 0; i < r1.patches.length; i++) {
      expect(r2.patches[i].range).toEqual(r1.patches[i].range);
      expect(r2.patches[i].before).toBe(r1.patches[i].before);
      expect(r2.patches[i].after).toBe(r1.patches[i].after);
    }
  });
});

describe('widget-replacement-carousel — axe baseline', () => {
  it('post-substitution rendered fragment matches the widget axe baseline', async () => {
    const result = await transformer.apply(pkg([{ path: 'p.html', content: CAR_FIXTURE }]));
    expect(result.patches).toHaveLength(1);
    const widgetDir = path.resolve(__dirname, '../../src/widgets/carousel');
    const styles = fs.readFileSync(path.join(widgetDir, 'styles.css'), 'utf8');
    const script = fs.readFileSync(path.join(widgetDir, 'script.js'), 'utf8');
    const baseline = JSON.parse(fs.readFileSync(path.join(widgetDir, 'axe-baseline.json'), 'utf8'));

    const fragment = result.patches[0].after;
    const docHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>T</title><style>${styles}</style></head><body>${fragment}<script>${script}</script></body></html>`;
    const dom = new JSDOM(docHtml, { runScripts: 'dangerously', pretendToBeVisual: true });
    const win = dom.window;
    win.eval(axe.source);
    const results = await win.axe.run(win.document, {
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
    });
    expect(results.violations).toEqual(baseline.violations);
    dom.window.close();
  });
});
