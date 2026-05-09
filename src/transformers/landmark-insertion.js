/**
 * Full-tier transformer — Landmark Insertion.
 *
 * Promotes inferred wrapper elements (`<div>`, `<section>`) to ARIA landmark
 * elements (`<main>`, `<nav>`, `<header>`, `<footer>`) using class / id /
 * role / heading / position signals.
 *
 * Conforms to the Transformer interface documented in `src/rebuild/types.js`
 * (chunk 00). Produces ONE Transform per package, with one Patch per
 * promoted wrapper. Patches carry `tier: 'full'`, `triage: 'author rework'`,
 * and `transformId` linking back to the parent transform.
 *
 * Rule-based only — v5 ships landmarks as deterministic. LLM-mode landmark
 * detection is a v5.1 concern (see PRD § "Tier definitions: Full tier").
 *
 * @typedef {import('../rebuild/types').Patch} Patch
 * @typedef {import('../rebuild/types').Transform} Transform
 * @typedef {import('../rebuild/types').DeferredFinding} DeferredFinding
 */

const cheerio = require('cheerio');
const { buildPatch, revertPatch, applyMods, linkPatchToTransform } = require('../rebuild/types');

const TRANSFORMER_ID = 'landmark-insertion';
const FAMILY = 'landmark';
const CRITERIA = ['1.3.1', '2.4.1', '4.1.2'];
const TRIAGE = 'author rework';
const TIER = 'full';
const PROVENANCE = 'rule-based';

// Landmarks we know how to promote to. Order is significant for deterministic
// detection priority within a single page (header/nav scanned before main so
// the same div isn't claimed twice).
const LANDMARK_ROLES = ['header', 'nav', 'main', 'footer'];

// HTML5 elements that, if present, mean the page already has the landmark
// for that role and we should not double-up.
const LANDMARK_TAG_BY_ROLE = {
  header: 'header',
  nav: 'nav',
  main: 'main',
  footer: 'footer'
};

// Class / id signals per role. Lower-cased; matched case-insensitively.
const CLASS_ID_SIGNALS = {
  header: ['header', 'banner', 'page-header', 'site-header'],
  nav: ['nav', 'navigation', 'menu', 'main-nav', 'site-nav'],
  main: ['main', 'main-content', 'content', 'page-content', 'primary'],
  footer: ['footer', 'page-footer', 'site-footer']
};

// ARIA role signals per landmark.
const ARIA_ROLE_SIGNALS = {
  header: ['banner'],
  nav: ['navigation'],
  main: ['main'],
  footer: ['contentinfo']
};

// Block-level wrappers we will rewrite. <span> et al. are inline and rejected
// so we never produce <main class="…"> as a child of an inline parent.
const ALLOWED_WRAPPER_TAGS = new Set(['div', 'section', 'article', 'aside']);

// Skip-link href the v4 fixer always emits. If the page has a link with this
// href and we're promoting a wrapper to <main>, the wrapper must end up with
// id="main-content" or we decline so we don't leave a dangling target.
const V4_SKIP_LINK_HREF = '#main-content';
const V4_SKIP_LINK_TARGET_ID = 'main-content';

const COPYRIGHT_RE = /(?:©|\(c\)|copyright|all rights reserved)/i;

