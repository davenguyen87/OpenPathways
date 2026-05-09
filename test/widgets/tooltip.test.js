import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import fs from 'node:fs';
import axe from 'axe-core';

const WIDGET_DIR = path.resolve(__dirname, '../../src/widgets/tooltip');

function loadTemplate(values) {
  const tmpl = fs.readFileSync(
    path.join(WIDGET_DIR, 'template.html'),
    'utf8'
  );
  return Object.keys(values).reduce(function (acc, key) {
    return acc.split('{{' + key + '}}').join(values[key]);
  }, tmpl);
}

function buildDom(filledFragment) {
  const styles = fs.readFileSync(path.join(WIDGET_DIR, 'styles.css'), 'utf8');
  const script = fs.readFileSync(path.join(WIDGET_DIR, 'script.js'), 'utf8');
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Tooltip Test</title><style>${styles}</style></head><body><h1>Course page</h1><p>Hover for help: ${filledFragment}</p><script>${script}<\/script></body></html>`;
  return new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
}

const placeholders = {
  tooltipId: 'tip-1',
  triggerLabel: 'Why?',
  tipText: 'This score is computed from your last attempt.'
};

describe('tooltip widget', () => {
  let dom;
  let baseline;

  beforeEach(() => {
    baseline = JSON.parse(
      fs.readFileSync(path.join(WIDGET_DIR, 'axe-baseline.json'), 'utf8')
    );
    dom = buildDom(loadTemplate(placeholders));
  });

  afterEach(() => {
    if (dom) dom.window.close();
  });

  it('renders the tooltip trigger with aria-describedby and a hidden bubble', () => {
    const doc = dom.window.document;
    const root = doc.querySelector('[data-prism-widget="tooltip"]');
    expect(root).toBeTruthy();
    expect(root.classList.contains('prism-widget-tooltip')).toBe(true);
    const trigger = doc.querySelector('[data-prism-trigger]');
    expect(trigger.getAttribute('aria-describedby')).toBe('tip-1');
    const bubble = doc.querySelector('[role="tooltip"]');
    expect(bubble).toBeTruthy();
    expect(bubble.hasAttribute('hidden')).toBe(true);
  });

  it('passes its axe baseline (zero violations)', async () => {
    const win = dom.window;
    win.eval(axe.source);
    const results = await win.axe.run(win.document, {
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
    });
    expect(results.violations).toEqual([]);
    expect(baseline.violations).toEqual([]);
  });

  it('exposes the registration function', () => {
    expect(typeof dom.window.PrismWidgets.registerTooltip).toBe('function');
  });

  it('focusing the trigger reveals the tooltip; blurring hides it', () => {
    const doc = dom.window.document;
    const trigger = doc.querySelector('[data-prism-trigger]');
    const bubble = doc.querySelector('[role="tooltip"]');
    expect(bubble.hasAttribute('hidden')).toBe(true);
    trigger.dispatchEvent(new dom.window.FocusEvent('focus'));
    expect(bubble.hasAttribute('hidden')).toBe(false);
    trigger.dispatchEvent(new dom.window.FocusEvent('blur'));
    expect(bubble.hasAttribute('hidden')).toBe(true);
  });

  it('Escape with focus on the trigger hides the tooltip', () => {
    const doc = dom.window.document;
    const trigger = doc.querySelector('[data-prism-trigger]');
    const bubble = doc.querySelector('[role="tooltip"]');
    trigger.dispatchEvent(new dom.window.FocusEvent('focus'));
    expect(bubble.hasAttribute('hidden')).toBe(false);
    trigger.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true
      })
    );
    expect(bubble.hasAttribute('hidden')).toBe(true);
  });

  it('pointerenter/leave toggles the tooltip', () => {
    const doc = dom.window.document;
    const trigger = doc.querySelector('[data-prism-trigger]');
    const bubble = doc.querySelector('[role="tooltip"]');
    trigger.dispatchEvent(new dom.window.Event('pointerenter'));
    expect(bubble.hasAttribute('hidden')).toBe(false);
    trigger.dispatchEvent(new dom.window.Event('pointerleave'));
    expect(bubble.hasAttribute('hidden')).toBe(true);
  });

  it('is idempotent: registering twice does not double-bind show/hide', () => {
    const win = dom.window;
    const root = win.document.querySelector('[data-prism-widget="tooltip"]');
    win.PrismWidgets.registerTooltip(root);
    win.PrismWidgets.registerTooltip(root);
    const trigger = win.document.querySelector('[data-prism-trigger]');
    const bubble = win.document.querySelector('[role="tooltip"]');
    trigger.dispatchEvent(new win.FocusEvent('focus'));
    expect(bubble.hasAttribute('hidden')).toBe(false);
    trigger.dispatchEvent(new win.FocusEvent('blur'));
    expect(bubble.hasAttribute('hidden')).toBe(true);
  });
});
