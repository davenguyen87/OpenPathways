/* Prism — three-state theme toggle (Auto / Light / Dark).
   Self-contained, no dependencies. Works on every HTML page that
   includes a #theme-toggle button.

   Behavior:
     - Reads/writes localStorage key 'op-theme': 'light' | 'dark' | absent (auto).
     - Resolves 'auto' against (prefers-color-scheme: dark).
     - Applies two attributes to <html>:
         data-theme       = the resolved theme actually applied ('light' | 'dark')
         data-theme-pref  = the user's preference ('auto' | 'light' | 'dark')
     - Cycles auto → light → dark → auto on click.
     - Updates the button's accessible name on every state change.
     - Live-updates while in 'auto' mode if the OS theme changes.

   A small inline pre-paint script in <head> applies the saved preference
   before paint to avoid a flash. This file re-applies on DOMContentLoaded
   for safety and wires the click handler. */

(function () {
  'use strict';

  var STORAGE_KEY = 'op-theme';
  var html = document.documentElement;

  function readPref() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      return v === 'light' || v === 'dark' ? v : 'auto';
    } catch (_) { return 'auto'; }
  }

  function writePref(pref) {
    try {
      if (pref === 'auto') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, pref);
    } catch (_) { /* private mode etc. */ }
  }

  function resolve(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return window.matchMedia &&
           window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark' : 'light';
  }

  function apply(pref) {
    var resolved = resolve(pref);
    html.setAttribute('data-theme', resolved);
    html.setAttribute('data-theme-pref', pref);
    updateButton(pref);
  }

  function nextPref(p) {
    return p === 'auto' ? 'light' : p === 'light' ? 'dark' : 'auto';
  }

  function announceFor(pref) {
    var current = pref === 'auto' ? 'auto, matches your system'
                : pref === 'light' ? 'light' : 'dark';
    var next = nextPref(pref);
    return 'Theme: ' + current + '. Activate to switch to ' + next + '.';
  }

  function updateButton(pref) {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.setAttribute('aria-label', announceFor(pref));
    btn.title = 'Theme: ' + pref;
  }

  function onClick() {
    var current = readPref();
    var next = nextPref(current);
    writePref(next);
    apply(next);
  }

  // Re-apply on script load (for parity with the inline pre-paint script
  // and to set data-theme-pref if the inline script was unavailable).
  apply(readPref());

  // Wire button when DOM is ready.
  function wire() {
    var btn = document.getElementById('theme-toggle');
    if (btn && !btn._opThemeBound) {
      btn._opThemeBound = true;
      btn.addEventListener('click', onClick);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  // Live-update when OS theme changes and user pref is 'auto'.
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var handler = function () {
      if (readPref() === 'auto') apply('auto');
    };
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else if (mq.addListener) mq.addListener(handler);
  }
})();
