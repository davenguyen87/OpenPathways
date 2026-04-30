const fs = require('fs').promises;

/**
 * Load baseline violations from a JSON file.
 * @param {string} path - Path to the baseline JSON file (e.g., from prior results.json)
 * @returns {Promise<{ violations: Array }>} Object with violations array
 * @throws {Error} if file is missing or unparseable
 */
async function loadBaseline(path) {
  try {
    const content = await fs.readFile(path, 'utf-8');
    const parsed = JSON.parse(content);

    // Handle both raw violations array and full scorecard JSON
    const violations = Array.isArray(parsed)
      ? parsed
      : (parsed.violations || []);

    return { violations };
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Baseline file not found: ${path}`);
    }
    if (err instanceof SyntaxError) {
      throw new Error(`Baseline file is not valid JSON: ${path}`);
    }
    throw new Error(`Failed to read baseline: ${err.message}`);
  }
}

/**
 * Build a match key from a violation's criterion, file, line, and message.
 * Treats null line values as equal to each other.
 * @param {object} violation - Violation object with criterion, file, line, message
 * @returns {string} Stringified key
 */
function buildViolationKey(violation) {
  const { criterion, file, line, message } = violation;
  return JSON.stringify({ criterion, file, line: line === null ? 'NULL' : line, message });
}

/**
 * Filter current violations to remove those matching the baseline.
 * Matching is based on: criterion, file, line, and message.
 * @param {Array} currentViolations - Current audit violations
 * @param {Array} baselineViolations - Baseline violations to suppress
 * @returns {Array} Filtered violations (only new/changed ones)
 */
function diffAgainstBaseline(currentViolations, baselineViolations) {
  // Build a Set of baseline violation keys for O(1) lookup
  const baselineKeys = new Set(
    baselineViolations.map((v) => buildViolationKey(v))
  );

  // Filter to only violations NOT in baseline
  return currentViolations.filter((violation) => {
    const key = buildViolationKey(violation);
    return !baselineKeys.has(key);
  });
}

module.exports = {
  loadBaseline,
  diffAgainstBaseline,
};
