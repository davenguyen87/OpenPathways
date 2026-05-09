/**
 * Full-tier transformer — Landmark Labeling.
 *
 * When a page has multiple landmarks of the same role (e.g. two <nav>
 * elements: primary nav and secondary), labels each unlabeled landmark with
 * a distinct `aria-label` so screen reader users can distinguish them.
 *
 * Conforms to the Transformer interface in `src/rebuild/types.js` (chunk 00).
 * Designed to run AFTER landmark-insertion in the orchestrator's tier
 * dispatch — by that point, promoted wrappers carry their landmark tag and
 * are eligible for labeling. Coordination is the orchestrator's job; this
 * transformer does not call landmark-insertion directly.
 *
 * Rule-based only.
 *
 * @typedef {import('../rebuild/types').Patch} Patch
 * @typedef {import('../rebuild/types').Transform} Transform
 * @typedef {import('../rebuild/types').DeferredFinding} DeferredFinding
 */

const cheerio = require('cheerio');
const { buildPatch, revertPatch, applyMods, linkPatchToTransform } = require('../rebuild/types');

const TRANSFORMER_ID = 'landmark-labeling';
const FAMILY = 'landmark';
const CRITERIA = ['1.3.1', '4.1.2'];
const TRIAGE = 'author rework';
const TIER = 'full';
const PROVENANCE = 'rule-based';

const MAX_LABEL_LENGTH = 60;

// Landmark element names (HTML5) and their corresponding ARIA roles. We treat
// both forms as a single landmark for grouping purposes.
const LANDMARK_TAGS = {
  header: 'banner',
  nav: 'navigation',
  main: 'main',
  footer: 'contentinfo'
};

const ROLE_TO_LANDMARK = {
  banner: 'header',
  navigation: 'nav',
  main: 'main',
  contentinfo: 'footer'
};

// Documented positional fallback labels per role (greppable).
const POSITIONAL_FALLBACKS = {
  nav: ['Primary navigation', 'Secondary navigation', 'Footer navigation'],
  header: ['Primary header', 'Secondary header'],
  main: ['Primary content', 'Secondary content'],
  footer: ['Primary footer', 'Secondary footer']
};

