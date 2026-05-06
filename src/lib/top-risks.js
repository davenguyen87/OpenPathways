/**
 * Top-Three Risks Extractor
 *
 * Extracts the top three highest-impact findings and formats them as risk cards
 * suitable for the engagement assessment's "top three risks" section.
 *
 * Ranking algorithm (PRD §Open questions):
 * 1. Severity (Critical first)
 * 2. Tie-break: 508-reference urgency (501.x > 502.2 > 502.3 > 503.x)
 * 3. Tie-break: package count (more packages affected = higher rank)
 * 4. Tie-break: occurrence count
 *
 * If fewer than 3 Critical findings exist, fills with Serious tier and sets fallback=true.
 */

// Import section508 mapping to access criterion metadata
const { mapWcagTo508, REFERENCE_TITLES } = require('./section508');

/**
 * Get WCAG criterion name from ID.
 * This is a lookup of common criteria; add as needed.
 */
const CRITERION_NAMES = {
  '1.1.1': 'Non-text content',
  '1.2.1': 'Audio-only and Video-only (Prerecorded)',
  '1.2.2': 'Captions (Prerecorded)',
  '1.2.3': 'Audio description or media alternative',
  '1.2.5': 'Audio description (Prerecorded)',
  '1.3.1': 'Info and relationships',
  '1.3.2': 'Meaningful sequence',
  '1.3.3': 'Sensory characteristics',
  '1.3.4': 'Orientation',
  '1.3.5': 'Identify input purpose',
  '1.4.1': 'Use of color',
  '1.4.2': 'Audio control',
  '1.4.3': 'Contrast (minimum)',
  '1.4.4': 'Resize text',
  '1.4.10': 'Reflow',
  '1.4.11': 'Non-text contrast',
  '2.1.1': 'Keyboard',
  '2.1.2': 'No keyboard trap',
  '2.4.1': 'Bypass blocks',
  '2.4.2': 'Page titled',
  '2.4.3': 'Focus order',
  '2.4.6': 'Headings and labels',
  '2.4.7': 'Focus visible',
  '2.4.11': 'Focus not obscured',
  '2.5.1': 'Pointer gestures',
  '2.5.2': 'Pointer cancellation',
  '2.5.3': 'Label in name',
  '2.5.4': 'Motion actuation',
  '2.5.7': 'Dragging movements',
  '2.5.8': 'Target size (minimum)',
  '3.1.1': 'Language of page',
  '3.1.2': 'Language of parts',
  '3.2.1': 'On focus',
  '3.2.2': 'On input',
  '3.2.3': 'Consistent navigation',
  '3.2.4': 'Consistent identification',
  '3.2.6': 'Consistent help',
  '3.3.1': 'Error identification',
  '3.3.2': 'Labels or instructions',
  '3.3.7': 'Redundant entry',
  '3.3.8': 'Accessible authentication',
  '4.1.2': 'Name, role, value',
  '4.1.3': 'Status messages'
};

/**
 * Framing sentence templates by criterion category.
 * Used to generate regulated-learner impact language.
 * Variables: {N} = count, {criterion} = ID, {criterionName} = name
 */
const FRAMING_TEMPLATES = {
  '1.1.1': 'Screen-reader users encounter unlabeled imagery in {N} packages, blocking comprehension of training content.',
  '1.2.1': '{N} packages contain audio or video without captions or transcripts, excluding deaf and hard-of-hearing learners from required content.',
  '1.2.2': '{N} packages contain audio or video without captions or transcripts, excluding deaf and hard-of-hearing learners from required content.',
  '1.2.3': '{N} packages contain audio or video without captions or transcripts, excluding deaf and hard-of-hearing learners from required content.',
  '1.2.5': '{N} packages contain audio or video without captions or transcripts, excluding deaf and hard-of-hearing learners from required content.',
  '1.4.3': '{N} packages contain text that fails minimum-contrast against its background, putting learners with low vision at risk of missing required information.',
  '2.1.1': 'Keyboard-only users — including those using assistive switches and screen readers — cannot complete required interactions in {N} packages.',
  '2.1.2': 'Keyboard-only users — including those using assistive switches and screen readers — cannot complete required interactions in {N} packages.',
  '2.4.7': '{N} packages provide no visible focus indicator, leaving keyboard-only users unable to track their position in the course.',
  '4.1.2': 'Custom controls in {N} packages do not expose accessible names, roles, or states; assistive technology cannot announce them.',
  '4.1.3': 'Status changes in {N} packages are not announced to assistive technology, preventing users with disabilities from knowing when content updates.'
};

/**
 * Get 508 reference urgency tier.
 * Returns a number for sorting (higher = more urgent).
 */
function get508Urgency(ref) {
  if (!ref) return 0;

  // 501.x (operable, media) - highest urgency
  if (ref.startsWith('501')) return 9;

  // 502.2 (interoperability general) - high urgency
  if (ref === '502.2') return 8;
  if (ref.startsWith('502.2')) return 8;

  // 502.3 (predictability) - medium urgency
  if (ref === '502.3') return 6;

  // 503.x (applications, audio/visual controls) - lower urgency
  if (ref.startsWith('503')) return 4;

  // Unknown
  return 2;
}

