/**
 * Open Pathways Web — frontend.
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
  const DEFAULT_PREFS = { standard: 'wcag22', packageType: 'auto' };

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
    if (s) s.value = p.standard;
    if (t) t.value = p.packageType;
  }

  function readPrefsFromForm() {
    const s = document.getElementById('opt-standard');
    const t = document.getElementById('opt-package-type');
    return {
      standard: (s && s.value) || DEFAULT_PREFS.standard,
      packageType: (t && t.value) || DEFAULT_PREFS.packageType,
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
    setView('batch');
    const tbody = $('#batch-tbody');
    if (tbody) tbody.innerHTML = '';
    const subtitle = $('#batch-subtitle');
    if (subtitle) subtitle.textContent = `Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`;

    const prefs = readPrefsFromForm();
    savePrefs(prefs);

    const form = new FormData();
    for (const f of files) form.append('package', f);
    form.append('standard', prefs.standard);
    form.append('packageType', prefs.packageType);

    let resp;
    try {
      resp = await fetch('/api/audits/batch', { method: 'POST', body: form });
    } catch (err) {
      showError(`Batch upload failed: ${err.message}`);
      return;
    }
    if (!resp.ok) {
      let msg = `Batch upload failed (HTTP ${resp.status})`;
      try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch (_) {}
      showError(msg);
      return;
    }
    const data = await resp.json();
    state.batchId = data.batchId;
    pushBatchUrl(data.batchId);
    loadBatchView(data.batchId);
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
      try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch (_) {}
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
      try { if (e && e.data) { const j = JSON.parse(e.data); msg = j.error; } } catch (_) {}
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
      try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch (_) {}
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
      try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch (_) {}
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
      text: j.originalName || `(job ${j.id.slice(0, 8)})`,
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
    es.addEventListener('batch', () => {});
    es.addEventListener('child-progress', (e) => {
      try {
        const d = JSON.parse(e.data);
        // We could surface stage labels per-row, but the table already
        // reflects status; per-progress noise would be distracting. Keep
        // the row marked 'running' until terminal.
        updateBatchRow(d.jobId, { status: 'running' });
      } catch (_) {}
    });
    es.addEventListener('child-done', (e) => {
      try {
        const d = JSON.parse(e.data);
        updateBatchRow(d.jobId, { status: 'done', summary: d.summary });
      } catch (_) {}
    });
    es.addEventListener('child-error', (e) => {
      try {
        const d = JSON.parse(e.data);
        updateBatchRow(d.jobId, { status: 'error' });
      } catch (_) {}
    });
    es.addEventListener('child-cancelled', (e) => {
      try {
        const d = JSON.parse(e.data);
        updateBatchRow(d.jobId, { status: 'cancelled' });
      } catch (_) {}
    });
    es.addEventListener('error', () => {
      // Best-effort: server closed the stream once everything was terminal.
      // No action needed — the table is up to date.
    });
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
      try { const j = await resp.json(); if (j && j.error) msg = j.error; } catch (_) {}
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
