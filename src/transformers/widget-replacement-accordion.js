/**
 * Full-tier transformer — Widget Replacement: Accordion.
 *
 * Detects div-soup accordion patterns by DOM signature and replaces them
 * with the vetted ARIA-compliant Accordion widget shipped in
 * `src/widgets/accordion/` (chunk 02).
 *
 * Conforms to the Transformer interface from `src/rebuild/types.js`. One
 * Transform per HTML page with at least one matched & accepted accordion.
 *
 * Detection (DOM signature):
 *   - Wrapper element whose class contains one of {accordion, collapse,
 *     expandable} (case-insensitive).
 *   - Pairs of (trigger, panel) where the trigger toggles the panel.
 *     The trigger is matched by data-target / aria-controls / href="#id"
 *     OR by sibling-pair convention (trigger then panel inside a section).
 *
 * Decline rules (general):
 *   - <form> in the source -> decline
 *   - Nested <script> with non-trivial logic -> decline
 *   - Text-content hash mismatch before/after -> decline
 *   - Sections > 24 -> decline
 *   - No matching audit finding (1.3.1 / 2.1.1 / 4.1.2) -> decline
 *
 * Decline rules (accordion README, chunk 02):
 *   - Hash-based open-by-default behaviour (anchor links to section ids)
 *   - Triggers contain block-level descendants other than the label span
 *   - Single section (use Disclosure)
 *   - "Click anywhere on the row" handler (cannot be split into trigger
 *     + region cleanly).
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
const { classifyWidget } = require('../lib/transformer-judgment');

const TRANSFORMER_ID = 'widget-replacement-accordion';
const FAMILY = 'widget';
const CRITERIA = ['1.3.1', '2.1.1', '4.1.2'];
const TRIAGE = 'author rework';
const TIER = 'full';
const PROVENANCE = 'rule-based';
const WIDGET_FAMILY = 'accordion';

const MAX_SECTIONS = 24;
const MIN_SECTIONS = 2;

const ACCORDION_CLASS_TOKENS = ['accordion', 'collapse', 'expandable'];
const PANEL_CLASS_TOKENS = ['panel', 'collapse-content', 'accordion-content', 'accordion-panel', 'pane'];
const HEADER_CLASS_TOKENS = ['accordion-header', 'accordion-trigger', 'collapse-header', 'expandable-header', 'header', 'trigger'];

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
  name: 'Replace div-soup accordions with ARIA Accordion widget',
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
    const threshold = packageContext?.opts?.llmJudgmentConfidenceThreshold ?? 0.7;

    for (const file of htmlFiles(packageContext)) {
      const plan = planForFile(file, findings, bypass);
      for (const d of plan.declines) deferred.push(d);
      if (plan.substitutions.length === 0) continue;

      // LLM judgment: classify each heuristic candidate before emitting patches.
      const acceptedSubs = [];
      for (const sub of plan.substitutions) {
        if (packageContext.provider) {
          const $ = cheerio.load(file.content, { decodeEntities: false });
          const candidateRoot = $('*').toArray().find((el) =>
            el.attribs && hasClassToken(el, ACCORDION_CLASS_TOKENS)
          );
          const structure = candidateRoot ? {
            tagName: (candidateRoot.name || 'div').toLowerCase(),
            childCount: (candidateRoot.children || []).filter((c) => c.type === 'tag').length,
            hasButtons: $(candidateRoot).find('button, [role="button"]').length > 0,
            hasForm: $(candidateRoot).find('form').length > 0,
            headingCount: $(candidateRoot).find('h1,h2,h3,h4,h5,h6').length
          } : { tagName: 'div', childCount: 0, hasButtons: false, hasForm: false, headingCount: 0 };
          const classTokens = candidateRoot
            ? ((candidateRoot.attribs && candidateRoot.attribs.class) || '').split(/\s+/).filter(Boolean)
            : [];
          const result = await classifyWidget({
            packageContext,
            candidate: {
              file: file.path,
              html: sub.originalText,
              classes: classTokens,
              structure,
              rationale: `matched ACCORDION_CLASS_TOKENS on wrapper; ${structure.childCount} children`
            },
            expectedType: 'accordion',
            options: packageContext.opts || {},
            provider: packageContext.provider
          });
          if (result.ok) {
            let effectiveVerdict = result.verdict;
            if (result.verdict === 'match' && result.confidence < threshold) {
              effectiveVerdict = 'uncertain';
            }
            if (effectiveVerdict === 'no-match') {
              deferred.push({
                criterion: '4.1.2',
                triage: TRIAGE,
                reason: `LLM rejected as not a accordion widget: ${result.rationale}`,
                file: file.path,
                line: 0
              });
              continue; // skip this candidate
            }
            sub._judgment = {
              source: 'llm',
              verdict: effectiveVerdict,
              confidence: result.confidence,
              rationale: result.rationale,
              ...result.provenance
            };
          } else {
            log.push(`[${TRANSFORMER_ID}] LLM judgment skipped for ${file.path}: ${result.reason}`);
          }
        }
        acceptedSubs.push(sub);
      }

      if (acceptedSubs.length === 0) continue;

      const mods = acceptedSubs.map((s) => ({
        offset: s.offset,
        originalText: s.originalText,
        replacementText: s.replacementText
      }));

      for (const sub of acceptedSubs) {
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
          // See widget-replacement-tabs for rationale on contextChars: 0.
          contextChars: 0
        });
        if (sub._judgment) patch._judgment = sub._judgment;
        patches.push(patch);
        filesAffected.add(file.path);
      }

      const newContent = applyMods(file.content, mods);
      updatedFiles.push({ path: file.path, newContent });
      log.push(`[${TRANSFORMER_ID}] replaced ${acceptedSubs.length} accordion(s) in ${file.path}`);
    }

    const firstJudgedPatch = patches.find((p) => p._judgment);

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
          ? 'No div-soup accordion patterns met the rule-based substitution criteria.'
          : `Replaced ${patches.length} div-soup accordion(s) with the Prism ARIA Accordion widget across ${filesAffected.size} page(s).`,
      previewPath: `rebuild-preview.html#${TRANSFORMER_ID}`,
      requiresCheckpointApproval: true,
      status: 'pending-checkpoint',
      ...(firstJudgedPatch ? { judgment: firstJudgedPatch._judgment } : {})
    };

    const linkedPatches = patches.map((p, i) =>
      ({ ...linkPatchToTransform(p, localTransformId()), _localPatchId: localPatchId(i) })
    );

    return { transform, patches: linkedPatches, log, deferred, updatedFiles };
  },

  async revert(packageContext, transform) {
    return revertCommon(TRANSFORMER_ID, packageContext, transform);
  }
};

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
  const substitutions = [];
  const declines = [];

  let $;
  try {
    $ = cheerio.load(file.content, { decodeEntities: false });
  } catch (_) {
    return { substitutions, declines };
  }

  const wrappers = $('*')
    .toArray()
    .filter((el) => hasClassToken(el, ACCORDION_CLASS_TOKENS));

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
  if (!ir || ir.items.length === 0) return { kind: 'skip' };

  if (!bypass && !hasMatchingFinding(findings, file.path, CRITERIA)) {
    return decline(file, wrapper, $, ir,
      'Audit findings list does not include a 1.3.1/2.1.1/4.1.2 violation on this page that the Accordion widget would resolve.',
      'no-matching-finding');
  }

  if ($wrapper.find('form').length > 0) {
    return decline(file, wrapper, $, ir,
      'Source accordion contains a <form> element. Replacing it with a different DOM structure can break form submission.',
      'form-in-source');
  }

  const scriptDecline = scriptDeclineReason($wrapper);
  if (scriptDecline) {
    return decline(file, wrapper, $, ir, scriptDecline, 'nested-script');
  }

  if (ir.items.length < MIN_SECTIONS) {
    return decline(file, wrapper, $, ir,
      `Accordion has only ${ir.items.length} section — use a Disclosure component instead.`,
      'too-few-sections');
  }
  if (ir.items.length > MAX_SECTIONS) {
    return decline(file, wrapper, $, ir,
      `Accordion has ${ir.items.length} sections (limit ${MAX_SECTIONS}); recommend a page split.`,
      'too-many-sections');
  }

  // Decline rule: hash-based open-by-default — outbound links elsewhere on
  // the page that point to a section id that this accordion owns.
  if (hasHashOpenBehaviour($, $wrapper, ir)) {
    return decline(file, wrapper, $, ir,
      'Source accordion has hash-based section navigation. Outbound anchors targeting section ids cannot be preserved without rewriting.',
      'hash-open-behaviour');
  }

  // Decline rule: triggers contain block-level elements (other than the
  // label span / inner text node).
  if (triggersHaveBlockChildren(ir.triggerElements)) {
    return decline(file, wrapper, $, ir,
      'Trigger elements contain block-level descendants — the source is doing more than disclosure.',
      'block-trigger');
  }

  // Decline rule: "click anywhere on row" — onclick on the section element
  // itself (the trigger AND panel share an onclick handler).
  if (sectionHasRowClick(ir.sectionElements)) {
    return decline(file, wrapper, $, ir,
      'Source has a click-anywhere-on-row handler that includes the panel content. Cannot be cleanly split into trigger + region.',
      'row-click');
  }

  const located = locator.consumeOuter(wrapper, file.content);
  if (!located) {
    return decline(file, wrapper, $, ir,
      'Could not unambiguously locate the wrapper element in source — declined.',
      'source-locate-failed');
  }

  const idBase = stableIdBase(file.path, located.offset);
  const headingLevel = chooseHeadingLevel($, $wrapper);
  const replacementText = renderAccordion(ir, idBase, headingLevel);

  const beforeText = normalizeText($wrapper.text());
  const afterText = normalizeText(cheerio.load(replacementText, { decodeEntities: false }).root().text());
  if (beforeText !== afterText) {
    return decline(file, wrapper, $, ir,
      'Substitution would lose source text content — IR extraction is incomplete for this pattern.',
      'content-loss');
  }

  return {
    kind: 'accept',
    substitution: {
      offset: located.offset,
      originalText: located.text,
      replacementText,
      criterion: '4.1.2',
      rationale:
        `Replaced div-soup accordion (${ir.items.length} sections) with the Prism ARIA Accordion widget. ` +
        `Headers and panel content preserved verbatim; keyboard model now follows the APG accordion pattern.`
    },
    candidateDescendants: ir.candidateDescendants
  };
}

function decline(file, wrapper, $, ir, reason, ruleId) {
  return {
    kind: 'decline',
    deferred: {
      criterion: '4.1.2',
      triage: TRIAGE,
      reason: `[${ruleId}] ${reason}`,
      file: file.path,
      line: lineForElement(file.content, wrapper, $)
    },
    candidateDescendants: ir.candidateDescendants
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
    const text = (s.children || []).map((c) => (c.type === 'text' ? c.data || '' : '')).join('');
    const compact = text.replace(/\s+/g, '');
    if (!compact) continue;
    const hasControlFlow = /(?:function\s|=>|if\s*\(|for\s*\(|while\s*\(|switch\s*\(|class\s|new\s+[A-Z])/.test(text);
    if (compact.length > 80 || hasControlFlow) {
      return 'Source contains a nested <script> with non-trivial logic. The replacement script may conflict with bespoke behaviour.';
    }
  }
  return null;
}

function hasHashOpenBehaviour($, $wrapper, ir) {
  const sectionIds = ir.panelElements
    .filter((p) => p && p.attribs && p.attribs.id)
    .map((p) => p.attribs.id);
  if (sectionIds.length === 0) return false;
  const root = $.root();
  let hit = false;
  root.find('a[href]').each((_, a) => {
    if (hit) return;
    const href = $(a).attr('href') || '';
    if (!href.startsWith('#')) return;
    const targetId = href.slice(1);
    if (sectionIds.includes(targetId)) {
      // Anchor inside the wrapper itself is the trigger reference, not external nav.
      if ($(a).closest($wrapper).length > 0) return;
      hit = true;
    }
  });
  return hit;
}

function triggersHaveBlockChildren(triggerElements) {
  const block = new Set([
    'div', 'section', 'article', 'aside', 'header', 'footer', 'main',
    'nav', 'ul', 'ol', 'li', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table'
  ]);
  for (const t of triggerElements) {
    const stack = (t.children || []).slice();
    while (stack.length > 0) {
      const n = stack.shift();
      if (!n) continue;
      if (n.type === 'tag') {
        const name = (n.name || '').toLowerCase();
        if (block.has(name) && !['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(name)) return true;
      }
    }
  }
  return false;
}

function sectionHasRowClick(sectionElements) {
  for (const s of sectionElements) {
    if (s && s.attribs && s.attribs.onclick) return true;
  }
  return false;
}

function chooseHeadingLevel($, $wrapper) {
  // Pick the next level deeper than the deepest heading already on the page
  // (or h3 by default). Caps at h6.
  const levels = [];
  $.root().find('h1,h2,h3,h4,h5,h6').each((_, el) => {
    const n = parseInt(el.name.slice(1), 10);
    if (!Number.isNaN(n)) levels.push(n);
  });
  if (levels.length === 0) return 'h3';
  const deepest = Math.max(...levels);
  return 'h' + Math.min(6, deepest + 1);
}

/**
 * Build the IR. Strategy:
 *   - Look for "section" wrappers — direct children of the accordion that
 *     contain both a trigger and a panel.
 *   - A trigger is a clickable element with class containing 'header' /
 *     'trigger' OR data-target / aria-controls / href="#id" referencing a
 *     panel id. A panel has a panel-class token and is a sibling of the
 *     trigger.
 */
