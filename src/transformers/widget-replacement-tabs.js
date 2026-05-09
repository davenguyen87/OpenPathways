/**
 * Full-tier transformer — Widget Replacement: Tabs.
 *
 * Detects div-soup tab patterns by DOM signature and replaces them with the
 * vetted ARIA-compliant Tabs widget shipped in `src/widgets/tabs/` (chunk 02).
 *
 * Conforms to the Transformer interface documented in `src/rebuild/types.js`
 * (chunk 00). Per the spec, this is a per-page operation: a page with N
 * matched & accepted tabsets emits ONE Transform with N patches.
 *
 * Detection (DOM signature):
 *   1. A wrapper element whose class contains one of {tab, tabs, tabset,
 *      tab-container} (case-insensitive).
 *   2. Inside the wrapper, a "tablist" of clickable elements that share a
 *      common parent. Clickable means <a>, <button>, <li>, or <div onclick>.
 *   3. Panels — sibling-of-tablist elements identifiable by class
 *      containing `panel` or `pane`, OR resolved via the tablist's
 *      data-target / aria-controls / href references when those name
 *      another element on the page.
 *
 * Decline rules (general — every widget transformer enforces these):
 *   - <form> anywhere in the source pattern -> decline.
 *   - Nested <script> with non-trivial logic -> decline.
 *   - IR extraction loses content (text-content hash mismatch before/after
 *     substitution) -> decline.
 *   - More than N items (default tabs N=12) -> decline.
 *   - Audit findings list does not include a violation this widget would
 *     resolve -> decline.
 *
 * Decline rules (tabs README — chunk 02):
 *   - Nested anchors leave the page (off-host or different path) — source
 *     is acting as a nav menu, not a tabset.
 *   - Mixed interactive content controls the widget itself — tab labels
 *     contain form controls.
 *   - Panels contain <form> elements (overlaps with general rule above).
 *   - Panel count is 1 or > 9.
 *
 * @typedef {import('../rebuild/types').Patch} Patch
 * @typedef {import('../rebuild/types').Transform} Transform
 * @typedef {import('../rebuild/types').DeferredFinding} DeferredFinding
 */

const path = require('path');
const fs = require('fs');
const cheerio = require('cheerio');
const {
  buildPatch,
  revertPatch,
  applyMods,
  linkPatchToTransform
} = require('../rebuild/types');

const TRANSFORMER_ID = 'widget-replacement-tabs';
const FAMILY = 'widget';
const CRITERIA = ['1.3.1', '2.1.1', '2.4.3', '4.1.2'];
const TRIAGE = 'author rework';
const TIER = 'full';
const PROVENANCE = 'rule-based';
const WIDGET_FAMILY = 'tabs';

// Tabs README rule 4 caps panel count at 9. The general chunk-04 cap is
// N=12, but README rules are non-negotiable.
const MAX_TABS = 9;
const MIN_TABS = 2;

const TAB_CLASS_TOKENS = ['tab', 'tabs', 'tabset', 'tab-container'];
const PANEL_CLASS_TOKENS = ['panel', 'pane'];

let TEMPLATE_CACHE = null;
function loadTemplate() {
  if (TEMPLATE_CACHE === null) {
    const p = path.join(__dirname, '..', 'widgets', WIDGET_FAMILY, 'template.html');
    TEMPLATE_CACHE = fs.readFileSync(p, 'utf8');
  }
  return TEMPLATE_CACHE;
}

