/**
 * Normalize heading order — repairs two specific deterministic patterns:
 *   1. Missing <h1>: page has <h2> or lower but no <h1>; promote the first
 *      heading to <h1> when it is the unambiguous candidate.
 *   2. Orphan <h1>: a <section> or <article> contains an <h1> while another
 *      <h1> already exists outside that section at the same DOM depth;
 *      demote the orphan to <h2>.
 *
 * Declines on every other heading-skip pattern (h1 -> h3 with no h2,
 * arbitrary level skips, or ambiguous candidate selection). Safe-tier
 * means definitive only.
 *
 * Each heading change emits exactly one patch whose originalText spans
 * from the opening tag through the matching closing tag, so revertPatch
 * locates and reverses it as a single substring even when other patches
 * touch the same file.
 */

const cheerio = require('cheerio');
const { buildPatch, revertPatch, applyMods } = require('../rebuild/types');

const FIXER_ID = 'normalize-heading-order';
const CRITERION = '1.3.1';

/**
 * Locate the Nth open tag of a given heading level in `content`, in
 * document order. Returns the regex match (with .index and .[0]) or null.
 *
 * @param {string} content
 * @param {string} level - 'h1' | 'h2' | ...
 * @param {number} n - 0-based occurrence index
 */
function findNthHeadingOpen(content, level, n) {
  const re = new RegExp(`<${level}(\\s[^>]*)?>`, 'gi');
  let match;
  let i = 0;
  // eslint-disable-next-line no-cond-assign
  while ((match = re.exec(content)) !== null) {
    if (i === n) return match;
    i += 1;
  }
  return null;
}

/**
 * Given an open-tag match, return `{ originalText, openTagOnly }` covering
 * from the open tag through the matching close tag in the original
 * content. Returns null if the close tag isn't found.
 *
 * Heading elements may not legally contain another heading of the same
 * level, so the next </hN> after the open tag is the matching close.
 *
 * @param {string} content
 * @param {RegExpExecArray} openMatch
 * @param {string} level
 * @returns {{ originalText: string, openTag: string } | null}
 */
function spanHeadingElement(content, openMatch, level) {
  const openTag = openMatch[0];
  const openOffset = openMatch.index;
  const closeRe = new RegExp(`</${level}\\s*>`, 'i');
  const tail = content.slice(openOffset + openTag.length);
  const closeMatch = tail.match(closeRe);
  if (!closeMatch) return null;
  const totalLen = openTag.length + closeMatch.index + closeMatch[0].length;
  return {
    originalText: content.slice(openOffset, openOffset + totalLen),
    openTag
  };
}

/**
 * Decide whether the page is a candidate for Pattern 1 (missing h1).
 * Returns the level of the unambiguous candidate or null if ambiguous /
 * not applicable.
 *
 * @param {Array<{level: number}>} headings - in document order
 * @returns {{ candidateLevel: number } | null}
 */
function detectMissingH1(headings) {
  if (headings.length === 0) return null;
  const hasH1 = headings.some((h) => h.level === 1);
  if (hasH1) return null;
  const firstLevel = headings[0].level;
  // Ambiguous if more than one heading shares the first heading's level —
  // we can't tell which one is "the page title".
  const peers = headings.filter((h) => h.level === firstLevel).length;
  if (peers !== 1) return null;
  return { candidateLevel: firstLevel };
}

/**
 * Identify cheerio <h1> elements that are nested inside a <section> or
 * <article> while another <h1> exists OUTSIDE that section. Such inner
 * h1s are "orphans" and should be demoted.
 *
 * Returns the document-order index (among all <h1>s) of every orphan.
 *
 * @param {ReturnType<typeof cheerio.load>} $
 * @returns {number[]} - sorted ascending
 */
function detectOrphanH1Indices($) {
  const allH1s = $('h1').toArray();
  if (allH1s.length < 2) return [];
  const orphans = [];
  for (let i = 0; i < allH1s.length; i += 1) {
    const el = allH1s[i];
    // Walk ancestors: is there a section/article wrapping this h1?
    let p = el.parent;
    let container = null;
    while (p) {
      if (p.type === 'tag' && (p.name === 'section' || p.name === 'article')) {
        container = p;
        break;
      }
      p = p.parent;
    }
    if (!container) continue;
    // Is there another h1 NOT inside this container?
    const siblingOutside = allH1s.some((other, j) => {
      if (j === i) return false;
      let q = other.parent;
      while (q) {
        if (q === container) return false; // inside same container
        q = q.parent;
      }
      return true;
    });
    if (siblingOutside) orphans.push(i);
  }
  return orphans;
}

