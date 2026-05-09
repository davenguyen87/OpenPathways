import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import fs from 'node:fs';
import axe from 'axe-core';

const WIDGET_DIR = path.resolve(__dirname, '../../src/widgets/carousel');

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
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Carousel Test</title><style>${styles}</style></head><body>${filledFragment}<script>${script}<\/script></body></html>`;
  return new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
}

const placeholders = {
  carouselLabel: 'Module highlights',
  prevLabel: 'Previous slide',
  nextLabel: 'Next slide',
  'slideId.0': 'slide-1',
  'slideId.1': 'slide-2',
  'slideLabel.0': 'Slide 1 of 2: Welcome',
  'slideLabel.1': 'Slide 2 of 2: Wrap up',
  'slideHTML.0': '<p>First slide content.</p>',
  'slideHTML.1': '<p>Second slide content.</p>'
};

describe('carousel widget', () => {
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

  it('renders the carousel with prev/next controls and slides', () => {
    const doc = dom.window.document;
    const root = doc.querySelector('[data-prism-widget="carousel"]');
    expect(root).toBeTruthy();
    expect(root.classList.contains('prism-widget-carousel')).toBe(true);
    expect(root.getAttribute('aria-roledescription')).toBe('carousel');
    expect(doc.querySelectorAll('[data-prism-slide]').length).toBe(2);
    expect(doc.querySelector('[data-prism-prev]')).toBeTruthy();
    expect(doc.querySelector('[data-prism-next]')).toBeTruthy();
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
    expect(typeof dom.window.PrismWidgets.registerCarousel).toBe('function');
  });

  it('Next button advances to slide 2 and updates status', () => {
    const doc = dom.window.document;
    const next = doc.querySelector('[data-prism-next]');
    const slides = doc.querySelectorAll('[data-prism-slide]');
    expect(slides[0].hasAttribute('hidden')).toBe(false);
    expect(slides[1].hasAttribute('hidden')).toBe(true);
    next.click();
    expect(slides[0].hasAttribute('hidden')).toBe(true);
    expect(slides[1].hasAttribute('hidden')).toBe(false);
    const status = doc.querySelector('[data-prism-status]');
    expect(status.textContent).toContain('2 of 2');
  });

  it('Previous is disabled on first slide; Next is disabled on last', () => {
    const doc = dom.window.document;
    const prev = doc.querySelector('[data-prism-prev]');
    const next = doc.querySelector('[data-prism-next]');
    expect(prev.hasAttribute('disabled')).toBe(true);
    expect(next.hasAttribute('disabled')).toBe(false);
    next.click();
    expect(prev.hasAttribute('disabled')).toBe(false);
    expect(next.hasAttribute('disabled')).toBe(true);
  });

  it('ArrowRight on next button advances slide; ArrowLeft on prev returns', () => {
    const doc = dom.window.document;
    const next = doc.querySelector('[data-prism-next]');
    const prev = doc.querySelector('[data-prism-prev]');
    next.focus();
    next.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })
    );
    const slides = doc.querySelectorAll('[data-prism-slide]');
    expect(slides[1].hasAttribute('hidden')).toBe(false);
    prev.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })
    );
    expect(slides[0].hasAttribute('hidden')).toBe(false);
  });

  it('Home and End keys jump to first/last slide', () => {
    const doc = dom.window.document;
    const next = doc.querySelector('[data-prism-next]');
    next.click();
    next.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })
    );
    const slides = doc.querySelectorAll('[data-prism-slide]');
    expect(slides[0].hasAttribute('hidden')).toBe(false);
    next.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true })
    );
    expect(slides[1].hasAttribute('hidden')).toBe(false);
  });

  it('is idempotent: registering twice does not double-bind navigation', () => {
    const win = dom.window;
    const root = win.document.querySelector('[data-prism-widget="carousel"]');
    win.PrismWidgets.registerCarousel(root);
    win.PrismWidgets.registerCarousel(root);
    const next = win.document.querySelector('[data-prism-next]');
    const slides = win.document.querySelectorAll('[data-prism-slide]');
    next.click();
    expect(slides[1].hasAttribute('hidden')).toBe(false);
    // Status should advance only once per click
    const status = win.document.querySelector('[data-prism-status]');
    expect(status.textContent).toBe('Slide 2 of 2');
  });
});
