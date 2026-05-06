/**
 * Generate a SARIF 2.1.0 report from a scorecard.
 *
 * SARIF (Static Analysis Results Interchange Format) is compatible with
 * GitHub Code Scanning and other security/quality dashboards.
 *
 * @param {object} config - { scorecard, violations }
 * @returns {string} SARIF JSON string (pretty-printed)
 */
function generateSarif({ scorecard, violations }) {
  const { tool = 'prism', version = '1.0.0', criteria = [] } = scorecard;

  // Build rules array: one rule per criterion with violations
  // Deduplicate by criterion id
  const rulesMap = {};
  violations.forEach((v) => {
    if (!rulesMap[v.criterion]) {
      // Find the criterion metadata
      const criterionInfo = criteria.find((c) => c.id === v.criterion);
      rulesMap[v.criterion] = {
        id: v.criterion,
        name: criterionInfo?.name || v.criterionName || 'Unknown',
        shortDescription: {
          text: criterionInfo?.name || v.criterionName || v.criterion,
        },
        helpUri: criterionInfo?.url || `https://www.w3.org/WAI/WCAG22/Understanding/${v.criterion}`,
      };
    }
  });

  const rules = Object.values(rulesMap);

  // Build results array: one result per violation
  const results = violations.map((v) => {
    const level = severityToLevel(v.severity);
    return {
      ruleId: v.criterion,
      level,
      message: {
        text: v.message || 'Accessibility violation detected',
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri: v.file || 'unknown',
            },
            region: {
              startLine: v.line || 1,
            },
          },
        },
      ],
    };
  });

  // Build SARIF document
  const sarif = {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: tool,
            version,
            informationUri: 'https://www.w3.org/WAI/WCAG22/',
            rules,
          },
        },
        results,
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}

/**
 * Map axe-core severity to SARIF level.
 *
 * @param {string} severity - 'critical', 'serious', 'moderate', 'minor'
 * @returns {string} SARIF level: 'error', 'warning', 'note'
 */
function severityToLevel(severity) {
  if (severity === 'critical' || severity === 'serious') {
    return 'error';
  } else if (severity === 'moderate') {
    return 'warning';
  } else if (severity === 'minor') {
    return 'note';
  }
  // Unknown/missing severity defaults to warning
  return 'warning';
}

module.exports = {
  generateSarif,
};