module.exports = {
  id: TRANSFORMER_ID,
  name: 'Replace div-soup tabs with ARIA Tabs widget',
  family: FAMILY,
  supported: ['scorm12', 'scorm2004'],
  criteria: CRITERIA,
  triage: TRIAGE,
  tier: TIER,
  provenance: PROVENANCE,

  canTransform(packageContext) {
    for (const file of htmlFiles(packageContext)) {
      const plan = planForFile(file, findingsFor(packageContext), bypassAuditGate(packageContext));
      if (plan.substitutions.length > 0) return true;
    }
    return false;
  },

  async apply(packageContext) {
    const log = [];
    const patches = [];
    const deferred = [];
    const filesAffected = new Set();
    const updatedFiles = [];

    const findings = findingsFor(packageContext);
    const bypass = bypassAuditGate(packageContext);

    for (const file of htmlFiles(packageContext)) {
      const plan = planForFile(file, findings, bypass);
      for (const d of plan.declines) deferred.push(d);
      if (plan.substitutions.length === 0) continue;

      const mods = plan.substitutions.map((s) => ({
        offset: s.offset,
        originalText: s.originalText,
        replacementText: s.replacementText
      }));

      for (const sub of plan.substitutions) {
        const patch = buildPatch({
          fixer: TRANSFORMER_ID,
          criterion: sub.criterion,
          triage: TRIAGE,
          tier: TIER,
          confidence: 'likely',
          provenanceSource: PROVENANCE,
          file: file.path,
          content: file.content,
          originalOffset: sub.offset,
          originalText: sub.originalText,
          replacementText: sub.replacementText,
          rationale: sub.rationale,
          // Widget replacements emit large outerHTML changes; adjacent
          // patches on the same line would collide if buildPatch tried to
          // share line-bounded context. The replacement text is already
          // unique per occurrence (idBase encodes the source offset), so
          // zero-width context is sufficient for revertPatch's indexOf.
          contextChars: 0
        });
        patches.push(patch);
        filesAffected.add(file.path);
      }

      const newContent = applyMods(file.content, mods);
      updatedFiles.push({ path: file.path, newContent });
      log.push(
        `[${TRANSFORMER_ID}] replaced ${plan.substitutions.length} tabset(s) in ${file.path}`
      );
    }

    /** @type {Transform} */
    const transform = {
      transformer: TRANSFORMER_ID,
      family: FAMILY,
      criteria: CRITERIA.slice(),
      tier: TIER,
      scope: {
        files: Array.from(filesAffected).sort(),
        manifestEdited: false
      },
      patchIds: patches.map((_, i) => localPatchId(i)),
      provenance: {
        source: PROVENANCE,
        timestamp: new Date().toISOString()
      },
      rationale:
        patches.length === 0
          ? 'No div-soup tab patterns met the rule-based substitution criteria.'
          : `Replaced ${patches.length} div-soup tabset(s) with the Prism ARIA Tabs widget across ${filesAffected.size} page(s).`,
      previewPath: `rebuild-preview.html#${TRANSFORMER_ID}`,
      requiresCheckpointApproval: true,
      status: 'pending-checkpoint'
    };

    const linkedPatches = patches.map((p, i) =>
      ({ ...linkPatchToTransform(p, localTransformId()), _localPatchId: localPatchId(i) })
    );

    return {
      transform,
      patches: linkedPatches,
      log,
      deferred,
      updatedFiles
    };
  },

  async revert(packageContext, transform) {
    return revertCommon(TRANSFORMER_ID, packageContext, transform);
  }
};

// Exposed for sister modules — same revert logic across all widget transformers.
module.exports._revertCommon = revertCommon;

// ─────────────────────────────────────────────────────────────────────────────
// Detection internals
// ─────────────────────────────────────────────────────────────────────────────

