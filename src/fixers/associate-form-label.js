/**
 * Associate <label> with form input via for / id when the relationship
 * is unambiguous within a parent block.
 *
 * "Unambiguous" means: within a single parent block element, exactly one
 * <label> without a `for` attribute and exactly one <input>/<textarea>/<select>
 * without an `id` attribute. If multiple labels, multiple unlabelled inputs,
 * or any pre-existing for/id is present in that block, the fixer declines.
 *
 * Resolves both 1.3.1 (info & relationships) and 3.3.2 (labels or instructions)
 * since a missing label association violates both. Per PRD v4 chunk 03 spec,
 * this fixer emits one Patch per (criterion, finding) pair: when both criteria
 * arrive for the same input, two patches are emitted with identical
 * before/after spans but distinct `criterion` fields. The underlying string
 * edit is applied only once (we dedupe by span offset). Round-trip is
 * preserved because revertPatch is a no-op when the after-text cannot be
 * located, so a second revert against the already-restored content is
 * harmless.
 */

const crypto = require('crypto');
const cheerio = require('cheerio');
const { buildPatch, revertPatch, applyMods } = require('../rebuild/types');

const FIXER_ID = 'associate-form-label';
// Module-level criterion is one of the two — per-patch criterion comes from
// the violation. 3.3.2 is the closer thematic match for label association.
const CRITERION = '3.3.2';
const SUPPORTED_CRITERIA = new Set(['1.3.1', '3.3.2']);
const ID_PREFIX = 'prism-label-';
// Block-level parents we'll scope the unambiguity check to. If the closest
// matching ancestor of the input has exactly one bare label and one bare
// input among its descendants, we treat the pair as unambiguous.
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'li',
  'td',
  'th',
  'fieldset',
  'form',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'body'
]);

