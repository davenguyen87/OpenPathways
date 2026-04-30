/**
 * Static list of criteria that require manual review.
 * These cannot be reliably evaluated via static analysis alone.
 *
 * Phase 3 (2026-04-30): Removed 3 criteria that are now dynamically auto-checkable:
 * - 2.4.3 Focus order (moved to dynamic check)
 * - 3.2.4 Consistent identification (moved to dynamic check)
 * - 4.1.3 Status messages (moved to dynamic check)
 */
const MANUAL_REVIEW_CRITERIA = [
  {
    id: '1.2.3',
    name: 'Audio description or media alternative (prerecorded)',
    level: 'A',
    wcagIntroduced: '2.0',
    url: 'https://www.w3.org/WAI/WCAG22/Understanding/audio-description-or-media-alternative-prerecorded',
    guidance: 'Verify that all prerecorded synchronized video content has either an audio description track or a text transcript describing the visual content. This requires listening to the media and comparing it to the description provided.',
  },
  {
    id: '1.2.5',
    name: 'Audio description (prerecorded)',
    level: 'AA',
    wcagIntroduced: '2.0',
    url: 'https://www.w3.org/WAI/WCAG22/Understanding/audio-description-prerecorded',
    guidance: 'Verify that all prerecorded video content has an audio description track that accurately describes the visual content, including important actions, characters, scene changes, and text on screen.',
  },
  {
    id: '3.3.7',
    name: 'Redundant entry',
    level: 'A',
    wcagIntroduced: '2.2',
    url: 'https://www.w3.org/WAI/WCAG22/Understanding/redundant-entry',
    guidance: 'In multi-step processes (quizzes, forms, workflows), verify that users are not required to re-enter information they have already provided in the same session. Step 2 should remember data from Step 1.',
  },
];

/**
 * Returns manual review items filtered by WCAG standard version.
 *
 * @param {string} standard - 'wcag21' or 'wcag22' (default: 'wcag22')
 * @returns {Array} Filtered manual review items
 */
function getManualReview(standard = 'wcag22') {
  if (standard === 'wcag21') {
    return MANUAL_REVIEW_CRITERIA.filter((item) => item.wcagIntroduced !== '2.2');
  } else if (standard === 'wcag22') {
    return MANUAL_REVIEW_CRITERIA;
  }
  return MANUAL_REVIEW_CRITERIA;
}

module.exports = { getManualReview, MANUAL_REVIEW_CRITERIA };
