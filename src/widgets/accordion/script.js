/*
 * Prism widget: Accordion
 * APG pattern: Disclosure (repeated)
 * Keyboard model:
 *   Enter / Space         - toggle the focused section
 *   ArrowDown / ArrowUp   - move focus between section triggers
 *   Home                  - move focus to first trigger
 *   End                   - move focus to last trigger
 * Idempotent via data-prism-registered.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') {
    return;
  }
  var ns = (window.PrismWidgets = window.PrismWidgets || {});

  function getTriggers(root) {
    return Array.prototype.slice.call(
      root.querySelectorAll('[data-prism-trigger]')
    );
  }

  function panelFor(trigger) {
    var id = trigger.getAttribute('aria-controls');
    if (!id) return null;
    return document.getElementById(id);
  }

  function toggle(trigger) {
    var expanded = trigger.getAttribute('aria-expanded') === 'true';
    var next = !expanded;
    trigger.setAttribute('aria-expanded', next ? 'true' : 'false');
    var panel = panelFor(trigger);
    if (panel) {
      if (next) {
        panel.removeAttribute('hidden');
      } else {
        panel.setAttribute('hidden', '');
      }
    }
  }

  function focusAt(triggers, index) {
    if (!triggers.length) return;
    if (index < 0) index = triggers.length - 1;
    if (index >= triggers.length) index = 0;
    triggers[index].focus();
  }

  function registerAccordion(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.getAttribute('data-prism-registered') === '1') return;
    root.setAttribute('data-prism-registered', '1');

    var triggers = getTriggers(root);
    if (!triggers.length) return;

    triggers.forEach(function (trigger, index) {
      trigger.addEventListener('click', function (event) {
        event.preventDefault();
        toggle(trigger);
      });
      trigger.addEventListener('keydown', function (event) {
        var key = event.key;
        if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
          event.preventDefault();
          toggle(trigger);
        } else if (key === 'ArrowDown') {
          event.preventDefault();
          focusAt(triggers, index + 1);
        } else if (key === 'ArrowUp') {
          event.preventDefault();
          focusAt(triggers, index - 1);
        } else if (key === 'Home') {
          event.preventDefault();
          focusAt(triggers, 0);
        } else if (key === 'End') {
          event.preventDefault();
          focusAt(triggers, triggers.length - 1);
        }
      });
    });
  }

  ns.registerAccordion = registerAccordion;

  function autoRegister() {
    var roots = document.querySelectorAll('[data-prism-widget="accordion"]');
    Array.prototype.forEach.call(roots, registerAccordion);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', autoRegister);
    } else {
      autoRegister();
    }
  }
})();
