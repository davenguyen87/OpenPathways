/*
 * Prism widget: Tooltip
 * APG pattern: Tooltip
 * Behavior:
 *   - Tooltip shows on focus and on pointerenter of the trigger.
 *   - Tooltip hides on blur, on pointerleave, and on Escape.
 *   - Tooltip never receives focus and never traps interaction.
 *   - tipText is plain text; the widget refuses to render interactive content
 *     inside the tooltip per APG guidance.
 * Idempotent via data-prism-registered.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') {
    return;
  }
  var ns = (window.PrismWidgets = window.PrismWidgets || {});

  function show(root) {
    var tip = root.querySelector('[data-prism-tip]');
    if (tip) tip.removeAttribute('hidden');
  }

  function hide(root) {
    var tip = root.querySelector('[data-prism-tip]');
    if (tip) tip.setAttribute('hidden', '');
  }

  function registerTooltip(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.getAttribute('data-prism-registered') === '1') return;
    root.setAttribute('data-prism-registered', '1');

    var trigger = root.querySelector('[data-prism-trigger]');
    if (!trigger) return;

    trigger.addEventListener('focus', function () {
      show(root);
    });
    trigger.addEventListener('blur', function () {
      hide(root);
    });
    trigger.addEventListener('pointerenter', function () {
      show(root);
    });
    trigger.addEventListener('pointerleave', function () {
      hide(root);
    });
    trigger.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' || event.key === 'Esc') {
        hide(root);
      }
    });
  }

  ns.registerTooltip = registerTooltip;

  function autoRegister() {
    var roots = document.querySelectorAll('[data-prism-widget="tooltip"]');
    Array.prototype.forEach.call(roots, registerTooltip);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', autoRegister);
    } else {
      autoRegister();
    }
  }
})();
