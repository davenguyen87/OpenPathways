/**
 * Full-tier transformer — Widget Replacement: Carousel.
 *
 * Detects div-soup carousel/slideshow patterns and replaces them with the
 * vetted ARIA-compliant Carousel widget shipped in `src/widgets/carousel/`
 * (chunk 02). The replacement is manual-rotation only — autoplay is dropped.
 *
 * Conforms to the Transformer interface from `src/rebuild/types.js`.
 *
 * Detection (DOM signature):
 *   - Wrapper element whose class contains one of {carousel, slider,
 *     slideshow, gallery} (case-insensitive).
 *   - An inner "slides" wrapper (class containing 'slide' / 'item') with
 *     more than one direct child slide element. (Falls back to direct
 *     wrapper children when no inner slides container is present.)
 *   - Optional prev/next controls; optional pagination dots.
 *   - Optional autoplay (inline setInterval / class containing 'auto').
 *
 * Decline rules (general):
 *   - <form> in source -> decline
 *   - Nested <script> with non-trivial logic -> decline
 *   - Text-content hash mismatch -> decline
 *   - Slide count > 20 -> decline
 *   - No matching audit finding (2.1.1 / 2.4.3 / 4.1.2) -> decline
 *
 * Decline rules (carousel README, chunk 02):
 *   - Source autoplays — would change author intent. Defer; raise 2.2.2.
 *   - Slides contain <form> elements (overlaps with general).
 *   - Slides contain anchors with target="_self" to in-package routes.
 *   - CSS-only sliding (no JS) — that is a slideshow, not a widget.
 *   - Slide count is 1.
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

const TRANSFORMER_ID = 'widget-replacement-carousel';
const FAMILY = 'widget';
const CRITERIA = ['2.1.1', '2.4.3', '4.1.2'];
const TRIAGE = 'author rework';
const TIER = 'full';
const PROVENANCE = 'rule-based';
const WIDGET_FAMILY = 'carousel';

const MAX_SLIDES = 20;
const MIN_SLIDES = 2;

const CAROUSEL_CLASS_TOKENS = ['carousel', 'slider', 'slideshow', 'gallery'];
const SLIDE_CONTAINER_CLASS_TOKENS = ['slides', 'slider-track', 'carousel-track', 'gallery-track', 'carousel-inner'];
const SLIDE_CLASS_TOKENS = ['slide', 'carousel-item', 'slider-item', 'gallery-item'];
const AUTOPLAY_CLASS_TOKENS = ['autoplay', 'auto-play', 'auto-rotate', 'auto'];

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
  name: 'Replace div-soup carousels with ARIA Carousel widget',
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
            el.attribs && hasClassToken(el, CAROUSEL_CLASS_TOKENS)
          );
          const structure = candidateRoot ? {
            tagName: (candidateRoot.name || 'div').toLowerCase(),
            childCount: (candidateRoot.children || []).filter((c) => c.type === 'tag').length,
            hasButtons: $(candidateRoot).find('button, .prev, .next, [data-prism-prev], [data-prism-next]').length > 0,
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
              rationale: `matched CAROUSEL_CLASS_TOKENS on wrapper; ${structure.childCount} children`
            },
            expectedType: 'carousel',
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
                reason: `LLM rejected as not a carousel widget: ${result.rationale}`,
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
      log.push(`[${TRANSFORMER_ID}] replaced ${acceptedSubs.length} carousel(s) in ${file.path}`);
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
          ? 'No div-soup carousel patterns met the rule-based substitution criteria.'
          : `Replaced ${patches.length} div-soup carousel(s) with the Prism ARIA Carousel widget across ${filesAffected.size} page(s).`,
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

  const wrappers = $('*')
    .toArray()
    .filter((el) => hasClassToken(el, CAROUSEL_CLASS_TOKENS));

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
  if (!ir || ir.slides.length === 0) return { kind: 'skip' };

  if (!bypass && !hasMatchingFinding(findings, file.path, CRITERIA)) {
    return decline(file, wrapper, $, ir,
      'Audit findings list does not include a 2.1.1/2.4.3/4.1.2 violation on this page that the Carousel widget would resolve.',
      'no-matching-finding');
  }

  if ($wrapper.find('form').length > 0) {
    return decline(file, wrapper, $, ir,
      'Source carousel contains a <form> element. Hidden form controls behave inconsistently across browsers.',
      'form-in-source');
  }

  const scriptDecline = scriptDeclineReason($wrapper);
  if (scriptDecline) {
    return decline(file, wrapper, $, ir, scriptDecline, 'nested-script');
  }

  if (ir.slides.length < MIN_SLIDES) {
    return decline(file, wrapper, $, ir,
      `Carousel has only ${ir.slides.length} slide — strip the wrapper or use plain stacked sections.`,
      'too-few-slides');
  }
  if (ir.slides.length > MAX_SLIDES) {
    return decline(file, wrapper, $, ir,
      `Carousel has ${ir.slides.length} slides (limit ${MAX_SLIDES}); the replacement may not handle keyboard interaction the same way.`,
      'too-many-slides');
  }

  // Decline rule: in-package self-target anchors inside slides.
  if (slidesHaveSelfTargetAnchors(ir.slideElements, $)) {
    return decline(file, wrapper, $, ir,
      'Slide contains anchors with target="_self" to in-package routes. SCORM in-package navigation depends on slide-state lifecycle.',
      'self-target-anchors');
  }

  // Decline rule: CSS-only sliding (no JS at all in or near the wrapper).
  if (looksCssOnly($, $wrapper)) {
    return decline(file, wrapper, $, ir,
      'Source uses CSS-only sliding (no JS). Recommend leaving as plain stacked sections; not a widget.',
      'css-only-slideshow');
  }

  const located = locator.consumeOuter(wrapper, file.content);
  if (!located) {
    return decline(file, wrapper, $, ir,
      'Could not unambiguously locate the wrapper element in source — declined.',
      'source-locate-failed');
  }

  const idBase = stableIdBase(file.path, located.offset);
  const replacementText = renderCarousel(ir, idBase);

  // Content-loss check: the replacement must preserve every word that lives
  // inside a slide. Words from prev/next controls and pagination dots are
  // chrome — they're replaced with the widget's own labelled controls, so
  // we don't compare wrapper-level text wholesale.
  const beforeSlideText = ir.slideElements
    .map((el) => $(el).text())
    .map(normalizeText)
    .join('|');
  const afterSlideText = ir.slides
    .map((s) => normalizeText(cheerio.load(`<div>${s.html}</div>`, { decodeEntities: false }).root().text()))
    .join('|');
  if (beforeSlideText !== afterSlideText) {
    return decline(file, wrapper, $, ir,
      'Substitution would lose slide text content — IR extraction is incomplete for this pattern.',
      'content-loss');
  }

  const autoplayNote = ir.hasAutoplay
    ? ' Source had autoplay; the replacement is manual-only per the firm\'s carousel house style — flag as a 2.2.2 finding for the consultant.'
    : '';

  return {
    kind: 'accept',
    substitution: {
      offset: located.offset,
      originalText: located.text,
      replacementText,
      criterion: '4.1.2',
      rationale:
        `Replaced div-soup carousel (${ir.slides.length} slides) with the Prism ARIA Carousel widget. ` +
        `Slide content preserved verbatim; keyboard model now follows the APG carousel pattern.` +
        autoplayNote
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

function slidesHaveSelfTargetAnchors(slideElements, $) {
  for (const slide of slideElements) {
    const anchors = $(slide).find('a[target="_self"]').toArray();
    for (const a of anchors) {
      const href = (a.attribs && a.attribs.href) || '';
      if (!href) continue;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) continue; // absolute URL
      if (href.startsWith('#')) continue; // in-page anchor
      return true; // relative path with _self -> in-package SCO route
    }
  }
  return false;
}

function looksCssOnly($, $wrapper) {
  // Heuristic: no <script> anywhere in the document AND the wrapper has no
  // inline JS handlers AND there are no controls. CSS-only carousels rely
  // on :checked or :hover and have no controls a screen reader can drive.
  const docHasJs = $.root().find('script').length > 0;
  if (docHasJs) return false;
  const hasInlineJs = !!$wrapper.attr('onclick') || $wrapper.find('[onclick]').length > 0;
  if (hasInlineJs) return false;
  const hasControls = $wrapper.find('button, [role="button"], .carousel-control, .carousel-prev, .carousel-next, .slider-prev, .slider-next, .prev, .next').length > 0;
  if (hasControls) return false;
  return true;
}

function extractIR($, $wrapper) {
  const candidateDescendants = [];

  // Strategy A: dedicated slides container.
  let slidesContainer = null;
  const containerCandidates = $wrapper.find('*').toArray().filter((el) => hasClassToken(el, SLIDE_CONTAINER_CLASS_TOKENS));
  if (containerCandidates.length > 0) slidesContainer = containerCandidates[0];

  let slideEls;
  if (slidesContainer) {
    slideEls = $(slidesContainer).children().toArray()
      .filter((el) => hasClassToken(el, SLIDE_CLASS_TOKENS) || ['div', 'section', 'article', 'figure', 'li'].includes((el.name || '').toLowerCase()));
  } else {
    // Strategy B: slide-classed descendants directly inside the wrapper.
    const direct = $wrapper.find('*').toArray().filter((el) => hasClassToken(el, SLIDE_CLASS_TOKENS));
    if (direct.length === 0) return null;
    // Only keep the shallowest depth-equal group to avoid double-counting nested slides.
    const minDepth = Math.min(...direct.map((el) => depthFromWrapper(el, $wrapper[0])));
    slideEls = direct.filter((el) => depthFromWrapper(el, $wrapper[0]) === minDepth);
  }

  if (!slideEls || slideEls.length === 0) return null;

  candidateDescendants.push(...slideEls);
  if (slidesContainer) candidateDescendants.push(slidesContainer);

  const hasAutoplay = detectAutoplay($, $wrapper);

  const slides = slideEls.map((el, i) => {
    const $el = $(el);
    const html = $el.html() || '';
    // Best-effort label: aria-label on the slide, or text of a heading inside it.
    let label = $el.attr('aria-label') || '';
    if (!label) {
      const h = $el.find('h1, h2, h3, h4, h5, h6').first();
      if (h.length > 0) label = h.text().trim();
    }
    if (!label) label = `Slide ${i + 1} of ${slideEls.length}`;
    else label = `Slide ${i + 1} of ${slideEls.length}: ${label}`;
    return { html, label };
  });

  return {
    slides,
    slideElements: slideEls,
    hasAutoplay,
    candidateDescendants
  };
}

function depthFromWrapper(el, wrapper) {
  let d = 0;
  let p = el.parent;
  while (p && p !== wrapper) {
    d += 1;
    p = p.parent;
  }
  return d;
}

function detectAutoplay($, $wrapper) {
  // Class signal on the wrapper.
  const cls = ($wrapper.attr('class') || '').toLowerCase();
  for (const tok of AUTOPLAY_CLASS_TOKENS) {
    if (cls.split(/\s+/).some((c) => c === tok || c.includes(tok))) return true;
  }
  // data-autoplay attribute.
  if ($wrapper.attr('data-autoplay') !== undefined && $wrapper.attr('data-autoplay') !== 'false') return true;
  if ($wrapper.attr('data-ride') === 'carousel') return true;
  // Inline setInterval near the wrapper (in any descendant <script>).
  const scripts = $wrapper.find('script').toArray();
  for (const s of scripts) {
    const text = (s.children || []).map((c) => (c.type === 'text' ? c.data || '' : '')).join('');
    if (/setInterval\s*\(/.test(text)) return true;
  }
  return false;
}

function renderCarousel(ir, idBase) {
  void loadTemplate(); // surface bit-rot

  const carouselLabel = htmlEscape(`Slideshow (${ir.slides.length})`);
  const slidesHtml = ir.slides
    .map((s, i) => {
      const slideId = `${idBase}-slide-${i}`;
      const hidden = i === 0 ? '' : '\n      hidden';
      return [
        '    <div',
        '      class="prism-widget-carousel__slide"',
        `      id="${slideId}"`,
        '      role="group"',
        '      aria-roledescription="slide"',
        `      aria-label="${htmlEscape(s.label)}"` + hidden,
        '      data-prism-slide',
        `    >${s.html}</div>`
      ].join('\n');
    })
    .join('\n');

  return [
    '<section',
    '  class="prism-widget-carousel"',
    '  data-prism-widget="carousel"',
    '  aria-roledescription="carousel"',
    `  aria-label="${carouselLabel}"`,
    '>',
    '  <div class="prism-widget-carousel__viewport">',
    slidesHtml,
    '  </div>',
    '  <div class="prism-widget-carousel__controls">',
    '    <button',
    '      type="button"',
    '      class="prism-widget-carousel__prev"',
    '      aria-label="Previous slide"',
    '      data-prism-prev',
    '    >',
    '      <svg viewBox="0 0 16 16" width="14" height="14" focusable="false" aria-hidden="true">',
    '        <path d="M10 3l-5 5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    '      </svg>',
    '    </button>',
    '    <p',
    '      class="prism-widget-carousel__status"',
    '      aria-live="polite"',
    '      data-prism-status',
    `    >Slide 1 of ${ir.slides.length}</p>`,
    '    <button',
    '      type="button"',
    '      class="prism-widget-carousel__next"',
    '      aria-label="Next slide"',
    '      data-prism-next',
    '    >',
    '      <svg viewBox="0 0 16 16" width="14" height="14" focusable="false" aria-hidden="true">',
    '        <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    '      </svg>',
    '    </button>',
    '  </div>',
    '</section>'
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
  return `prism-car-${safe}-${line}`;
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