module.exports = {
  id: TRANSFORMER_ID,
  name: 'Label duplicate ARIA landmarks',
  family: FAMILY,
  supported: ['scorm12', 'scorm2004'],
  criteria: CRITERIA,
  triage: TRIAGE,
  tier: TIER,
  provenance: PROVENANCE,

  /**
   * Returns true when at least one HTML page has multiple landmarks of the
   * same role and at least one of them lacks both `aria-label` and
   * `aria-labelledby`.
   *
   * @param {{ files?: Array<{path:string,content:string,isHtml?:boolean}> }} packageContext
   * @returns {boolean}
   */
  canTransform(packageContext) {
    const files = htmlFiles(packageContext);
    for (const file of files) {
      const plan = planForFile(file);
      if (plan.labelings.length > 0) return true;
    }
    return false;
  },

  /**
   * Apply: insert `aria-label="…"` on each unlabeled landmark in pages that
   * have duplicates. One Patch per inserted attribute.
   *
   * @param {{ files: Array<{path:string,content:string,isHtml?:boolean}> }} packageContext
   * @returns {Promise<{transform: Transform, patches: Patch[], log: string[], deferred: DeferredFinding[], updatedFiles: Array<{path:string,newContent:string}>}>}
   */
  async apply(packageContext) {
    const log = [];
    const patches = [];
    const deferred = [];
    const filesAffected = new Set();
    const updatedFiles = [];

    const files = htmlFiles(packageContext);
    for (const file of files) {
      const plan = planForFile(file);
      for (const d of plan.declines) deferred.push(d);
      if (plan.labelings.length === 0) continue;

      const mods = plan.labelings.map((l) => ({
        offset: l.offset,
        originalText: l.originalText,
        replacementText: l.replacementText
      }));

      for (const lab of plan.labelings) {
        const patch = buildPatch({
          fixer: TRANSFORMER_ID,
          criterion: lab.criterion,
          triage: TRIAGE,
          tier: TIER,
          confidence: lab.confidence,
          provenanceSource: PROVENANCE,
          file: file.path,
          content: file.content,
          originalOffset: lab.offset,
          originalText: lab.originalText,
          replacementText: lab.replacementText,
          rationale: lab.rationale,
          // Zero context for transformer patches; see landmark-insertion's
          // matching comment for the rationale (avoids cross-patch overlap
          // when multiple labels land on the same line).
          contextChars: 0
        });
        patches.push(patch);
        filesAffected.add(file.path);
      }

      const newContent = applyMods(file.content, mods);
      updatedFiles.push({ path: file.path, newContent });
      log.push(
        `[${TRANSFORMER_ID}] labeled ${plan.labelings.length} landmark(s) in ${file.path}`
      );
    }

    const transformProvenance = {
      source: PROVENANCE,
      timestamp: new Date().toISOString()
    };

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
      provenance: transformProvenance,
      rationale:
        patches.length === 0
          ? 'No duplicate landmarks needed labeling.'
          : `Labeled ${patches.length} landmark(s) across ${filesAffected.size} page(s).`,
      previewPath: `rebuild-preview.html#${TRANSFORMER_ID}`,
      requiresCheckpointApproval: true,
      status: 'pending-checkpoint'
    };

    const linkedPatches = patches.map((p, i) => ({
      ...linkPatchToTransform(p, localTransformId()),
      _localPatchId: localPatchId(i)
    }));

    return {
      transform,
      patches: linkedPatches,
      log,
      deferred,
      updatedFiles
    };
  },

  /**
   * Atomic revert. Reverses each patch on the supplied (post-apply) file
   * content. Round-trips byte-identical with the original.
   *
   * @param {{ files: Array<{path:string,content:string}> }} packageContext
   * @param {Transform & { patches?: Patch[] }} transform
   * @returns {Promise<{patches: Patch[], log: string[], updatedFiles: Array<{path:string,newContent:string}>}>}
   */
  async revert(packageContext, transform) {
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
        log.push(`[${TRANSFORMER_ID}] revert: file not in packageContext: ${filePath}`);
        for (const p of filePatches) reverted.push({ ...p, status: 'reverted' });
        continue;
      }
      const ordered = [...filePatches].sort(
        (a, b) => b.range.startLine - a.range.startLine
                || b.range.startCol - a.range.startCol
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
};

// ─────────────────────────────────────────────────────────────────────────────
// Detection internals
// ─────────────────────────────────────────────────────────────────────────────

