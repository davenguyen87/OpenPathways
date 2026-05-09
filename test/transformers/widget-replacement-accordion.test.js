import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import axe from 'axe-core';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const transformer = require('../../src/transformers/widget-replacement-accordion.js');

const REQUIRED_PATCH_FIELDS = [
  'fixer', 'criterion', 'triage', 'tier', 'confidence', 'provenance',
  'file', 'range', 'before', 'after', 'rationale', 'reversible', 'status'
];

function assertWidgetPatch(patch) {
  for (const f of REQUIRED_PATCH_FIELDS) expect(patch).toHaveProperty(f);
  expect(patch.tier).toBe('full');
  expect(patch.triage).toBe('author rework');
  expect(patch.fixer).toBe('widget-replacement-accordion');
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

const ACC_FIXTURE = `<!doctype html>
<html><body>
<div class="accordion">
  <div class="accordion-section">
    <button class="accordion-trigger" data-target="#s1">First Section</button>
    <div id="s1" class="accordion-panel">First panel body</div>
  </div>
  <div class="accordion-section">
    <button class="accordion-trigger" data-target="#s2">Second Section</button>
    <div id="s2" class="accordion-panel">Second panel body</div>
  </div>
</div>
</body></html>`;

describe('widget-replacement-accordion — interface', () => {
  it('exposes the documented Transformer interface', () => {
    expect(transformer.id).toBe('widget-replacement-accordion');
    expect(transformer.family).toBe('widget');
    expect(transformer.tier).toBe('full');
    expect(transformer.provenance).toBe('rule-based');
    expect(transformer.triage).toBe('author rework');
    expect(transformer.criteria).toEqual(['1.3.1', '2.1.1', '4.1.2']);
    expect(typeof transformer.canTransform).toBe('function');
    expect(typeof transformer.apply).toBe('function');
    expect(typeof transformer.revert).toBe('function');
  });
});

describe('widget-replacement-accordion — happy path', () => {
  it('claims and replaces a div-soup accordion with patches that revert byte-identically', async () => {
    const input = pkg([{ path: 'page.html', content: ACC_FIXTURE }]);
    expect(transformer.canTransform(input)).toBe(true);
    const { result } = await applyAndRevert(input);
    expect(result.patches).toHaveLength(1);
    assertWidgetPatch(result.patches[0]);
    expect(result.patches[0].before).toMatch(/<div class="accordion">/);
    expect(result.patches[0].after).toMatch(/<div class="prism-widget-accordion"/);
    expect(result.transform.family).toBe('widget');
    expect(result.transform.requiresCheckpointApproval).toBe(true);
    expect(result.transform.scope.manifestEdited).toBe(false);
  });
});

describe('widget-replacement-accordion — IR extraction', () => {
  it('captures every header label, panel body, and initially-expanded state', async () => {
    const fixture = `<!doctype html><html><body>
<div class="accordion">
  <div class="section">
    <button class="trigger" aria-controls="p1">Alpha</button>
    <div id="p1" class="panel">Alpha body</div>
  </div>
  <div class="section">
    <button class="trigger active" aria-controls="p2" aria-expanded="true">Beta</button>
    <div id="p2" class="panel">Beta body</div>
  </div>
  <div class="section">
    <button class="trigger" aria-controls="p3">Gamma</button>
    <div id="p3" class="panel">Gamma body</div>
  </div>
</div></body></html>`;
    const result = await transformer.apply(pkg([{ path: 'p.html', content: fixture }]));
    expect(result.patches).toHaveLength(1);
    const after = result.patches[0].after;
    expect(after).toContain('>Alpha</span>');
    expect(after).toContain('>Beta</span>');
    expect(after).toContain('>Gamma</span>');
    expect(after).toContain('Alpha body');
    expect(after).toContain('Beta body');
    expect(after).toContain('Gamma body');
    // The Beta trigger was aria-expanded="true" and class="active"; should be initially expanded.
    const m = after.match(/aria-expanded="true"[^>]*data-prism-trigger\s*>\s*<span[^>]*>([^<]+)/);
    expect(m).toBeTruthy();
    expect(m[1].trim()).toBe('Beta');
  });

  it('text content survives substitution (whitespace-stripped)', async () => {
    const result = await transformer.apply(pkg([{ path: 'p.html', content: ACC_FIXTURE }]));
    const stripText = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
    const beforeText = stripText(result.patches[0].before);
    const afterText = stripText(result.patches[0].after);
    expect(afterText).toContain(beforeText);
  });
});

describe('widget-replacement-accordion — decline rules', () => {
  it('declines when the source contains a <form>', async () => {
    const fixture = `<!doctype html><html><body><div class="accordion">
      <div class="section"><button data-target="#a">A</button><div id="a" class="panel"><form><input></form></div></div>
      <div class="section"><button data-target="#b">B</button><div id="b" class="panel">B</div></div>
      </div></body></html>`;
    const r = await transformer.apply(pkg([{ path: 'p.html', content: fixture }]));
    expect(r.patches).toHaveLength(0);
    expect(r.deferred.some((d) => /form-in-source/.test(d.reason))).toBe(true);
  });

  it('declines when nested <script> contains non-trivial logic', async () => {
    const fixture = `<!doctype html><html><body><div class="accordion">
      <div class="section"><button data-target="#a">A</button><div id="a" class="panel">A<script>function x(){if(1){return 1}}</script></div></div>
      <div class="section"><button data-target="#b">B</button><div id="b" class="panel">B</div></div>
      </div></body></html>`;
    const r = await transformer.apply(pkg([{ path: 'p.html', content: fixture }]));
    expect(r.patches).toHaveLength(0);
    expect(r.deferred.some((d) => /nested-script/.test(d.reason))).toBe(true);
  });

  it('declines when section count exceeds the cap', async () => {
    const sections = Array.from({ length: 25 }, (_, i) =>
      `<div class="section"><button data-target="#p${i}">T${i}</button><div id="p${i}" class="panel">B${i}</div></div>`
    ).join('');
    const fixture = `<!doctype html><html><body><div class="accordion">${sections}</div></body></html>`;
    const r = await transformer.apply(pkg([{ path: 'p.html', content: fixture }]));
    expect(r.patches).toHaveLength(0);
    expect(r.deferred.some((d) => /too-many-sections/.test(d.reason))).toBe(true);
  });

  it('declines when an outbound anchor points at an accordion panel id (hash open)', async () => {
    const fixture = `<!doctype html><html><body>
<a href="#s2" class="jump-link">Jump to second</a>
<div class="accordion">
  <div class="section"><button aria-controls="s1">One</button><div id="s1" class="panel">First</div></div>
  <div class="section"><button aria-controls="s2">Two</button><div id="s2" class="panel">Second</div></div>
</div></body></html>`;
    const r = await transformer.apply(pkg([{ path: 'p.html', content: fixture }]));
    expect(r.patches).toHaveLength(0);
    expect(r.deferred.some((d) => /hash-open-behaviour/.test(d.reason))).toBe(true);
  });

  it('declines when the audit findings list does not match', async () => {
    const input = {
      bypassAuditGate: false,
      findings: [],
      files: [{ path: 'p.html', isHtml: true, content: ACC_FIXTURE }]
    };
    expect(transformer.canTransform(input)).toBe(false);
    const r = await transformer.apply(input);
    expect(r.patches).toHaveLength(0);
    expect(r.deferred.some((d) => /no-matching-finding/.test(d.reason))).toBe(true);
  });
});

describe('widget-replacement-accordion — multi-pattern page', () => {
  it('one Transform with two patches for two accordions', async () => {
    const acc = (n, p) => `<div class="accordion">
      <div class="section"><button aria-controls="${p}1">${n}-A</button><div id="${p}1" class="panel">${n}-A body</div></div>
      <div class="section"><button aria-controls="${p}2">${n}-B</button><div id="${p}2" class="panel">${n}-B body</div></div>
    </div>`;
    const fixture = `<!doctype html><html><body>${acc('one', 'a')}<hr>${acc('two', 'b')}</body></html>`;
    const { result } = await applyAndRevert(pkg([{ path: 'p.html', content: fixture }]));
    expect(result.patches).toHaveLength(2);
    expect(result.transform.scope.files).toEqual(['p.html']);
  });
});

describe('widget-replacement-accordion — round-trip determinism', () => {
  it('apply twice produces identical patches modulo provenance.timestamp', async () => {
    const r1 = await transformer.apply(pkg([{ path: 'p.html', content: ACC_FIXTURE }]));
    const r2 = await transformer.apply(pkg([{ path: 'p.html', content: ACC_FIXTURE }]));
    expect(r1.patches.length).toBe(r2.patches.length);
    for (let i = 0; i < r1.patches.length; i++) {
      expect(r2.patches[i].range).toEqual(r1.patches[i].range);
      expect(r2.patches[i].before).toBe(r1.patches[i].before);
      expect(r2.patches[i].after).toBe(r1.patches[i].after);
    }
  });
});

describe('widget-replacement-accordion — axe baseline', () => {
  it('post-substitution rendered fragment matches the widget axe baseline', async () => {
    const result = await transformer.apply(pkg([{ path: 'p.html', content: ACC_FIXTURE }]));
    expect(result.patches).toHaveLength(1);
    const widgetDir = path.resolve(__dirname, '../../src/widgets/accordion');
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
