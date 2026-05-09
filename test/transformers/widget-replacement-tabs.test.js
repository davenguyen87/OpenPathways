import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import axe from 'axe-core';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const transformer = require('../../src/transformers/widget-replacement-tabs.js');

const REQUIRED_PATCH_FIELDS = [
  'fixer', 'criterion', 'triage', 'tier', 'confidence', 'provenance',
  'file', 'range', 'before', 'after', 'rationale', 'reversible', 'status'
];

function assertWidgetPatch(patch) {
  for (const f of REQUIRED_PATCH_FIELDS) expect(patch).toHaveProperty(f);
  expect(patch.tier).toBe('full');
  expect(patch.triage).toBe('author rework');
  expect(patch.fixer).toBe('widget-replacement-tabs');
  expect(patch.confidence).toBe('likely');
  expect(patch.provenance.source).toBe('rule-based');
  expect(typeof patch.provenance.timestamp).toBe('string');
  expect(patch.reversible).toBe(true);
  expect(patch.status).toBe('applied');
  expect(patch.before).not.toBe(patch.after);
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

const TABS_FIXTURE = `<!doctype html>
<html><body>
<div class="tabs">
  <ul class="tab-list">
    <li><a href="#p1">Intro</a></li>
    <li><a href="#p2">Detail</a></li>
  </ul>
  <div id="p1" class="panel"><p>Apple content</p></div>
  <div id="p2" class="panel"><p>Berry content</p></div>
</div>
</body></html>`;

describe('widget-replacement-tabs — interface', () => {
  it('exposes the documented Transformer interface', () => {
    expect(transformer.id).toBe('widget-replacement-tabs');
    expect(transformer.family).toBe('widget');
    expect(transformer.tier).toBe('full');
    expect(transformer.provenance).toBe('rule-based');
    expect(transformer.triage).toBe('author rework');
    expect(transformer.criteria).toEqual(['1.3.1', '2.1.1', '2.4.3', '4.1.2']);
    expect(transformer.supported).toEqual(['scorm12', 'scorm2004']);
    expect(typeof transformer.canTransform).toBe('function');
    expect(typeof transformer.apply).toBe('function');
    expect(typeof transformer.revert).toBe('function');
  });
});

describe('widget-replacement-tabs — happy path', () => {
  it('claims and replaces a div-soup tabset with patches that revert byte-identically', async () => {
    const input = pkg([{ path: 'page.html', content: TABS_FIXTURE }]);
    expect(transformer.canTransform(input)).toBe(true);
    const { result } = await applyAndRevert(input);
    expect(result.patches).toHaveLength(1);
    assertWidgetPatch(result.patches[0]);
    expect(result.patches[0].before).toMatch(/<div class="tabs">/);
    expect(result.patches[0].after).toMatch(/<div class="prism-widget-tabs"/);
    expect(result.transform.family).toBe('widget');
    expect(result.transform.tier).toBe('full');
    expect(result.transform.requiresCheckpointApproval).toBe(true);
    expect(result.transform.status).toBe('pending-checkpoint');
    expect(result.transform.scope.manifestEdited).toBe(false);
  });
});

describe('widget-replacement-tabs — IR extraction', () => {
  it('captures every label, panel body, and initially-active tab; preserves text content', async () => {
    const input = pkg([{
      path: 'p.html',
      content: `<!doctype html><html><body>
<div class="tabs">
  <ul>
    <li><a href="#x">First Label</a></li>
    <li class="active"><a href="#y">Second Label</a></li>
    <li><a href="#z">Third Label</a></li>
  </ul>
  <div id="x" class="panel">First panel body</div>
  <div id="y" class="panel">Second panel body</div>
  <div id="z" class="panel">Third panel body</div>
</div>
</body></html>`
    }]);
    const result = await transformer.apply(input);
    expect(result.patches).toHaveLength(1);
    const after = result.patches[0].after;
    expect(after).toContain('>First Label<');
    expect(after).toContain('>Second Label<');
    expect(after).toContain('>Third Label<');
    expect(after).toContain('First panel body');
    expect(after).toContain('Second panel body');
    expect(after).toContain('Third panel body');
    // Initially active matches the source's "active" item.
    const m = after.match(/aria-selected="true"\s+tabindex="0"\s+data-prism-tab[^>]*>([^<]+)/);
    expect(m).toBeTruthy();
    expect(m[1].trim()).toBe('Second Label');
  });

  it('text-content hash matches before and after substitution (whitespace-stripped)', async () => {
    const input = pkg([{ path: 'p.html', content: TABS_FIXTURE }]);
    const result = await transformer.apply(input);
    const beforeText = result.patches[0].before.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
    const afterText = result.patches[0].after.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
    expect(afterText).toContain(beforeText);
  });
});

describe('widget-replacement-tabs — decline rules', () => {
  it('declines when the source contains a <form>', async () => {
    const input = pkg([{
      path: 'p.html',
      content: `<!doctype html><html><body><div class="tabs">
        <ul><li><a href="#a">A</a></li><li><a href="#b">B</a></li></ul>
        <div id="a" class="panel"><form><input name="x"></form></div>
        <div id="b" class="panel">B</div></div></body></html>`
    }]);
    const result = await transformer.apply(input);
    expect(result.patches).toHaveLength(0);
    expect(result.deferred.some((d) => /form-in-source/.test(d.reason))).toBe(true);
  });

  it('declines when nested <script> contains non-trivial logic', async () => {
    const input = pkg([{
      path: 'p.html',
      content: `<!doctype html><html><body><div class="tabs">
        <ul><li><a href="#a">A</a></li><li><a href="#b">B</a></li></ul>
        <div id="a" class="panel">A<script>function bind(){if(true){return 1}}bind();</script></div>
        <div id="b" class="panel">B</div></div></body></html>`
    }]);
    const result = await transformer.apply(input);
    expect(result.patches).toHaveLength(0);
    expect(result.deferred.some((d) => /nested-script/.test(d.reason))).toBe(true);
  });

  it('declines when the panel count is less than 2', async () => {
    const input = pkg([{
      path: 'p.html',
      content: `<!doctype html><html><body><div class="tabs">
        <ul><li><a href="#a">A</a></li></ul>
        <div id="a" class="panel">A</div></div></body></html>`
    }]);
    const result = await transformer.apply(input);
    expect(result.patches).toHaveLength(0);
    // signature didn't match (need >= 2 tabs); no deferred either since
    // IR returned null. Either way no substitution happened.
  });

  it('declines when the panel count is greater than 9', async () => {
    const tabs = Array.from({ length: 10 }, (_, i) => `<li><a href="#p${i}">T${i}</a></li>`).join('');
    const panels = Array.from({ length: 10 }, (_, i) => `<div id="p${i}" class="panel">Body${i}</div>`).join('');
    const input = pkg([{
      path: 'p.html',
      content: `<!doctype html><html><body><div class="tabs"><ul>${tabs}</ul>${panels}</div></body></html>`
    }]);
    const result = await transformer.apply(input);
    expect(result.patches).toHaveLength(0);
    expect(result.deferred.some((d) => /too-many-panels/.test(d.reason))).toBe(true);
  });

  it('declines when anchors point off-host (nav-menu pattern)', async () => {
    const input = pkg([{
      path: 'p.html',
      content: `<!doctype html><html><body><div class="tabs">
        <ul><li><a href="https://example.com/a">A</a></li><li><a href="https://example.com/b">B</a></li></ul>
        <div class="panel">A</div><div class="panel">B</div></div></body></html>`
    }]);
    const result = await transformer.apply(input);
    expect(result.patches).toHaveLength(0);
    expect(result.deferred.some((d) => /nav-menu-not-tabset/.test(d.reason))).toBe(true);
  });

  it('declines when tab labels contain interactive form controls', async () => {
    const input = pkg([{
      path: 'p.html',
      content: `<!doctype html><html><body><div class="tabs">
        <ul>
          <li><a href="#a"><input type="checkbox"> A</a></li>
          <li><a href="#b">B</a></li>
        </ul>
        <div id="a" class="panel">A</div>
        <div id="b" class="panel">B</div>
      </div></body></html>`
    }]);
    const result = await transformer.apply(input);
    expect(result.patches).toHaveLength(0);
    expect(result.deferred.some((d) => /mixed-interactive-labels/.test(d.reason))).toBe(true);
  });

  it('declines when no audit finding matches and bypassAuditGate is not set', async () => {
    const input = {
      bypassAuditGate: false,
      findings: [], // empty — no matches
      files: [{ path: 'p.html', isHtml: true, content: TABS_FIXTURE }]
    };
    expect(transformer.canTransform(input)).toBe(false);
    const result = await transformer.apply(input);
    expect(result.patches).toHaveLength(0);
    expect(result.deferred.some((d) => /no-matching-finding/.test(d.reason))).toBe(true);
  });

  it('proceeds when an audit finding for a target criterion exists on the page', async () => {
    const input = {
      bypassAuditGate: false,
      findings: [{ file: 'p.html', criterion: '4.1.2' }],
      files: [{ path: 'p.html', isHtml: true, content: TABS_FIXTURE }]
    };
    expect(transformer.canTransform(input)).toBe(true);
    const result = await transformer.apply(input);
    expect(result.patches).toHaveLength(1);
  });
});

describe('widget-replacement-tabs — multi-pattern page', () => {
  it('produces one Transform with two patches for two tabsets on one page', async () => {
    const tabset = (n, ids) => `<div class="tabs">
      <ul><li><a href="#${ids[0]}">${n}-A</a></li><li><a href="#${ids[1]}">${n}-B</a></li></ul>
      <div id="${ids[0]}" class="panel">${n}-A body</div>
      <div id="${ids[1]}" class="panel">${n}-B body</div>
    </div>`;
    const input = pkg([{
      path: 'p.html',
      content: `<!doctype html><html><body>${tabset('one', ['x1', 'x2'])}<hr>${tabset('two', ['y1', 'y2'])}</body></html>`
    }]);
    const { result } = await applyAndRevert(input);
    expect(result.patches).toHaveLength(2);
    expect(result.transform.scope.files).toEqual(['p.html']);
    expect(result.transform.patchIds).toHaveLength(2);
    for (const p of result.patches) assertWidgetPatch(p);
  });
});

describe('widget-replacement-tabs — round-trip determinism', () => {
  it('apply twice produces identical patches modulo provenance.timestamp', async () => {
    const input = pkg([{ path: 'p.html', content: TABS_FIXTURE }]);
    const r1 = await transformer.apply(input);
    const r2 = await transformer.apply(input);
    expect(r1.patches.length).toBe(r2.patches.length);
    for (let i = 0; i < r1.patches.length; i++) {
      expect(r2.patches[i].range).toEqual(r1.patches[i].range);
      expect(r2.patches[i].before).toBe(r1.patches[i].before);
      expect(r2.patches[i].after).toBe(r1.patches[i].after);
      expect(r2.patches[i].rationale).toBe(r1.patches[i].rationale);
    }
  });
});

describe('widget-replacement-tabs — axe baseline', () => {
  it('post-substitution rendered fragment matches the widget axe baseline', async () => {
    const input = pkg([{ path: 'p.html', content: TABS_FIXTURE }]);
    const result = await transformer.apply(input);
    expect(result.patches).toHaveLength(1);

    const widgetDir = path.resolve(__dirname, '../../src/widgets/tabs');
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