module.exports = {
  id: TRANSFORMER_ID,
  name: 'Insert ARIA landmarks',
  family: FAMILY,
  supported: ['scorm12', 'scorm2004'],
  criteria: CRITERIA,
  triage: TRIAGE,
  tier: TIER,
  provenance: PROVENANCE,

  /**
   * Package-level claim. Returns true when at least one HTML file in the
   * package is missing at least one detectable landmark.
   *
   * @param {{ files?: Array<{path:string,content:string,isHtml?:boolean}> }} packageContext
   * @returns {boolean}
   */
  canTransform(packageContext) {
    const files = htmlFiles(packageContext);
    for (const file of files) {
      const plan = planForFile(file);
      if (plan.promotions.length > 0) return true;
    }
    return false;
  },

  /**
   * Apply the transform across every HTML page in the package. Emits one
   * Patch per promoted wrapper plus one Transform that scopes them.
   *
   * Patch ids are local (`landmark-insertion-NNNN`); the orchestrator's
   * manifest.addPatch reassigns them to global `patch-NNNN` ids and
   * `addTransform` rewrites `patchIds` accordingly.
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
      for (const d of plan.declines) {
        deferred.push(d);
      }
      if (plan.promotions.length === 0) continue;

      // Build mods sorted by ascending offset for stable patch ordering.
      const mods = plan.promotions.map((p) => ({
        offset: p.offset,
        originalText: p.originalText,
        replacementText: p.replacementText
      }));

      // Build a Patch per promotion against the ORIGINAL content. buildPatch
      // captures correct line/col + context windows from the pre-edit file.
      for (const promo of plan.promotions) {
        const patch = buildPatch({
          fixer: TRANSFORMER_ID,
          criterion: promo.criterion,
          triage: TRIAGE,
          tier: TIER,
          confidence: promo.confidence,
          provenanceSource: PROVENANCE,
          file: file.path,
          content: file.content,
          originalOffset: promo.offset,
          originalText: promo.originalText,
          replacementText: promo.replacementText,
          rationale: promo.rationale,
          // Zero context window: a landmark promotion produces an opening
          // patch and a closing patch on potentially the same source line.
          // Wider context windows would interlock (each patch's `right`
          // would contain the other patch's modified text) and break the
          // indexOf-based revert. Zero-context patches use the bare opening
          // / closing tags, which are unique within a page once we've
          // declined duplicate-role promotions.
          contextChars: 0
        });
        patches.push(patch);
        filesAffected.add(file.path);
      }

      const newContent = applyMods(file.content, mods);
      updatedFiles.push({ path: file.path, newContent });
      log.push(
        `[${TRANSFORMER_ID}] promoted ${plan.promotions.length} wrapper(s) in ${file.path}`
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
      // Local placeholder ids — the orchestrator remaps to global patch-NNNN.
      patchIds: patches.map((_, i) => localPatchId(i)),
      provenance: transformProvenance,
      rationale:
        patches.length === 0
          ? 'No wrappers met the rule-based promotion criteria.'
          : `Promoted ${patches.length} wrapper element(s) to ARIA landmarks across ${filesAffected.size} page(s).`,
      previewPath: `rebuild-preview.html#${TRANSFORMER_ID}`,
      requiresCheckpointApproval: true,
      status: 'pending-checkpoint'
    };

    // Carry the local placeholder transformId on each patch so the orchestrator
    // can assert internal consistency before remapping.
    const linkedPatches = patches.map((p, i) => {
      const localId = localTransformId();
      // The orchestrator will overwrite this; we set it deterministically so
      // the relationship is auditable in tests that bypass the orchestrator.
      return { ...linkPatchToTransform(p, localId), _localPatchId: localPatchId(i) };
    });

    return {
      transform,
      patches: linkedPatches,
      log,
      deferred,
      // Surface the rewritten file content for the orchestrator (and tests)
      // to write to disk. The orchestrator already does this for fixers via
      // `result.newContent`; for package-level transformers we emit one entry
      // per touched file.
      updatedFiles
    };
  },

  /**
   * Atomic revert. Reverses every patch in the transform in reverse
   * application order on each file, producing byte-identical original
   * content. The orchestrator passes the current (post-apply) file state.
   *
   * @param {{ files: Array<{path:string,content:string}> }} packageContext
   * @param {Transform & { patches?: Patch[] }} transform - in tests we pass
   *   the patch array alongside; the manifest stores it separately and the
   *   orchestrator wires it through.
   * @returns {Promise<{patches: Patch[], log: string[], updatedFiles: Array<{path:string,newContent:string}>}>}
   */
  async revert(packageContext, transform) {
    const log = [];
    const patches = (transform && Array.isArray(transform.patches)) ? transform.patches : [];
    const filesByPath = new Map();
    for (const f of (packageContext && packageContext.files) || []) {
      filesByPath.set(f.path, f.content);
    }

    // Group patches by file so we can apply revertPatch in reverse order
    // per file (last-applied patch is reverted first, mirroring how
    // applyMods sorted them).
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
      // Reverse application order so revertPatch's indexOf finds the latest
      // (rightmost) `after` first; this mirrors applyMods's reverse-offset
      // application and round-trips byte-identically.
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

/**
 * Filter packageContext.files to HTML pages, sorted by path for determinism.
 * @param {object} packageContext
 * @returns {Array<{path:string,content:string,isHtml?:boolean}>}
 */
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
 * Build a per-file plan: which wrappers to promote, which roles to decline,
 * and why. Pure — does not mutate `file`.
 *
 * @param {{path:string,content:string}} file
 * @returns {{promotions: Array<Promotion>, declines: Array<DeferredFinding>}}
 */
function planForFile(file) {
  /** @type {Array<Promotion>} */
  const promotions = [];
  /** @type {Array<DeferredFinding>} */
  const declines = [];

  let $;
  try {
    // xmlMode:false so we get HTML5 parsing; decodeEntities:false to keep
    // existing entities in `before`/`after` byte-identical.
    $ = cheerio.load(file.content, { decodeEntities: false });
  } catch (_) {
    return { promotions, declines };
  }

  const body = $('body').first();
  if (body.length === 0) return { promotions, declines };

  // Roles already provided by an HTML5 element OR explicit role attribute on
  // a tag that is itself a landmark element. Used to suppress double-ups.
  const existingRoles = new Set();
  for (const role of LANDMARK_ROLES) {
    if ($(LANDMARK_TAG_BY_ROLE[role]).length > 0) {
      existingRoles.add(role);
    }
  }

  // Detect a v4 skip-link target. If present, every <main> promotion must
  // either land on a wrapper that already has id="main-content" or add it.
  const skipLinkPresent = $(`a[href="${V4_SKIP_LINK_HREF}"]`).length > 0;

  // Per-file source locator for resolving multiple-element ambiguity.
  const locator = createSourceLocator(file.content);

  // Depth-1 wrappers (direct children of <body>) — these are the candidates
  // for header / nav / main / footer.
  const candidates = body
    .children()
    .toArray()
    .filter((el) => ALLOWED_WRAPPER_TAGS.has((el.name || '').toLowerCase()));

  // Track which DOM nodes we've already claimed so a single wrapper can't be
  // promoted to two roles.
  const claimed = new WeakSet();

  // Two-pass detection. Explicit signals (class / id / role attribute) outrank
  // inferred signals. Inside each pass we walk roles header → nav → footer →
  // main so that explicit nav/header/footer signals on a wrapper that ALSO
  // happens to contain an <h1> aren't beaten by main's heading inference —
  // and so `main` (which has both class signals and inference rules) gets a
  // chance after the others' explicit claims are resolved.
  const roleOrder = ['header', 'nav', 'footer', 'main'];

  // PASS 1: explicit signals (class / id / role).
  for (const role of roleOrder) {
    if (existingRoles.has(role)) continue;
    const matches = collectExplicitMatches($, candidates, role, claimed);
    if (matches.length === 0) continue;
    if (matches.length > 1) {
      declines.push({
        criterion: '1.3.1',
        triage: TRIAGE,
        reason: `${matches.length} wrappers compete for landmark role "${role}" — declined to avoid mis-identifying ${role}.`,
        file: file.path,
        line: lineForElement($, file.content, matches[0].el)
      });
      // Mark claimed so later (inferred) rules don't grab one of the
      // ambiguous wrappers under a weaker signal.
      for (const m of matches) claimed.add(m.el);
      continue;
    }
    commitPromotion(matches[0], role);
  }

  // PASS 2: inferred signals (heading + position). Within this pass we put
  // <main> first because heading-based main inference is stronger than
  // position-based header inference (which would otherwise grab the same
  // wrapper if it sits at depth-1 position 0 and contains an <h1>).
  const inferredOrder = ['main', 'header', 'footer', 'nav'];
  for (const role of inferredOrder) {
    if (existingRoles.has(role)) continue;
    const matches = collectInferredMatches($, candidates, role, claimed);
    if (matches.length === 0) continue;
    if (matches.length > 1) {
      declines.push({
        criterion: '1.3.1',
        triage: TRIAGE,
        reason: `${matches.length} wrappers compete for landmark role "${role}" — declined to avoid mis-identifying ${role}.`,
        file: file.path,
        line: lineForElement($, file.content, matches[0].el)
      });
      for (const m of matches) claimed.add(m.el);
      continue;
    }
    commitPromotion(matches[0], role);
  }

  function commitPromotion(winner, role) {
    // Resolve <main>-specific skip-link coordination.
    let extraAttr = null;
    if (role === 'main' && skipLinkPresent) {
      const idAttr = $(winner.el).attr('id');
      if (!idAttr) {
        extraAttr = { name: 'id', value: V4_SKIP_LINK_TARGET_ID };
      } else if (idAttr !== V4_SKIP_LINK_TARGET_ID) {
        declines.push({
          criterion: '2.4.1',
          triage: TRIAGE,
          reason:
            `Skip-link points to #${V4_SKIP_LINK_TARGET_ID} but the candidate <main> wrapper has id="${idAttr}". ` +
            'Renaming the id risks breaking other references — declined.',
          file: file.path,
          line: lineForElement($, file.content, winner.el)
        });
        return;
      }
    }

    const located = locator.consume(winner.el);
    if (!located) {
      declines.push({
        criterion: winner.criterion,
        triage: TRIAGE,
        reason:
          `Could not locate the opening tag for the candidate ${role} wrapper unambiguously in source — declined.`,
        file: file.path,
        line: 0
      });
      return;
    }

    // Locate the matching closing tag by scanning from end-of-opening forward,
    // tracking depth so nested same-tag elements don't fool us.
    const tagName = (winner.el.name || '').toLowerCase();
    const closingOffset = findMatchingClose(file.content, located.offset + located.text.length, tagName);
    if (closingOffset === -1) {
      declines.push({
        criterion: winner.criterion,
        triage: TRIAGE,
        reason: `Could not locate the matching </${tagName}> for the candidate ${role} wrapper — declined.`,
        file: file.path,
        line: 0
      });
      return;
    }

    claimed.add(winner.el);

    const replacementText = rewriteOpeningTag(located.text, role, winner.removeRole, extraAttr);
    if (replacementText === located.text) return;

    const rationaleParts = [
      `Promoted .${describeWrapper(winner.el)} to <${role}> based on ${winner.signal}.`
    ];
    if (extraAttr) {
      rationaleParts.push(
        `Added id="${V4_SKIP_LINK_TARGET_ID}" to keep the existing skip-to-main-content link valid.`
      );
    }
    if (winner.removeRole) {
      rationaleParts.push(`Dropped redundant role="${winner.removeRole}".`);
    }

    // Promotion = TWO patches: opening + closing. Both carry the same
    // rationale; the orchestrator groups them under the parent transform.
    const closingOriginal = `</${tagName}>`;
    const closingReplacement = `</${role}>`;

    promotions.push({
      offset: located.offset,
      originalText: located.text,
      replacementText,
      role,
      criterion: winner.criterion,
      confidence: winner.confidence,
      rationale: rationaleParts.join(' ')
    });
    promotions.push({
      offset: closingOffset,
      originalText: closingOriginal,
      replacementText: closingReplacement,
      role,
      criterion: winner.criterion,
      confidence: winner.confidence,
      rationale: rationaleParts.join(' ') + ` Closing tag also rewritten to </${role}>.`
    });
  }

  // Stable ordering by offset (ascending) so re-runs produce identical output.
  promotions.sort((a, b) => a.offset - b.offset);

  return { promotions, declines };
}

/**
 * Collect candidate wrappers for `role` using EXPLICIT signals only:
 * priority 1 (class), 2 (id), 3 (role attribute). Higher priority short-
 * circuits — if class matches anything, we don't fall through to id/role.
 *
 * Returns 0..N matches; the caller declines on ≥2.
 */
function collectExplicitMatches($, candidates, role, claimed) {
  const classMatches = candidates.filter((el) => {
    if (claimed.has(el)) return false;
    const classes = ($(el).attr('class') || '').toLowerCase().split(/\s+/).filter(Boolean);
    return classes.some((c) => CLASS_ID_SIGNALS[role].includes(c));
  });
  if (classMatches.length > 0) {
    return classMatches.map((el) => ({
      el,
      signal: `class="${($(el).attr('class') || '').trim()}"`,
      confidence: 'definitive',
      criterion: criterionForRole(role),
      removeRole: redundantRoleAttr($, el, role)
    }));
  }

  const idMatches = candidates.filter((el) => {
    if (claimed.has(el)) return false;
    const id = ($(el).attr('id') || '').toLowerCase();
    return CLASS_ID_SIGNALS[role].includes(id);
  });
  if (idMatches.length > 0) {
    return idMatches.map((el) => ({
      el,
      signal: `id="${($(el).attr('id') || '').trim()}"`,
      confidence: 'definitive',
      criterion: criterionForRole(role),
      removeRole: redundantRoleAttr($, el, role)
    }));
  }

  const roleMatches = candidates.filter((el) => {
    if (claimed.has(el)) return false;
    const r = ($(el).attr('role') || '').toLowerCase();
    return ARIA_ROLE_SIGNALS[role].includes(r);
  });
  if (roleMatches.length > 0) {
    return roleMatches.map((el) => ({
      el,
      signal: `role="${($(el).attr('role') || '').trim()}"`,
      confidence: 'definitive',
      criterion: criterionForRole(role),
      removeRole: ($(el).attr('role') || '').trim()
    }));
  }

  return [];
}

/**
 * Collect candidate wrappers for `role` using INFERRED signals only:
 * heading-based for `<main>`, position-based for `<header>` / `<footer>`.
 * Run in pass 2 after explicit signals have claimed wrappers in pass 1.
 */
function collectInferredMatches($, candidates, role, claimed) {
  if (role === 'main') {
    const withH1 = candidates.filter(
      (el) => !claimed.has(el) && $(el).find('h1').length > 0
    );
    if (withH1.length > 0) {
      return withH1.map((el) => ({
        el,
        signal: 'contained <h1>',
        confidence: 'likely',
        criterion: '1.3.1',
        removeRole: null
      }));
    }
    const withH2 = candidates.filter(
      (el) => !claimed.has(el) && $(el).find('h2').length > 0
    );
    if (withH2.length > 0) {
      return [{
        el: withH2[0],
        signal: 'contained earliest <h2>',
        confidence: 'likely',
        criterion: '1.3.1',
        removeRole: null
      }];
    }
  }

  if (role === 'header' && candidates.length > 0) {
    const first = candidates[0];
    if (!claimed.has(first) && $(first).find('h1').length > 0) {
      return [{
        el: first,
        signal: 'first depth-1 wrapper containing <h1>',
        confidence: 'likely',
        criterion: '1.3.1',
        removeRole: null
      }];
    }
  }
  if (role === 'footer' && candidates.length > 0) {
    const last = candidates[candidates.length - 1];
    if (!claimed.has(last) && COPYRIGHT_RE.test($(last).text())) {
      return [{
        el: last,
        signal: 'last depth-1 wrapper containing copyright text',
        confidence: 'likely',
        criterion: '1.3.1',
        removeRole: null
      }];
    }
  }

  return [];
}

/**
 * If the element carries `role="<aria-role-for-this-landmark>"`, return the
 * exact role string so the rewrite can drop it as redundant. Otherwise null.
 */
function redundantRoleAttr($, el, role) {
  const r = ($(el).attr('role') || '').trim();
  if (!r) return null;
  return ARIA_ROLE_SIGNALS[role].includes(r.toLowerCase()) ? r : null;
}

/**
 * Build a per-file locator that walks source occurrences of opening tags
 * matching a given (tagName, attribSignature). The first `consume()` call
 * for a signature returns the first source match; the second returns the
 * second; etc. This correctly disambiguates cases where multiple wrappers
 * share an attribute signature (e.g. two `<div class="main">`).
 */
function createSourceLocator(source) {
  const cache = new Map();
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
  // Strip leading `<tag` and trailing `>`, then walk attributes.
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
 * Find the offset of the matching `</tag>` starting at `from`, tracking
 * nesting depth so a `<tag>...<tag>...</tag>...</tag>` chain resolves
 * to the correct close. Returns the offset of the `<` of the matching close,
 * or -1 if not found. Case-insensitive on tag name; preserves source bytes.
 */
function findMatchingClose(source, from, tagName) {
  const tag = tagName.toLowerCase();
  // Scan for `<tag` and `</tag>` tokens. Self-closing variants (`<tag .../>`
  // — rare for divs/sections but we handle just in case) don't increment.
  const re = new RegExp(`</?${escapeRegex(tag)}\\b([^>]*)>`, 'gi');
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(source)) !== null) {
    const tokenText = m[0];
    const isClose = tokenText.startsWith('</');
    const isSelfClose = !isClose && /\/\s*>$/.test(tokenText);
    if (isClose) {
      depth -= 1;
      if (depth === 0) return m.index;
    } else if (!isSelfClose) {
      depth += 1;
    }
  }
  return -1;
}

/**
 * Rewrite an opening tag to a new tag name. Preserves all attributes.
 * Optionally drops a redundant role and / or appends an id="…" attribute.
 */
function rewriteOpeningTag(openingTag, newTag, removeRoleValue, extraAttr) {
  // Replace the leading `<tag` with `<newTag`.
  let out = openingTag.replace(/^<\s*[a-zA-Z][\w-]*/, `<${newTag}`);

  // Drop redundant role attribute, preserving surrounding whitespace.
  if (removeRoleValue) {
    const re = new RegExp(
      `\\s+role\\s*=\\s*("${escapeRegex(removeRoleValue)}"|'${escapeRegex(removeRoleValue)}'|${escapeRegex(removeRoleValue)})`,
      'i'
    );
    out = out.replace(re, '');
  }

  // Add extra attribute if requested. Insert just before the closing `>`.
  if (extraAttr) {
    const closeIdx = out.lastIndexOf('>');
    if (closeIdx !== -1) {
      const inner = out.slice(1, closeIdx);
      out = `<${inner} ${extraAttr.name}="${extraAttr.value}">`;
    }
  }

  return out;
}

function describeWrapper(el) {
  const cls = (el.attribs && el.attribs.class) || '';
  if (cls) return cls.trim().split(/\s+/)[0];
  if (el.attribs && el.attribs.id) return `#${el.attribs.id}`;
  return (el.name || 'div');
}

function lineForElement($, source, el) {
  // Best-effort: locate the opening tag in source and translate to a 1-based
  // line. If we can't locate it, return 0 (matches DeferredFinding fallback).
  const opening = $.html(el).split('>')[0] + '>';
  const idx = source.indexOf(opening);
  if (idx === -1) return 0;
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function criterionForRole(role) {
  // Header / nav / footer absence is primarily a 1.3.1 (info & relationships)
  // failure; main absence additionally maps to 2.4.1 (bypass blocks). This
  // matters because the audit uses these criteria to attribute the patch
  // back to the underlying finding.
  if (role === 'main') return '2.4.1';
  if (role === 'nav') return '4.1.2';
  return '1.3.1';
}

function localPatchId(i) {
  return `${TRANSFORMER_ID}-patch-${String(i + 1).padStart(4, '0')}`;
}

function localTransformId() {
  return `${TRANSFORMER_ID}-local`;
}

/**
 * @typedef {Object} Promotion
 * @property {number} offset
 * @property {string} originalText
 * @property {string} replacementText
 * @property {string} role
 * @property {string} criterion
 * @property {'definitive'|'likely'} confidence
 * @property {string} rationale
 */