module.exports = {
  id: FIXER_ID,
  name: 'Associate <label> with form input',
  supported: ['scorm12', 'scorm2004', 'aicc'],
  confidence: 'definitive',
  criterion: CRITERION,
  triage: 'auto-fix safe',
  tier: 'safe',
  provenance: 'deterministic',

  canFix(file, violation) {
    if (!file || !file.isHtml) return false;
    if (!violation) return false;
    if (!SUPPORTED_CRITERIA.has(violation.criterion)) return false;
    return true;
  },

  async apply(file, violations) {
    const original = file.content;
    const log = [];
    const patches = [];

    if (!file.isHtml) {
      return { changed: false, newContent: original, patches, log };
    }

    // sourceCodeLocationInfo gives us exact source offsets for every tag,
    // including the original (unnormalized) start-tag span — critical for
    // round-tripping `<input ... />` and other source-level oddities.
    const $ = cheerio.load(original, {
      decodeEntities: false,
      sourceCodeLocationInfo: true,
      withStartIndices: true,
      withEndIndices: true
    });

    const formElements = $('input, textarea, select').toArray();
    const pairs = [];

    for (let i = 0; i < formElements.length; i++) {
      const el = formElements[i];
      const $el = $(el);

      if (el.tagName === 'input') {
        const t = ($el.attr('type') || 'text').toLowerCase();
        if (t === 'hidden' || t === 'submit' || t === 'reset' || t === 'button' || t === 'image') {
          continue;
        }
      }
      if (typeof $el.attr('id') !== 'undefined') continue;

      const block = closestBlock(el);
      if (!block) continue;

      const $block = $(block);
      const blockLabels = $block.find('label').toArray();
      const blockInputs = $block.find('input, textarea, select').filter((_, x) => {
        if (x.tagName === 'input') {
          const t = ($(x).attr('type') || 'text').toLowerCase();
          if (t === 'hidden' || t === 'submit' || t === 'reset' || t === 'button' || t === 'image') {
            return false;
          }
        }
        return true;
      }).toArray();

      // Decline when any for/id already present in the block — that signals
      // the author has begun their own association scheme we shouldn't disturb.
      const anyExistingFor = blockLabels.some((l) => typeof $(l).attr('for') !== 'undefined');
      const anyExistingId = blockInputs.some((x) => typeof $(x).attr('id') !== 'undefined');
      if (anyExistingFor || anyExistingId) continue;

      const bareLabels = blockLabels.filter((l) => typeof $(l).attr('for') === 'undefined');
      // (All inputs in this block are bare since anyExistingId is false.)
      if (bareLabels.length !== 1 || blockInputs.length !== 1) continue;

      const label = bareLabels[0];
      const input = blockInputs[0];
      // Verify this iteration's element is the chosen input — keeps the loop
      // index aligned with the named/positional id-generation hash below.
      if (input !== el) continue;

      const name = $(input).attr('name') || '';
      const hash = crypto
        .createHash('sha256')
        .update(`${name}|${i}`)
        .digest('hex')
        .slice(0, 8);
      const generatedId = `${ID_PREFIX}${hash}`;

      pairs.push({ label, input, generatedId });
    }

    if (pairs.length === 0) {
      return { changed: false, newContent: original, patches, log };
    }

    // Decide which criteria each pair should produce patches for. The fixer
    // accepts violations bearing 1.3.1 and/or 3.3.2; emit one patch per
    // criterion arriving in the violations list. If no violations are passed
    // but pairs exist, fall back to module CRITERION (3.3.2) so the fixer
    // still works in apply-without-violations smoke tests.
    const incomingCriteria = new Set(
      (violations || [])
        .filter((v) => v && SUPPORTED_CRITERIA.has(v.criterion))
        .map((v) => v.criterion)
    );
    const criteriaForPair = incomingCriteria.size > 0
      ? Array.from(incomingCriteria).sort() // stable ordering
      : [CRITERION];

    const mods = [];
    const seenSpans = new Set();

    for (const pair of pairs) {
      const { label, input, generatedId } = pair;

      const labelStartTag = label.sourceCodeLocation && label.sourceCodeLocation.startTag;
      const inputStartTag = input.sourceCodeLocation && input.sourceCodeLocation.startTag;
      if (!labelStartTag || !inputStartTag) {
        log.push(`Missing source location for label/input pair (${generatedId}); skipped`);
        continue;
      }

      const labelTagStart = labelStartTag.startOffset;
      const labelTagEnd = labelStartTag.endOffset;
      const inputTagStart = inputStartTag.startOffset;
      const inputTagEnd = inputStartTag.endOffset;

      const spanStart = Math.min(labelTagStart, inputTagStart);
      const spanEnd = Math.max(labelTagEnd, inputTagEnd);
      const originalSpan = original.slice(spanStart, spanEnd);

      const labelTag = original.slice(labelTagStart, labelTagEnd);
      const inputTag = original.slice(inputTagStart, inputTagEnd);

      const newLabelTag = injectForAttribute(labelTag, generatedId);
      const newInputTag = injectIdAttribute(inputTag, generatedId);

      let replacementSpan;
      if (labelTagStart <= inputTagStart) {
        const labelLocal = labelTagStart - spanStart;
        const inputLocal = inputTagStart - spanStart;
        replacementSpan =
          originalSpan.slice(0, labelLocal) +
          newLabelTag +
          originalSpan.slice(labelLocal + labelTag.length, inputLocal) +
          newInputTag +
          originalSpan.slice(inputLocal + inputTag.length);
      } else {
        const inputLocal = inputTagStart - spanStart;
        const labelLocal = labelTagStart - spanStart;
        replacementSpan =
          originalSpan.slice(0, inputLocal) +
          newInputTag +
          originalSpan.slice(inputLocal + inputTag.length, labelLocal) +
          newLabelTag +
          originalSpan.slice(labelLocal + labelTag.length);
      }

      const spanKey = `${spanStart}:${spanEnd}`;
      if (!seenSpans.has(spanKey)) {
        seenSpans.add(spanKey);
        mods.push({ offset: spanStart, originalText: originalSpan, replacementText: replacementSpan });
        log.push(`Paired <label> with form input via id="${generatedId}" at offset ${spanStart}`);
      }

      for (const crit of criteriaForPair) {
        patches.push(
          buildPatch({
            fixer: FIXER_ID,
            criterion: crit,
            confidence: 'definitive',
            file: file.path,
            content: original,
            originalOffset: spanStart,
            originalText: originalSpan,
            replacementText: replacementSpan,
            rationale:
              'Single <label> and single form input in parent block; associated via generated for/id pair.'
          })
        );
      }
    }

    return {
      changed: patches.length > 0 && mods.length > 0,
      newContent: applyMods(original, mods),
      patches,
      log
    };
  },

  async revert(file, patch) {
    return revertPatch(file, patch);
  },

  async fix(file, violations) {
    const result = await this.apply(file, violations);
    return { changed: result.changed, newContent: result.newContent, log: result.log };
  }
};

/**
 * Walk up from `el` until we find a recognised block-level ancestor. Returns
 * null if traversal hits the root without matching.
 */
function closestBlock(el) {
  let cur = el.parent;
  while (cur && cur.type === 'tag') {
    if (BLOCK_TAGS.has(cur.tagName)) return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Insert `for="<id>"` into a `<label>` open tag. Assumes the tag has no
 * existing `for` attribute (caller validated).
 */
function injectForAttribute(tag, idValue) {
  return tag.replace(/\s*\/?>$/, (m) => ` for="${idValue}"${m}`);
}

/**
 * Insert `id="<id>"` into an input/textarea/select open tag. Assumes no
 * existing `id` attribute.
 */
function injectIdAttribute(tag, idValue) {
  return tag.replace(/\s*\/?>$/, (m) => ` id="${idValue}"${m}`);
}
