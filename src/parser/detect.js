const fs = require('fs').promises;
const path = require('path');
const { findFile } = require('./util');

/**
 * Detect the package type: SCORM 1.2, SCORM 2004, AICC, cmi5, or xAPI.
 * Detection order:
 *   1. If imsmanifest.xml exists → SCORM (infer 1.2 or 2004)
 *   2. Else if *.crs exists → AICC
 *   3. Else if cmi5.xml exists → cmi5
 *   4. Else if tincan.xml exists → xAPI
 *   5. Else → throw error
 *
 * @param {string} packageRoot - Absolute path to extracted package
 * @returns {Promise<string>} - 'scorm12', 'scorm2004', 'aicc', 'cmi5', or 'xapi'
 * @throws {Error} - "Could not detect a valid SCORM, AICC, xAPI, or cmi5 manifest."
 */
async function detectPackageType(packageRoot) {
  // Look for imsmanifest.xml (prefer shallowest)
  const manifestPath = await findFile(packageRoot, 'imsmanifest.xml', {
    recursive: true,
    preferShallowest: true,
  });

  if (manifestPath) {
    // Determine SCORM version
    const version = await detectScormVersion(manifestPath);
    return version;
  }

  // Look for AICC .crs file
  const crsPath = await findFile(packageRoot, '*.crs', { recursive: true });
  if (crsPath) {
    return 'aicc';
  }

  // Look for cmi5.xml (at root, not recursive for cmi5)
  const cmi5Path = await findFile(packageRoot, 'cmi5.xml', {
    recursive: false,
  });
  if (cmi5Path) {
    return 'cmi5';
  }

  // Look for xAPI tincan.xml (at root, not recursive for xAPI)
  const tincantPath = await findFile(packageRoot, 'tincan.xml', {
    recursive: false,
  });
  if (tincantPath) {
    return 'xapi';
  }

  // No manifest found
  throw new Error('Could not detect a valid SCORM, AICC, xAPI, or cmi5 manifest.');
}

/**
 * Infer SCORM version from imsmanifest.xml structure.
 * - If <manifest> has schemaversion attribute containing "2004" → SCORM 2004
 * - If xmlns includes imscp_v1p1 AND (adlcp_v1p3 or imsss) → SCORM 2004
 * - Else → SCORM 1.2 (default for ambiguous)
 *
 * @param {string} manifestPath - Path to imsmanifest.xml
 * @returns {Promise<string>} - 'scorm12' or 'scorm2004'
 */
async function detectScormVersion(manifestPath) {
  const content = await fs.readFile(manifestPath, 'utf-8');

  // Check for schemaversion attribute
  const schemaVersionMatch = content.match(/schemaversion\s*=\s*["']([^"']*)/i);
  if (schemaVersionMatch && schemaVersionMatch[1].includes('2004')) {
    return 'scorm2004';
  }

  // Check for SCORM 2004 namespaces
  const has2004Namespaces =
    content.includes('imscp_v1p1') &&
    (content.includes('adlcp_v1p3') || content.includes('imsss'));

  if (has2004Namespaces) {
    return 'scorm2004';
  }

  // Default to SCORM 1.2
  return 'scorm12';
}

module.exports = {
  detectPackageType,
  detectScormVersion,
};
