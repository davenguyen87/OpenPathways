/**
 * settings.js — Workspace LLM key management.
 * Standalone; no dependency on app.js.
 * Provider model values: anthropic → bare alias; openrouter → anthropic/<alias>.
 * CSRF: reads XSRF-TOKEN cookie; sends as x-csrf-token on state-changing requests.
 */
(function () {
  'use strict';

  var MODEL_DEFS = {
    anthropic:  [
      { value: 'claude-haiku-4-5',             label: 'claude-haiku-4-5 (default — fast & affordable)' },
      { value: 'claude-sonnet-4-6',            label: 'claude-sonnet-4-6 (balanced)' },
      { value: 'claude-opus-4-7',              label: 'claude-opus-4-7 (most capable)' },
    ],
    openrouter: [
      { value: 'anthropic/claude-haiku-4-5',   label: 'claude-haiku-4-5 (default — fast & affordable)' },
      { value: 'anthropic/claude-sonnet-4-6',  label: 'claude-sonnet-4-6 (balanced)' },
      { value: 'anthropic/claude-opus-4-7',    label: 'claude-opus-4-7 (most capable)' },
    ],
  };

  // ─── Element refs ───────────────────────────────────────────────────────────
  var providerSelect = document.getElementById('provider-select');
  var apiKeyInput    = document.getElementById('api-key-input');
  var modelSelect    = document.getElementById('model-select');
  var keyHint        = document.getElementById('api-key-hint');
  var statusArea     = document.getElementById('status-area');
  var saveBtn        = document.getElementById('save-btn');
  var testBtn        = document.getElementById('test-btn');
  var deleteBtn      = document.getElementById('delete-btn');

  // Topbar user/logout (mirrors app.js pattern; optional — page works without auth).
  var topbarUser     = document.getElementById('topbar-user');
  var topbarSettings = document.getElementById('topbar-settings');
  var logoutBtn      = document.getElementById('topbar-logout');

  // ─── CSRF helper ────────────────────────────────────────────────────────────

  function getCsrfToken() {
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

  // ─── Provider / model sync ───────────────────────────────────────────────────

  // Rebuild <option> elements for provider; restore by preferredValue or prior index.
  function syncModelOptions(provider, preferredValue) {
    if (!modelSelect) return;
    var defs = MODEL_DEFS[provider] || MODEL_DEFS['anthropic'];
    var currentIdx = modelSelect.selectedIndex >= 0 ? modelSelect.selectedIndex : 0;
    modelSelect.innerHTML = '';
    defs.forEach(function (def) {
      var opt = document.createElement('option');
      opt.value = def.value;
      opt.textContent = def.label;
      modelSelect.appendChild(opt);
    });
    if (preferredValue) {
      var matched = modelSelect.querySelector('option[value="' + preferredValue + '"]');
      if (matched) { modelSelect.value = preferredValue; return; }
    }
    modelSelect.selectedIndex = Math.min(currentIdx, defs.length - 1);
  }

  function currentProvider() {
    return providerSelect ? providerSelect.value : 'anthropic';
  }

  // ─── Load current config ────────────────────────────────────────────────────

  function loadConfig() {
    fetch('/api/workspace/llm-config', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.hasKey) {
          keyHint.textContent = 'Current key: sk-…' + data.keyLast4;

          // Select the stored provider first so syncModelOptions uses the right defs.
          if (data.provider && providerSelect) {
            var opt = providerSelect.querySelector('option[value="' + data.provider + '"]');
            if (opt) providerSelect.value = data.provider;
          }

          // Rebuild model options for the stored provider, selecting the stored model.
          syncModelOptions(currentProvider(), data.model || null);
        } else {
          keyHint.textContent = 'No key stored yet.';
          syncModelOptions(currentProvider(), null);
        }
      })
      .catch(function () {
        keyHint.textContent = '';
        syncModelOptions(currentProvider(), null);
      });
  }

  // ─── Save ────────────────────────────────────────────────────────────────────

  function handleSave() {
    var provider = currentProvider();
    var apiKey   = apiKeyInput.value.trim();
    var model    = modelSelect ? modelSelect.value : MODEL_DEFS[provider][0].value;

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
      body: JSON.stringify({ provider: provider, model: model, apiKey: apiKey }),
    })
      .then(function (r) {
        if (r.status === 204) {
          showStatus('✓ Saved', 'ok');
          keyHint.textContent = 'Current key: sk-…' + apiKey.slice(-4);
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
    var apiKey   = apiKeyInput.value.trim();
    var provider = currentProvider();
    // Include provider so /test can use the right engine when testing before save.
    var body = apiKey ? { apiKey: apiKey, provider: provider } : { provider: provider };

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

    // When provider changes, rebuild model options and reset model to Haiku.
    if (providerSelect) {
      providerSelect.addEventListener('change', function () {
        syncModelOptions(currentProvider(), null);
        clearStatus();
      });
    }

    if (saveBtn)   saveBtn.addEventListener('click', handleSave);
    if (testBtn)   testBtn.addEventListener('click', handleTest);
    if (deleteBtn) deleteBtn.addEventListener('click', handleDelete);
  });
})();