module.exports = {
  id: FIXER_ID,
  name: 'Normalize heading order',
  supported: ['scorm12', 'scorm2004', 'aicc'],
  confidence: 'definitive',
  criterion: CRITERION,
  triage: 'auto-fix safe',
  tier: 'safe',
  provenance: 'deterministic',

  /**
   * Returns true only when the file matches one of the two deterministic
   * patterns above. Any other heading-skip pattern returns false so the
   * orchestrator can defer it for human judgment.
   */
  canFix(file /* , violation */) {
    if (!file || !file.isHtml) return false;
    if (typeof file.content !== 'string' || file.content.length === 0) return false;

    let $;
    try {
      $ = cheerio.load(file.content);
    } catch (_e) {
      return false;
    }

    const headings = $('h1, h2, h3, h4, h5, h6').toArray().map((el) => ({
      level: parseInt(el.name.slice(1), 10)
    }));

    if (detectMissingH1(headings)) return true;
    if (detectOrphanH1Indices($).length > 0) return true;
    return false;
  },

  async apply(file /* , violations */) {
    const log = [];
    const patches = [];
    const mods = [];

    if (
      !file ||
      !file.isHtml ||
      typeof file.content !== 'string' ||
      file.content.length === 0
    ) {
      return {
        changed: false,
        newContent: (file && file.content) || '',
        patches,
        log
      };
    }

    const original = file.content;

    let $;
    try {
      $ = cheerio.load(original);
    } catch (e) {
      log.push(`Could not parse HTML: ${e.message}`);
      return { changed: false, newContent: original, patches, log };
    }

    const headings = $('h1, h2, h3, h4, h5, h6').toArray().map((el) => ({
      level: parseInt(el.name.slice(1), 10)
    }));

    // ── Pattern 1: missing <h1> ──────────────────────────────────────────
    const pattern1 = detectMissingH1(headings);
    if (pattern1) {
      const candidateTag = `h${pattern1.candidateLevel}`;
      // The candidate is the FIRST heading on the page, which is the 0th
      // occurrence of `candidateTag` (because no h1 exists and that level
      // is the highest present).
      const openMatch = findNthHeadingOpen(original, candidateTag, 0);
      if (!openMatch) {
        log.push(`Could not locate <${candidateTag}> in source for promotion`);
      } else {
        const span = spanHeadingElement(original, openMatch, candidateTag);
        if (!span) {
          log.push(`Found <${candidateTag}> with no matching </${candidateTag}>; skipping`);
        } else {
          const { originalText, openTag } = span;
          // Rewrite the open tag's level digit and the close tag.
          const newOpenTag = openTag.replace(/^<h\d/i, '<h1');
          const replacementText =
            newOpenTag +
            originalText.slice(openTag.length).replace(
              new RegExp(`</${candidateTag}\\s*>`, 'i'),
              '</h1>'
            );

          patches.push(
            buildPatch({
              fixer: FIXER_ID,
              criterion: CRITERION,
              confidence: 'definitive',
              file: file.path,
              content: original,
              originalOffset: openMatch.index,
              originalText,
              replacementText,
              rationale: `No <h1> on page; promoted the first heading from <${candidateTag}> to <h1> so the document has a single top-level heading.`
            })
          );
          mods.push({
            offset: openMatch.index,
            originalText,
            replacementText
          });
          log.push(
            `Promoted first <${candidateTag}> at offset ${openMatch.index} to <h1>`
          );
        }
      }
    } else {
      // ── Pattern 2: orphan <h1> demotion ───────────────────────────────
      const orphanIndices = detectOrphanH1Indices($);
      for (const idx of orphanIndices) {
        const openMatch = findNthHeadingOpen(original, 'h1', idx);
        if (!openMatch) {
          log.push(`Could not locate orphan <h1> #${idx} in source`);
          continue;
        }
        const span = spanHeadingElement(original, openMatch, 'h1');
        if (!span) {
          log.push(`No </h1> after orphan <h1> at offset ${openMatch.index}`);
          continue;
        }
        const { originalText, openTag } = span;
        const newOpenTag = openTag.replace(/^<h1/i, '<h2');
        const replacementText =
          newOpenTag +
          originalText.slice(openTag.length).replace(/<\/h1\s*>/i, '</h2>');

        patches.push(
          buildPatch({
            fixer: FIXER_ID,
            criterion: CRITERION,
            confidence: 'definitive',
            file: file.path,
            content: original,
            originalOffset: openMatch.index,
            originalText,
            replacementText,
            rationale:
              'Orphan <h1> inside <section>/<article> while another <h1> exists outside; demoted to <h2> so the page has a single top-level heading.'
          })
        );
        mods.push({
          offset: openMatch.index,
          originalText,
          replacementText
        });
        log.push(`Demoted orphan <h1> at offset ${openMatch.index} to <h2>`);
      }
    }

    return {
      changed: patches.length > 0,
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
