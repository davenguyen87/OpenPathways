import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import axe from 'axe-core';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const transformer = require('../../src/transformers/widget-replacement-dialog.js');

const REQUIRED_PATCH_FIELDS = [
  'fixer', 'criterion', 'triage', 'tier', 'confidence', 'provenance',
  'file', 'range', 'before', 'after', 'rationale', 'reversible', 'status'
];

function assertWidgetPatch(patch) {
  for (const f of REQUIRED_PATCH_FIELDS) expect(patch).toHaveProperty(f);
  expect(patch.tier).toBe('full');
  expect(patch.fixer).toBe('widget-replacement-dialog');
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

const DLG_FIXTURE = `<!doctype html>
<html><body>
<button class="open-dialog" data-target="#m1">Open dialog</button>
<div id="m1" class="modal" style="position:fixed;z-index:1000">
  <h2 class="modal-title">Important Notice</h2>
  <div class="modal-body">Please read this carefully before continuing.</div>
  <button class="close" aria-label="Close">X</button>
</div>
</body></html>`;

describe('widget-replacement-dialog — interface', () => {
  it('exposes the documented Transformer interface', () => {
    expect(transformer.id).toBe('widget-replacement-dialog');
    expect(transformer.family).toBe('widget');
    expect(transformer.tier).toBe('full');
    expect(transformer.provenance).toBe('rule-based');
    expect(transformer.criteria).toEqual(['1.3.1', '2.1.1', '2.4.3', '4.1.2']);
    expect(typeof transformer.canTransform).toBe('function');
    expect(typeof transformer.apply).toBe('function');
    expect(typeof transformer.revert).toBe('function');
  });
});

describe('widget-replacement-dialog — happy path', () => {
  it('claims and replaces a div-soup modal; trigger and dialog patches revert byte-identically', async () => {
    const input = pkg([{ path: 'page.html', content: DLG_FIXTURE }]);
    expect(transformer.canTransform(input)).toBe(true);
    const { result } = await applyAndRevert(input);
    // One dialog patch + one trigger patch.
    expect(result.patches.length).toBeGreaterThanOrEqual(1);
    for (const p of result.patches) assertWidgetPatch(p);
    expect(result.transform.requiresCheckpointApproval).toBe(true);
    expect(result.transform.scope.manifestEdited).toBe(false);
    // The dialog patch should produce a role="dialog" element.
    const dialogPatch = result.patches.find((p) => /role="dialog"/.test(p.after));
    expect(dialogPatch).toBeDefined();
  });

  it('rewrites the page-side trigger to a <button> with aria-haspopup and aria-controls', async () => {
    const result = await transformer.apply(pkg([{ path: 'p.html', content: DLG_FIXTURE }]));
    const triggerPatch = result.patches.find((p) => /aria-haspopup="dialog"/.test(p.after));
    expect(triggerPatch).toBeDefined();
    expect(triggerPatch.after).toMatch(/aria-controls="[^"]+-dialog"/);
  });
});

describe('widget-replacement-dialog — IR extraction', () => {
  it('captures title, body, and (where applicable) close-button presence', async () => {
    const result = await transformer.apply(pkg([{ path: 'p.html', content: DLG_FIXTURE }]));
    const dialogPatch = result.patches.find((p) => /role="dialog"/.test(p.after));
    expect(dialogPatch).toBeDefined();
    expect(dialogPatch.after).toContain('Important Notice');
    expect(dialogPatch.after).toContain('Please read this carefully before continuing.');
  });

  it('text-content key (title + body) survives substitution', async () => {
    const result = await transformer.apply(pkg([{ path: 'p.html', content: DLG_FIXTURE }]));
    const dialogPatch = result.patches.find((p) => /role="dialog"/.test(p.after));
    expect(dialogPatch).toBeDefined();
    const stripText = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
    expect(stripText(dialogPatch.after)).toContain('ImportantNotice');
    expect(stripText(dialogPatch.after)).toContain('Pleasereadthiscarefullybeforecontinuing');
  });
});

describe('widget-replacement-dialog — decline rules', () => {
  it('declines when the source dialog hosts a <form>', async () => {
    const fixture = `<!doctype html><html><body>
<a href="#m1" data-target="#m1">Open</a>
<div id="m1" class="modal" style="position:fixed">
  <h2 class="modal-title">T</h2>
  <div class="modal-body"><form><input></form></div>
</div></body></html>`;
    const r = await transformer.apply(pkg([{ path: 'p.html', content: fixture }]));
    const accept = r.patches.find((p) => /role="dialog"/.test(p.after));
    expect(accept).toBeUndefined();
    expect(r.deferred.some((d) => /form-in-source/.test(d.reason))).toBe(true);
  });

  it('declines when nested <script> contains non-trivial logic', async () => {
    const fixture = `<!doctype html><html><body>
<a href="#m1" data-target="#m1">Open</a>
<div id="m1" class="modal" style="position:fixed">
  <h2 class="modal-title">T</h2>
  <div class="modal-body">B<script>function x(){if(true){return 1}}</script></div>
</div></body></html>`;
    const r = await transformer.apply(pkg([{ path: 'p.html', content: fixture }]));
    expect(r.deferred.some((d) => /nested-script/.test(d.reason))).toBe(true);
  });

  it('declines when there are nested modal layers', async () => {
    const fixture = `<!doctype html><html><body>
<a href="#m1" data-target="#m1">Open</a>
<div id="m1" class="modal" style="position:fixed">
  <h2 class="modal-title">T</h2>
  <div class="modal-body">B</div>
  <div class="modal" style="position:fixed">Inner modal</div>
</div></body></html>`;
    const r = await transformer.apply(pkg([{ path: 'p.html', content: fixture }]));
    expect(r.deferred.some((d) => /nested-dialog/.test(d.reason))).toBe(true);
  });

  it('declines when the source uses inert siblings', async () => {
    const fixture = `<!doctype html><html><body>
<div aria-hidden="true">Inert</div>
<div id="m1" class="modal" style="position:fixed">
  <h2 class="modal-title">T</h2>
  <div class="modal-body">B</div>
</div></body></html>`;
    const r = await transformer.apply(pkg([{ path: 'p.html', content: fixture }]));
    expect(r.deferred.some((d) => /inert-siblings/.test(d.reason))).toBe(true);
  });

  it('declines when the source is a viewport takeover with no close affordance', async () => {
    const fixture = `<!doctype html><html><body>
<div id="m1" class="modal" style="position:fixed;width:100vw;height:100vh;top:0;left:0">
  <h2 class="modal-title">Big</h2>
  <div class="modal-body">All the things</div>
</div></body></html>`;
    const r = await transformer.apply(pkg([{ path: 'p.html', content: fixture }]));
    expect(r.deferred.some((d) => /viewport-takeover-no-close/.test(d.reason))).toBe(true);
  });

  it('declines when no audit finding matches', async () => {
    const input = {
      bypassAuditGate: false,
      findings: [],
      files: [{ path: 'p.html', isHtml: true, content: DLG_FIXTURE }]
    };
    expect(transformer.canTransform(input)).toBe(false);
    const r = await transformer.apply(input);
    expect(r.deferred.some((d) => /no-matching-finding/.test(d.reason))).toBe(true);
  });
});

describe('widget-replacement-dialog — multi-pattern page', () => {
  it('one Transform with two dialog patches (plus trigger patches) for two modals', async () => {
    const fixture = `<!doctype html><html><body>
<button data-target="#m1" class="open">Open 1</button>
<button data-target="#m2" class="open">Open 2</button>
<div id="m1" class="modal" style="position:fixed">
  <h2 class="modal-title">First</h2>
  <div class="modal-body">First body</div>
</div>
<div id="m2" class="modal" style="position:fixed">
  <h2 class="modal-title">Second</h2>
  <div class="modal-body">Second body</div>
</div></body></html>`;
    const { result } = await applyAndRevert(pkg([{ path: 'p.html', content: fixture }]));
    const dialogPatches = result.patches.filter((p) => /role="dialog"/.test(p.after));
    expect(dialogPatches).toHaveLength(2);
  });
});

describe('widget-replacement-dialog — round-trip determinism', () => {
  it('apply twice produces identical patches modulo provenance.timestamp', async () => {
    const r1 = await transformer.apply(pkg([{ path: 'p.html', content: DLG_FIXTURE }]));
    const r2 = await transformer.apply(pkg([{ path: 'p.html', content: DLG_FIXTURE }]));
    expect(r1.patches.length).toBe(r2.patches.length);
    for (let i = 0; i < r1.patches.length; i++) {
      expect(r2.patches[i].range).toEqual(r1.patches[i].range);
      expect(r2.patches[i].before).toBe(r1.patches[i].before);
      expect(r2.patches[i].after).toBe(r1.patches[i].after);
    }
  });
});

describe('widget-replacement-dialog — axe baseline', () => {
  it('post-substitution rendered dialog fragment matches the widget axe baseline', async () => {
    const result = await transformer.apply(pkg([{ path: 'p.html', content: DLG_FIXTURE }]));
    const dialogPatch = result.patches.find((p) => /role="dialog"/.test(p.after));
    expect(dialogPatch).toBeDefined();
    const widgetDir = path.resolve(__dirname, '../../src/widgets/dialog');
    const styles = fs.readFileSync(path.join(widgetDir, 'styles.css'), 'utf8');
    const script = fs.readFileSync(path.join(widgetDir, 'script.js'), 'utf8');
    const baseline = JSON.parse(fs.readFileSync(path.join(widgetDir, 'axe-baseline.json'), 'utf8'));

    const fragment = dialogPatch.after;
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
