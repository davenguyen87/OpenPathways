const fs = require('fs').promises;
const path = require('path');

/**
 * Auto-discovers all dynamic check files in src/dynamic-checks/ and validates their shape.
 * Sorts by criterion ID (dotted form converted to comparable number).
 *
 * @returns {Promise<Array>} Array of validated check objects
 */
async function loadDynamicChecks() {
  const dynamicChecksDir = path.join(__dirname, '..', 'dynamic-checks');

  let entries = [];
  try {
    entries = await fs.readdir(dynamicChecksDir, { withFileTypes: true });
  } catch (err) {
    // If dynamic-checks directory doesn't exist yet, return empty array
    return [];
  }

  const checks = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;

    try {
      const checkPath = path.join(dynamicChecksDir, entry.name);
      // Clear require cache to allow hot-loading during tests
      delete require.cache[require.resolve(checkPath)];
      const check = require(checkPath);

      // Validate check shape (same as static checks)
      if (
        !check.id ||
        !check.name ||
        !check.level ||
        !check.wcagIntroduced ||
        !check.url ||
        typeof check.run !== 'function'
      ) {
        console.warn(`Invalid dynamic check in ${entry.name}: missing required fields`);
        continue;
      }

      checks.push(check);
    } catch (err) {
      console.warn(`Failed to load dynamic check ${entry.name}: ${err.message}`);
    }
  }

  // Sort by criterion ID (convert "1.2.3" to numeric for sorting)
  checks.sort((a, b) => {
    const aParts = a.id.split('.').map(Number);
    const bParts = b.id.split('.').map(Number);

    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aVal = aParts[i] || 0;
      const bVal = bParts[i] || 0;
      if (aVal !== bVal) return aVal - bVal;
    }
    return 0;
  });

  return checks;
}

module.exports = { loadDynamicChecks };