function extractIR($, $wrapper) {
  const candidateDescendants = [];

  // Look for direct-child sections.
  const childGroups = $wrapper.children().toArray();

  // Strategy A: each child is a section containing a trigger + a panel.
  let sectionGroups = childGroups
    .map((sec) => {
      const $sec = $(sec);
      // Trigger: first descendant clickable matching header/trigger semantics
      const trigger = findTrigger($, $sec);
      if (!trigger) return null;
      const panel = findPanelForTrigger($, $sec, trigger, $wrapper);
      if (!panel) return null;
      if (trigger === panel) return null;
      return { section: sec, trigger, panel };
    })
    .filter(Boolean);

  if (sectionGroups.length < MIN_SECTIONS) {
    // Strategy B: triggers and panels are alternating siblings inside the
    // wrapper itself (not grouped per section).
    sectionGroups = [];
    const triggers = childGroups.filter((c) => isTriggerLike($, $(c)));
    const panels = childGroups.filter((c) => hasClassToken(c, PANEL_CLASS_TOKENS) && !triggers.includes(c));
    if (triggers.length >= MIN_SECTIONS && panels.length >= triggers.length) {
      for (let i = 0; i < triggers.length; i++) {
        const trig = triggers[i];
        const ref = panelIdRef($, trig);
        let panel = null;
        if (ref) {
          const $p = $wrapper.find(`#${cssEscape(ref)}`);
          if ($p.length > 0) panel = $p[0];
        }
        if (!panel) panel = panels[i];
        if (panel) {
          sectionGroups.push({ section: null, trigger: trig, panel });
        }
      }
    }
  }

  if (sectionGroups.length < MIN_SECTIONS) return null;

  candidateDescendants.push(...sectionGroups.map((g) => g.section).filter(Boolean));
  candidateDescendants.push(...sectionGroups.map((g) => g.trigger));
  candidateDescendants.push(...sectionGroups.map((g) => g.panel));

  const items = sectionGroups.map((g) => {
    const $t = $(g.trigger);
    const $p = $(g.panel);
    const label = extractLabel($t);
    const panelHTML = $p.html() || '';
    const expanded = isInitiallyExpanded($t, $p);
    return { label, panelHTML, initiallyExpanded: expanded };
  });

  return {
    items,
    sectionElements: sectionGroups.map((g) => g.section).filter(Boolean),
    triggerElements: sectionGroups.map((g) => g.trigger),
    panelElements: sectionGroups.map((g) => g.panel),
    candidateDescendants
  };
}

