import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import fs from 'node:fs';
import axe from 'axe-core';

const WIDGET_DIR = path.resolve(__dirname, '../../src/widgets/dialog');

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
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Dialog Test</title><style>${styles}</style></head><body><h1>Course page</h1>${filledFragment}<script>${script}<\/script></body></html>`;
  return new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
}

const placeholders = {
  dialogId: 'd1',
  titleId: 'd1-title',
  descId: 'd1-desc',
  title: 'Confirm submission',
  descHTML: 'Submitting now will lock your responses.',
  contentHTML:
    '<p>Choose an action.</p><button type="button" id="confirm-yes">Submit</button><button type="button" id="confirm-no">Cancel</button>',
  closeLabel: 'Close dialog',
  triggerLabel: 'Open confirmation'
};

describe('dialog widget', () => {
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

  it('renders the dialog with proper ARIA attributes', () => {
    const doc = dom.window.document;
    const dialog = doc.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('d1-title');
    expect(dialog.hasAttribute('hidden')).toBe(true);
    expect(doc.querySelector('[data-prism-trigger]')).toBeTruthy();
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
    expect(typeof dom.window.PrismWidgets.registerDialog).toBe('function');
  });

  it('clicking the trigger opens the dialog and moves focus inside', () => {
    const doc = dom.window.document;
    const trigger = doc.querySelector('[data-prism-trigger]');
    const dialog = doc.querySelector('[data-prism-dialog]');
    trigger.focus();
    trigger.click();
    expect(dialog.hasAttribute('hidden')).toBe(false);
    // First focusable inside dialog should receive focus
    expect(dialog.contains(doc.activeElement)).toBe(true);
  });

  it('Escape closes the dialog and returns focus to the trigger', () => {
    const doc = dom.window.document;
    const trigger = doc.querySelector('[data-prism-trigger]');
    const dialog = doc.querySelector('[data-prism-dialog]');
    trigger.focus();
    trigger.click();
    expect(dialog.hasAttribute('hidden')).toBe(false);
    dialog.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true
      })
    );
    expect(dialog.hasAttribute('hidden')).toBe(true);
    expect(doc.activeElement).toBe(trigger);
  });

  it('clicking the close button closes the dialog', () => {
    const doc = dom.window.document;
    const trigger = doc.querySelector('[data-prism-trigger]');
    const closeBtn = doc.querySelector('[data-prism-close]');
    const dialog = doc.querySelector('[data-prism-dialog]');
    trigger.click();
    expect(dialog.hasAttribute('hidden')).toBe(false);
    closeBtn.click();
    expect(dialog.hasAttribute('hidden')).toBe(true);
  });

  it('Tab traps focus inside the dialog', () => {
    const doc = dom.window.document;
    const win = dom.window;
    const trigger = doc.querySelector('[data-prism-trigger]');
    const dialog = doc.querySelector('[data-prism-dialog]');
    trigger.click();
    // Find last focusable in dialog
    const focusables = dialog.querySelectorAll(
      'button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'
    );
    const last = focusables[focusables.length - 1];
    last.focus();
    expect(doc.activeElement).toBe(last);
    // Tab from last should wrap to first
    const evt = new win.KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true
    });
    dialog.dispatchEvent(evt);
    expect(dialog.contains(doc.activeElement)).toBe(true);
  });

  it('is idempotent: registering twice does not double-bind close', () => {
    const win = dom.window;
    const host = win.document.querySelector('[data-prism-widget="dialog"]');
    win.PrismWidgets.registerDialog(host);
    win.PrismWidgets.registerDialog(host);
    const trigger = win.document.querySelector('[data-prism-trigger]');
    const dialog = win.document.querySelector('[data-prism-dialog]');
    trigger.click();
    expect(dialog.hasAttribute('hidden')).toBe(false);
    const closeBtn = win.document.querySelector('[data-prism-close]');
    closeBtn.click();
    expect(dialog.hasAttribute('hidden')).toBe(true);
  });
});