/**
 * Extract top risks from a violations array.
 *
 * @param {Array} violations - Array of violation objects (with severity, criterion, section508)
 * @param {Object} options - Optional { libraryMode: boolean }
 *                           libraryMode aggregates findings by criterion across packages
 * @returns {Object} { risks: [risk1, risk2, risk3], fallback: boolean, fallbackMessage: string|null }
 */
function extractTopRisks(violations, options = {}) {
  const { libraryMode } = options;

  if (!violations || violations.length === 0) {
    return {
      risks: [],
      fallback: false,
      fallbackMessage: null
    };
  }

  // Group violations by criterion
  const criterionMap = new Map();

  for (const violation of violations) {
    const criterion = violation.criterion;
    if (!criterion) continue;

    if (!criterionMap.has(criterion)) {
      criterionMap.set(criterion, {
        criterion,
        criterionName: CRITERION_NAMES[criterion] || criterion,
        section508: violation.section508 || mapWcagTo508(criterion),
        severities: { critical: [], serious: [], moderate: [], minor: [] },
        packages: new Set(),
        totalCount: 0
      });
    }

    const entry = criterionMap.get(criterion);
    const severity = violation.severity || 'moderate';
    entry.severities[severity].push(violation);
    if (violation.sco?.id || violation.file) {
      entry.packages.add(violation.sco?.id || violation.file);
    }
    entry.totalCount += 1;
  }

  // Convert to risk candidates, ranked by severity and 508 urgency
  const candidates = Array.from(criterionMap.values()).map(entry => ({
    criterion: entry.criterion,
    criterionName: entry.criterionName,
    section508: entry.section508,
    section508Title: entry.section508 ? REFERENCE_TITLES[entry.section508] : 'Unknown reference',
    criticalCount: entry.severities.critical.length,
    seriousCount: entry.severities.serious.length,
    packageCount: entry.packages.size,
    findingCount: entry.totalCount,
    severity: entry.severities.critical.length > 0 ? 'critical' : (entry.severities.serious.length > 0 ? 'serious' : 'moderate'),
    maxSeverity: entry.severities.critical.length > 0 ? 'critical' : (entry.severities.serious.length > 0 ? 'serious' : (entry.severities.moderate.length > 0 ? 'moderate' : 'minor'))
  }));

  // Separate into critical and serious tiers
  const criticalCandidates = candidates.filter(c => c.severity === 'critical');
  const seriousCandidates = candidates.filter(c => c.severity === 'serious');

  // Sort within each tier
  const sortCandidates = (list) => {
    return list.sort((a, b) => {
      // 1. Severity (already filtered by tier)
      // 2. 508 urgency
      const urgencyA = get508Urgency(a.section508);
      const urgencyB = get508Urgency(b.section508);
      if (urgencyA !== urgencyB) return urgencyB - urgencyA;

      // 3. Package count
      if (a.packageCount !== b.packageCount) return b.packageCount - a.packageCount;

      // 4. Finding count
      if (a.findingCount !== b.findingCount) return b.findingCount - a.findingCount;

      // 5. Criterion ID (stable sort)
      return a.criterion.localeCompare(b.criterion);
    });
  };

  const sortedCritical = sortCandidates(criticalCandidates);
  const sortedSerious = sortCandidates(seriousCandidates);

  // Build top 3 risks
  const topRisks = [];
  const combined = [...sortedCritical, ...sortedSerious];

  for (let i = 0; i < Math.min(3, combined.length); i++) {
    const candidate = combined[i];
    const framing = buildFraming(candidate.criterion, candidate.packageCount);

    topRisks.push({
      rank: i + 1,
      criterion: candidate.criterion,
      criterionName: candidate.criterionName,
      section508: candidate.section508,
      section508Title: candidate.section508Title,
      severity: candidate.severity,
      packageCount: candidate.packageCount,
      findingCount: candidate.findingCount,
      framing
    });
  }

  // Determine fallback state
  // Fallback is true if we have fewer than 3 critical and we filled slots with serious
  let fallback = false;
  let fallbackMessage = null;

  if (criticalCandidates.length < 3 && topRisks.length > 0) {
    // Check if any of the risks we returned came from serious tier
    const hasSerious = topRisks.some(r => r.severity === 'serious');
    if (hasSerious) {
      fallback = true;
      fallbackMessage = 'No critical-tier findings; top serious-tier risks are below.';
    }
  }

  return {
    risks: topRisks,
    fallback,
    fallbackMessage
  };
}

/**
 * Build a single framing sentence for a risk.
 * Looks up template by criterion, falls back to default.
 *
 * @param {string} criterion - WCAG criterion ID (e.g. '1.1.1')
 * @param {number} packageCount - Number of packages affected
 * @returns {string} One-sentence framing
 */
function buildFraming(criterion, packageCount) {
  let template = FRAMING_TEMPLATES[criterion];

  if (!template) {
    // Default fallback
    const criterionName = CRITERION_NAMES[criterion] || criterion;
    template = '{N} packages fail criterion {criterion} ({criterionName}); regulated learners depending on assistive technology may be blocked from completing required training.';
  }

  return template
    .replace('{N}', packageCount)
    .replace('{criterion}', criterion)
    .replace('{criterionName}', CRITERION_NAMES[criterion] || criterion);
}

module.exports = {
  extractTopRisks,
  CRITERION_NAMES,
  FRAMING_TEMPLATES
};
