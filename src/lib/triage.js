/**
 * Triage taxonomy and severity tagger for Open Pathways v3
 *
 * Maps findings to one of five triage categories based on fixer availability
 * and WCAG criterion-specific rules. Each violation receives a deterministic
 * triage tag answering "what action is needed to fix this?"
 */

/**
 * Ordered triage tiers (low effort → high effort / cost)
 * Used for rollup aggregation: "dominant" tier = highest in this list present
 */
const TRIAGE_TIERS = [
  'auto-fix safe',
  'auto-fix assisted',
  'author rework',
  'content rework',
  'recommend retire'
];

/**
 * Map criterion ID to its fixer's presence, if one exists.
 * Filenames from src/fixers/:
 *  - add-alt-decorative.js          → 1.1.1 (decorative images case)
 *  - add-iframe-title.js            → 4.1.2 (iframe name/role/value)
 *  - add-html5-doctype.js           → (no criterion; doctype is structural)
 *  - add-lang-attribute.js          → 3.1.1 (page language)
 *  - add-skip-link.js               → (no criterion; improves 2.4.1 but not directly)
 *  - add-tabindex-keyboard.js       → 2.1.1 (keyboard accessible)
 *  - add-title.js                   → 2.4.2 (page title)
 *  - add-autocomplete-password.js   → 3.3.8 (autocomplete for password inputs)
 *  - repair-viewport-scale.js       → 1.4.4 (resize text) and 1.4.10 (reflow)
 *
 * Each entry is marked 'mechanical' (true) if the fix is deterministic and requires
 * no author judgment or net-new content.
 */
const FIXER_CRITERIA_MAP = {
  '1.1.1': { hasFixer: true, mechanical: true, fixerId: 'add-alt-decorative' }, // decorative case
  '2.1.1': { hasFixer: true, mechanical: true, fixerId: 'add-tabindex-keyboard' },
  '2.4.2': { hasFixer: true, mechanical: true, fixerId: 'add-title' },
  '3.1.1': { hasFixer: true, mechanical: true, fixerId: 'add-lang-attribute' },
  '3.3.8': { hasFixer: true, mechanical: true, fixerId: 'add-autocomplete-password' },
  '4.1.2': { hasFixer: true, mechanical: true, fixerId: 'add-iframe-title' },
  '1.4.4': { hasFixer: true, mechanical: true, fixerId: 'repair-viewport-scale' }
};

/**
 * Criteria that require author judgment or consultant review (assisted mode)
 */
const ASSISTED_CRITERIA = new Set([
  '1.1.1', // alt text for non-decorative images
  '3.3.2', // labels
  '4.1.2'  // name/role/value with judgment needed
]);

/**
 * Criteria that require net-new content creation
 */
const CONTENT_REWORK_CRITERIA = new Set([
  '1.2.1', // audio-video-only
  '1.2.2', // captions
  '1.2.3', // audio description
  '1.2.5'  // audio description (prerecorded)
]);

/**
 * Determine the triage tag for a single violation.
 *
 * Rules (in order):
 * 1. If fixer exists and is mechanical → 'auto-fix safe'
 * 2. If criterion is in ASSISTED_CRITERIA → 'auto-fix assisted'
 * 3. If criterion is in CONTENT_REWORK_CRITERIA → 'content rework'
 * 4. Default → 'author rework'
 *
 * Note: 'recommend retire' is a package-level decision made by dominantTriage()
 * when the package has 8+ Critical violations across 3+ different criteria
 * with at least one content-tier criterion. That logic lives in dominantTriage(),
 * not here.
 *
 * @param {object} violation - { criterion, message, snippet, severity, ... }
 * @param {object} context - { packageType, packageScale, fixerCriteriaMap } (optional)
 * @returns {string} one of TRIAGE_TIERS
 */
function tagFinding(violation, context = {}) {
  const { criterion } = violation;
  if (!criterion) {
    // No criterion → default to author rework
    return 'author rework';
  }

  const fixerMap = context.fixerCriteriaMap || FIXER_CRITERIA_MAP;

  // Rule 1: Check if a mechanical fixer exists
  if (fixerMap[criterion]?.hasFixer && fixerMap[criterion]?.mechanical) {
    return 'auto-fix safe';
  }

  // Rule 2: Check if this is an assisted-judgment criterion
  if (ASSISTED_CRITERIA.has(criterion)) {
    return 'auto-fix assisted';
  }

  // Rule 3: Check if this requires net-new content
  if (CONTENT_REWORK_CRITERIA.has(criterion)) {
    return 'content rework';
  }

  // Rule 4: Default
  return 'author rework';
}

/**
 * Tag all violations in an array.
 * Mutates each violation to add a `triage` field.
 *
 * @param {array} violations - array of violation objects
 * @param {object} context - context passed to tagFinding
 * @returns {array} the same violations array (mutated)
 */
function tagAllFindings(violations, context = {}) {
  for (const violation of violations) {
    violation.triage = tagFinding(violation, context);
  }
  return violations;
}

/**
 * Determine the dominant (highest-effort) triage tier present in a set.
 * Used to decide if a package should be marked 'recommend retire'.
 *
 * Decision: 'recommend retire' if:
 *   - Package has 8+ Critical findings AND
 *   - At least 3 different criteria are flagged AND
 *   - At least one criterion is in CONTENT_REWORK_CRITERIA
 *
 * This is a package-level decision, not per-finding.
 *
 * @param {object} triageCounts - { 'auto-fix safe': N, 'auto-fix assisted': N, ..., 'Critical': N, ... }
 *                                 or can contain raw violation objects to filter
 * @param {array} allViolations - full list of violations to check criteria diversity (optional)
 * @returns {string} the dominant tier: 'recommend retire' | 'content rework' | 'author rework' | 'auto-fix assisted' | 'auto-fix safe'
 */
function dominantTriage(triageCounts, allViolations = []) {
  // Check retire condition: 8+ Critical AND 3+ criteria AND at least one content-tier
  let criticalCount = 0;
  let criteriaSet = new Set();
  let hasContentRework = false;

  for (const violation of allViolations) {
    if (violation.severity === 'critical') {
      criticalCount += 1;
      if (violation.criterion) {
        criteriaSet.add(violation.criterion);
        if (CONTENT_REWORK_CRITERIA.has(violation.criterion)) {
          hasContentRework = true;
        }
      }
    }
  }

  if (
    criticalCount >= 8 &&
    criteriaSet.size >= 3 &&
    hasContentRework
  ) {
    return 'recommend retire';
  }

  // Otherwise, find the highest tier present in triageCounts
  for (const tier of TRIAGE_TIERS.slice().reverse()) {
    if (triageCounts[tier] > 0) {
      return tier;
    }
  }

  // Fallback: no violations
  return 'auto-fix safe';
}

module.exports = {
  TRIAGE_TIERS,
  tagFinding,
  tagAllFindings,
  dominantTriage,
  FIXER_CRITERIA_MAP,
  ASSISTED_CRITERIA,
  CONTENT_REWORK_CRITERIA
};