function isTriggerLike($, $el) {
  const tag = ($el[0] && $el[0].name || '').toLowerCase();
  if (tag === 'button' || tag === 'a') return true;
  if ($el.attr('onclick')) return true;
  if ($el.attr('role') === 'button') return true;
  if (hasClassToken($el[0] || {}, HEADER_CLASS_TOKENS)) return true;
  return false;
}

function findTrigger($, $sec) {
  // Order matters: first try button/a, then onclick, then class signal.
  const explicit = $sec.find('button, a, [onclick], [role="button"]').toArray();
  for (const el of explicit) {
    // Skip elements inside a panel.
    if ($(el).parents().toArray().some((p) => hasClassToken(p, PANEL_CLASS_TOKENS))) continue;
    return el;
  }
  // Fallback: header-classed div.
  const headerClassed = $sec.find('*').toArray().find((el) => hasClassToken(el, HEADER_CLASS_TOKENS));
  return headerClassed || null;
}

function findPanelForTrigger($, $sec, trigger, $wrapper) {
  // Strategy 1: aria-controls / data-target / href -> id within $wrapper
  const ref = panelIdRef($, trigger);
  if (ref) {
    const $p = $wrapper.find(`#${cssEscape(ref)}`);
    if ($p.length > 0) return $p[0];
  }
  // Strategy 2: panel-class sibling within $sec
  const inSec = $sec.find('*').toArray().find((el) => el !== trigger && hasClassToken(el, PANEL_CLASS_TOKENS));
  if (inSec) return inSec;
  // Strategy 3: next-sibling of trigger
  const next = $(trigger).next();
  if (next.length > 0) return next[0];
  return null;
}

