import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import fs from 'node:fs';
import axe from 'axe-core';

const WIDGET_DIR = path.resolve(__dirname, '../../src/widgets/accordion');

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
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Accordion Test</title><style>${styles}</style></head><body><h1>Page Title</h1><h2>Section</h2>${filledFragment}<script>${script}<\/script></body></html>`;
  return new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
}

const placeholders = {
  headingLevel: 'h3',
  'headerId.0': 'header-overview',
  'headerId.1': 'header-faq',
  'panelId.0': 'panel-overview',
  'panelId.1': 'panel-faq',
  'headerLabel.0': 'Overview',
  'headerLabel.1': 'Frequently Asked Questions',
  'panelHTML.0': '<p>This module covers compliance basics.</p>',
  'panelHTML.1': '<p>FAQ content here.</p>',
  'expanded.0': 'false',
  'expanded.1': 'false'
};

describe('accordion widget', () => {
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

  it('renders the section structure with disclosure triggers', () => {
    const doc = dom.window.document;
    const root = doc.querySelector('[data-prism-widget="accordion"]');
    expect(root).toBeTruthy();
    expect(root.classList.contains('prism-widget-accordion')).toBe(true);
    expect(doc.querySelectorAll('[data-prism-trigger]').length).toBe(2);
    expect(doc.querySelectorAll('[role="region"]').length).toBe(2);
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
    expect(typeof dom.window.PrismWidgets.registerAccordion).toBe('function');
  });

  it('Enter on a trigger toggles aria-expanded and panel hidden state', () => {
    const doc = dom.window.document;
    const triggers = doc.querySelectorAll('[data-prism-trigger]');
    const panels = doc.querySelectorAll('[role="region"]');
    expect(triggers[0].getAttribute('aria-expanded')).toBe('false');
    expect(panels[0].hasAttribute('hidden')).toBe(true);
    triggers[0].dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true
      })
    );
    expect(triggers[0].getAttribute('aria-expanded')).toBe('true');
    expect(panels[0].hasAttribute('hidden')).toBe(false);
  });

  it('Space toggles closed again', () => {
    const doc = dom.window.document;
    const triggers = doc.querySelectorAll('[data-prism-trigger]');
    triggers[0].click();
    expect(triggers[0].getAttribute('aria-expanded')).toBe('true');
    triggers[0].dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: ' ',
        bubbles: true,
        cancelable: true
      })
    );
    expect(triggers[0].getAttribute('aria-expanded')).toBe('false');
  });

  it('ArrowDown moves focus to the next trigger', () => {
    const doc = dom.window.document;
    const triggers = doc.querySelectorAll('[data-prism-trigger]');
    triggers[0].focus();
    triggers[0].dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    );
    expect(doc.activeElement).toBe(triggers[1]);
  });

  it('ArrowUp from first trigger wraps to the last', () => {
    const doc = dom.window.document;
    const triggers = doc.querySelectorAll('[data-prism-trigger]');
    triggers[0].focus();
    triggers[0].dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })
    );
    expect(doc.activeElement).toBe(triggers[1]);
  });

  it('Home and End jump to first/last trigger', () => {
    const doc = dom.window.document;
    const triggers = doc.querySelectorAll('[data-prism-trigger]');
    triggers[0].focus();
    triggers[0].dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true })
    );
    expect(doc.activeElement).toBe(triggers[1]);
    triggers[1].dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })
    );
    expect(doc.activeElement).toBe(triggers[0]);
  });

  it('is idempotent: registering twice does not double-bind toggle', () => {
    const win = dom.window;
    const root = win.document.querySelector('[data-prism-widget="accordion"]');
    const triggers = win.document.querySelectorAll('[data-prism-trigger]');
    win.PrismWidgets.registerAccordion(root);
    win.PrismWidgets.registerAccordion(root);
    triggers[0].click();
    // Single click should expand once, not toggle-then-toggle-back
    expect(triggers[0].getAttribute('aria-expanded')).toBe('true');
  });
});
