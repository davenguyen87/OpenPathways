/**
 * settings.js — Workspace LLM key management page.
 *
 * Standalone module; no dependency on app.js.
 * Loads the current config on DOMContentLoaded, then wires Save / Test / Delete.
 *
 * CSRF: reads the XSRF-TOKEN cookie (set by the server on every page load in
 * hosted mode) and sends it as the x-csrf-token header on state-changing requests.
 */
(function () {
  'use strict';

  // ─── Element refs ───────────────────────────────────────────────────────────
  var apiKeyInput  = document.getElementById('api-key-input');
  var modelSelect  = document.getElementById('model-select');
  var keyHint      = document.getElementById('api-key-hint');
  var statusArea   = document.getElementById('status-area');
  var saveBtn      = document.getElementById('save-btn');
  var testBtn      = document.getElementById('test-btn');
  var deleteBtn    = document.getElementById('delete-btn');

  // Topbar user/logout (mirrors app.js pattern; optional — page works without auth).
  var topbarUser   = document.getElementById('topbar-user');
  var topbarSettings = document.getElementById('topbar-settings');
  var logoutBtn    = document.getElementById('topbar-logout');

  // ─── CSRF helper ────────────────────────────────────────────────────────────

  function getCsrfToken() {
    // Read XSRF-TOKEN cookie (double-submit cookie pattern used by csrf-csrf).
    try {
      var match = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    } catch (_) { return ''; }
  }

  function csrfHeaders() {
    var token = getCsrfToken();
    return token ? { 'x-csrf-token': token } : {};
  }

  // ─── Status helpers ─────────────────────────────────────────────────────────

  function showStatus(msg, type) {
    // type: 'ok' | 'err' | 'pending'
    statusArea.className = 'status-area status-' + (type || 'pending');
    statusArea.textContent = msg;
  }

  function clearStatus() {
    statusArea.className = 'status-area';
    statusArea.textContent = '';
  }

  function setButtonsDisabled(disabled) {
    saveBtn.disabled   = disabled;
    testBtn.disabled   = disabled;
    deleteBtn.disabled = disabled;
  }

  // ─── Load current config ────────────────────────────────────────────────────

  function loadConfig() {
    fetch('/api/workspace/llm-config', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.hasKey) {
          keyHint.textContent = 'Current key: sk-…' + data.keyLast4;
          if (data.model && modelSelect) {
            // Try to select the stored model.
            var opt = modelSelect.querySelector('option[value="' + data.model + '"]');
            if (opt) modelSelect.value = data.model;
          }
        } else {
          keyHint.textContent = 'No key stored yet.';
        }
      })
      .catch(function () {
        keyHint.textContent = '';
      });
  }

  // ─── Save ────────────────────────────────────────────────────────────────────

  function handleSave() {
    var apiKey = apiKeyInput.value.trim();
    var model  = modelSelect ? modelSelect.value : 'claude-haiku-4-5';

    if (!apiKey) {
      showStatus('Enter an API key before saving.', 'err');
      return;
    }
    if (!apiKey.startsWith('sk-') || apiKey.length < 20) {
      showStatus("API key must start with 'sk-' and be at least 20 characters.", 'err');
      return;
    }

    setButtonsDisabled(true);
    showStatus('Saving…', 'pending');

    fetch('/api/workspace/llm-config', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: Object.assign({ 'Content-Type': 'application/json' }, csrfHeaders()),
      body: JSON.stringify({ provider: 'anthropic', model: model, apiKey: apiKey }),
    })
      .then(function (r) {
        if (r.status === 204) {
          showStatus('✓ Saved', 'ok');
          // Update the hint to show the new last-4.
          var last4 = apiKey.slice(-4);
          keyHint.textContent = 'Current key: sk-…' + last4;
          apiKeyInput.value = '';
        } else {
          return r.json().then(function (body) {
            showStatus('✗ ' + (body.error || 'Save failed'), 'err');
          });
        }
      })
      .catch(function () {
        showStatus('✗ Network error — could not save', 'err');
      })
      .finally(function () {
        setButtonsDisabled(false);
      });
  }

  // ─── Test ────────────────────────────────────────────────────────────────────

  function handleTest() {
    var apiKey = apiKeyInput.value.trim();
    var body = apiKey ? { apiKey: apiKey } : {};

    setButtonsDisabled(true);
    showStatus('Testing…', 'pending');

    fetch('/api/workspace/llm-config/test', {
      method: 'POST',
      credentials: 'same-origin',
      headers: Object.assign({ 'Content-Type': 'application/json' }, csrfHeaders()),
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          showStatus('✓ Test passed (' + data.latencyMs + 'ms)', 'ok');
        } else {
          showStatus('✗ Test failed: ' + (data.error || 'unknown error'), 'err');
        }
      })
      .catch(function () {
        showStatus('✗ Network error — could not test', 'err');
      })
      .finally(function () {
        setButtonsDisabled(false);
      });
  }

  // ─── Delete ──────────────────────────────────────────────────────────────────

  function handleDelete() {
    var confirmed = window.confirm(
      'This will disable LLM features for your workspace. Delete the stored API key?'
    );
    if (!confirmed) return;

    setButtonsDisabled(true);
    showStatus('Removing…', 'pending');

    fetch('/api/workspace/llm-config', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: csrfHeaders(),
    })
      .then(function (r) {
        if (r.status === 204) {
          showStatus('✓ Key removed', 'ok');
          keyHint.textContent = 'No key stored yet.';
          apiKeyInput.value = '';
        } else if (r.status === 404) {
          showStatus('No key was stored.', 'pending');
        } else {
          return r.json().then(function (body) {
            showStatus('✗ ' + (body.error || 'Delete failed'), 'err');
          });
        }
      })
      .catch(function () {
        showStatus('✗ Network error — could not delete', 'err');
      })
      .finally(function () {
        setButtonsDisabled(false);
      });
  }

  // ─── Topbar user / logout (optional hosted-mode wiring) ─────────────────────

  function loadUser() {
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.user) return;
        if (topbarUser) {
          topbarUser.textContent = data.user.email || '';
          topbarUser.classList.remove('hidden');
        }
        if (topbarSettings) topbarSettings.classList.remove('hidden');
        if (logoutBtn) {
          logoutBtn.classList.remove('hidden');
          logoutBtn.addEventListener('click', function () {
            fetch('/api/auth/logout', {
              method: 'POST',
              credentials: 'same-origin',
              headers: csrfHeaders(),
            }).then(function () { window.location.href = '/'; });
          });
        }
      })
      .catch(function () { /* no auth — local mode, ignore */ });
  }

  // ─── Wire up ─────────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    loadConfig();
    loadUser();

    if (saveBtn)   saveBtn.addEventListener('click', handleSave);
    if (testBtn)   testBtn.addEventListener('click', handleTest);
    if (deleteBtn) deleteBtn.addEventListener('click', handleDelete);
  });
})();