function htmlFiles(packageContext) {
  const all = (packageContext && Array.isArray(packageContext.files)) ? packageContext.files : [];
  return all
    .filter((f) => {
      if (!f || typeof f.content !== 'string' || typeof f.path !== 'string') return false;
      if (f.isHtml === false) return false;
      return f.isHtml === true || /\.x?html?$/i.test(f.path);
    })
    .slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function findingsFor(packageContext) {
  if (!packageContext) return [];
  if (Array.isArray(packageContext.findings)) return packageContext.findings;
  if (packageContext.audit && Array.isArray(packageContext.audit.findings)) {
    return packageContext.audit.findings;
  }
  return [];
}

function bypassAuditGate(packageContext) {
  return !!(packageContext && packageContext.bypassAuditGate);
}

function planForFile(file, findings, bypass) {
  /** @type {Array<Substitution>} */
  const substitutions = [];
  /** @type {Array<DeferredFinding>} */
  const declines = [];

  let $;
  try {
    $ = cheerio.load(file.content, { decodeEntities: false });
  } catch (_) {
    return { substitutions, declines };
  }

  const wrappers = $('*')
    .toArray()
    .filter((el) => hasClassToken(el, TAB_CLASS_TOKENS));

  // Per-file source locator that disambiguates same-signature occurrences.
  const locator = createSourceLocator(file.content);

  const claimed = new WeakSet();
  for (const wrapper of wrappers) {
    if (claimed.has(wrapper)) continue;
    if (ancestorIsClaimed($(wrapper), claimed)) continue;

    const decision = analyzeWrapper($, wrapper, file, findings, bypass, locator);

    if (decision.kind === 'decline') {
      declines.push(decision.deferred);
      claimed.add(wrapper);
      for (const desc of decision.candidateDescendants || []) claimed.add(desc);
      continue;
    }
    if (decision.kind === 'accept') {
      claimed.add(wrapper);
      for (const desc of decision.candidateDescendants || []) claimed.add(desc);
      substitutions.push(decision.substitution);
    }
  }

  substitutions.sort((a, b) => a.offset - b.offset);
  return { substitutions, declines };
}

function ancestorIsClaimed($el, claimed) {
  let p = $el.parent();
  while (p && p.length > 0) {
    if (claimed.has(p[0])) return true;
    p = p.parent();
  }
  return false;
}

function analyzeWrapper($, wrapper, file, findings, bypass, locator) {
  const $wrapper = $(wrapper);

  const ir = extractIR($, $wrapper);
  if (!ir || ir.tabs.length === 0) {
    return { kind: 'skip' };
  }

  // Decline rule: no matching audit finding.
  if (!bypass && !hasMatchingFinding(findings, file.path, CRITERIA)) {
    return {
      kind: 'decline',
      deferred: deferred(file.path, lineForElement(file.content, wrapper, $),
        '4.1.2',
        'Audit findings list does not include a 1.3.1/2.1.1/2.4.3/4.1.2 violation on this page that the Tabs widget would resolve.',
        'no-matching-finding'),
      candidateDescendants: ir.candidateDescendants
    };
  }

  // Decline rule: <form> in the candidate.
  if ($wrapper.find('form').length > 0) {
    return {
      kind: 'decline',
      deferred: deferred(file.path, lineForElement(file.content, wrapper, $),
        '4.1.2',
        'Source tabset contains a <form> element. Replacing it with a different DOM structure can break form submission. Defer.',
        'form-in-source'),
      candidateDescendants: ir.candidateDescendants
    };
  }

  // Decline rule: nested <script> with non-trivial logic.
  const scriptDecline = scriptDeclineReason($wrapper);
  if (scriptDecline) {
    return {
      kind: 'decline',
      deferred: deferred(file.path, lineForElement(file.content, wrapper, $),
        '4.1.2',
        scriptDecline,
        'nested-script'),
      candidateDescendants: ir.candidateDescendants
    };
  }

  // Decline rule: panel count out of range.
  if (ir.tabs.length < MIN_TABS) {
    return {
      kind: 'decline',
      deferred: deferred(file.path, lineForElement(file.content, wrapper, $),
        '4.1.2',
        `Tabset has only ${ir.tabs.length} panel — a single panel is not a tabset; recommend a Disclosure component.`,
        'too-few-panels'),
      candidateDescendants: ir.candidateDescendants
    };
  }
  if (ir.tabs.length > MAX_TABS) {
    return {
      kind: 'decline',
      deferred: deferred(file.path, lineForElement(file.content, wrapper, $),
        '4.1.2',
        `Tabset has ${ir.tabs.length} panels (limit ${MAX_TABS}); more creates an unusable focus order — recommend an accordion or page split.`,
        'too-many-panels'),
      candidateDescendants: ir.candidateDescendants
    };
  }

  // Decline rule: anchors leaving the page (nav-menu pattern).
  if (anchorsLeavePage($wrapper, ir.tabElements)) {
    return {
      kind: 'decline',
      deferred: deferred(file.path, lineForElement(file.content, wrapper, $),
        '4.1.2',
        'Tabset contains anchors that point off-host or to a different path — source appears to be a nav menu, not a tabset.',
        'nav-menu-not-tabset'),
      candidateDescendants: ir.candidateDescendants
    };
  }

  // Decline rule: tab labels contain interactive form controls.
  if (labelsContainInteractive(ir.tabElements)) {
    return {
      kind: 'decline',
      deferred: deferred(file.path, lineForElement(file.content, wrapper, $),
        '4.1.2',
        'Tab labels contain form controls — the source is not a tab pattern.',
        'mixed-interactive-labels'),
      candidateDescendants: ir.candidateDescendants
    };
  }

  // Locate the wrapper's exact outerHTML in source — also gives a unique
  // offset we can hash into the idBase to keep multi-tabset pages distinct.
  const located = locator.consumeOuter(wrapper, file.content);
  if (!located) {
    return {
      kind: 'decline',
      deferred: deferred(file.path, lineForElement(file.content, wrapper, $),
        '4.1.2',
        'Could not unambiguously locate the wrapper element in source — declined.',
        'source-locate-failed'),
      candidateDescendants: ir.candidateDescendants
    };
  }

  // Build replacement template. idBase is unique per wrapper occurrence.
  const idBase = stableIdBase(file.path, located.offset);
  const replacementText = renderTabs(ir, idBase);

  // Decline rule: text-content hash mismatch.
  const beforeText = normalizeText($wrapper.text());
  const afterText = normalizeText(cheerio.load(replacementText, { decodeEntities: false }).root().text());
  if (beforeText !== afterText) {
    return {
      kind: 'decline',
      deferred: deferred(file.path, lineForElement(file.content, wrapper, $),
        '4.1.2',
        'Substitution would lose source text content — IR extraction is incomplete for this pattern. Defer.',
        'content-loss'),
      candidateDescendants: ir.candidateDescendants
    };
  }

  return {
    kind: 'accept',
    substitution: {
      offset: located.offset,
      originalText: located.text,
      replacementText,
      criterion: '4.1.2',
      rationale:
        `Replaced div-soup tabset (${ir.tabs.length} tabs) with the Prism ARIA Tabs widget. ` +
        `Tab labels and panel content preserved verbatim; keyboard model now follows the APG manual-activation pattern.`
    },
    candidateDescendants: ir.candidateDescendants
  };
}

function deferred(file, line, criterion, reason, ruleId) {
  return {
    criterion,
    triage: TRIAGE,
    reason: `[${ruleId}] ${reason}`,
    file,
    line
  };
}

function hasClassToken(el, tokens) {
  const cls = (el.attribs && el.attribs.class) || '';
  if (!cls) return false;
  const lower = cls.toLowerCase().split(/\s+/).filter(Boolean);
  return lower.some((c) => tokens.some((t) => c === t || c.includes(t)));
}

function hasMatchingFinding(findings, filePath, criteria) {
  if (!Array.isArray(findings) || findings.length === 0) return false;
  for (const f of findings) {
    if (!f || typeof f !== 'object') continue;
    const ff = f.file || f.filePath || f.path;
    const cc = f.criterion || f.id;
    if (ff && ff !== filePath) continue;
    if (!cc) continue;
    if (criteria.includes(String(cc))) return true;
  }
  return false;
}

function scriptDeclineReason($wrapper) {
  const scripts = $wrapper.find('script').toArray();
  for (const s of scripts) {
    const text = (s.children || [])
      .map((c) => (c.type === 'text' ? c.data || '' : ''))
      .join('');
    const compact = text.replace(/\s+/g, '');
    if (!compact) continue;
    const hasControlFlow = /(?:function\s|=>|if\s*\(|for\s*\(|while\s*\(|switch\s*\(|class\s|new\s+[A-Z])/.test(text);
    if (compact.length > 80 || hasControlFlow) {
      return 'Source contains a nested <script> with non-trivial logic. The replacement script may conflict with bespoke behaviour. Defer.';
    }
  }
  return null;
}

function anchorsLeavePage($wrapper, tabElements) {
  // Only audit anchors that ARE the tab triggers OR live in tab labels.
  // Anchors inside panel bodies are content and don't disqualify the pattern.
  for (const tab of tabElements) {
    let anchors;
    if ((tab.name || '').toLowerCase() === 'a') {
      anchors = [tab];
    } else {
      anchors = [];
      const stack = (tab.children || []).slice();
      while (stack.length > 0) {
        const n = stack.shift();
        if (!n) continue;
        if (n.type === 'tag') {
          if ((n.name || '').toLowerCase() === 'a') anchors.push(n);
          if (n.children) stack.push(...n.children);
        }
      }
    }
    for (const a of anchors) {
      const href = (a.attribs && a.attribs.href) || '';
      if (!href) continue;
      if (href.startsWith('#')) continue;
      if (/^javascript:/i.test(href)) continue;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) return true;
      if (href.startsWith('/')) return true;
      // Relative href to a different file is a different path.
      return true;
    }
  }
  return false;
}

function labelsContainInteractive(tabElements) {
  for (const tab of tabElements) {
    const stack = (tab.children || []).slice();
    while (stack.length > 0) {
      const n = stack.shift();
      if (!n) continue;
      if (n.type === 'tag') {
        const name = (n.name || '').toLowerCase();
        if (['input', 'select', 'textarea'].includes(name)) return true;
        // Nested <button> inside the tab label is interactive content.
        if (name === 'button' && tab !== n) return true;
        if (n.children) stack.push(...n.children);
      }
    }
  }
  return false;
}

function extractIR($, $wrapper) {
  const candidateDescendants = [];

  const allDesc = $wrapper.find('a, button, li, [onclick], [role="tab"]').toArray();
  const tabCandidates = allDesc.filter((el) => {
    const $el = $(el);
    if ($el.parents('[role="tabpanel"]').length > 0) return false;
    return true;
  });

  if (tabCandidates.length === 0) return null;

  // Group candidates by their direct parent.
  const byParent = new Map();
  for (const el of tabCandidates) {
    const parent = el.parent;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(el);
  }
  let tabElements = null;
  for (const els of byParent.values()) {
    if (els.length >= 2) {
      tabElements = els;
      break;
    }
  }
  if (!tabElements) {
    const explicitTablist = $wrapper.find('[role="tablist"], .tablist, .tabs__list').first();
    if (explicitTablist.length > 0) {
      tabElements = explicitTablist
        .children()
        .toArray()
        .filter((el) => ['a', 'button', 'li', 'div', 'span'].includes((el.name || '').toLowerCase()));
      if (tabElements.length < 2) tabElements = null;
    }
  }
  if (!tabElements || tabElements.length < 2) return null;

  candidateDescendants.push(...tabElements);

  const panels = resolvePanels($, $wrapper, tabElements);
  if (!panels || panels.length !== tabElements.length) return null;

  candidateDescendants.push(...panels.filter(Boolean));

  // Decline if a panel is the same node as a tab — degenerate pattern.
  const tabSet = new Set(tabElements);
  if (panels.some((p) => tabSet.has(p))) return null;

  // Determine initial active.
  let initialIdx = -1;
  tabElements.forEach((tab, i) => {
    const $t = $(tab);
    const ariaSelected = $t.attr('aria-selected');
    const cls = ($t.attr('class') || '').toLowerCase();
    if (ariaSelected === 'true' || /\b(active|selected|current)\b/.test(cls)) {
      if (initialIdx === -1) initialIdx = i;
    }
  });
  if (initialIdx === -1) {
    panels.forEach((panel, i) => {
      if (!panel) return;
      const $p = $(panel);
      const cls = ($p.attr('class') || '').toLowerCase();
      const hidden = $p.attr('hidden');
      if (/\b(active|selected|show|in)\b/.test(cls) && !hidden) {
        if (initialIdx === -1) initialIdx = i;
      }
    });
  }
  if (initialIdx === -1) initialIdx = 0;

  const tabs = tabElements.map((tab, i) => {
    const $t = $(tab);
    const label = $t.text().trim();
    const $panel = panels[i] ? $(panels[i]) : null;
    const panelHTML = $panel ? ($panel.html() || '') : '';
    return {
      label,
      panelHTML,
      initiallyActive: i === initialIdx
    };
  });

  return {
    tabs,
    tabElements,
    panelElements: panels,
    candidateDescendants
  };
}

function resolvePanels($, $wrapper, tabElements) {
  const panels = [];
  const idRefs = tabElements.map((t) => panelIdRef($, t));
  if (idRefs.every(Boolean)) {
    for (const id of idRefs) {
      const $p = $wrapper.find(`#${cssEscape(id)}`);
      if ($p.length > 0) {
        panels.push($p[0]);
      } else {
        const $g = $.root().find(`#${cssEscape(id)}`);
        if ($g.length === 0) return null;
        panels.push($g[0]);
      }
    }
    return panels;
  }

  const candidates = $wrapper.find('*').toArray().filter((el) => hasClassToken(el, PANEL_CLASS_TOKENS));
  const tabSet = new Set(tabElements);
  // Exclude tab elements themselves and exclude descendants of tab elements
  // (a child <span class="pane"> inside an <a class="tab"> isn't a panel).
  const filtered = candidates.filter((el) => {
    if (tabSet.has(el)) return false;
    let p = el.parent;
    while (p) {
      if (tabSet.has(p)) return false;
      p = p.parent;
    }
    return true;
  });
  if (filtered.length >= tabElements.length) {
    return filtered.slice(0, tabElements.length);
  }
  return null;
}

function panelIdRef($, tabEl) {
  const $t = $(tabEl);
  const ac = $t.attr('aria-controls');
  if (ac) return ac.replace(/^#/, '').trim();
  const dt = $t.attr('data-target') || $t.attr('data-bs-target');
  if (dt) return dt.replace(/^#/, '').trim();
  const href = $t.attr('href');
  if (href && href.startsWith('#')) return href.slice(1).trim();
  const $a = $t.find('a').first();
  if ($a.length > 0) {
    const ah = $a.attr('href');
    if (ah && ah.startsWith('#')) return ah.slice(1).trim();
  }
  return null;
}

function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function renderTabs(ir, idBase) {
  // We don't reuse the template's HTML byte-for-byte because we need N
  // tabs/panels. The template's structure is replicated faithfully.
  // Touching `loadTemplate()` ensures bit-rot caught by the widget's tests.
  void loadTemplate();

  const tabsLabel = htmlEscape(`Tabs (${ir.tabs.length})`);
  const initialIdx = ir.tabs.findIndex((t) => t.initiallyActive);
  const selectedIndex = initialIdx === -1 ? 0 : initialIdx;

  const tabButtons = ir.tabs
    .map((t, i) => {
      const tabId = `${idBase}-tab-${i}`;
      const panelId = `${idBase}-panel-${i}`;
      const selected = i === selectedIndex ? 'true' : 'false';
      const tabindex = i === selectedIndex ? '0' : '-1';
      return [
        '    <button',
        '      type="button"',
        '      class="prism-widget-tabs__tab"',
        '      role="tab"',
        `      id="${tabId}"`,
        `      aria-controls="${panelId}"`,
        `      aria-selected="${selected}"`,
        `      tabindex="${tabindex}"`,
        '      data-prism-tab',
        `    >${htmlEscape(t.label)}</button>`
      ].join('\n');
    })
    .join('\n');

  const panelDivs = ir.tabs
    .map((t, i) => {
      const tabId = `${idBase}-tab-${i}`;
      const panelId = `${idBase}-panel-${i}`;
      const hidden = i === selectedIndex ? '' : '\n    hidden';
      return [
        '  <div',
        '    class="prism-widget-tabs__panel"',
        '    role="tabpanel"',
        `    id="${panelId}"`,
        `    aria-labelledby="${tabId}"`,
        '    tabindex="0"' + hidden,
        '    data-prism-panel',
        `  >${t.panelHTML}</div>`
      ].join('\n');
    })
    .join('\n');

  return [
    '<div class="prism-widget-tabs" data-prism-widget="tabs">',
    '  <div',
    '    class="prism-widget-tabs__list"',
    '    role="tablist"',
    `    aria-label="${tabsLabel}"`,
    '  >',
    tabButtons,
    '  </div>',
    panelDivs,
    '</div>'
  ].join('\n');
}

function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeText(s) {
  // Strip ALL whitespace to compare semantic word content. The rendered
  // template introduces source-level whitespace between elements that the
  // original may not have; removing it (rather than collapsing) avoids a
  // false content-loss decline when the only difference is layout whitespace.
  return String(s || '').replace(/\s+/g, '');
}

function stableIdBase(filePath, line) {
  const safe = String(filePath).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `prism-tabs-${safe}-${line}`;
}

function lineForElement(source, el, $) {
  if (!el || !el.attribs) return 0;
  const opening = $.html(el).split('>')[0] + '>';
  const idx = source.indexOf(opening);
  if (idx === -1) return 0;
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * Per-file source locator. consumeOuter() returns the next unclaimed
 * outerHTML that matches the element's tag + attributes signature. Subsequent
 * calls for the same signature advance the cursor so two same-signature
 * wrappers in one file each get a distinct source slice.
 */
function createSourceLocator(content) {
  const cursor = new Map();

  function key(tagName, attribs) {
    const ks = Object.keys(attribs).sort();
    return tagName + '|' + ks.map((k) => `${k}=${attribs[k]}`).join('&');
  }

  return {
    consumeOuter(el) {
      const tagName = (el.name || '').toLowerCase();
      if (!tagName) return null;
      const attribs = el.attribs || {};
      const k = key(tagName, attribs);
      const startFrom = cursor.get(k) || 0;
      const opening = findNthOpeningTag(content, tagName, attribs, startFrom);
      if (!opening) return null;
      const matchingClose = findMatchingClose(content, tagName, opening.offset + opening.text.length);
      if (matchingClose === -1) return null;
      const text = content.slice(opening.offset, matchingClose + `</${tagName}>`.length);
      cursor.set(k, opening.cursorAfter);
      return { offset: opening.offset, text };
    }
  };
}

function findNthOpeningTag(content, tagName, attribs, startFrom) {
  const re = new RegExp(`<${escapeRegex(tagName)}(\\s[^>]*)?>`, 'gi');
  let m;
  let nth = 0;
  while ((m = re.exec(content)) !== null) {
    const open = m[0];
    const parsed = parseAttrs(open);
    if (sameAttrs(parsed, attribs)) {
      if (nth >= startFrom) {
        return { offset: m.index, text: open, cursorAfter: nth + 1 };
      }
      nth += 1;
    }
  }
  return null;
}

function findMatchingClose(content, tagName, fromOffset) {
  const closeTag = `</${tagName}>`;
  const openRe = new RegExp(`<${escapeRegex(tagName)}\\b`, 'gi');
  openRe.lastIndex = fromOffset;
  let depth = 1;
  let cursor = fromOffset;
  while (cursor < content.length && depth > 0) {
    const nextClose = content.indexOf(closeTag, cursor);
    if (nextClose === -1) return -1;
    openRe.lastIndex = cursor;
    let openMatch = openRe.exec(content);
    while (openMatch && openMatch.index < nextClose) {
      const after = content.charAt(openMatch.index + tagName.length + 1);
      if (after === ' ' || after === '>' || after === '\t' || after === '\n' || after === '/') {
        depth += 1;
      }
      openMatch = openRe.exec(content);
    }
    depth -= 1;
    if (depth === 0) return nextClose;
    cursor = nextClose + closeTag.length;
  }
  return -1;
}

function parseAttrs(openingTag) {
  const inner = openingTag.replace(/^<\s*[a-zA-Z][\w-]*/, '').replace(/\/?>$/, '').trim();
  const attrs = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : '';
    attrs[name] = value;
  }
  return attrs;
}

function sameAttrs(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (String(a[ka[i]]) !== String(b[ka[i]])) return false;
  }
  return true;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function localPatchId(i) {
  return `${TRANSFORMER_ID}-patch-${String(i + 1).padStart(4, '0')}`;
}

function localTransformId() {
  return `${TRANSFORMER_ID}-local`;
}

/**
 * Shared revert implementation used by every widget transformer in this
 * family. Reverses every patch in reverse application order per file so the
 * round-trip is byte-identical.
 */
function revertCommon(transformerId, packageContext, transform) {
  const log = [];
  const patches = (transform && Array.isArray(transform.patches)) ? transform.patches : [];
  const filesByPath = new Map();
  for (const f of (packageContext && packageContext.files) || []) {
    filesByPath.set(f.path, f.content);
  }

  const byFile = new Map();
  for (const p of patches) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file).push(p);
  }

  const reverted = [];
  const updatedFiles = [];
  for (const [filePath, filePatches] of byFile.entries()) {
    let content = filesByPath.get(filePath);
    if (typeof content !== 'string') {
      log.push(`[${transformerId}] revert: file not in packageContext: ${filePath}`);
      for (const p of filePatches) reverted.push({ ...p, status: 'reverted' });
      continue;
    }
    const ordered = [...filePatches].sort(
      (a, b) =>
        b.range.startLine - a.range.startLine ||
        b.range.startCol - a.range.startCol
    );
    for (const patch of ordered) {
      const r = revertPatch({ path: filePath, content }, patch);
      content = r.newContent;
      for (const line of r.log) log.push(line);
      reverted.push({ ...patch, status: 'reverted' });
    }
    updatedFiles.push({ path: filePath, newContent: content });
  }

  return { patches: reverted, log, updatedFiles };
}

/**
 * @typedef {Object} Substitution
 * @property {number} offset
 * @property {string} originalText
 * @property {string} replacementText
 * @property {string} criterion
 * @property {string} rationale
 */
