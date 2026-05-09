/*
 * Prism widget: Dialog (modal)
 * APG pattern: Dialog (Modal)
 * Keyboard model:
 *   Tab               - cycles forward through dialog focusables (trapped while open)
 *   Shift + Tab       - cycles backward
 *   Escape            - closes the dialog and returns focus to the trigger
 *   Enter / Space     - activates the focused dialog control
 * Idempotent via data-prism-registered.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') {
    return;
  }
  var ns = (window.PrismWidgets = window.PrismWidgets || {});

  var FOCUSABLE_SELECTOR = [
    'a[href]',
    'area[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]'
  ].join(',');

  function getFocusables(dialog) {
    return Array.prototype.slice
      .call(dialog.querySelectorAll(FOCUSABLE_SELECTOR))
      .filter(function (el) {
        return !el.hasAttribute('hidden') && el.offsetParent !== null
          ? true
          : (el.getAttribute('tabindex') !== null);
      });
  }

  function open(host, state) {
    if (state.open) return;
    state.open = true;
    state.lastFocus = document.activeElement;
    var dialog = host.querySelector('[data-prism-dialog]');
    var backdrop = host.querySelector('[data-prism-backdrop]');
    if (backdrop) backdrop.removeAttribute('hidden');
    if (dialog) {
      dialog.removeAttribute('hidden');
      var focusables = getFocusables(dialog);
      if (focusables.length) {
        focusables[0].focus();
      } else {
        dialog.focus();
      }
    }
  }

  function close(host, state) {
    if (!state.open) return;
    state.open = false;
    var dialog = host.querySelector('[data-prism-dialog]');
    var backdrop = host.querySelector('[data-prism-backdrop]');
    if (backdrop) backdrop.setAttribute('hidden', '');
    if (dialog) dialog.setAttribute('hidden', '');
    if (state.lastFocus && typeof state.lastFocus.focus === 'function') {
      state.lastFocus.focus();
    } else {
      var trigger = host.querySelector('[data-prism-trigger]');
      if (trigger) trigger.focus();
    }
  }

  function trapTab(dialog, event) {
    var focusables = getFocusables(dialog);
    if (!focusables.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    var active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !dialog.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else {
      if (active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  function registerDialog(host) {
    if (!host || host.nodeType !== 1) return;
    if (host.getAttribute('data-prism-registered') === '1') return;
    host.setAttribute('data-prism-registered', '1');

    var trigger = host.querySelector('[data-prism-trigger]');
    var closeBtn = host.querySelector('[data-prism-close]');
    var dialog = host.querySelector('[data-prism-dialog]');
    var backdrop = host.querySelector('[data-prism-backdrop]');
    if (!dialog) return;

    var state = { open: false, lastFocus: null };

    if (trigger) {
      trigger.addEventListener('click', function (event) {
        event.preventDefault();
        open(host, state);
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', function (event) {
        event.preventDefault();
        close(host, state);
      });
    }
    if (backdrop) {
      backdrop.addEventListener('click', function () {
        close(host, state);
      });
    }
    dialog.addEventListener('keydown', function (event) {
      if (!state.open) return;
      if (event.key === 'Escape' || event.key === 'Esc') {
        event.preventDefault();
        close(host, state);
      } else if (event.key === 'Tab') {
        trapTab(dialog, event);
      }
    });
  }

  ns.registerDialog = registerDialog;

  function autoRegister() {
    var roots = document.querySelectorAll('[data-prism-widget="dialog"]');
    Array.prototype.forEach.call(roots, registerDialog);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', autoRegister);
    } else {
      autoRegister();
    }
  }
})();