function htmlFiles(packageContext) {
  const all = (packageContext && Array.isArray(packageContext.files)) ? packageContext.files : [];
  const html = all.filter((f) => {
    if (!f || typeof f.content !== 'string' || typeof f.path !== 'string') return false;
    if (f.isHtml === false) return false;
    return f.isHtml === true || /\.x?html?$/i.test(f.path);
  });
  return html.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Build a per-file plan: which landmarks need an aria-label and what the
 * label text should be. Pure.
 *
 * @param {{path:string,content:string}} file
 * @returns {{labelings: Array<Labeling>, declines: Array<DeferredFinding>}}
 */
function planForFile(file) {
  /** @type {Array<Labeling>} */
  const labelings = [];
  /** @type {Array<DeferredFinding>} */
  const declines = [];

  let $;
  try {
    $ = cheerio.load(file.content, { decodeEntities: false });
  } catch (_) {
    return { labelings, declines };
  }

  // Collect every landmark element on the page, in document order, grouped
  // by canonical role (header/nav/main/footer regardless of whether the
  // role came from the tag name or a `role=` attribute).
  const groups = { header: [], nav: [], main: [], footer: [] };

  // Pass 1: HTML5 landmark tags.
  for (const tag of Object.keys(LANDMARK_TAGS)) {
    $(tag).each((_, el) => {
      groups[tag].push({ el, source: 'tag' });
    });
  }

  // Pass 2: explicit role= on non-landmark tags so we don't double-count an
  // element that already showed up in pass 1.
  for (const role of Object.keys(ROLE_TO_LANDMARK)) {
    const canon = ROLE_TO_LANDMARK[role];
    $(`[role="${role}"]`).each((_, el) => {
      const name = (el.name || '').toLowerCase();
      if (name === canon) return; // already counted by pass 1
      groups[canon].push({ el, source: 'role' });
    });
  }

  // Sort each group by document position so positional fallbacks are stable.
  for (const role of Object.keys(groups)) {
    groups[role].sort((a, b) => domOrder(a.el, b.el));
  }

  // Per-file source-locator state: for elements whose attribute signature is
  // shared with other instances (e.g. two `<nav>` with no attributes), we
  // walk source matches in order and consume them as we go.
  const locator = createSourceLocator(file.content);

  // Build labelings only when a role group has 2+ entries.
  for (const role of Object.keys(groups)) {
    const list = groups[role];
    if (list.length < 2) continue;

    list.forEach((entry, idx) => {
      const $el = $(entry.el);
      if ($el.attr('aria-label') || $el.attr('aria-labelledby')) {
        // Already labeled — leave alone (per chunk 03 decline rule #1/#2).
        // Still consume a source slot so subsequent same-signature elements
        // pick up the right offset.
        locator.consume(entry.el);
        return;
      }

      const headingText = firstHeadingText($, entry.el);
      let labelText = null;
      let confidence = 'likely';
      let signal = '';

      if (headingText && headingText.length > 0) {
        labelText = truncate(headingText, MAX_LABEL_LENGTH);
        confidence = 'definitive';
        signal = `first heading "${labelText}"`;
      } else {
        const fallback = POSITIONAL_FALLBACKS[role];
        if (Array.isArray(fallback) && idx < fallback.length) {
          labelText = fallback[idx];
          confidence = 'likely';
          signal = `positional fallback (#${idx + 1} of ${list.length})`;
        }
      }

      if (!labelText) {
        // Consume the slot so subsequent landmarks pick up the right offset,
        // even though we're declining to label this one.
        locator.consume(entry.el);
        declines.push({
          criterion: '1.3.1',
          triage: TRIAGE,
          reason:
            `Landmark <${(entry.el.name || '').toLowerCase()}> #${idx + 1} of ${list.length} has no inner heading and ` +
            'no positional fallback applies — declined.',
          file: file.path,
          line: lineForElement($, file.content, entry.el)
        });
        return;
      }

      const located = locator.consume(entry.el);
      if (!located) {
        declines.push({
          criterion: '1.3.1',
          triage: TRIAGE,
          reason: 'Could not locate landmark opening tag unambiguously in source — declined.',
          file: file.path,
          line: 0
        });
        return;
      }

      const replacementText = injectAriaLabel(located.text, labelText);
      if (replacementText === located.text) return;

      labelings.push({
        offset: located.offset,
        originalText: located.text,
        replacementText,
        criterion: confidence === 'definitive' ? '1.3.1' : '4.1.2',
        confidence,
        rationale:
          `Multiple <${(entry.el.name || '').toLowerCase()}> / role="${LANDMARK_TAGS[role] || role}" landmarks on this page; ` +
          `labeled with aria-label="${labelText}" derived from ${signal}.`
      });
    });
  }

  // Stable order by offset.
  labelings.sort((a, b) => a.offset - b.offset);

  return { labelings, declines };
}

/**
 * First non-empty trimmed plain-text content of the first <h1>/<h2>/<h3>
 * inside `el`. Returns an empty string if none exists.
 */
function firstHeadingText($, el) {
  const $el = $(el);
  for (const h of ['h1', 'h2', 'h3']) {
    const found = $el.find(h).first();
    if (found.length === 0) continue;
    const text = found.text().replace(/\s+/g, ' ').trim();
    if (text.length > 0) return text;
  }
  return '';
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n).replace(/\s+\S*$/, '').trim() || s.slice(0, n).trim();
}

