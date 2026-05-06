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
      node = el('div', { class: 'toast' });
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

  // -------------------------------------------------------------- routing
  function parseLocation() {
    const m = location.pathname.match(/^\/job\/([0-9a-fA-F-]{36})\/?$/);
    return m ? { kind: 'job', id: m[1] } : { kind: 'idle' };
  }

  function pushJobUrl(id) {
    const url = `/job/${id}`;
    if (location.pathname !== url) history.pushState({ jobId: id }, '', url);
  }

  function pushIdleUrl() {
    if (location.pathname !== '/') history.pushState({}, '', '/');
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
    pushJobUrl(state.jobId);
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
      loadResult(jobId);
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
        if (snap.status === 'done') return loadResult(jobId);
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
  const filterState = { severity: '', criterion: '', file: '', search: '' };

  async function loadResult(jobId) {
    let resp;
    try {
      resp = await fetch(`/api/audits/${jobId}/report.json`);
    } catch (err) {
      showError(`Could not load report: ${err.message}`);
      return;
    }
    if (!resp.ok) {
      showError(`Report unavailable (HTTP ${resp.status})`);
      return;
    }
    const report = await resp.json();
    lastReport = report;
    setView('done');
    renderScorecard(report);
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
    card.appendChild(el('div', { class: 'scorecard-meta' }, [
      el('div', { class: 'scorecard-headline', text: headline }),
      el('div', { class: 'muted', text: `Audited ${new Date(r.scannedAt).toLocaleString()}` }),
      el('div', { class: 'scorecard-tags' }, tags),
    ]));
  }

  function renderFilters(r) {
    const criteria = Array.from(new Set(r.violations.map((v) => v.criterion))).sort();
    const files = Array.from(new Set(r.violations.map((v) => v.file))).sort();

    const sevSel = el('select', { id: 'f-severity', onchange: (e) => { filterState.severity = e.target.value; renderViolations(lastReport); } }, [
      el('option', { value: '', text: 'all' }),
      el('option', { value: 'critical', text: 'critical' }),
      el('option', { value: 'serious', text: 'serious' }),
      el('option', { value: 'moderate', text: 'moderate' }),
      el('option', { value: 'minor', text: 'minor' }),
    ]);
    const critSel = el('select', { id: 'f-criterion', onchange: (e) => { filterState.criterion = e.target.value; renderViolations(lastReport); } });
    critSel.appendChild(el('option', { value: '', text: 'all' }));
    for (const c of criteria) critSel.appendChild(el('option', { value: c, text: c }));

    const fileSel = el('select', { id: 'f-file', onchange: (e) => { filterState.file = e.target.value; renderViolations(lastReport); } });
    fileSel.appendChild(el('option', { value: '', text: 'all' }));
    for (const f of files) fileSel.appendChild(el('option', { value: f, text: f }));

    const search = el('input', {
      id: 'f-search', type: 'search', placeholder: 'Search messages…',
      oninput: (e) => { filterState.search = e.target.value; renderViolations(lastReport); },
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

  // -------------------------------------------------------------- bootstrap
  async function bootstrapFromUrl() {
    const where = parseLocation();
    if (where.kind === 'idle') {
      setView('idle');
      applyPrefsToForm();
      loadRecent(); // fire-and-forget; panel hides itself if empty
      return;
    }
    // /job/:id — figure out the current state of this job.
    state.jobId = where.id;
    let resp;
    try {
      resp = await fetch(`/api/audits/${where.id}`);
    } catch (err) {
      showError(`Cannot reach server: ${err.message}`);
      return;
    }
    if (resp.status === 404) {
      showError('This audit is no longer available. The server may have restarted (jobs are kept in memory only).');
      return;
    }
    const snap = await resp.json();

    if (snap.status === 'done') {
      loadResult(where.id);
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
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) startAuditFromFile(file);
    });
  }

  function wireButtons() {
    $('#file-input').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) startAuditFromFile(file);
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
    window.addEventListener('popstate', bootstrapFromUrl);
  }

  // -------------------------------------------------------------- go
  document.addEventListener('DOMContentLoaded', () => {
    wireDropZone();
    wireButtons();
    bootstrapFromUrl();
  });
})();
