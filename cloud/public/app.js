/**
 * Prism Web — frontend.
 *
 * Vanilla JS. No framework, no bundler. Three views (idle/running/done) plus
 * an error fallback. SSE for progress, fetch for everything else.
 *
 * URL contract:
 *   /            → idle
 *   /job/:id     → bootstrap that job's current state from the server
 *
 * On reload at /job/:id we GET /api/audits/:id; if 404 we drop back to idle
 * with a friendly message (the server may have restarted; jobs are in-memory).
 */

(() => {
  'use strict';

  // -------------------------------------------------------------- helpers
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else if (v != null && v !== false) node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  };

  const setView = (name) => {
    document.querySelectorAll('.view').forEach((v) => {
      v.classList.toggle('hidden', v.dataset.view !== name);
    });
  };

  const toast = (msg) => {
    let node = document.querySelector('.toast');
    if (!node) {
      // role=status + aria-live=polite makes the message announced
      // by screen readers without stealing focus (WCAG 4.1.3).
      node = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(node);
    }
    node.textContent = msg;
    requestAnimationFrame(() => node.classList.add('show'));
    clearTimeout(toast._t);
    toast._t = setTimeout(() => node.classList.remove('show'), 1600);
  };

  const fmtPct = (n) => (n == null ? '—' : `${Math.round(n)}%`);

  // Extract a human-readable string from a server error payload. Tolerates
  // both the legacy `{ error: "string" }` shape and the structured contract
  // `{ error: { code, message, details? } }` (BULK_AUDIT_API.md §6).
  // Without this, `msg = j.error` on a structured error renders as
  // "[object Object]" — exactly the bug we hit on the live site.
  const errorText = (payload, fallback) => {
    if (!payload) return fallback;
    const e = payload.error;
    if (!e) return fallback;
    if (typeof e === 'string') return e;
    if (typeof e === 'object') {
      if (e.message) return e.message;
      if (e.code) return e.code;
    }
    return fallback;
  };

  const stageLabels = {
    'extracting': 'Extracting package',
    'static-checks-start': 'Starting static checks',
    'static-check': 'Static check',
    'dynamic-checks-start': 'Starting dynamic checks (Playwright)',
    'dynamic-page': 'Loading entry page',
    'dynamic-check': 'Dynamic check',
    'dynamic-checks-done': 'Dynamic checks finished',
    'done': 'Done',
  };

  // -------------------------------------------------------------- state
  const state = {
    jobId: null,
    eventSource: null,
    progressTotal: { static: 0, dynamic: 0 },
    progressDone: { static: 0, dynamic: 0 },
  };

  // -------------------------------------------------------------- auth (Phase 9B)
  // serverInfo populated by /api/version on bootstrap. mode === 'hosted'
  // gates the login view and CSRF header; mode === 'local' keeps the SPA
  // working unchanged.
  const auth = {
    mode: null,        // 'local' | 'hosted'
    user: null,        // { id, email } when authenticated
    csrfToken: null,
  };

  // Attach the CSRF header on state-changing requests when authenticated.
  // Wrap window.fetch so existing call sites don't need to change.
  const _origFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (auth.csrfToken) {
      init = init || {};
      const method = (init.method || (typeof input === 'string' ? 'GET' : (input && input.method) || 'GET')).toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        init.headers = new Headers(init.headers || {});
        if (!init.headers.has('X-CSRF-Token')) init.headers.set('X-CSRF-Token', auth.csrfToken);
        // Send same-origin cookies (default for same-origin, but explicit
        // makes intent obvious and hardens against future CORS additions).
        init.credentials = init.credentials || 'same-origin';
      }
    }
    return _origFetch(input, init);
  };

  // -------------------------------------------------------------- routing
  // Filter keys we mirror to the URL on the done view (Phase 8). Kept in
  // sync with filterState so any field added there shows up here.
  const URL_FILTER_KEYS = ['severity', 'criterion', 'file', 'q'];

  function parseLocation() {
    const params = new URLSearchParams(location.search);

    const batchM = location.pathname.match(/^\/batch\/([0-9a-fA-F-]{36})\/?$/);
    if (batchM) return { kind: 'batch', id: batchM[1] };

    const m = location.pathname.match(/^\/job\/([0-9a-fA-F-]{36})\/?$/);
    if (!m) return { kind: 'idle' };

    // Phase 7b: baseline state in the query string. Phase 8: filter state too.
    const baseline = params.get('baseline');
    const filters = {};
    for (const k of URL_FILTER_KEYS) {
      const v = params.get(k);
      if (v) filters[k] = v;
    }
    return {
      kind: 'job',
      id: m[1],
      baseline: baseline && /^[0-9a-fA-F-]{36}$/.test(baseline) ? baseline : null,
      filters,
    };
  }

  function pushJobUrl(id, baselineId) {
    const params = new URLSearchParams();
    if (baselineId) params.set('baseline', baselineId);
    const qs = params.toString();
    const url = `/job/${id}${qs ? '?' + qs : ''}`;
    if (location.pathname + location.search !== url) {
      history.pushState({ jobId: id, baseline: baselineId || null }, '', url);
    }
  }

  function pushBatchUrl(batchId) {
    const url = `/batch/${batchId}`;
    if (location.pathname + location.search !== url) {
      history.pushState({ batchId }, '', url);
    }
  }

  function pushIdleUrl() {
    if (location.pathname !== '/' || location.search) history.pushState({}, '', '/');
  }

  // Phase 8: sync filter UI ↔ URL via replaceState (no new history entry).
  function writeFiltersToUrl() {
    const here = parseLocation();
    if (here.kind !== 'job') return;
    const params = new URLSearchParams(location.search);
    for (const k of URL_FILTER_KEYS) {
      // Map filterState fields onto URL params. filterState.search → ?q=
      const stateKey = k === 'q' ? 'search' : k;
      const v = (filterState[stateKey] || '').trim();
      if (v) params.set(k, v); else params.delete(k);
    }
    const qs = params.toString();
    const url = `${location.pathname}${qs ? '?' + qs : ''}`;
    if (location.pathname + location.search !== url) {
      history.replaceState(history.state, '', url);
    }
  }

  // -------------------------------------------------------------- prefs
  // Persisted in localStorage so returning users don't re-pick every time.
  // Browser is intentionally NOT exposed: runDynamicChecks only accepts
  // chromium today — a dropdown would mislead.
  const PREFS_KEY = 'op-web-prefs.v1';
  // Default concurrency for parallel uploads (Phase 8b). Sequential toggle
  // overrides this to 1 when checked.
  const DEFAULT_CONCURRENCY = 4;
  const DEFAULT_PREFS = { standard: 'wcag22', packageType: 'auto', concurrency: DEFAULT_CONCURRENCY, sequential: false };

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return { ...DEFAULT_PREFS };
      const obj = JSON.parse(raw);
      return { ...DEFAULT_PREFS, ...obj };
    } catch (_) {
      return { ...DEFAULT_PREFS };
    }
  }

  function savePrefs(p) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); }
    catch (_) { /* private mode etc — silently keep in-memory only */ }
  }

  function applyPrefsToForm() {
    const p = loadPrefs();
    const s = document.getElementById('opt-standard');
    const t = document.getElementById('opt-package-type');
    const c = document.getElementById('opt-concurrency');
    const seq = document.getElementById('opt-sequential');
    if (s) s.value = p.standard;
    if (t) t.value = p.packageType;
    if (c) c.value = String(p.concurrency || DEFAULT_CONCURRENCY);
    if (seq) seq.checked = !!p.sequential;
    // When sequential is checked, concurrency input is irrelevant — dim it.
    if (seq && c) {
      const labelEl = document.getElementById('opt-concurrency-label');
      seq.addEventListener('change', () => {
        if (labelEl) labelEl.style.opacity = seq.checked ? '0.4' : '';
      });
      if (seq.checked && labelEl) labelEl.style.opacity = '0.4';
    }
  }

  function readPrefsFromForm() {
    const s = document.getElementById('opt-standard');
    const t = document.getElementById('opt-package-type');
    const c = document.getElementById('opt-concurrency');
    const seq = document.getElementById('opt-sequential');
    const sequential = seq ? seq.checked : false;
    let concurrency = DEFAULT_CONCURRENCY;
    if (!sequential && c) {
      const v = parseInt(c.value, 10);
      if (Number.isFinite(v) && v >= 1 && v <= 8) concurrency = v;
    }
    if (sequential) concurrency = 1;
    return {
      standard: (s && s.value) || DEFAULT_PREFS.standard,
      packageType: (t && t.value) || DEFAULT_PREFS.packageType,
      concurrency,
      sequential,
    };
  }

  // -------------------------------------------------------------- upload
  async function startAuditFromFiles(files) {
    // Filter to .zip only — drag-drop can drop arbitrary files.
    const zips = (files || []).filter((f) => /\.zip$/i.test(f.name));
    if (zips.length === 0) {
      showError('Drop one or more .zip packages.');
      return;
    }
    if (zips.length === 1) return startAuditFromFile(zips[0]);
    return startBatch(zips);
  }

  async function startBatch(files) {
    // Phase 8b: parallel uploader with worker-pool pattern and backpressure.
    // Concurrency is configurable via the "Parallel uploads" option (default 4).
    // Sequential fallback sets concurrency=1. Per-file progress bars update in
    // real time. 429/503 responses pause the worker lane and retry after
    // Retry-After seconds (cap 3 retries, then mark as failed).

    setView('batch');
    const tbody = $('#batch-tbody');
    if (tbody) tbody.innerHTML = '';
    const subtitle = $('#batch-subtitle');
    if (subtitle) subtitle.textContent = 'Preparing batch…';

    const prefs = readPrefsFromForm();
    savePrefs(prefs);

    // Determine engagement ID.
    const engagementId = 'web-' + Date.now();

    // Step 1: Create batch
    let resp;
    try {
      resp = await fetch('/api/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engagementId, count: files.length }),
      });
    } catch (err) {
      showError(`Batch creation failed: ${err.message}`);
      return;
    }
    if (!resp.ok) {
      let msg = `Batch creation failed (HTTP ${resp.status})`;
      try { const j = await resp.json(); msg = errorText(j, msg); } catch (_) {}
      showError(msg);
      return;
    }
    const batchData = await resp.json();
    const batchId = batchData.batchId;
    state.batchId = batchId;
    pushBatchUrl(batchId);

    // Step 2: Seed the batch table with rows for all files (status: uploading, tmp-N job IDs)
    if (tbody) {
      files.forEach((f, idx) => {
        const row = seedBatchRow(f, idx, batchId);
        tbody.appendChild(row);
      });
    }

    // Step 3: Worker-pool parallel uploader.
    // Each "lane" drains the queue independently; lanes pause on 429/503.
    const CONCURRENCY = prefs.concurrency || DEFAULT_CONCURRENCY;
    const uploadQueue = files.map((f, idx) => ({ file: f, index: idx }));
    let completedOrFailed = 0;

    // Returns the next item from the queue, or null if exhausted.
    const dequeue = () => uploadQueue.length > 0 ? uploadQueue.shift() : null;

    // A single lane: drains the queue until empty.
    const runLane = async () => {
      let item;
      while ((item = dequeue()) !== null) {
        const { file, index } = item;
        const rowEl = tbody ? tbody.querySelector(`tr[data-tmp-id="tmp-${index}"]`) : null;
        try {
          await uploadOneFile(file, batchId, index, rowEl, prefs);
        } catch (_) {
          // uploadOneFile marks the row as error internally; swallow here.
        } finally {
          completedOrFailed++;
          updateSubtitle(subtitle, files.length, completedOrFailed);
        }
      }
    };

    // Spawn N lanes and wait for all to drain.
    const lanes = [];
    for (let i = 0; i < CONCURRENCY; i++) lanes.push(runLane());
    await Promise.all(lanes);

    // Step 4: All uploads done (success or final failure); start SSE
    if (subtitle) subtitle.textContent = `All ${files.length} uploaded — auditing…`;
    subscribeBatchEvents(batchId);
  }

  function seedBatchRow(file, index, batchId) {
    const tr = el('tr', { 'data-tmp-id': `tmp-${index}`, 'data-job-id': '' });
    tr.appendChild(el('td', { text: String(index + 1) }));
    tr.appendChild(el('td', { class: 'batch-name', text: file.name }));

    // Status cell: pill + per-file upload progress bar (Phase 8b).
    const statusCell = el('td');
    const uploadProgress = el('div', { class: 'batch-upload-progress' });
    uploadProgress.appendChild(statusPill('uploading'));
    const bar = el('div', { class: 'batch-upload-bar' });
    bar.appendChild(el('div', { class: 'batch-upload-bar-fill' }));
    const pct = el('span', { class: 'batch-upload-pct', text: '0%' });
    uploadProgress.appendChild(bar);
    uploadProgress.appendChild(pct);
    statusCell.appendChild(uploadProgress);
    tr.appendChild(statusCell);

    tr.appendChild(el('td', { class: 'mono', text: '—' }));
    tr.appendChild(el('td', { class: 'mono', text: '—' }));
    tr.appendChild(el('td', {}));

    return tr;
  }

  async function uploadOneFile(file, batchId, index, rowEl, prefs) {
    // Upload a single file with retry budget.
    // - 429 / 503 (queue saturated / worker full): pause for Retry-After seconds
    //   (default 5s) then retry. These are counted in the retry budget.
    // - 4xx other: permanent client error, no retry.
    // - 5xx other / network error: exponential backoff, counted in retry budget.
    // On success (200 or 202), update row with real jobId and return jobId.
    // On final failure, mark row as error.

    const sha256Hex = await computeSha256(file);
    let retries = 0;
    const maxRetries = 3;
    let backoffMs = 1000;

    while (retries < maxRetries) {
      try {
        const result = await uploadFileOnce(file, batchId, sha256Hex, rowEl);
        if (result.success) {
          // HTTP 200 or 202: update row with real jobId, clear progress bar.
          updateBatchRowForUpload(rowEl, index, result.jobId, file.name);
          return result.jobId;
        }
        // 429 / 503: backpressure — pause for Retry-After then retry this file.
        if (result.rateLimited) {
          retries++;
          if (retries < maxRetries) {
            const pauseMs = result.retryAfterMs || 5000;
            await new Promise((res) => setTimeout(res, pauseMs));
          }
          continue;
        }
        // Other 4xx: permanent client error, no retry.
        if (result.clientError) {
          updateBatchRowForError(rowEl, result.error || 'Client error');
          return null;
        }
        // 5xx other: retryable with exponential backoff.
        retries++;
        if (retries < maxRetries) {
          await new Promise((res) => setTimeout(res, backoffMs));
          backoffMs = Math.min(30000, backoffMs * 2);
        }
      } catch (err) {
        // Network error: counts as retryable.
        retries++;
        if (retries < maxRetries) {
          await new Promise((res) => setTimeout(res, backoffMs));
          backoffMs = Math.min(30000, backoffMs * 2);
        }
      }
    }

    // Exhausted retries.
    updateBatchRowForError(rowEl, 'Upload failed after 3 retries');
    return null;
  }

  async function uploadFileOnce(file, batchId, sha256Hex, rowEl) {
    // One XHR attempt. Returns:
    //   { success, jobId }             — HTTP 200 or 202
    //   { rateLimited, retryAfterMs }  — HTTP 429 or 503 (backpressure)
    //   { clientError, error }         — HTTP 4xx other (no retry)
    //   { error }                      — HTTP 5xx / network (retryable)
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      const form = new FormData();
      form.append('package', file);

      // Per-file progress bar: update fill and percentage text.
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && rowEl) {
          const pct = Math.round((e.loaded / e.total) * 100);
          const fill = rowEl.querySelector('.batch-upload-bar-fill');
          const pctEl = rowEl.querySelector('.batch-upload-pct');
          if (fill) fill.style.width = `${pct}%`;
          if (pctEl) pctEl.textContent = `${pct}%`;
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status === 200 || xhr.status === 202) {
          // Clear progress bar to 100% on success.
          if (rowEl) {
            const fill = rowEl.querySelector('.batch-upload-bar-fill');
            const pctEl = rowEl.querySelector('.batch-upload-pct');
            if (fill) fill.style.width = '100%';
            if (pctEl) pctEl.textContent = '100%';
          }
          try {
            const data = JSON.parse(xhr.responseText);
            resolve({ success: true, jobId: data.jobId });
          } catch (_) {
            resolve({ error: 'Invalid response' });
          }
        } else if (xhr.status === 429 || xhr.status === 503) {
          // Backpressure: worker queue saturated. Pause and retry.
          const retryHeader = xhr.getResponseHeader('Retry-After');
          const retryAfterMs = retryHeader ? parseFloat(retryHeader) * 1000 : 5000;
          resolve({ rateLimited: true, retryAfterMs });
        } else if (xhr.status >= 400 && xhr.status < 500) {
          // Other 4xx: client error, no retry.
          let msg = `HTTP ${xhr.status}`;
          try {
            const data = JSON.parse(xhr.responseText);
            msg = errorText(data, msg);
          } catch (_) {}
          resolve({ clientError: true, error: msg });
        } else {
          // 5xx other or unexpected: retryable.
          resolve({ error: `HTTP ${xhr.status}` });
        }
      });

      xhr.addEventListener('error', () => {
        resolve({ error: 'Network error' });
      });

      xhr.addEventListener('abort', () => {
        resolve({ error: 'Upload aborted' });
      });

      xhr.open('POST', `/api/batches/${batchId}/files`);
      xhr.setRequestHeader('X-Content-SHA256', sha256Hex);
      // CSRF: the global window.fetch wrapper auto-injects this header on
      // state-changing fetches, but XMLHttpRequest bypasses that wrapper —
      // so we re-add the header here. Without this, hosted-mode uploads
      // fail with 403 csrf_failed.
      if (auth.csrfToken) xhr.setRequestHeader('X-CSRF-Token', auth.csrfToken);
      xhr.send(form);
    });
  }

  async function computeSha256(file) {
    // Compute SHA256 of file and return as hex string.
    const buf = await file.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', buf);
    const hashArray = Array.from(new Uint8Array(hash));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function updateBatchRowForUpload(rowEl, index, jobId, filename) {
    // Replace tmp-N with real jobId; set status to 'pending'.
    if (!rowEl) return;
    rowEl.setAttribute('data-tmp-id', '');
    rowEl.setAttribute('data-job-id', jobId);
    const statusCell = rowEl.children[2];
    if (statusCell) {
      statusCell.innerHTML = '';
      statusCell.appendChild(statusPill('pending'));
    }
    // nameCell may need update if filename differs
    const nameCell = rowEl.children[1];
    if (nameCell && nameCell.textContent !== filename) {
      nameCell.textContent = filename;
    }
    // Populate the "Open →" link cell now that we have a real jobId. Matches
    // the existing batchRow() pattern: a normal href for accessibility +
    // copy-link, with a click handler that does SPA-style navigation.
    const linkCell = rowEl.children[5];
    if (linkCell && !linkCell.hasChildNodes()) {
      const link = el('a', {
        class: 'btn btn-link', href: `/job/${jobId}`, text: 'Open →',
      });
      link.addEventListener('click', (e) => {
        e.preventDefault();
        history.pushState({ jobId }, '', `/job/${jobId}`);
        bootstrapFromUrl();
      });
      linkCell.appendChild(link);
    }
  }

  function updateBatchRowForError(rowEl, errorMsg) {
    // Mark row as 'error' with a tooltip or visible error.
    if (!rowEl) return;
    const statusCell = rowEl.children[2];
    if (statusCell) {
      statusCell.innerHTML = '';
      const pill = statusPill('error');
      pill.setAttribute('title', errorMsg);
      statusCell.appendChild(pill);
    }
  }

  function updateSubtitle(subtitleEl, total, done) {
    if (!subtitleEl) return;
    if (done < total) {
      subtitleEl.textContent = `Uploading ${total - done} of ${total}…`;
    } else {
      subtitleEl.textContent = `All ${total} uploaded — auditing…`;
    }
  }

  async function startAuditFromFile(file) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      showError('That file is not a .zip — drop a SCORM or AICC package.');
      return;
    }

    setView('running');
    resetRunning(file.name);

    const prefs = readPrefsFromForm();
    savePrefs(prefs);

    const form = new FormData();
    form.append('package', file);
    form.append('standard', prefs.standard);
    form.append('packageType', prefs.packageType);

    let resp;
    try {
      resp = await fetch('/api/audits', { method: 'POST', body: form });
    } catch (err) {
      showError(`Upload failed: ${err.message}`);
      return;
    }

    if (!resp.ok) {
      let msg = `Upload failed (HTTP ${resp.status})`;
      try { const j = await resp.json(); msg = errorText(j, msg); } catch (_) {}
      showError(msg);
      return;
    }

    const data = await resp.json();
    state.jobId = data.jobId;
    activeBaselineId = null;
    pushJobUrl(state.jobId, null);
    subscribe(state.jobId);
  }

  async function startAuditFromSample() {
    setView('running');
    resetRunning('sample.scorm12.zip');
    let resp;
    try {
      resp = await fetch('/api/sample');
    } catch (err) {
      showError(`Could not load sample: ${err.message}`);
      return;
    }
    if (!resp.ok) {
      showError(`Sample fixture not available (HTTP ${resp.status})`);
      return;
    }
    const blob = await resp.blob();
    const file = new File([blob], 'sample.scorm12.zip', { type: 'application/zip' });
    startAuditFromFile(file); // re-uses prefs read inside startAuditFromFile
  }

  // -------------------------------------------------------------- running
  function resetRunning(label) {
    state.progressTotal = { static: 0, dynamic: 0 };
    state.progressDone = { static: 0, dynamic: 0 };
    $('#running-title').textContent = `Auditing ${label}`;
    $('#running-subtitle').textContent = 'Preparing…';
    $('#progress-fill').style.width = '0%';
    const bar = document.getElementById('progress-bar');
    if (bar) bar.setAttribute('aria-valuenow', '0');
    $('#progress-log').innerHTML = '';
  }

  function appendLog(stage, detail) {
    const log = $('#progress-log');
    document.querySelectorAll('.progress-log li.now').forEach((li) => li.classList.remove('now'));
    const label = stageLabels[stage] || stage;
    const line = el('li', { class: 'now' }, [
      el('span', { class: 'stage', text: label }),
      detail ? ` · ${detail}` : '',
    ]);
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  function bumpProgressBar() {
    const total = state.progressTotal.static + state.progressTotal.dynamic;
    const done = state.progressDone.static + state.progressDone.dynamic;
    const pct = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 5;
    $('#progress-fill').style.width = pct + '%';
    const bar = document.getElementById('progress-bar');
    if (bar) bar.setAttribute('aria-valuenow', String(pct));
  }

  function handleProgress(ev) {
    switch (ev.stage) {
      case 'extracting':
        appendLog(ev.stage);
        $('#running-subtitle').textContent = 'Extracting package';
        break;
      case 'static-checks-start':
        state.progressTotal.static = ev.count || 0;
        appendLog(ev.stage, `${ev.count} checks`);
        break;
      case 'static-check':
        state.progressDone.static = ev.index || state.progressDone.static + 1;
        appendLog(ev.stage, `${ev.id} ${ev.name} (${ev.index}/${ev.total})`);
        $('#running-subtitle').textContent = `Static check ${ev.index}/${ev.total}: ${ev.id} ${ev.name}`;
        bumpProgressBar();
        break;
      case 'dynamic-checks-start':
        appendLog(ev.stage);
        $('#running-subtitle').textContent = 'Loading dynamic checks';
        break;
      case 'dynamic-page':
        appendLog(ev.stage, `${ev.path} (${ev.index}/${ev.total})`);
        $('#running-subtitle').textContent = `Loading ${ev.path} in headless Chromium`;
        break;
      case 'dynamic-check':
        if (ev.total && !state.progressTotal.dynamic) state.progressTotal.dynamic = ev.total;
        state.progressDone.dynamic = ev.index || state.progressDone.dynamic + 1;
        appendLog(ev.stage, `${ev.id} ${ev.name} (${ev.index}/${ev.total})`);
        $('#running-subtitle').textContent = `Dynamic check ${ev.index}/${ev.total}: ${ev.id} ${ev.name}`;
        bumpProgressBar();
        break;
      case 'dynamic-checks-done':
        appendLog(ev.stage, ev.skipped ? `skipped — ${ev.reason}` : `${ev.violationCount} violation(s)`);
        break;
      case 'done':
        appendLog(ev.stage, `score ${ev.score}%, ${ev.violationCount} violation(s)`);
        break;
      default:
        appendLog(ev.stage);
    }
  }

  function subscribe(jobId) {
    if (state.eventSource) {
      try { state.eventSource.close(); } catch (_) {}
    }
    const es = new EventSource(`/api/audits/${jobId}/events`);
    state.eventSource = es;

    es.addEventListener('progress', (e) => {
      try { handleProgress(JSON.parse(e.data)); } catch (_) {}
    });
    es.addEventListener('done', () => {
      es.close();
      $('#progress-fill').style.width = '100%';
      const bar = document.getElementById('progress-bar');
      if (bar) bar.setAttribute('aria-valuenow', '100');
      // New audits start unfiltered; the user can opt into a baseline diff.
      loadResult(jobId, null);
    });
    es.addEventListener('error', (e) => {
      // Browser fires 'error' both for protocol errors and our explicit
      // 'event: error' messages; the latter has parseable JSON in e.data.
      let msg = null;
      try { if (e && e.data) { const j = JSON.parse(e.data); msg = errorText(j, null); } } catch (_) {}
      if (msg) {
        es.close();
        showError(`Audit failed: ${msg}`);
      } else if (es.readyState === EventSource.CLOSED) {
        // Connection closed unexpectedly. Fall back to a snapshot poll.
        pollUntilTerminal(jobId);
      }
    });
    es.addEventListener('cancelled', () => {
      es.close();
      // We already navigated away on cancel; this just cleans up if still here.
    });
  }

  async function pollUntilTerminal(jobId) {
    for (let i = 0; i < 600; i++) { // up to 5 minutes at 500ms
      try {
        const r = await fetch(`/api/audits/${jobId}`);
        if (r.status === 404) { showError('This audit is no longer available.'); return; }
        const snap = await r.json();
        if (snap.status === 'done') return loadResult(jobId, null);
        if (snap.status === 'error') return showError(`Audit failed: ${snap.error}`);
        if (snap.status === 'cancelled') return; // user-driven; do nothing
      } catch (_) { /* keep polling */ }
      await new Promise((res) => setTimeout(res, 500));
    }
    showError('Audit is taking unexpectedly long; gave up watching.');
  }

  async function cancelCurrent() {
    if (!state.jobId) return;
    if (state.eventSource) { try { state.eventSource.close(); } catch (_) {} }
    try {
      await fetch(`/api/audits/${state.jobId}/cancel`, { method: 'POST' });
    } catch (_) { /* ignore */ }
    toast('Cancelled');
    state.jobId = null;
    pushIdleUrl();
    setView('idle');
  }

  // -------------------------------------------------------------- results
  let lastReport = null;
  let activeBaselineId = null;
  const filterState = { severity: '', criterion: '', file: '', search: '' };

  async function loadResult(jobId, baselineId) {
    activeBaselineId = baselineId || null;
    const url = baselineId
      ? `/api/audits/${jobId}/report.json?baseline=${encodeURIComponent(baselineId)}`
      : `/api/audits/${jobId}/report.json`;

    let resp;
    try {
      resp = await fetch(url);
    } catch (err) {
      showError(`Could not load report: ${err.message}`);
      return;
    }
    if (!resp.ok) {
      // If the requested baseline is gone, fall back to unfiltered rather
      // than dead-ending. The 404 from the server will be specific to
      // baseline; current-job 404 is handled in bootstrapFromUrl.
      if (baselineId) {
        toast('Baseline unavailable — showing full report');
        pushJobUrl(jobId, null);
        return loadResult(jobId, null);
      }
      showError(`Report unavailable (HTTP ${resp.status})`);
      return;
    }
    const report = await resp.json();
    lastReport = report;
    setView('done');
    renderScorecard(report);
    renderBaselineUI(jobId, report);
    renderFilters(report);
    renderViolations(report);
  }

  function renderScorecard(r) {
    const score = r.score == null ? '—' : `${Math.round(r.score)}%`;
    const passClass = !r.complete ? 'partial' : (r.passed ? '' : 'fail');
    const headline = !r.complete
      ? 'Incomplete audit'
      : (r.passed ? 'All criteria pass' : `${r.summary.totalViolations} violation${r.summary.totalViolations === 1 ? '' : 's'}`);

    const tags = [];
    tags.push(el('span', { class: 'tag', text: `WCAG ${r.wcagVersion}` }));
    tags.push(el('span', { class: 'tag', text: r.packageType || 'unknown' }));
    tags.push(el('span', { class: 'tag', text: `${r.summary.criteriaPassed}/${r.summary.criteriaEvaluated} criteria pass` }));
    if (r.summary.bySeverity.critical) tags.push(el('span', { class: 'tag tag-danger', text: `${r.summary.bySeverity.critical} critical` }));
    if (r.summary.bySeverity.serious) tags.push(el('span', { class: 'tag tag-warn', text: `${r.summary.bySeverity.serious} serious` }));
    if (!r.complete) tags.push(el('span', { class: 'tag tag-warn', text: `incomplete: ${r.incompleteReason || 'unknown'}` }));

    const card = $('#scorecard');
    card.innerHTML = '';
    card.appendChild(el('div', { class: `score-circle ${passClass}`, text: score }));
    const meta = [
      el('div', { class: 'scorecard-headline', text: headline }),
      el('div', { class: 'muted', text: `Audited ${new Date(r.scannedAt).toLocaleString()}` }),
      el('div', { class: 'scorecard-tags' }, tags),
    ];

    // v3: Add scope estimate if present
    if (r.scopeEstimate && r.scopeEstimate.totalHours != null) {
      const hours = Math.round(r.scopeEstimate.totalHours * 10) / 10;
      meta.push(el('div', { class: 'scope-estimate', text: `Estimated remediation effort: ${hours} hrs` }));
    }

    // v3: Add triage rollup if present
    if (r.triage && r.triage.rollup) {
      meta.push(renderTriageRollup(r.triage.rollup));
    }

    card.appendChild(el('div', { class: 'scorecard-meta' }, meta));

    // v3: Render top-3-risks card after scorecard
    if (r.topRisks && (r.topRisks.risks || r.topRisks).length > 0) {
      renderTopRisksCard(r.topRisks);
    }

    // v3: Render section 508 table at the end (will be positioned after violations)
    if (r.section508Table && r.section508Table.length > 0) {
      renderSection508Table(r.section508Table);
    }
  }

  function renderTriageRollup(rollup) {
    const { dominantTag, byTriage } = rollup;
    if (!byTriage) return null;

    const total = Object.values(byTriage).reduce((a, b) => a + b, 0);
    if (total === 0) return null;

    // Canonical tier names with SPACES (matching server-side byTriage keys)
    const TIER_KEYS = ['auto-fix safe', 'auto-fix assisted', 'author rework', 'content rework', 'recommend retire'];
    const tierToClass = (t) => t.replace(/\s+/g, '-');
    const colors = { 'auto-fix safe': '--ok', 'auto-fix assisted': '--ok', 'author rework': '--moderate', 'content rework': '--serious', 'recommend retire': '--critical' };

    const segments = [];
    for (const tier of TIER_KEYS) {
      const count = byTriage[tier] || 0;
      if (count > 0) {
        const pct = (count / total) * 100;
        const colorVar = colors[tier] || '--moderate';
        const classFrag = tierToClass(tier);
        segments.push(el('div', { class: `triage-segment triage-${classFrag}`, style: `flex: ${pct}%; background-color: var(${colorVar});`, title: `${tier}: ${count}` }));
      }
    }

    if (segments.length === 0) return null;

    return el('div', { class: 'triage-rollup' }, [
      el('div', { class: 'triage-label', text: 'Triage distribution:' }),
      el('div', { class: 'triage-bar' }, segments),
    ]);
  }

  function renderTopRisksCard(topRisksData) {
    const risks = topRisksData.risks || (Array.isArray(topRisksData) ? topRisksData : []);
    if (risks.length === 0) return;

    const scorecard = $('#scorecard');
    const card = el('div', { class: 'v3-card top-risks-card' });

    const title = el('h2', { class: 'v3-card-title', text: 'Top 3 Risks' });
    card.appendChild(title);

    if (topRisksData.fallback === true && topRisksData.fallbackMessage) {
      const note = el('p', { class: 'v3-fallback-note', text: topRisksData.fallbackMessage });
      card.appendChild(note);
    }

    const riskList = el('ul', { class: 'top-risks-list' });
    risks.slice(0, 3).forEach((risk, idx) => {
      const item = el('li', { class: 'risk-item' }, [
        el('span', { class: 'risk-rank', text: `${idx + 1}` }),
        el('span', { class: 'risk-criterion', text: risk.criterion || '?' }),
        el('span', { class: 'risk-name', text: risk.criterionName || 'Unknown' }),
        el('span', { class: `risk-severity sev-${risk.severity || 'minor'}`, text: (risk.severity || '').toUpperCase() }),
        el('span', { class: 'risk-count', text: `${risk.packageCount || 0} pkg${risk.packageCount === 1 ? '' : 's'}` }),
      ]);
      riskList.appendChild(item);
    });
    card.appendChild(riskList);

    scorecard.appendChild(card);
  }

  function renderSection508Table(section508Data) {
    if (!section508Data || section508Data.length === 0) return;

    const results = $('#results');
    if (!results) return;

    const container = el('div', { class: 'v3-section508-container' });
    container.appendChild(el('h2', { class: 'v3-section-title', text: 'Section 508 Mapping' }));

    const table = el('table', { class: 'section508-table' });
    const thead = el('thead');
    const headerRow = el('tr');
    headerRow.appendChild(el('th', { scope: 'col', text: '508 Reference' }));
    headerRow.appendChild(el('th', { scope: 'col', text: 'Title' }));
    headerRow.appendChild(el('th', { scope: 'col', text: 'Findings' }));
    headerRow.appendChild(el('th', { scope: 'col', text: 'Mapped WCAG Criteria' }));
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const row of section508Data) {
      const tr = el('tr');
      tr.appendChild(el('td', { text: row.reference || '—' }));
      tr.appendChild(el('td', { text: row.refTitle || '—' }));
      tr.appendChild(el('td', { text: String(row.findingCount || 0) }));
      const criteriaText = (row.criterionIds && Array.isArray(row.criterionIds)) ? row.criterionIds.join(', ') : '—';
      tr.appendChild(el('td', { text: criteriaText }));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    container.appendChild(table);
    results.appendChild(container);
  }

  function renderFilters(r) {
    const criteria = Array.from(new Set(r.violations.map((v) => v.criterion))).sort();
    const files = Array.from(new Set(r.violations.map((v) => v.file))).sort();

    const sevSel = el('select', { id: 'f-severity', onchange: (e) => { filterState.severity = e.target.value; writeFiltersToUrl(); renderViolations(lastReport); } }, [
      el('option', { value: '', text: 'all' }),
      el('option', { value: 'critical', text: 'critical' }),
      el('option', { value: 'serious', text: 'serious' }),
      el('option', { value: 'moderate', text: 'moderate' }),
      el('option', { value: 'minor', text: 'minor' }),
    ]);
    sevSel.value = filterState.severity || '';
    const critSel = el('select', { id: 'f-criterion', onchange: (e) => { filterState.criterion = e.target.value; writeFiltersToUrl(); renderViolations(lastReport); } });
    critSel.appendChild(el('option', { value: '', text: 'all' }));
    for (const c of criteria) critSel.appendChild(el('option', { value: c, text: c }));
    critSel.value = filterState.criterion || '';

    const fileSel = el('select', { id: 'f-file', onchange: (e) => { filterState.file = e.target.value; writeFiltersToUrl(); renderViolations(lastReport); } });
    fileSel.appendChild(el('option', { value: '', text: 'all' }));
    for (const f of files) fileSel.appendChild(el('option', { value: f, text: f }));
    fileSel.value = filterState.file || '';

    const search = el('input', {
      id: 'f-search', type: 'search', placeholder: 'Search messages…',
      value: filterState.search || '',
      oninput: (e) => { filterState.search = e.target.value; writeFiltersToUrl(); renderViolations(lastReport); },
    });

    const counts = el('span', { class: 'filter-counts', id: 'filter-counts' });

    const filters = $('#filters');
    filters.innerHTML = '';
    filters.appendChild(el('label', {}, [el('span', { text: 'Severity' }), sevSel]));
    filters.appendChild(el('label', {}, [el('span', { text: 'Criterion' }), critSel]));
    filters.appendChild(el('label', {}, [el('span', { text: 'File' }), fileSel]));
    filters.appendChild(el('label', {}, [el('span', { text: 'Search' }), search]));
    filters.appendChild(counts);
  }

  function applyFilters(violations) {
    const q = filterState.search.trim().toLowerCase();
    return violations.filter((v) => {
      if (filterState.severity && v.severity !== filterState.severity) return false;
      if (filterState.criterion && v.criterion !== filterState.criterion) return false;
      if (filterState.file && v.file !== filterState.file) return false;
      if (q) {
        const hay = `${v.message} ${v.file} ${v.criterion} ${v.criterionName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderViolations(r) {
    const root = $('#results');
    root.innerHTML = '';

    const filtered = applyFilters(r.violations);
    const counts = $('#filter-counts');
    if (counts) counts.textContent = `${filtered.length} of ${r.violations.length} violation${r.violations.length === 1 ? '' : 's'}`;

    if (filtered.length === 0) {
      root.appendChild(el('div', { class: 'empty-state', text: r.violations.length === 0
        ? 'No violations found.'
        : 'No violations match the current filters.' }));
      return;
    }

    // Group by criterion (preserves the report's pre-sorted ordering inside each group)
    const groups = new Map();
    for (const v of filtered) {
      if (!groups.has(v.criterion)) groups.set(v.criterion, { name: v.criterionName, items: [] });
      groups.get(v.criterion).items.push(v);
    }

    for (const [crit, { name, items }] of groups) {
      const body = el('div', { class: 'criterion-body' });
      for (const v of items) body.appendChild(violationNode(v));

      const summaryBtn = el('button', { class: 'criterion-summary', type: 'button' }, [
        el('span', { class: 'chev', text: '▶' }),
        el('span', { class: 'criterion-id', text: crit }),
        el('span', { class: 'criterion-name', text: name }),
        el('span', { class: 'criterion-count', text: `${items.length}` }),
      ]);
      const group = el('div', { class: 'criterion-group open' }, [summaryBtn, body]);
      summaryBtn.addEventListener('click', () => group.classList.toggle('open'));
      root.appendChild(group);
    }
  }

  function violationNode(v) {
    const head = el('div', { class: 'violation-head' }, [
      el('span', { class: `severity severity-${v.severity}`, text: v.severity }),
      el('span', { class: 'violation-file', text: `${v.file}${v.line ? ':' + v.line : ''}` }),
      v.sco ? el('span', { class: 'tag', text: `SCO ${v.sco.id}` }) : null,
      v.confidence === 'heuristic' ? el('span', { class: 'tag', text: 'heuristic' }) : null,
    ]);

    const actions = el('div', { class: 'violation-actions' }, [
      el('button', {
        class: 'btn btn-secondary', type: 'button',
        onclick: () => copyAsMarkdown(v),
        text: 'Copy as Markdown',
      }),
      v.url
        ? el('a', { class: 'btn btn-link', href: v.url, target: '_blank', rel: 'noopener', text: 'WCAG ref ↗' })
        : null,
    ]);

    return el('div', { class: 'violation' }, [
      head,
      el('p', { class: 'violation-message', text: v.message }),
      v.snippet ? el('pre', { class: 'violation-snippet', text: v.snippet }) : null,
      actions,
    ]);
  }

  function copyAsMarkdown(v) {
    const md =
      `**${v.criterion} ${v.criterionName}** — _${v.severity}_\n` +
      `\`${v.file}${v.line ? ':' + v.line : ''}\`\n\n` +
      `${v.message}\n\n` +
      (v.snippet ? '```html\n' + v.snippet + '\n```\n' : '') +
      (v.url ? `[WCAG reference](${v.url})\n` : '');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(md).then(
        () => toast('Copied to clipboard'),
        () => fallbackCopy(md)
      );
    } else {
      fallbackCopy(md);
    }
  }

  function fallbackCopy(text) {
    const ta = el('textarea', {}, []);
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Copied to clipboard'); }
    catch (_) { toast('Copy failed'); }
    finally { document.body.removeChild(ta); }
  }

  // -------------------------------------------------------------- baseline (Phase 7b)
  // Cached list of completed audits used to populate the "Compare against"
  // dropdown on the done view. Refreshed each time the done view is shown.
  let recentDoneJobs = [];

  async function renderBaselineUI(currentJobId, report) {
    const sel = document.getElementById('baseline-select');
    const banner = document.getElementById('baseline-banner');
    if (!sel || !banner) return;

    // Populate dropdown from /api/audits filtered to status=done & not the
    // currently-displayed job. The list mirrors what the recent panel shows.
    try {
      const resp = await fetch('/api/audits');
      const data = resp.ok ? await resp.json() : { jobs: [] };
      recentDoneJobs = (data.jobs || []).filter((j) => j.status === 'done' && j.id !== currentJobId);
    } catch (_) {
      recentDoneJobs = [];
    }

    sel.innerHTML = '';
    sel.appendChild(el('option', { value: '', text: '— none —' }));
    for (const j of recentDoneJobs) {
      const when = new Date(j.createdAt).toLocaleString();
      const label = `${j.originalName || `(job ${j.id.slice(0, 8)})`} · ${when}`;
      const opt = el('option', { value: j.id, text: label });
      if (activeBaselineId && j.id === activeBaselineId) opt.setAttribute('selected', '');
      sel.appendChild(opt);
    }
    sel.value = activeBaselineId || '';

    // Banner reflects whatever the server sent back (authoritative).
    if (report.baselineMeta) {
      const m = report.baselineMeta;
      const name = m.originalName || `(job ${m.id.slice(0, 8)})`;
      banner.innerHTML = '';
      banner.appendChild(el('span', {
        text: `Comparing against ${name} — ${m.filteredOut} violation${m.filteredOut === 1 ? '' : 's'} from baseline filtered out`,
      }));
      banner.appendChild(el('button', {
        class: 'btn btn-link',
        type: 'button',
        text: 'Clear comparison',
        onclick: () => clearBaseline(currentJobId),
      }));
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
      banner.innerHTML = '';
    }

    sel.onchange = () => {
      const newId = sel.value || null;
      pushJobUrl(currentJobId, newId);
      loadResult(currentJobId, newId);
    };
  }

  function clearBaseline(jobId) {
    pushJobUrl(jobId, null);
    loadResult(jobId, null);
  }

  // -------------------------------------------------------------- preview-fixes (Phase 7a)
  async function openFixModal() {
    if (!state.jobId) return;
    const modal = document.getElementById('fix-modal');
    const body = document.getElementById('fix-modal-body');
    const apply = document.getElementById('fix-modal-apply');
    if (!modal || !body || !apply) return;

    body.innerHTML = '';
    body.appendChild(el('p', { class: 'muted', text: 'Loading proposed fixes…' }));
    apply.setAttribute('disabled', '');
    showModal(modal);

    let resp;
    try {
      resp = await fetch(`/api/audits/${state.jobId}/fix?dry-run=true`, { method: 'POST' });
    } catch (err) {
      renderFixModalError(`Could not preview fixes: ${err.message}`);
      return;
    }

    if (!resp.ok) {
      let msg = `Preview failed (HTTP ${resp.status})`;
      try { const j = await resp.json(); msg = errorText(j, msg); } catch (_) {}
      renderFixModalError(msg);
      return;
    }

    const data = await resp.json();
    renderFixModalBody(data);
    if ((data.applied || []).length > 0) apply.removeAttribute('disabled');
  }

  function renderFixModalBody(data) {
    const body = document.getElementById('fix-modal-body');
    body.innerHTML = '';

    const applied = data.applied || [];
    const skipped = data.skipped || 0;

    if (applied.length === 0) {
      body.appendChild(el('p', { text: 'No auto-fixable violations were found in this audit.' }));
      if (skipped > 0) body.appendChild(el('p', { class: 'muted', text: `${skipped} violation${skipped === 1 ? '' : 's'} require manual review.` }));
      return;
    }

    const summary = el('p', { class: 'muted' }, [
      `${applied.length} fix${applied.length === 1 ? '' : 'es'} ready to apply`,
      skipped > 0 ? `, ${skipped} skipped` : '',
      '. Applying creates a new audit job on the fixed package.',
    ]);
    body.appendChild(summary);

    // Group applied fixes by file.
    const byFile = new Map();
    for (const f of applied) {
      if (!byFile.has(f.file)) byFile.set(f.file, []);
      byFile.get(f.file).push(f);
    }

    for (const [file, items] of byFile) {
      const group = el('div', { class: 'fix-group' });
      group.appendChild(el('h3', { class: 'fix-file', text: file }));
      const ul = el('ul', { class: 'fix-list' });
      for (const f of items) {
        ul.appendChild(el('li', { class: 'fix-item' }, [
          el('span', { class: 'criterion-id', text: f.criterion || '' }),
          el('span', { class: 'fix-line', text: f.line ? `line ${f.line}` : '' }),
          el('span', { class: 'fix-message', text: f.message || '' }),
          el('span', { class: 'tag', text: f.fixerId || '' }),
        ]));
      }
      group.appendChild(ul);
      body.appendChild(group);
    }
  }

  function renderFixModalError(msg) {
    const body = document.getElementById('fix-modal-body');
    body.innerHTML = '';
    body.appendChild(el('p', { class: 'fix-error', text: msg }));
  }

  async function applyFixesAndReaudit() {
    if (!state.jobId) return;
    const apply = document.getElementById('fix-modal-apply');
    apply.setAttribute('disabled', '');
    apply.textContent = 'Applying…';

    let resp;
    try {
      resp = await fetch(`/api/audits/${state.jobId}/fix`, { method: 'POST' });
    } catch (err) {
      apply.removeAttribute('disabled');
      apply.textContent = 'Apply & re-audit';
      renderFixModalError(`Apply failed: ${err.message}`);
      return;
    }

    if (!resp.ok) {
      apply.removeAttribute('disabled');
      apply.textContent = 'Apply & re-audit';
      let msg = `Apply failed (HTTP ${resp.status})`;
      try { const j = await resp.json(); msg = errorText(j, msg); } catch (_) {}
      renderFixModalError(msg);
      return;
    }

    const data = await resp.json();
    closeFixModal();
    if (data.jobId) {
      // Navigate to the new job; bootstrap will render its running state.
      history.pushState({ jobId: data.jobId }, '', `/job/${data.jobId}`);
      bootstrapFromUrl();
    }
  }

  function showModal(modal) {
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
  }

  function closeFixModal() {
    const modal = document.getElementById('fix-modal');
    const apply = document.getElementById('fix-modal-apply');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    if (apply) {
      apply.removeAttribute('disabled');
      apply.textContent = 'Apply & re-audit';
    }
  }

  // -------------------------------------------------------------- batch view (Phase 8)
  let batchEventSource = null;

  async function loadBatchView(batchId) {
    setView('batch');
    state.batchId = batchId;

    let resp;
    try { resp = await fetch(`/api/batches/${batchId}`); }
    catch (err) { showError(`Could not load batch: ${err.message}`); return; }
    if (resp.status === 404) { showError('Batch not found.'); return; }
    if (!resp.ok) { showError(`Batch unavailable (HTTP ${resp.status})`); return; }

    const data = await resp.json();
    const jobsList = data.jobs || [];
    const subtitle = $('#batch-subtitle');
    if (subtitle) subtitle.textContent = `${jobsList.length} job${jobsList.length === 1 ? '' : 's'}`;
    renderBatchTable(jobsList);

    // If everything is already terminal we don't need an SSE; the table is
    // a static view.
    const anyLive = jobsList.some((j) => j.status === 'pending' || j.status === 'running');
    if (anyLive) subscribeBatchEvents(batchId);
  }

  function renderBatchTable(jobsList) {
    const tbody = $('#batch-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    jobsList.forEach((j, i) => tbody.appendChild(batchRow(j, i + 1)));
  }

  function batchRow(j, n) {
    const tr = el('tr', { 'data-job-id': j.id });
    tr.appendChild(el('td', { text: String(n) }));
    tr.appendChild(el('td', {
      class: 'batch-name',
      text: j.filename || j.originalName || `(job ${j.id.slice(0, 8)})`,
    }));

    const statusCell = el('td');
    statusCell.appendChild(statusPill(j.status));
    tr.appendChild(statusCell);

    const score = (j.summary && j.summary.score != null) ? `${Math.round(j.summary.score)}%` : '—';
    tr.appendChild(el('td', { class: 'mono', text: score }));

    const violations = (j.summary && j.summary.totalViolations != null)
      ? String(j.summary.totalViolations) : '—';
    tr.appendChild(el('td', { class: 'mono', text: violations }));

    const link = el('a', {
      class: 'btn btn-link', href: `/job/${j.id}`, text: 'Open →',
    });
    link.addEventListener('click', (e) => {
      e.preventDefault();
      history.pushState({ jobId: j.id }, '', `/job/${j.id}`);
      bootstrapFromUrl();
    });
    tr.appendChild(el('td', {}, [link]));

    return tr;
  }

  function statusPill(status) {
    const cls = status === 'done' ? 'ok' : (status === 'error' || status === 'cancelled') ? 'fail' : 'run';
    return el('span', { class: `recent-badge ${cls}`, text: status });
  }

  function updateBatchRow(jobId, patch) {
    const tbody = $('#batch-tbody');
    if (!tbody) return;
    const row = tbody.querySelector(`tr[data-job-id="${jobId}"]`);
    if (!row) return;
    if (patch.filename) {
      const nameCell = row.children[1];
      if (nameCell) nameCell.textContent = patch.filename;
    }
    if (patch.status) {
      const statusCell = row.children[2];
      if (statusCell) {
        statusCell.innerHTML = '';
        statusCell.appendChild(statusPill(patch.status));
      }
    }
    if (patch.summary) {
      const scoreCell = row.children[3];
      const violCell = row.children[4];
      if (scoreCell && patch.summary.score != null) scoreCell.textContent = `${Math.round(patch.summary.score)}%`;
      if (violCell && patch.summary.totalViolations != null) violCell.textContent = String(patch.summary.totalViolations);
    }
  }

  function subscribeBatchEvents(batchId) {
    if (batchEventSource) {
      try { batchEventSource.close(); } catch (_) {}
    }
    const es = new EventSource(`/api/batches/${batchId}/events`);
    batchEventSource = es;
    // The server emits an initial 'batch' event with the full job list — we
    // already loaded that via /api/batches/:id, so we ignore it here.
    // Event schema is documented in docs/BULK_AUDIT_API.md §4.
    es.addEventListener('batch', () => {});
    es.addEventListener('file.uploaded', (e) => {
      try {
        const d = JSON.parse(e.data);
        // A new job entered the batch (the SSE handler polls for late-added
        // jobs). Refresh the row in case the page wasn't showing it yet.
        updateBatchRow(d.jobId, { status: 'pending', filename: d.filename });
      } catch (_) {}
    });
    es.addEventListener('file.queued', (e) => {
      try {
        const d = JSON.parse(e.data);
        updateBatchRow(d.jobId, { status: 'pending' });
      } catch (_) {}
    });
    es.addEventListener('file.running', (e) => {
      try {
        const d = JSON.parse(e.data);
        updateBatchRow(d.jobId, { status: 'running' });
      } catch (_) {}
    });
    es.addEventListener('file.done', (e) => {
      try {
        const d = JSON.parse(e.data);
        updateBatchRow(d.jobId, {
          status: 'done',
          summary: { score: d.score, totalViolations: d.totalViolations, passed: d.passed },
        });
      } catch (_) {}
    });
    es.addEventListener('file.failed', (e) => {
      try {
        const d = JSON.parse(e.data);
        updateBatchRow(d.jobId, { status: d.error === 'cancelled' ? 'cancelled' : 'error' });
      } catch (_) {}
    });
    es.addEventListener('batch.complete', () => {
      onBatchComplete();
    });
    es.addEventListener('ping', () => {
      // Heartbeat — no action needed, just keeps the connection alive.
    });
    es.addEventListener('error', () => {
      // Best-effort: server closed the stream once everything was terminal,
      // or the network dropped. EventSource auto-reconnects. The snapshot
      // endpoint covers any gap.
    });
  }

  // Hook: invoked when batch.complete arrives. Wired by Phase 2C (rollup CTA).
  function onBatchComplete() {
    const batchId = state.batchId;
    if (!batchId) return;

    const htmlEl = $('#batch-rollup-html');
    const mdEl = $('#batch-rollup-md');
    const jsonEl = $('#batch-rollup-json');
    const rollupSection = $('#batch-rollup');

    if (htmlEl) htmlEl.href = `/api/batches/${batchId}/rollup.html`;
    if (mdEl) mdEl.href = `/api/batches/${batchId}/rollup.md`;
    if (jsonEl) jsonEl.href = `/api/batches/${batchId}/rollup.json`;
    if (rollupSection) rollupSection.classList.remove('hidden');

    // Replace the misleading "uploaded — auditing…" subtitle. Count the
    // jobs in the table so the message reflects what actually finished.
    const subtitle = $('#batch-subtitle');
    if (subtitle) {
      const tbody = $('#batch-tbody');
      const rows = tbody ? tbody.querySelectorAll('tr') : [];
      const total = rows.length;
      let done = 0, errored = 0;
      rows.forEach((r) => {
        const pill = r.querySelector('.recent-badge');
        const status = pill ? pill.textContent.trim() : '';
        if (status === 'done') done++;
        else if (status === 'error' || status === 'cancelled') errored++;
      });
      const noun = total === 1 ? 'audit' : 'audits';
      const errPart = errored > 0 ? ` · ${errored} failed` : '';
      subtitle.textContent = `${done} of ${total} ${noun} complete${errPart} — library rollup ready.`;
    }
  }

  // -------------------------------------------------------------- auth helpers (Phase 9B)
  async function loadServerInfo() {
    try {
      const r = await fetch('/api/version');
      if (r.ok) {
        const j = await r.json();
        auth.mode = (j && j.mode) || 'local';
      } else {
        auth.mode = 'local';
      }
    } catch (_) { auth.mode = 'local'; }
  }

async function loadCurrentUser() {
    if (auth.mode !== 'hosted') return null;
    try {
      const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
      // When AUTH_ADAPTER=none, /api/auth/me is not mounted and returns 404.
      // Treat 404 as "auth disabled" and allow access without login.
      if (r.status === 404) {
        auth.user = { id: '__anonymous__', email: 'Anonymous (testing)' };
        auth.csrfToken = null; // CSRF not needed when auth is off
        renderTopbarUser();
        return auth.user;
      }
      if (r.status === 401) { auth.user = null; auth.csrfToken = null; return null; }
      if (!r.ok) { auth.user = null; auth.csrfToken = null; return null; }
      const j = await r.json();
      auth.user = j.user || null;
      auth.csrfToken = j.csrfToken || null;
      renderTopbarUser();
      return auth.user;
    } catch (_) {
      auth.user = null; auth.csrfToken = null; return null;
    }
  }

  function renderTopbarUser() {
    const userEl = $('#topbar-user');
    const logoutEl = $('#topbar-logout');
    if (!userEl || !logoutEl) return;
    if (auth.user && auth.user.email) {
      userEl.textContent = auth.user.email;
      userEl.classList.remove('hidden');
      logoutEl.classList.remove('hidden');
    } else {
      userEl.classList.add('hidden');
      logoutEl.classList.add('hidden');
    }
  }

  function showLoginView() {
    setView('login');
    const status = $('#login-status');
    if (status) status.textContent = '';
  }

  async function submitLogin(e) {
    e.preventDefault();
    const emailInput = $('#login-email');
    const status = $('#login-status');
    if (!emailInput) return;
    const email = (emailInput.value || '').trim();
    if (!email) return;
    if (status) status.textContent = 'Sending…';
    const submit = $('#login-submit');
    if (submit) submit.setAttribute('disabled', '');
    let resp;
    try {
      resp = await _origFetch('/api/auth/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
    } catch (err) {
      if (status) status.textContent = `Network error: ${err.message}`;
      if (submit) submit.removeAttribute('disabled');
      return;
    }
    if (resp.ok) {
      if (status) status.textContent = `Check your email — we sent a sign-in link to ${email}.`;
    } else if (resp.status === 403) {
      if (status) status.textContent = 'This address is not permitted to sign in.';
    } else if (resp.status === 429) {
      if (status) status.textContent = 'Too many attempts. Try again in a few minutes.';
    } else {
      let msg = `Could not send sign-in link (HTTP ${resp.status})`;
      try { const j = await resp.json(); msg = errorText(j, msg); } catch (_) {}
      if (status) status.textContent = msg;
    }
    if (submit) submit.removeAttribute('disabled');
  }

  async function handleLogout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (_) {}
    auth.user = null;
    auth.csrfToken = null;
    renderTopbarUser();
    showLoginView();
  }

  // -------------------------------------------------------------- recent
  async function loadRecent() {
    const panel = $('#recent-panel');
    const list = $('#recent-list');
    if (!panel || !list) return;

    let resp;
    try { resp = await fetch('/api/audits'); }
    catch (_) { panel.classList.add('hidden'); return; }
    if (!resp.ok) { panel.classList.add('hidden'); return; }

    let data;
    try { data = await resp.json(); }
    catch (_) { panel.classList.add('hidden'); return; }

    const jobs = (data.jobs || []).slice(0, 10);
    if (jobs.length === 0) { panel.classList.add('hidden'); return; }

    list.innerHTML = '';
    for (const j of jobs) list.appendChild(recentRow(j));
    panel.classList.remove('hidden');
  }

  function recentRow(j) {
    let badgeText, badgeClass;
    if (j.status === 'done') {
      const score = j.summary && j.summary.score != null ? `${Math.round(j.summary.score)}%` : '✓';
      const failed = j.summary && j.summary.passed === false;
      badgeText = score;
      badgeClass = failed ? 'fail' : 'ok';
    } else if (j.status === 'error' || j.status === 'cancelled') {
      badgeText = j.status;
      badgeClass = 'fail';
    } else {
      badgeText = j.status;
      badgeClass = 'run';
    }

    const when = new Date(j.createdAt);
    const meta = `${when.toLocaleString()} · ${(j.options && j.options.standard || 'wcag22').toUpperCase()}`;

    const link = el('a', { class: 'recent-item', href: `/job/${j.id}` }, [
      el('span', { class: `recent-badge ${badgeClass}`, text: badgeText }),
      el('span', { class: 'recent-name', text: j.originalName || `(job ${j.id.slice(0, 8)})` }),
      el('span', { class: 'recent-meta', text: meta }),
      el('span', { class: 'recent-meta', text: '→' }),
    ]);
    // Use pushState navigation instead of full reload so SPA state isn't lost.
    link.addEventListener('click', (e) => {
      e.preventDefault();
      history.pushState({ jobId: j.id }, '', `/job/${j.id}`);
      bootstrapFromUrl();
    });
    return link;
  }

  // -------------------------------------------------------------- error
  function showError(msg) {
    setView('error');
    $('#error-body').textContent = msg;
  }

  // -------------------------------------------------------------- keyboard shortcuts (Phase 8)
  const SEVERITY_BY_DIGIT = { '1': 'critical', '2': 'serious', '3': 'moderate', '4': 'minor' };

  function isTypingTarget(t) {
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (t.isContentEditable) return true;
    return false;
  }

  function modalOpen() {
    return document.querySelector('.modal:not(.hidden)') !== null;
  }

  function activeView() {
    const v = document.querySelector('.view:not(.hidden)');
    return v ? v.dataset.view : null;
  }

  function showHelp() {
    const m = document.getElementById('help-overlay');
    if (!m) return;
    m.classList.remove('hidden');
    m.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
  }
  function closeHelp() {
    const m = document.getElementById('help-overlay');
    if (!m) return;
    m.classList.add('hidden');
    m.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
  }

  function clearAllFilters() {
    if (activeView() !== 'done' || !lastReport) return;
    filterState.severity = '';
    filterState.criterion = '';
    filterState.file = '';
    filterState.search = '';
    writeFiltersToUrl();
    // Re-render filters so the visible <select>/<input> show defaults.
    renderFilters(lastReport);
    renderViolations(lastReport);
  }

  function setSeverityFilter(sev) {
    if (activeView() !== 'done' || !lastReport) return;
    filterState.severity = sev || '';
    writeFiltersToUrl();
    renderFilters(lastReport);
    renderViolations(lastReport);
  }

  function focusSearch() {
    const s = document.getElementById('f-search');
    if (s) { s.focus(); s.select(); }
  }

  function violationCards() {
    return Array.from(document.querySelectorAll('.violation'));
  }

  function moveViolationFocus(delta) {
    const cards = violationCards();
    if (cards.length === 0) return;
    let idx = cards.findIndex((c) => c === document.activeElement || c.contains(document.activeElement));
    if (idx < 0) idx = delta > 0 ? -1 : cards.length;
    const next = Math.max(0, Math.min(cards.length - 1, idx + delta));
    const target = cards[next];
    // The card itself isn't focusable; tabindex -1 makes it focusable for
    // a programmatic focus that scrolls it into view.
    target.setAttribute('tabindex', '-1');
    target.focus();
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function handleShortcut(e) {
    // Esc always closes whatever overlay is on top.
    if (e.key === 'Escape') {
      const fixModal = document.getElementById('fix-modal');
      if (fixModal && !fixModal.classList.contains('hidden')) {
        // closeFixModal is defined below; use direct DOM cue here.
        fixModal.classList.add('hidden');
        document.body.classList.remove('modal-open');
        return;
      }
      const help = document.getElementById('help-overlay');
      if (help && !help.classList.contains('hidden')) { closeHelp(); return; }
      // No overlay → clear filters on the done view.
      clearAllFilters();
      return;
    }

    // Ignore typing keys when focus is in an input.
    if (isTypingTarget(e.target)) return;
    // Ignore shortcuts while a modal/overlay is open (except Esc, handled above).
    if (modalOpen()) return;

    if (e.key === '?') { e.preventDefault(); showHelp(); return; }
    if (e.key === '/' && activeView() === 'done') { e.preventDefault(); focusSearch(); return; }
    if (activeView() === 'done') {
      if (e.key === 'j') { e.preventDefault(); moveViolationFocus(+1); return; }
      if (e.key === 'k') { e.preventDefault(); moveViolationFocus(-1); return; }
      if (e.key === '0') { setSeverityFilter(''); return; }
      if (SEVERITY_BY_DIGIT[e.key]) { setSeverityFilter(SEVERITY_BY_DIGIT[e.key]); return; }
    }
  }

  // -------------------------------------------------------------- bootstrap
  function applyUrlFiltersToState(filters) {
    // Reset to defaults, then overlay any URL-supplied values.
    filterState.severity = '';
    filterState.criterion = '';
    filterState.file = '';
    filterState.search = '';
    if (!filters) return;
    if (filters.severity) filterState.severity = filters.severity;
    if (filters.criterion) filterState.criterion = filters.criterion;
    if (filters.file) filterState.file = filters.file;
    if (filters.q) filterState.search = filters.q;
  }

  async function bootstrapFromUrl() {
    // Phase 9B: in hosted mode, gate every view on authentication. The
    // /api/auth/me call also seeds the CSRF token so subsequent POSTs work.
    if (auth.mode === 'hosted' && !auth.user) {
      await loadCurrentUser();
      if (!auth.user) { showLoginView(); return; }
    }

    // Phase 12: rebuild detail route /rebuild/:id.
    const rebuildId = parseRebuildLocation();
    if (rebuildId) {
      loadRebuildView(rebuildId, null);
      return;
    }

    const where = parseLocation();
    if (where.kind === 'idle') {
      setView('idle');
      applyPrefsToForm();
      loadRecent(); // fire-and-forget; panel hides itself if empty
      return;
    }
    if (where.kind === 'batch') {
      state.batchId = where.id;
      loadBatchView(where.id);
      return;
    }
    // /job/:id[?baseline=:bid&severity=...] — figure out the current state
    // of this job and any baseline / filters the URL is requesting.
    state.jobId = where.id;
    activeBaselineId = where.baseline || null;
    applyUrlFiltersToState(where.filters);
    let resp;
    try {
      resp = await fetch(`/api/audits/${where.id}`);
    } catch (err) {
      showError(`Cannot reach server: ${err.message}`);
      return;
    }
    if (resp.status === 404) {
      showError('This audit is no longer available.');
      return;
    }
    const snap = await resp.json();

    if (snap.status === 'done') {
      loadResult(where.id, where.baseline || null);
    } else if (snap.status === 'error') {
      showError(`Audit failed: ${snap.error || 'unknown error'}`);
    } else if (snap.status === 'cancelled') {
      pushIdleUrl();
      setView('idle');
    } else {
      setView('running');
      resetRunning(`(job ${where.id.slice(0, 8)})`);
      // Replay-on-subscribe in the server gives us back the buffered events.
      subscribe(where.id);
    }
  }

  // ================================================================
  // REBUILD — CTA, mode picker, detail view, checkpoint, undo
  // (Phase 12 frontend)
  // ================================================================

  // Rebuild state: the currently-displayed rebuild job id.
  const rebuildState = {
    jobId: null,       // rebuild job id (kind='rebuild')
    sourceJobId: null, // parent audit job id
    eventSource: null,
    manifest: null,    // last fetched rebuild manifest/snapshot
    checkpointDecisions: {}, // { [transformId]: 'approve'|'reject' }
  };

  // -------------------------------------------------------------- routing helpers

  function parseRebuildLocation() {
    const m = location.pathname.match(/^\/rebuild\/([0-9a-fA-F-]{36})\/?$/);
    if (!m) return null;
    return m[1];
  }

  function pushRebuildUrl(rebuildId) {
    const url = `/rebuild/${rebuildId}`;
    if (location.pathname !== url) {
      history.pushState({ rebuildId }, '', url);
    }
  }

  // -------------------------------------------------------------- open rebuild modal

  function openRebuildModal(auditJobId) {
    const modal = document.getElementById('rebuild-modal');
    if (!modal) return;
    // Reset radio to 'safe'
    const radios = modal.querySelectorAll('input[name="rebuild-tier"]');
    radios.forEach((r) => { r.checked = r.value === 'safe'; });
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    // Store source job id on the confirm button for use in handler.
    const confirm = document.getElementById('rebuild-modal-confirm');
    if (confirm) confirm.dataset.auditJobId = auditJobId;
  }

  function closeRebuildModal() {
    const modal = document.getElementById('rebuild-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
  }

  async function startRebuild() {
    const confirm = document.getElementById('rebuild-modal-confirm');
    if (!confirm) return;
    const auditJobId = confirm.dataset.auditJobId;
    if (!auditJobId) return;

    const radios = document.querySelectorAll('input[name="rebuild-tier"]');
    let mode = 'safe';
    radios.forEach((r) => { if (r.checked) mode = r.value; });

    confirm.setAttribute('disabled', '');
    confirm.textContent = 'Starting…';

    let resp;
    try {
      resp = await fetch(`/api/jobs/${auditJobId}/rebuild`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
    } catch (err) {
      confirm.removeAttribute('disabled');
      confirm.textContent = 'Start rebuild';
      toast(`Rebuild failed to start: ${err.message}`);
      return;
    }

    if (!resp.ok) {
      confirm.removeAttribute('disabled');
      confirm.textContent = 'Start rebuild';
      let msg = `Rebuild failed (HTTP ${resp.status})`;
      try { const j = await resp.json(); msg = errorText(j, msg); } catch (_) {}
      toast(msg);
      return;
    }

    const data = await resp.json();
    closeRebuildModal();
    confirm.removeAttribute('disabled');
    confirm.textContent = 'Start rebuild';

    // Navigate to rebuild detail view.
    rebuildState.sourceJobId = auditJobId;
    pushRebuildUrl(data.jobId);
    loadRebuildView(data.jobId, auditJobId);
  }

  // -------------------------------------------------------------- rebuild detail view

  async function loadRebuildView(rebuildJobId, sourceJobId) {
    setView('rebuild');
    rebuildState.jobId = rebuildJobId;
    if (sourceJobId) rebuildState.sourceJobId = sourceJobId;
    rebuildState.manifest = null;
    rebuildState.checkpointDecisions = {};

    // Reset UI panels.
    const donePanel = document.getElementById('rebuild-done-panel');
    const checkpointPanel = document.getElementById('rebuild-checkpoint');
    const progressBar = document.getElementById('rebuild-progress-bar');
    const progressLog = document.getElementById('rebuild-progress-log');
    const headerActions = document.getElementById('rebuild-header-actions');

    if (donePanel) donePanel.classList.add('hidden');
    if (checkpointPanel) checkpointPanel.classList.add('hidden');
    if (progressBar) progressBar.classList.remove('hidden');
    if (progressLog) { progressLog.classList.remove('hidden'); progressLog.innerHTML = ''; }
    if (headerActions) headerActions.innerHTML = '';

    const title = document.getElementById('rebuild-title');
    if (title) title.textContent = 'Rebuild';
    const subtitle = document.getElementById('rebuild-subtitle');
    if (subtitle) subtitle.textContent = 'Connecting…';

    // Fetch snapshot first.
    let snap;
    try {
      const r = await fetch(`/api/rebuilds/${rebuildJobId}`);
      if (r.status === 404) { showError('Rebuild job not found.'); return; }
      snap = await r.json();
    } catch (err) {
      showError(`Cannot reach server: ${err.message}`);
      return;
    }

    rebuildState.manifest = snap;
    updateRebuildHeader(snap);

    if (snap.status === 'done' || snap.status === 'promoted') {
      onRebuildDone(snap);
    } else if (snap.status === 'staged') {
      onRebuildStaged(snap);
    } else if (snap.status === 'error') {
      showError(`Rebuild failed: ${snap.error || 'unknown error'}`);
    } else {
      // pending / running — subscribe SSE.
      subscribeRebuildEvents(rebuildJobId);
    }
  }

  function updateRebuildHeader(snap) {
    const title = document.getElementById('rebuild-title');
    if (title) {
      const mode = (snap.options && snap.options.mode) || (snap.mode) || 'safe';
      const name = snap.originalName || snap.filename || `(job ${(snap.id||'').slice(0,8)})`;
      title.textContent = `Rebuild — ${name}`;
    }
    const subtitle = document.getElementById('rebuild-subtitle');
    if (subtitle) {
      const mode = (snap.options && snap.options.mode) || (snap.mode) || 'safe';
      subtitle.textContent = `Mode: ${mode} · Status: ${snap.status}`;
    }
  }

  function appendRebuildLog(msg) {
    const log = document.getElementById('rebuild-progress-log');
    if (!log) return;
    document.querySelectorAll('#rebuild-progress-log li.now').forEach((li) => li.classList.remove('now'));
    const line = el('li', { class: 'now' }, [el('span', { class: 'stage', text: msg })]);
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  function subscribeRebuildEvents(rebuildJobId) {
    if (rebuildState.eventSource) {
      try { rebuildState.eventSource.close(); } catch (_) {}
    }
    const es = new EventSource(`/api/rebuilds/${rebuildJobId}/events`);
    rebuildState.eventSource = es;

    es.addEventListener('progress', (e) => {
      try {
        const d = JSON.parse(e.data);
        appendRebuildLog(d.message || d.stage || JSON.stringify(d));
        // bump progress bar crudely
        const fill = document.getElementById('rebuild-progress-fill');
        const bar = document.getElementById('rebuild-progress-bar');
        if (fill && d.pct != null) {
          fill.style.width = `${d.pct}%`;
          if (bar) bar.setAttribute('aria-valuenow', String(d.pct));
        }
      } catch (_) {}
    });

    es.addEventListener('done', (e) => {
      es.close();
      const fill = document.getElementById('rebuild-progress-fill');
      const bar = document.getElementById('rebuild-progress-bar');
      if (fill) fill.style.width = '100%';
      if (bar) bar.setAttribute('aria-valuenow', '100');
      // Re-fetch snapshot to get final manifest + artifact URLs.
      fetchAndShowRebuildResult(rebuildJobId);
    });

    es.addEventListener('staged', () => {
      es.close();
      fetchAndShowRebuildResult(rebuildJobId);
    });

    es.addEventListener('error', (e) => {
      let msg = null;
      try { if (e && e.data) { const j = JSON.parse(e.data); msg = errorText(j, null); } } catch (_) {}
      if (msg) {
        es.close();
        showError(`Rebuild failed: ${msg}`);
      } else if (es.readyState === EventSource.CLOSED) {
        // Fallback: poll until terminal.
        pollRebuildUntilTerminal(rebuildJobId);
      }
    });
  }

  async function pollRebuildUntilTerminal(rebuildJobId) {
    for (let i = 0; i < 600; i++) {
      try {
        const r = await fetch(`/api/rebuilds/${rebuildJobId}`);
        if (r.status === 404) { showError('Rebuild job no longer available.'); return; }
        const snap = await r.json();
        if (snap.status === 'done' || snap.status === 'promoted') { onRebuildDone(snap); return; }
        if (snap.status === 'staged') { onRebuildStaged(snap); return; }
        if (snap.status === 'error') { showError(`Rebuild failed: ${snap.error}`); return; }
      } catch (_) {}
      await new Promise((res) => setTimeout(res, 1000));
    }
    showError('Rebuild is taking unexpectedly long; gave up watching.');
  }

  async function fetchAndShowRebuildResult(rebuildJobId) {
    try {
      const r = await fetch(`/api/rebuilds/${rebuildJobId}`);
      if (!r.ok) { showError(`Could not load rebuild result (HTTP ${r.status})`); return; }
      const snap = await r.json();
      rebuildState.manifest = snap;
      updateRebuildHeader(snap);
      if (snap.status === 'staged') {
        onRebuildStaged(snap);
      } else {
        onRebuildDone(snap);
      }
    } catch (err) {
      showError(`Could not load rebuild result: ${err.message}`);
    }
  }

  function onRebuildDone(snap) {
    const progressBar = document.getElementById('rebuild-progress-bar');
    const progressLog = document.getElementById('rebuild-progress-log');
    const donePanel = document.getElementById('rebuild-done-panel');
    const checkpointPanel = document.getElementById('rebuild-checkpoint');

    if (progressBar) progressBar.classList.add('hidden');
    if (progressLog) progressLog.classList.add('hidden');
    if (checkpointPanel) checkpointPanel.classList.add('hidden');
    if (donePanel) donePanel.classList.remove('hidden');

    updateRebuildHeader(snap);
    renderRebuildDownloads(snap);
    renderRebuildDiff(snap);
    renderRebuildActionsMenu(snap);
  }

  function renderRebuildDownloads(snap) {
    const container = document.getElementById('rebuild-downloads');
    if (!container) return;
    container.innerHTML = '';

    const id = snap.id || rebuildState.jobId;
    // Use the source audit job id if available (downloads may be keyed on that).
    const sourceId = rebuildState.sourceJobId || snap.parent_job_id;

    const links = [];
    // The backend serves rebuild artifacts at /api/rebuilds/:id/* or /api/jobs/:id/*
    // We'll use /api/rebuilds/:id/rebuilt.zip etc. since those routes exist.
    links.push(el('a', {
      class: 'btn btn-primary',
      href: `/api/rebuilds/${id}/rebuilt.zip`,
      download: 'rebuilt.zip',
      text: 'Download rebuilt.zip',
    }));
    links.push(el('a', {
      class: 'btn btn-secondary',
      href: `/api/rebuilds/${id}/rebuild-manifest.json`,
      download: 'rebuild-manifest.json',
      text: 'Download manifest',
    }));
    links.push(el('a', {
      class: 'btn btn-link',
      href: `/api/rebuilds/${id}/rebuild-diff.html`,
      target: '_blank',
      rel: 'noopener',
      text: 'Open diff report ↗',
    }));

    links.forEach((l) => container.appendChild(l));
  }

  async function renderRebuildDiff(snap) {
    const wrap = document.getElementById('rebuild-diff-wrap');
    if (!wrap) return;
    wrap.innerHTML = '';

    const id = snap.id || rebuildState.jobId;
    // Fetch the diff HTML and inject in an iframe via srcdoc to sandbox it.
    try {
      const r = await fetch(`/api/rebuilds/${id}/rebuild-diff.html`);
      if (!r.ok) {
        wrap.appendChild(el('p', { class: 'muted', text: 'Diff report not yet available.' }));
        return;
      }
      const html = await r.text();
      const iframe = el('iframe', {
        class: 'rebuild-diff-iframe',
        title: 'Rebuild diff report',
        sandbox: 'allow-same-origin',
      });
      iframe.srcdoc = html;
      wrap.appendChild(iframe);
    } catch (_) {
      wrap.appendChild(el('p', { class: 'muted', text: 'Could not load diff report.' }));
    }
  }

  function renderRebuildActionsMenu(snap) {
    const headerActions = document.getElementById('rebuild-header-actions');
    if (!headerActions) return;
    headerActions.innerHTML = '';

    const manifest = snap.result && snap.result.manifest ? snap.result.manifest : snap.manifest;
    const hasTransforms = manifest && Array.isArray(manifest.transforms) && manifest.transforms.length > 0;
    const hasPatch = manifest && Array.isArray(manifest.patches) && manifest.patches.length > 0;

    if (!hasPatch && !hasTransforms) return;

    // Wrap in a details/summary dropdown to match a minimal actions menu pattern.
    const details = el('details', { class: 'rebuild-actions-menu' });
    const summary = el('summary', { class: 'btn btn-secondary rebuild-actions-summary', text: 'Actions' });
    details.appendChild(summary);

    const menuList = el('div', { class: 'rebuild-actions-list' });

    if (hasPatch) {
      const undoPatchBtn = el('button', {
        class: 'btn btn-link rebuild-action-item',
        type: 'button',
        text: 'Undo a patch',
      });
      undoPatchBtn.addEventListener('click', () => {
        details.removeAttribute('open');
        openUndoModal(snap, 'patch');
      });
      menuList.appendChild(undoPatchBtn);
    }

    if (hasTransforms) {
      const undoTransformBtn = el('button', {
        class: 'btn btn-link rebuild-action-item',
        type: 'button',
        text: 'Undo a transform',
      });
      undoTransformBtn.addEventListener('click', () => {
        details.removeAttribute('open');
        openUndoModal(snap, 'transform');
      });
      menuList.appendChild(undoTransformBtn);
    }

    details.appendChild(menuList);
    headerActions.appendChild(details);
  }

  // -------------------------------------------------------------- checkpoint review (full-tier)

  async function onRebuildStaged(snap) {
    const progressBar = document.getElementById('rebuild-progress-bar');
    const progressLog = document.getElementById('rebuild-progress-log');
    const donePanel = document.getElementById('rebuild-done-panel');
    const checkpointPanel = document.getElementById('rebuild-checkpoint');

    if (progressBar) progressBar.classList.add('hidden');
    if (progressLog) progressLog.classList.add('hidden');
    if (donePanel) donePanel.classList.add('hidden');
    if (checkpointPanel) checkpointPanel.classList.remove('hidden');

    updateRebuildHeader(snap);

    const id = snap.id || rebuildState.jobId;

    // Fetch checkpoint data (transforms + previewHtml).
    let checkData;
    try {
      const r = await fetch(`/api/jobs/${id}/checkpoint`);
      if (!r.ok) {
        const p = document.getElementById('checkpoint-transforms');
        if (p) p.innerHTML = '<p class="muted">Could not load checkpoint data.</p>';
        return;
      }
      checkData = await r.json();
    } catch (err) {
      const p = document.getElementById('checkpoint-transforms');
      if (p) p.innerHTML = `<p class="muted">Error: ${err.message}</p>`;
      return;
    }

    // Load preview into iframe via srcdoc (avoids needing a separate route).
    const iframe = document.getElementById('checkpoint-preview-iframe');
    if (iframe && checkData.previewHtml) {
      iframe.srcdoc = checkData.previewHtml;
    } else if (iframe) {
      iframe.srcdoc = '<body style="font-family:sans-serif;padding:2rem;color:#666">No preview available.</body>';
    }

    // Render transform sidebar.
    renderCheckpointSidebar(checkData.transforms || [], id);
  }

  function renderCheckpointSidebar(transforms, rebuildJobId) {
    const container = document.getElementById('checkpoint-transforms');
    if (!container) return;
    container.innerHTML = '';
    rebuildState.checkpointDecisions = {};

    if (transforms.length === 0) {
      container.appendChild(el('p', { class: 'muted', text: 'No transforms to review.' }));
      // All-decided (vacuously) → enable Promote.
      updatePromoteButton();
      return;
    }

    transforms.forEach((t) => {
      const row = el('div', { class: 'checkpoint-transform-row', 'data-transform-id': t.id });

      // Kind + summary.
      const kind = el('div', { class: 'checkpoint-transform-kind', text: t.kind || t.type || 'transform' });
      const summary = el('div', { class: 'checkpoint-transform-summary', text: t.summary || '' });

      // AI verdict pill.
      const pills = el('div', { class: 'checkpoint-pills' });
      if (t.judgment) {
        const isConfirmed = (t.judgment === 'confirmed' || t.judgment === 'AI-CONFIRMED');
        const pillClass = isConfirmed ? 'pill-confirmed' : 'pill-uncertain';
        const pillText = isConfirmed ? 'AI-CONFIRMED' : 'AI-UNCERTAIN';
        pills.appendChild(el('span', { class: `checkpoint-verdict-pill ${pillClass}`, text: pillText }));
      }

      // Decision buttons.
      const decisionWrap = el('div', { class: 'checkpoint-decision' });
      const approveBtn = el('button', {
        class: 'btn btn-secondary checkpoint-approve',
        type: 'button',
        'aria-label': `Approve transform: ${t.kind || t.id}`,
        text: '✓ Approve',
      });
      const rejectBtn = el('button', {
        class: 'btn btn-secondary checkpoint-reject',
        type: 'button',
        'aria-label': `Reject transform: ${t.kind || t.id}`,
        text: '✗ Reject',
      });

      approveBtn.addEventListener('click', () => {
        setTransformDecision(t.id, 'approve', row, approveBtn, rejectBtn, rebuildJobId, transforms);
      });
      rejectBtn.addEventListener('click', () => {
        setTransformDecision(t.id, 'reject', row, approveBtn, rejectBtn, rebuildJobId, transforms);
      });

      // If server already has a decision, reflect it.
      if (t.decision === 'approve' || t.decision === 'approved') {
        rebuildState.checkpointDecisions[t.id] = 'approve';
        row.classList.add('decision-approve');
        approveBtn.classList.add('active');
      } else if (t.decision === 'reject' || t.decision === 'rejected') {
        rebuildState.checkpointDecisions[t.id] = 'reject';
        row.classList.add('decision-reject');
        rejectBtn.classList.add('active');
      }

      decisionWrap.appendChild(approveBtn);
      decisionWrap.appendChild(rejectBtn);

      row.appendChild(kind);
      row.appendChild(summary);
      row.appendChild(pills);
      row.appendChild(decisionWrap);
      container.appendChild(row);
    });

    updatePromoteButton();
  }

  async function setTransformDecision(transformId, decision, rowEl, approveBtn, rejectBtn, rebuildJobId, allTransforms) {
    rebuildState.checkpointDecisions[transformId] = decision;

    // Update visual state immediately (optimistic).
    rowEl.classList.toggle('decision-approve', decision === 'approve');
    rowEl.classList.toggle('decision-reject', decision === 'reject');
    approveBtn.classList.toggle('active', decision === 'approve');
    rejectBtn.classList.toggle('active', decision === 'reject');

    updatePromoteButton();

    // Save to server (fire and forget; user can promote when ready).
    try {
      await fetch(`/api/jobs/${rebuildJobId}/checkpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisions: { [transformId]: decision } }),
      });
    } catch (_) {
      // Non-fatal: the decisions will be re-sent on promote.
    }
  }

  function updatePromoteButton() {
    const container = document.getElementById('checkpoint-transforms');
    const btn = document.getElementById('checkpoint-promote');
    if (!btn || !container) return;

    const rows = container.querySelectorAll('.checkpoint-transform-row');
    const totalTransforms = rows.length;
    const decidedCount = Object.keys(rebuildState.checkpointDecisions).length;

    const allDecided = totalTransforms === 0 || decidedCount >= totalTransforms;
    btn.disabled = !allDecided;
    btn.setAttribute('aria-disabled', String(!allDecided));
  }

  async function promoteCheckpoint() {
    const btn = document.getElementById('checkpoint-promote');
    const errEl = document.getElementById('checkpoint-error');
    const id = rebuildState.jobId;
    if (!id) return;

    if (btn) { btn.disabled = true; btn.textContent = 'Promoting…'; }
    if (errEl) { errEl.classList.add('hidden'); errEl.innerHTML = ''; }

    // POST decisions, then promote.
    try {
      const decResp = await fetch(`/api/jobs/${id}/checkpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisions: rebuildState.checkpointDecisions }),
      });
      if (!decResp.ok) {
        const j = await decResp.json().catch(() => ({}));
        throw new Error(errorText(j, `Saving decisions failed (HTTP ${decResp.status})`));
      }

      const promoteResp = await fetch(`/api/jobs/${id}/checkpoint/promote`, { method: 'POST' });
      const promoteData = await promoteResp.json().catch(() => ({}));

      if (!promoteResp.ok || promoteData.promoted === false) {
        const reason = promoteData.reason || errorText(promoteData, `Promote failed (HTTP ${promoteResp.status})`);
        if (errEl) {
          errEl.classList.remove('hidden');
          errEl.innerHTML = '';
          errEl.appendChild(el('strong', { text: 'Promote failed: ' }));
          errEl.appendChild(document.createTextNode(reason));
          if (Array.isArray(promoteData.diagnostics) && promoteData.diagnostics.length) {
            const ul = el('ul', { class: 'promote-diagnostics' });
            promoteData.diagnostics.forEach((d) => ul.appendChild(el('li', { text: String(d) })));
            errEl.appendChild(ul);
          }
        }
        if (btn) { btn.disabled = false; btn.textContent = 'Promote rebuild'; }
        return;
      }

      // Promoted successfully — navigate to done view.
      toast('Promote successful!');
      await fetchAndShowRebuildResult(id);

    } catch (err) {
      if (errEl) {
        errEl.classList.remove('hidden');
        errEl.textContent = err.message;
      }
      if (btn) { btn.disabled = false; btn.textContent = 'Promote rebuild'; }
    }
  }

  // -------------------------------------------------------------- undo controls

  function openUndoModal(snap, kind) {
    const modal = document.getElementById('undo-modal');
    const title = document.getElementById('undo-modal-title');
    const body = document.getElementById('undo-modal-body');
    const confirm = document.getElementById('undo-modal-confirm');
    if (!modal || !body) return;

    if (title) title.textContent = kind === 'patch' ? 'Undo a patch' : 'Undo a transform';
    body.innerHTML = '';
    if (confirm) { confirm.disabled = true; confirm.setAttribute('aria-disabled', 'true'); delete confirm.dataset.undoKind; delete confirm.dataset.undoId; }

    const manifest = (snap.result && snap.result.manifest) ? snap.result.manifest : (snap.manifest || {});
    const items = kind === 'patch'
      ? (manifest.patches || [])
      : (manifest.transforms || []);

    if (items.length === 0) {
      body.appendChild(el('p', { class: 'muted', text: `No ${kind}s available to undo.` }));
    } else {
      const legend = el('p', { class: 'muted', text: `Select a ${kind} to undo:` });
      body.appendChild(legend);

      const list = el('div', { class: 'undo-item-list' });
      items.forEach((item) => {
        const itemId = kind === 'patch' ? item.id : item.id;
        const label = kind === 'patch'
          ? `${item.fixer || item.id} — ${item.file || ''} ${item.line ? ':' + item.line : ''}`
          : `${item.kind || item.type || item.id}`;
        const desc = kind === 'patch'
          ? (item.description || item.criterion || '')
          : (item.summary || '');

        const btn = el('button', {
          class: 'undo-item-btn',
          type: 'button',
          'data-undo-id': itemId,
          'data-undo-kind': kind,
        }, [
          el('span', { class: 'undo-item-label', text: label }),
          desc ? el('span', { class: 'undo-item-desc muted', text: desc }) : null,
        ]);

        btn.addEventListener('click', () => {
          list.querySelectorAll('.undo-item-btn').forEach((b) => b.classList.remove('selected'));
          btn.classList.add('selected');
          if (confirm) {
            confirm.disabled = false;
            confirm.setAttribute('aria-disabled', 'false');
            confirm.dataset.undoId = itemId;
            confirm.dataset.undoKind = kind;
          }
        });

        list.appendChild(btn);
      });
      body.appendChild(list);
    }

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');

    // Wire confirm with the current snap.
    if (confirm) confirm.dataset.snapJobId = snap.id || rebuildState.jobId;
  }

  function closeUndoModal() {
    const modal = document.getElementById('undo-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
  }

  async function confirmUndo() {
    const confirm = document.getElementById('undo-modal-confirm');
    if (!confirm || confirm.disabled) return;
    const jobId = confirm.dataset.snapJobId || rebuildState.jobId;
    const undoId = confirm.dataset.undoId;
    const undoKind = confirm.dataset.undoKind;
    if (!jobId || !undoId) return;

    confirm.disabled = true;
    confirm.textContent = 'Undoing…';

    const body = undoKind === 'patch' ? { patchId: undoId } : { transformId: undoId };

    let resp;
    try {
      resp = await fetch(`/api/jobs/${jobId}/undo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      toast(`Undo failed: ${err.message}`);
      confirm.disabled = false;
      confirm.textContent = 'Undo selected';
      return;
    }

    if (!resp.ok) {
      let msg = `Undo failed (HTTP ${resp.status})`;
      try { const j = await resp.json(); msg = errorText(j, msg); } catch (_) {}
      toast(msg);
      confirm.disabled = false;
      confirm.textContent = 'Undo selected';
      return;
    }

    const data = await resp.json();
    closeUndoModal();
    toast('Undo applied');

    // Refresh the diff view and downloads.
    if (data.diffHtml) {
      const wrap = document.getElementById('rebuild-diff-wrap');
      if (wrap) {
        wrap.innerHTML = '';
        const iframe = el('iframe', {
          class: 'rebuild-diff-iframe',
          title: 'Rebuild diff report (after undo)',
          sandbox: 'allow-same-origin',
        });
        iframe.srcdoc = data.diffHtml;
        wrap.appendChild(iframe);
      }
    }

    // Re-fetch snapshot to refresh manifest + action menu.
    fetchAndShowRebuildResult(jobId);
  }

  // -------------------------------------------------------------- wiring
  function wireDropZone() {
    const overlay = $('#drag-overlay');
    let dragDepth = 0; // dragenter/leave fire on every child; depth-count to be safe

    window.addEventListener('dragenter', (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      dragDepth++;
      overlay.classList.add('active');
      overlay.setAttribute('aria-hidden', 'false');
    });
    window.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault(); // required to enable drop
    });
    window.addEventListener('dragleave', () => {
      dragDepth--;
      if (dragDepth <= 0) {
        dragDepth = 0;
        overlay.classList.remove('active');
        overlay.setAttribute('aria-hidden', 'true');
      }
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      overlay.classList.remove('active');
      overlay.setAttribute('aria-hidden', 'true');
      const list = e.dataTransfer.files;
      if (!list || list.length === 0) return;
      // Phase 8: multi-file drop routes to /api/audits/batch.
      startAuditFromFiles(Array.from(list));
    });
  }

  function wireButtons() {
    $('#file-input').addEventListener('change', (e) => {
      const list = e.target.files;
      if (list && list.length > 0) startAuditFromFiles(Array.from(list));
      e.target.value = ''; // allow re-selecting the same file
    });
    // Folder picker (webkitdirectory). Browser hands us every file in the
    // folder + subfolders; filter to .zip at the top level only (one level
    // deep) to match the audit-library CLI semantics, then route through
    // the same intake function so single vs batch behavior is identical.
    const folderInput = $('#folder-input');
    if (folderInput) {
      folderInput.addEventListener('change', (e) => {
        const all = Array.from(e.target.files || []);
        const zips = all.filter((f) => {
          if (!/\.zip$/i.test(f.name)) return false;
          const rel = f.webkitRelativePath || '';
          // depth 1 = exactly one slash: "<folder>/<file>.zip"
          const slashes = (rel.match(/\//g) || []).length;
          return slashes === 1;
        });
        if (zips.length === 0) {
          showError('No .zip packages found at the top level of that folder.');
        } else {
          startAuditFromFiles(zips);
        }
        e.target.value = ''; // allow re-selecting the same folder
      });
    }
    $('#sample-btn').addEventListener('click', () => startAuditFromSample());
    $('#cancel-btn').addEventListener('click', cancelCurrent);
    $('#new-audit').addEventListener('click', () => {
      pushIdleUrl();
      setView('idle');
      applyPrefsToForm();
      loadRecent();
    });
    $('#error-reset').addEventListener('click', () => {
      pushIdleUrl();
      setView('idle');
      applyPrefsToForm();
      loadRecent();
    });
    // Persist option changes immediately (idle form). save-on-submit also
    // covers the case where the user picked an option then dropped a file.
    ['opt-standard', 'opt-package-type'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => savePrefs(readPrefsFromForm()));
    });
    $('#download-md').addEventListener('click', () => {
      if (state.jobId) window.location.href = `/api/audits/${state.jobId}/report.md`;
    });
    $('#download-json').addEventListener('click', () => {
      if (state.jobId) window.location.href = `/api/audits/${state.jobId}/report.json`;
    });
    const downloadCsv = document.getElementById('download-csv');
    if (downloadCsv) downloadCsv.addEventListener('click', () => {
      if (state.jobId) window.location.href = `/api/audits/${state.jobId}/report.csv`;
    });
    const downloadHtml = document.getElementById('download-html');
    if (downloadHtml) downloadHtml.addEventListener('click', () => {
      if (state.jobId) window.location.href = `/api/audits/${state.jobId}/report.html`;
    });

    // Batch view buttons.
    const batchCsv = document.getElementById('batch-csv');
    if (batchCsv) batchCsv.addEventListener('click', () => {
      if (state.batchId) window.location.href = `/api/batches/${state.batchId}/report.csv`;
    });
    const batchNew = document.getElementById('batch-new');
    if (batchNew) batchNew.addEventListener('click', () => {
      if (batchEventSource) { try { batchEventSource.close(); } catch (_) {} batchEventSource = null; }
      pushIdleUrl();
      setView('idle');
      applyPrefsToForm();
      loadRecent();
    });

    // Help overlay.
    const helpClose = document.getElementById('help-close');
    if (helpClose) helpClose.addEventListener('click', closeHelp);
    const helpBackdrop = document.getElementById('help-backdrop');
    if (helpBackdrop) helpBackdrop.addEventListener('click', closeHelp);
    // Footer "Keyboard shortcuts" link — same overlay, accessible from every page.
    const footerHelp = document.getElementById('footer-help');
    if (footerHelp) footerHelp.addEventListener('click', (e) => {
      e.preventDefault();
      showHelp();
    });

    // Phase 8: keyboard shortcuts.
    document.addEventListener('keydown', handleShortcut);

    // Phase 7a: preview-fixes modal wiring.
    const previewBtn = document.getElementById('preview-fixes');
    if (previewBtn) previewBtn.addEventListener('click', openFixModal);
    const fixClose = document.getElementById('fix-modal-close');
    if (fixClose) fixClose.addEventListener('click', closeFixModal);
    const fixCancel = document.getElementById('fix-modal-cancel');
    if (fixCancel) fixCancel.addEventListener('click', closeFixModal);
    const fixBackdrop = document.getElementById('fix-modal-backdrop');
    if (fixBackdrop) fixBackdrop.addEventListener('click', closeFixModal);
    const fixApply = document.getElementById('fix-modal-apply');
    if (fixApply) fixApply.addEventListener('click', applyFixesAndReaudit);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const m = document.getElementById('fix-modal');
        if (m && !m.classList.contains('hidden')) closeFixModal();
      }
    });

    // Phase 12: rebuild CTA.
    const rebuildCta = document.getElementById('rebuild-cta');
    if (rebuildCta) rebuildCta.addEventListener('click', () => {
      if (state.jobId) openRebuildModal(state.jobId);
    });

    // Phase 12: rebuild modal wiring.
    const rebuildModalClose = document.getElementById('rebuild-modal-close');
    if (rebuildModalClose) rebuildModalClose.addEventListener('click', closeRebuildModal);
    const rebuildModalCancel = document.getElementById('rebuild-modal-cancel');
    if (rebuildModalCancel) rebuildModalCancel.addEventListener('click', closeRebuildModal);
    const rebuildModalBackdrop = document.getElementById('rebuild-modal-backdrop');
    if (rebuildModalBackdrop) rebuildModalBackdrop.addEventListener('click', closeRebuildModal);
    const rebuildModalConfirm = document.getElementById('rebuild-modal-confirm');
    if (rebuildModalConfirm) rebuildModalConfirm.addEventListener('click', startRebuild);

    // Phase 12: undo modal wiring.
    const undoModalClose = document.getElementById('undo-modal-close');
    if (undoModalClose) undoModalClose.addEventListener('click', closeUndoModal);
    const undoModalCancel = document.getElementById('undo-modal-cancel');
    if (undoModalCancel) undoModalCancel.addEventListener('click', closeUndoModal);
    const undoModalBackdrop = document.getElementById('undo-modal-backdrop');
    if (undoModalBackdrop) undoModalBackdrop.addEventListener('click', closeUndoModal);
    const undoModalConfirm = document.getElementById('undo-modal-confirm');
    if (undoModalConfirm) undoModalConfirm.addEventListener('click', confirmUndo);

    // Phase 12: checkpoint promote button.
    const promoteBtn = document.getElementById('checkpoint-promote');
    if (promoteBtn) promoteBtn.addEventListener('click', promoteCheckpoint);

    // Escape closes rebuild/undo modals too.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const rm = document.getElementById('rebuild-modal');
        if (rm && !rm.classList.contains('hidden')) { closeRebuildModal(); return; }
        const um = document.getElementById('undo-modal');
        if (um && !um.classList.contains('hidden')) { closeUndoModal(); return; }
      }
    });

    window.addEventListener('popstate', bootstrapFromUrl);
  }

  // -------------------------------------------------------------- go
  document.addEventListener('DOMContentLoaded', async () => {
    wireDropZone();
    wireButtons();
    wireAuth();
    await loadServerInfo();
    if (auth.mode === 'hosted') await loadCurrentUser();
    bootstrapFromUrl();
  });

  function wireAuth() {
    const form = document.getElementById('login-form');
    if (form) form.addEventListener('submit', submitLogin);
    const logout = document.getElementById('topbar-logout');
    if (logout) logout.addEventListener('click', handleLogout);
  }
})();