function domOrder(a, b) {
  // Walk parents of `a` to build a path then check ancestry against `b`.
  // For simplicity and because cheerio nodes carry `prev`/`next`/`parent`,
  // compare by traversal index from the root.
  const idxA = nodeIndex(a);
  const idxB = nodeIndex(b);
  // Compare path arrays element-wise.
  for (let i = 0; i < Math.min(idxA.length, idxB.length); i++) {
    if (idxA[i] !== idxB[i]) return idxA[i] - idxB[i];
  }
  return idxA.length - idxB.length;
}

function nodeIndex(el) {
  const path = [];
  let cur = el;
  while (cur && cur.parent) {
    const parent = cur.parent;
    const siblings = parent.children || [];
    const i = siblings.indexOf(cur);
    path.unshift(i);
    cur = parent;
  }
  return path;
}

/**
 * Build a per-file locator that, for each (tagName, attribSignature) pair,
 * walks the source's matching opening-tag occurrences in document order and
 * consumes them as `consume(el)` is called for elements with that signature.
 *
 * This handles the case where multiple landmarks have identical attributes
 * (e.g. two bare `<nav>` tags): the first call consumes the first source
 * occurrence, the second call consumes the second, etc.
 */
function createSourceLocator(source) {
  // signature → array of {offset, text}
  const cache = new Map();
  // signature → next index to consume
  const cursor = new Map();

  function signatureFor(tagName, attribs) {
    const ks = Object.keys(attribs).sort();
    const parts = [tagName];
    for (const k of ks) parts.push(`${k}=${String(attribs[k])}`);
    return parts.join('|');
  }

  function ensureMatches(tagName, attribs, signature) {
    if (cache.has(signature)) return cache.get(signature);
    const re = new RegExp(`<${escapeRegex(tagName)}(\\s[^>]*)?>`, 'gi');
    const matches = [];
    let m;
    while ((m = re.exec(source)) !== null) {
      const opening = m[0];
      const parsed = parseAttrs(opening);
      if (sameAttrs(parsed, attribs)) {
        matches.push({ offset: m.index, text: opening });
      }
    }
    cache.set(signature, matches);
    cursor.set(signature, 0);
    return matches;
  }

  return {
    consume(el) {
      const tagName = (el.name || '').toLowerCase();
      if (!tagName) return null;
      const attribs = el.attribs || {};
      const signature = signatureFor(tagName, attribs);
      const matches = ensureMatches(tagName, attribs, signature);
      const idx = cursor.get(signature) || 0;
      if (idx >= matches.length) return null;
      cursor.set(signature, idx + 1);
      return matches[idx];
    }
  };
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

/**
 * Insert `aria-label="<value>"` on an opening tag, just before the closing
 * `>`. Escapes double-quotes in the label value.
 */
function injectAriaLabel(openingTag, label) {
  const closeIdx = openingTag.lastIndexOf('>');
  if (closeIdx === -1) return openingTag;
  const escaped = label.replace(/"/g, '&quot;');
  const inner = openingTag.slice(1, closeIdx);
  return `<${inner} aria-label="${escaped}">`;
}

function lineForElement($, source, el) {
  const opening = $.html(el).split('>')[0] + '>';
  const idx = source.indexOf(opening);
  if (idx === -1) return 0;
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function localPatchId(i) {
  return `${TRANSFORMER_ID}-patch-${String(i + 1).padStart(4, '0')}`;
}

function localTransformId() {
  return `${TRANSFORMER_ID}-local`;
}

/**
 * @typedef {Object} Labeling
 * @property {number} offset
 * @property {string} originalText
 * @property {string} replacementText
 * @property {string} criterion
 * @property {'definitive'|'likely'} confidence
 * @property {string} rationale
 */
