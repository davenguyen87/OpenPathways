/**
 * Full-tier transformer — Widget Replacement: Dialog (Modal).
 *
 * Detects div-soup modal/dialog patterns and replaces them with the vetted
 * ARIA-compliant Dialog widget shipped in `src/widgets/dialog/` (chunk 02).
 *
 * Conforms to the Transformer interface from `src/rebuild/types.js`.
 *
 * Detection (DOM signature):
 *   - Wrapper element whose class contains one of {modal, dialog, popup,
 *     lightbox} (case-insensitive).
 *   - Style attribute or class indicating fixed/absolute positioning with
 *     a high z-index.
 *   - A trigger element on the page that toggles visibility, matched by
 *     data-target / aria-controls / data-toggle="modal" referencing the
 *     dialog element id.
 *   - Optional close button inside the dialog.
 *
 * Triggers on the page get rewritten to <button> with aria-haspopup="dialog"
 * and aria-controls referencing the dialog id.
 *
 * Decline rules (general):
 *   - <form> in source -> decline (overlap with chunk 02 README rule 2)
 *   - Nested <script> with non-trivial logic -> decline
 *   - Text-content hash mismatch -> decline
 *   - Per-page item count cap N/A (a page rarely has many modals;
 *     enforced as a soft cap of 8 to avoid pathological inputs)
 *   - No matching audit finding (1.3.1 / 2.1.1 / 2.4.3 / 4.1.2) -> decline
 *
 * Decline rules (dialog README, chunk 02):
 *   - Multiple modal layers (dialog inside dialog).
 *   - Dialog hosts a <form> whose submit reloads the host SCO.
 *   - Source dialog is a viewport takeover with no close button.
 *   - Source uses inert document siblings (aria-hidden="true" on body
 *     siblings — v5 doesn't ship inert polyfilling).
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

const TRANSFORMER_ID = 'widget-replacement-dialog';
const FAMILY = 'widget';
const CRITERIA = ['1.3.1', '2.1.1', '2.4.3', '4.1.2'];
const TRIAGE = 'author rework';
const TIER = 'full';
const PROVENANCE = 'rule-based';
const WIDGET_FAMILY = 'dialog';

const MAX_DIALOGS_PER_PAGE = 8; // soft cap, not from README

const DIALOG_CLASS_TOKENS = ['modal', 'dialog', 'popup', 'lightbox'];

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
  name: 'Replace div-soup modals with ARIA Dialog widget',
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

      // LLM judgment: classify each heuristic dialog candidate before emitting
      // patches. Dialog plans include dialog-wrapper subs and per-trigger-rewrite
      // subs in one flat array. We only call the LLM on the dialog wrappers
      // (they carry the full dialog HTML); trigger subs always flow through
      // unchanged. If the LLM rejects the dialog wrapper, the trigger rewrite
      // associated with that dialog still ships — the consultant catches the
      // mismatch at checkpoint review. (Wholesale dialog+trigger filtering by
      // ID is a v5.2 nicety; today's heuristic emits triggers only when the
      // dialog matches, so this edge case is rare.)
      const dialogSubs = plan.substitutions.filter(
        (s) => s.rationale && /dialog|modal/i.test(s.rationale)
      );
      const acceptedDialogSubs = [];
      const droppedDialogIds = new Set();
      const otherSubs = plan.substitutions.filter((s) => !dialogSubs.includes(s));

      for (const sub of dialogSubs) {
        if (packageContext.provider) {
          const $ = cheerio.load(file.content, { decodeEntities: false });
          const candidateRoot = $('*').toArray().find((el) =>
            el.attribs && hasClassToken(el, DIALOG_CLASS_TOKENS)
          );
          const structure = candidateRoot ? {
            tagName: (candidateRoot.name || 'div').toLowerCase(),
            childCount: (candidateRoot.children || []).filter((c) => c.type === 'tag').length,
            hasButtons: $(candidateRoot).find('button, [role="button"], [data-dismiss]').length > 0,
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
              rationale: `matched DIALOG_CLASS_TOKENS on wrapper; ${structure.childCount} children`
            },
            expectedType: 'dialog',
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
                reason: `LLM rejected as not a dialog widget: ${result.rationale}`,
                file: file.path,
                line: 0
              });
              droppedDialogIds.add(sub.offset);
              continue;
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
        acceptedDialogSubs.push(sub);
      }

      // Compose the final substitution list. When no provider is set,
      // acceptedDialogSubs === dialogSubs and otherSubs is everything else, so
      // finalSubs equals plan.substitutions byte-for-byte (preserving the v5
      // round-trip contract that revert tests rely on).
      const finalSubs = packageContext.provider
        ? [...acceptedDialogSubs, ...otherSubs]
        : plan.substitutions;
      if (finalSubs.length === 0) continue;
      void droppedDialogIds;

      const mods = finalSubs.map((s) => ({
        offset: s.offset,
        originalText: s.originalText,
        replacementText: s.replacementText
      }));

      for (const sub of finalSubs) {
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
      log.push(`[${TRANSFORMER_ID}] replaced ${acceptedDialogSubs.length} dialog(s) in ${file.path}`);
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
          ? 'No div-soup modal patterns met the rule-based substitution criteria.'
          : `Replaced ${patches.length} div-soup modal(s) with the Prism ARIA Dialog widget across ${filesAffected.size} page(s).`,
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

  // A wrapper is a candidate when its class contains a dialog token AND it
  // looks like an absolute/fixed positioned overlay (style or positioning
  // class). The .modal class is enough on its own — bootstrap convention.
  const wrappers = $('*')
    .toArray()
    .filter((el) => hasClassToken(el, DIALOG_CLASS_TOKENS))
    .filter((el) => looksPositioned(el));

  if (wrappers.length > MAX_DIALOGS_PER_PAGE) {
    declines.push({
      criterion: '4.1.2',
      triage: TRIAGE,
      reason: `[too-many-dialogs] Page contains ${wrappers.length} modal-like elements (cap ${MAX_DIALOGS_PER_PAGE}). Defer to author rework.`,
      file: file.path,
      line: 0
    });
    return { substitutions, declines };
  }

  const locator = createSourceLocator(file.content);
  const claimed = new WeakSet();

  for (const wrapper of wrappers) {
    if (claimed.has(wrapper)) continue;
    if (ancestorIsClaimed($(wrapper), claimed)) continue;

    const decision = analyzeWrapper($, wrapper, file, findings, bypass, locator);

    if (decision.kind === 'decline') {
      declines.push(decision.deferred);
      claimed.add(wrapper);
      for (const d of decision.candidateDescendants || []) claimed.add(d);
      continue;
    }
    if (decision.kind === 'accept') {
      claimed.add(wrapper);
      for (const d of decision.candidateDescendants || []) claimed.add(d);
      // Trigger patches stored in the substitution; sub patches added below.
      substitutions.push(decision.substitution);
      // Trigger substitutions are independent patches — add them too.
      for (const trig of decision.triggerSubstitutions || []) {
        substitutions.push(trig);
      }
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

function looksPositioned(el) {
  const cls = ((el.attribs && el.attribs.class) || '').toLowerCase();
  const tokens = cls.split(/\s+/).filter(Boolean);
  // Whole-token match only — `.modal-body` is NOT `.modal`.
  if (tokens.includes('modal') || tokens.includes('popup') || tokens.includes('lightbox')) return true;
  // dialog token without positioning may match too many divs; require style hint.
  const style = ((el.attribs && el.attribs.style) || '').toLowerCase();
  const hasDialogToken = tokens.includes('dialog');
  if (/position\s*:\s*(fixed|absolute)/.test(style) && hasDialogToken) return true;
  if (/z-index\s*:\s*\d{2,}/.test(style) && hasDialogToken) return true;
  // fallback: explicit role="dialog"
  if ((el.attribs && el.attribs.role) === 'dialog') return true;
  return false;
}

function analyzeWrapper($, wrapper, file, findings, bypass, locator) {
  const $wrapper = $(wrapper);
  const ir = extractIR($, $wrapper);
  if (!ir) return { kind: 'skip' };

  if (!bypass && !hasMatchingFinding(findings, file.path, CRITERIA)) {
    return decline(file, wrapper, $, ir,
      'Audit findings list does not include a 1.3.1/2.1.1/2.4.3/4.1.2 violation on this page that the Dialog widget would resolve.',
      'no-matching-finding');
  }

  // Decline rule: <form> in the dialog body.
  if ($wrapper.find('form').length > 0) {
    return decline(file, wrapper, $, ir,
      'Source dialog hosts a <form>. Submit handlers may reload the host SCO; focus restoration becomes meaningless after navigation.',
      'form-in-source');
  }

  // Decline rule: nested dialog (modal-inside-modal). Only flag when the
  // inner element ALSO satisfies looksPositioned — otherwise a child
  // `.modal-body` falsely registers as a nested modal.
  const nested = $wrapper.find('*').toArray().filter((el) => el !== wrapper && looksPositioned(el));
  if (nested.length > 0) {
    return decline(file, wrapper, $, ir,
      'Source has multiple modal layers (dialog inside dialog). Skill Loop\'s house style is one modal at a time.',
      'nested-dialog');
  }

  const scriptDecline = scriptDeclineReason($wrapper);
  if (scriptDecline) {
    return decline(file, wrapper, $, ir, scriptDecline, 'nested-script');
  }

  // Decline rule: viewport-takeover with no close button.
  if (looksLikeTakeover($wrapper) && !hasCloseButton($, $wrapper)) {
    return decline(file, wrapper, $, ir,
      'Source dialog is a viewport takeover with no close affordance. That\'s a screen, not a dialog — recommend page split.',
      'viewport-takeover-no-close');
  }

  // Decline rule: inert siblings.
  if (usesInertSiblings($, $wrapper)) {
    return decline(file, wrapper, $, ir,
      'Source uses inert/aria-hidden siblings on document body. v5 does not ship inert polyfilling — defer rather than ship a partial fix.',
      'inert-siblings');
  }

  const located = locator.consumeOuter(wrapper, file.content);
  if (!located) {
    return decline(file, wrapper, $, ir,
      'Could not unambiguously locate the wrapper element in source — declined.',
      'source-locate-failed');
  }

  const idBase = stableIdBase(file.path, located.offset);
  const replacementText = renderDialog(ir, idBase);

  // Content-loss check: compare ONLY the title + body content (the parts
  // the IR captures). Close-button glyph text and other widget chrome are
  // replaced with the widget's own labelled affordances, so we don't
  // compare wrapper-level text wholesale.
  const beforeBody = ir.bodyHTML || '';
  const beforeBodyText = normalizeText(cheerio.load(`<div>${beforeBody}</div>`, { decodeEntities: false }).root().text());
  const beforeTitleText = normalizeText(ir.title || '');
  const beforeKey = beforeTitleText + '|' + beforeBodyText;

  const $rendered = cheerio.load(replacementText, { decodeEntities: false });
  const afterTitle = normalizeText($rendered('.prism-widget-dialog__title').text());
  const afterBody = normalizeText($rendered('.prism-widget-dialog__body').text());
  const afterKey = afterTitle + '|' + afterBody;

  if (beforeKey !== afterKey) {
    return decline(file, wrapper, $, ir,
      'Substitution would lose source text content — IR extraction is incomplete for this pattern.',
      'content-loss');
  }

  // Trigger rewrites — page-side triggers that toggle this dialog get
  // promoted to <button aria-haspopup="dialog" aria-controls="...">.
  const triggerSubstitutions = [];
  if (ir.triggers && ir.triggers.length > 0) {
    for (const trig of ir.triggers) {
      const trigLocated = locator.consumeOuter(trig, file.content);
      if (!trigLocated) continue; // soft-fail trigger rewrites
      const trigReplacement = renderTriggerButton($, trig, idBase);
      // Skip if no actual change.
      if (trigReplacement === trigLocated.text) continue;
      triggerSubstitutions.push({
        offset: trigLocated.offset,
        originalText: trigLocated.text,
        replacementText: trigReplacement,
        criterion: '4.1.2',
        rationale: `Rewrote dialog trigger as <button aria-haspopup="dialog" aria-controls="${idBase}-dialog"> to provide an accessible name and proper role to assistive technology.`
      });
    }
  }

  return {
    kind: 'accept',
    substitution: {
      offset: located.offset,
      originalText: located.text,
      replacementText,
      criterion: '4.1.2',
      rationale:
        `Replaced div-soup modal with the Prism ARIA Dialog widget. ` +
        `Title and body content preserved verbatim; keyboard model now follows the APG dialog (modal) pattern with focus trap and Escape to close.`
    },
    triggerSubstitutions,
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
    candidateDescendants: (ir && ir.candidateDescendants) || []
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

function looksLikeTakeover($wrapper) {
  const style = ($wrapper.attr('style') || '').toLowerCase();
  // 100vw/100vh or width:100%; height:100%; overlay.
  if (/(width|min-width)\s*:\s*100(%|vw)/.test(style) && /(height|min-height)\s*:\s*100(%|vh)/.test(style)) return true;
  return false;
}

function hasCloseButton($, $wrapper) {
  const candidates = $wrapper.find('button, a, [role="button"], [data-dismiss], [data-bs-dismiss], .close, .modal-close, .dialog-close').toArray();
  for (const c of candidates) {
    const text = $(c).text().trim().toLowerCase();
    if (/close|dismiss|cancel|×|x/.test(text)) return true;
    const dd = (c.attribs && (c.attribs['data-dismiss'] || c.attribs['data-bs-dismiss']));
    if (dd) return true;
    const cls = ((c.attribs && c.attribs.class) || '').toLowerCase();
    if (/(close|dismiss)/.test(cls)) return true;
    const ariaLabel = ((c.attribs && c.attribs['aria-label']) || '').toLowerCase();
    if (/close|dismiss/.test(ariaLabel)) return true;
  }
  return false;
}

function usesInertSiblings($, $wrapper) {
  // Look at the wrapper's parent siblings for aria-hidden or inert.
  const parent = $wrapper.parent();
  if (parent.length === 0) return false;
  let found = false;
  parent.children().each((_, sib) => {
    if (sib === $wrapper[0]) return;
    if (sib.attribs && (sib.attribs['aria-hidden'] === 'true' || sib.attribs.inert !== undefined)) found = true;
  });
  return found;
}

function extractIR($, $wrapper) {
  const candidateDescendants = [];

  const dialogId = $wrapper.attr('id') || null;

  // Title — first heading inside the dialog, or a [role="heading"] element.
  let title = null;
  const heading = $wrapper.find('h1, h2, h3, h4, h5, h6, [role="heading"]').first();
  if (heading.length > 0) {
    title = heading.text().trim();
    candidateDescendants.push(heading[0]);
  }
  if (!title) {
    // Fall back to .modal-title / .dialog-title.
    const titled = $wrapper.find('.modal-title, .dialog-title, .title').first();
    if (titled.length > 0) {
      title = titled.text().trim();
      candidateDescendants.push(titled[0]);
    }
  }

  // Body — .modal-body / .dialog-body / role-aware fallback.
  let bodyHTML = null;
  const body = $wrapper.find('.modal-body, .dialog-body, .body').first();
  if (body.length > 0) {
    bodyHTML = body.html() || '';
    candidateDescendants.push(body[0]);
  } else {
    // Fall back: dialog inner = wrapper html minus heading.
    bodyHTML = $wrapper.html() || '';
  }

  // Find triggers on the document referencing this dialog.
  const triggers = [];
  if (dialogId) {
    const ref1 = $.root().find(`[data-target="#${cssAttr(dialogId)}"]`).toArray();
    const ref2 = $.root().find(`[data-bs-target="#${cssAttr(dialogId)}"]`).toArray();
    const ref3 = $.root().find(`[aria-controls="${cssAttr(dialogId)}"]`).toArray();
    const ref4 = $.root().find(`[href="#${cssAttr(dialogId)}"]`).toArray();
    const seen = new Set();
    for (const r of [...ref1, ...ref2, ...ref3, ...ref4]) {
      if (seen.has(r)) continue;
      // Skip elements inside the dialog itself.
      if ($(r).closest($wrapper).length > 0) continue;
      seen.add(r);
      triggers.push(r);
    }
  }

  return {
    title,
    bodyHTML,
    triggers,
    candidateDescendants
  };
}

function cssAttr(s) {
  return String(s).replace(/[\\"]/g, (c) => `\\${c}`);
}

function renderDialog(ir, idBase) {
  void loadTemplate(); // surface bit-rot

  const dialogId = `${idBase}-dialog`;
  const titleId = `${idBase}-title`;
  const descId = `${idBase}-desc`;
  const title = ir.title || 'Dialog';
  const triggerLabel = ir.title || 'Open dialog';

  return [
    '<div class="prism-widget-dialog-host" data-prism-widget="dialog">',
    '  <button',
    '    type="button"',
    '    class="prism-widget-dialog__trigger"',
    '    aria-haspopup="dialog"',
    `    aria-controls="${dialogId}"`,
    '    data-prism-trigger',
    `  >${htmlEscape(triggerLabel)}</button>`,
    '  <div',
    '    class="prism-widget-dialog__backdrop"',
    '    hidden',
    '    data-prism-backdrop',
    '  ></div>',
    '  <div',
    '    class="prism-widget-dialog"',
    `    id="${dialogId}"`,
    '    role="dialog"',
    '    aria-modal="true"',
    `    aria-labelledby="${titleId}"`,
    `    aria-describedby="${descId}"`,
    '    tabindex="-1"',
    '    hidden',
    '    data-prism-dialog',
    '  >',
    '    <div class="prism-widget-dialog__header">',
    `      <h2 class="prism-widget-dialog__title" id="${titleId}">${htmlEscape(title)}</h2>`,
    '      <button',
    '        type="button"',
    '        class="prism-widget-dialog__close"',
    '        aria-label="Close dialog"',
    '        data-prism-close',
    '      >',
    '        <svg viewBox="0 0 16 16" width="14" height="14" focusable="false" aria-hidden="true">',
    '          <path d="M3 3l10 10M13 3L3 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    '        </svg>',
    '      </button>',
    '    </div>',
    `    <p class="prism-widget-dialog__desc" id="${descId}"></p>`,
    `    <div class="prism-widget-dialog__body">${ir.bodyHTML || ''}</div>`,
    '  </div>',
    '</div>'
  ].join('\n');
}

function renderTriggerButton($, trig, idBase) {
  const dialogId = `${idBase}-dialog`;
  const $t = $(trig);
  const label = $t.text().trim() || 'Open dialog';
  return [
    `<button type="button" class="prism-widget-dialog__trigger" aria-haspopup="dialog" aria-controls="${dialogId}" data-prism-trigger>`,
    htmlEscape(label),
    '</button>'
  ].join('');
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
  return `prism-dlg-${safe}-${line}`;
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
      // Self-closing / void tags skip close-tag walk.
      if (isVoidTag(tagName) || /\/>$/.test(opening.text)) {
        cursor.set(k, opening.cursorAfter);
        return { offset: opening.offset, text: opening.text };
      }
      const matchingClose = findMatchingClose(content, tagName, opening.offset + opening.text.length);
      if (matchingClose === -1) return null;
      const text = content.slice(opening.offset, matchingClose + `</${tagName}>`.length);
      cursor.set(k, opening.cursorAfter);
      return { offset: opening.offset, text };
    }
  };
}

function isVoidTag(tagName) {
  return ['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'].includes(tagName);
}

function findNthOpeningTag(content, tagName, attribs, startFrom) {
  const re = new RegExp(`<${escapeRegex(tagName)}(\\s[^>]*)?\\/?>`, 'gi');
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