function panelIdRef($, el) {
  const $t = $(el);
  const ac = $t.attr('aria-controls');
  if (ac) return ac.replace(/^#/, '').trim();
  const dt = $t.attr('data-target') || $t.attr('data-bs-target');
  if (dt) return dt.replace(/^#/, '').trim();
  const href = $t.attr('href');
  if (href && href.startsWith('#')) return href.slice(1).trim();
  return null;
}

function extractLabel($t) {
  // Prefer a heading or .label child if present; otherwise use text.
  const heading = $t.find('h1, h2, h3, h4, h5, h6').first();
  if (heading.length > 0) return heading.text().trim();
  return $t.text().trim();
}

function isInitiallyExpanded($t, $p) {
  if ($t.attr('aria-expanded') === 'true') return true;
  const tCls = ($t.attr('class') || '').toLowerCase();
  if (/\b(active|open|expanded|in)\b/.test(tCls)) return true;
  const pCls = ($p.attr('class') || '').toLowerCase();
  if (/\b(in|show|open)\b/.test(pCls)) {
    if ($p.attr('hidden') === undefined) return true;
  }
  return false;
}

function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function renderAccordion(ir, idBase, headingLevel) {
  void loadTemplate(); // touch to surface bit-rot

  const sections = ir.items
    .map((it, i) => {
      const headerId = `${idBase}-header-${i}`;
      const panelId = `${idBase}-panel-${i}`;
      const expanded = it.initiallyExpanded ? 'true' : 'false';
      const hidden = it.initiallyExpanded ? '' : '\n      hidden';
      return [
        '  <div class="prism-widget-accordion__section" data-prism-section>',
        `    <${headingLevel} class="prism-widget-accordion__heading">`,
        '      <button',
        '        type="button"',
        '        class="prism-widget-accordion__trigger"',
        `        id="${headerId}"`,
        `        aria-controls="${panelId}"`,
        `        aria-expanded="${expanded}"`,
        '        data-prism-trigger',
        '      >',
        `        <span class="prism-widget-accordion__label">${htmlEscape(it.label)}</span>`,
        '        <span class="prism-widget-accordion__chevron" aria-hidden="true">',
        '          <svg viewBox="0 0 16 16" width="12" height="12" focusable="false">',
        '            <path d="M3 5l5 6 5-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
        '          </svg>',
        '        </span>',
        '      </button>',
        `    </${headingLevel}>`,
        '    <div',
        '      class="prism-widget-accordion__panel"',
        `      id="${panelId}"`,
        '      role="region"',
        `      aria-labelledby="${headerId}"` + hidden,
        '      data-prism-panel',
        `    >${it.panelHTML}</div>`,
        '  </div>'
      ].join('\n');
    })
    .join('\n');

  return [
    '<div class="prism-widget-accordion" data-prism-widget="accordion">',
    sections,
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
  // Strip ALL whitespace to compare semantic word content. See sibling
  // transformer for rationale.
  return String(s || '').replace(/\s+/g, '');
}

function stableIdBase(filePath, line) {
  const safe = String(filePath).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `prism-acc-${safe}-${line}`;
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
      if (nth >= startFrom) return { offset: m.index, text: open, cursorAfter: nth + 1 };
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
