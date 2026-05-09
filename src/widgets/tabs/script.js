/*
 * Prism widget: Tabs
 * APG pattern: Tabs (manual activation)
 * Keyboard model:
 *   ArrowLeft / ArrowRight  - move focus between tabs (does NOT activate)
 *   Home                    - move focus to first tab
 *   End                     - move focus to last tab
 *   Enter / Space           - activate the focused tab
 * Idempotent: a root with data-prism-registered="1" is skipped on re-call.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') {
    return;
  }
  var ns = (window.PrismWidgets = window.PrismWidgets || {});

  function getTabs(root) {
    return Array.prototype.slice.call(
      root.querySelectorAll('[data-prism-tab]')
    );
  }

  function getPanels(root) {
    return Array.prototype.slice.call(
      root.querySelectorAll('[data-prism-panel]')
    );
  }

  function activate(root, index) {
    var tabs = getTabs(root);
    var panels = getPanels(root);
    if (!tabs.length) return;
    if (index < 0) index = 0;
    if (index >= tabs.length) index = tabs.length - 1;
    for (var i = 0; i < tabs.length; i++) {
      var selected = i === index;
      tabs[i].setAttribute('aria-selected', selected ? 'true' : 'false');
      tabs[i].setAttribute('tabindex', selected ? '0' : '-1');
      if (panels[i]) {
        if (selected) {
          panels[i].removeAttribute('hidden');
        } else {
          panels[i].setAttribute('hidden', '');
        }
      }
    }
  }

  function focusTab(root, index) {
    var tabs = getTabs(root);
    if (!tabs.length) return;
    if (index < 0) index = tabs.length - 1;
    if (index >= tabs.length) index = 0;
    activate(root, index);
    tabs[index].focus();
  }

  function registerTabs(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.getAttribute('data-prism-registered') === '1') return;
    root.setAttribute('data-prism-registered', '1');

    var tabs = getTabs(root);
    if (!tabs.length) return;

    tabs.forEach(function (tab, index) {
      tab.addEventListener('click', function () {
        activate(root, index);
        tab.focus();
      });
      tab.addEventListener('keydown', function (event) {
        var key = event.key;
        if (key === 'ArrowRight') {
          event.preventDefault();
          focusTab(root, index + 1);
        } else if (key === 'ArrowLeft') {
          event.preventDefault();
          focusTab(root, index - 1);
        } else if (key === 'Home') {
          event.preventDefault();
          focusTab(root, 0);
        } else if (key === 'End') {
          event.preventDefault();
          focusTab(root, tabs.length - 1);
        } else if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
          event.preventDefault();
          activate(root, index);
        }
      });
    });
  }

  ns.registerTabs = registerTabs;

  function autoRegister() {
    var roots = document.querySelectorAll('[data-prism-widget="tabs"]');
    Array.prototype.forEach.call(roots, registerTabs);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', autoRegister);
    } else {
      autoRegister();
    }
  }
})();
