/**
 * Section 508 Mapping (2018 ICT Refresh)
 *
 * Maps WCAG 2.0/2.1/2.2 criteria to their corresponding Section 508 references.
 * Used to enrich findings and generate 508 mapping tables for reports.
 */

/**
 * Canonical WCAG-to-508 mapping table (v3.0 reference: 2018 ICT Refresh)
 */
const WCAG_TO_508 = {
  // 1.1.1 - Non-text content
  '1.1.1': '503.4',

  // 1.2 - Time-based media
  '1.2.1': '501.5',
  '1.2.2': '501.5',
  '1.2.3': '501.5',
  '1.2.5': '501.5',

  // 1.3 - Adaptable
  '1.3.1': '502.2.1',
  '1.3.2': '502.2.1',
  '1.3.3': '502.2.1',
  '1.3.4': '502.2.1',
  '1.3.5': '502.2.1',

  // 1.4 - Distinguishable
  '1.4.1': '502.2.2',
  '1.4.2': '503.2',
  '1.4.3': '502.2.2',
  '1.4.4': '503.2',
  '1.4.10': '502.2.2',
  '1.4.11': '502.2.2',

  // 2.1 - Keyboard accessible
  '2.1.1': '501.1',
  '2.1.2': '501.1',

  // 2.4 - Navigable
  '2.4.1': '502.2.1',
  '2.4.2': '502.2.1',
  '2.4.3': '502.2.1',
  '2.4.6': '502.2.1',
  '2.4.7': '502.2.1',
  '2.4.11': '502.2.1',

  // 2.5 - Input modalities (WCAG 2.1+)
  '2.5.1': '501.1',
  '2.5.2': '501.1',
  '2.5.3': '501.1',
  '2.5.4': '501.1',
  '2.5.7': '501.1',
  '2.5.8': '501.1',

  // 3.1 - Readable
  '3.1.1': '502.2.1',
  '3.1.2': '502.2.1',

  // 3.2 - Predictable
  '3.2.1': '502.3',
  '3.2.2': '502.3',
  '3.2.3': '502.3',
  '3.2.4': '502.3',
  '3.2.6': '502.3',

  // 3.3 - Input assistance
  '3.3.1': '502.3',
  '3.3.2': '502.3',
  '3.3.7': '502.3',
  '3.3.8': '502.3',

  // 4.1 - Compatible (WCAG 2.0/2.1; 4.1.1 removed in 2.2)
  '4.1.2': '502.2',
  '4.1.3': '502.2'
};

/**
 * Reference title lookup for HTML/Markdown rendering
 */
const REFERENCE_TITLES = {
  '501.1': 'Operable without specialized input',
  '501.5': 'Captions for synchronized media',
  '502.2': 'Interoperability with assistive technology (general)',
  '502.2.1': 'Programmatically determinable',
  '502.2.2': 'Information and relationships (color/contrast)',
  '502.3': 'Predictability and consistent behavior',
  '503.2': 'User control of audio/visual',
  '503.3': 'Captioning controls',
  '503.4': 'Audio description and text alternatives'
};

/**
 * Map a single WCAG criterion to its 508 reference.
 *
 * @param {string} criterionId - WCAG criterion ID (e.g. '1.1.1')
 * @returns {string|null} Section 508 reference (e.g. '503.4') or null if not mapped
 */
function mapWcagTo508(criterionId) {
  return WCAG_TO_508[criterionId] || null;
}

/**
 * Add section508 field to each violation in-place.
 * Mutates the violations array to add the section508 mapping.
 *
 * @param {Array} violations - Array of violation objects with criterion field
 * @returns {Array} The same violations array, now with section508 field added
 */
function mapAllFindings(violations) {
  for (const violation of violations) {
    if (violation.criterion) {
      violation.section508 = mapWcagTo508(violation.criterion);
    }
  }
  return violations;
}

/**
 * Build a 508 mapping table for rendering in HTML/Markdown reports.
 * Groups violations by 508 reference and sorts by reference number.
 *
 * @param {Array} violations - Array of violation objects (with section508 field)
 * @returns {Array} Array of { reference, refTitle, findingCount, criterionIds: [...] }
 *                  sorted by reference number, ready for table rendering
 */
function buildSection508Table(violations) {
  const refMap = new Map();

  // Group violations by 508 reference
  for (const violation of violations) {
    const ref = violation.section508;
    if (!ref) continue; // Skip unmapped criteria

    if (!refMap.has(ref)) {
      refMap.set(ref, {
        reference: ref,
        refTitle: REFERENCE_TITLES[ref] || 'Unknown reference',
        findingCount: 0,
        criterionIds: new Set()
      });
    }

    const entry = refMap.get(ref);
    entry.findingCount += 1;
    if (violation.criterion) {
      entry.criterionIds.add(violation.criterion);
    }
  }

  // Convert Set to Array and sort by reference number
  const result = Array.from(refMap.values()).map(entry => ({
    reference: entry.reference,
    refTitle: entry.refTitle,
    findingCount: entry.findingCount,
    criterionIds: Array.from(entry.criterionIds).sort()
  }));

  // Sort by reference (numeric sort on first 3 digits, then decimal part)
  result.sort((a, b) => {
    const aParts = a.reference.split('.').map(Number);
    const bParts = b.reference.split('.').map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aVal = aParts[i] || 0;
      const bVal = bParts[i] || 0;
      if (aVal !== bVal) return aVal - bVal;
    }
    return 0;
  });

  return result;
}

module.exports = {
  mapWcagTo508,
  mapAllFindings,
  buildSection508Table,
  WCAG_TO_508,
  REFERENCE_TITLES
};
