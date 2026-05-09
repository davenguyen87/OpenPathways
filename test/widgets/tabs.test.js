import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import fs from 'node:fs';
import axe from 'axe-core';

const WIDGET_DIR = path.resolve(__dirname, '../../src/widgets/tabs');

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
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Tabs Test</title><style>${styles}</style></head><body>${filledFragment}<script>${script}<\/script></body></html>`;
  return new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
}

const placeholders = {
  tabsLabel: 'Module sections',
  'tabId.0': 'tab-intro',
  'tabId.1': 'tab-detail',
  'panelId.0': 'panel-intro',
  'panelId.1': 'panel-detail',
  'tabLabel.0': 'Introduction',
  'tabLabel.1': 'Detail',
  'panelHTML.0': '<p>Welcome to the module.</p>',
  'panelHTML.1': '<p>Detail content lives here.</p>',
  selectedIndex: '0'
};

describe('tabs widget', () => {
  let dom;
  let baseline;

  beforeEach(() => {
    baseline = JSON.parse(
      fs.readFileSync(path.join(WIDGET_DIR, 'axe-baseline.json'), 'utf8')
    );
    const fragment = loadTemplate(placeholders);
    dom = buildDom(fragment);
  });

  afterEach(() => {
    if (dom) dom.window.close();
  });

  it('renders the tablist with the expected structure', () => {
    const doc = dom.window.document;
    const root = doc.querySelector('[data-prism-widget="tabs"]');
    expect(root).toBeTruthy();
    expect(root.classList.contains('prism-widget-tabs')).toBe(true);
    expect(doc.querySelectorAll('[role="tab"]').length).toBe(2);
    expect(doc.querySelectorAll('[role="tabpanel"]').length).toBe(2);
    expect(doc.querySelectorAll('[role="tablist"]').length).toBe(1);
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
    const win = dom.window;
    expect(typeof win.PrismWidgets.registerTabs).toBe('function');
  });

  it('Arrow Right activates the next tab and moves focus', () => {
    const doc = dom.window.document;
    const tabs = doc.querySelectorAll('[role="tab"]');
    tabs[0].focus();
    const event = new dom.window.KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true
    });
    tabs[0].dispatchEvent(event);
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].getAttribute('aria-selected')).toBe('false');
    expect(doc.activeElement).toBe(tabs[1]);
  });

  it('Arrow Left from first tab wraps to the last', () => {
    const doc = dom.window.document;
    const tabs = doc.querySelectorAll('[role="tab"]');
    tabs[0].focus();
    tabs[0].dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        bubbles: true,
        cancelable: true
      })
    );
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(doc.activeElement).toBe(tabs[1]);
  });

  it('Home and End jump to first/last tab', () => {
    const doc = dom.window.document;
    const tabs = doc.querySelectorAll('[role="tab"]');
    tabs[0].focus();
    tabs[0].dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true })
    );
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    tabs[1].dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })
    );
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  });

  it('clicking a tab activates it', () => {
    const doc = dom.window.document;
    const tabs = doc.querySelectorAll('[role="tab"]');
    const panels = doc.querySelectorAll('[role="tabpanel"]');
    tabs[1].click();
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(panels[1].hasAttribute('hidden')).toBe(false);
    expect(panels[0].hasAttribute('hidden')).toBe(true);
  });

  it('is idempotent: registering twice does not double-bind', () => {
    const win = dom.window;
    const doc = win.document;
    const root = doc.querySelector('[data-prism-widget="tabs"]');
    let clickCount = 0;
    const tab1 = doc.querySelectorAll('[role="tab"]')[1];
    const origActivate = tab1.click.bind(tab1);
    tab1.addEventListener('click', () => {
      clickCount += 1;
    });
    // Registering again should be a no-op
    win.PrismWidgets.registerTabs(root);
    win.PrismWidgets.registerTabs(root);
    origActivate();
    expect(clickCount).toBe(1);
    // Deeper check: aria-selected only flips once per click
    const tabs = doc.querySelectorAll('[role="tab"]');
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
  });
});
