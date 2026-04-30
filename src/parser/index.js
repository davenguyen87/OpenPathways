const { detectPackageType } = require('./detect');
const { parseScormPackage } = require('./scorm');
const { parseAiccPackage } = require('./aicc');
const { parseCmi5Package } = require('./cmi5');
const { parseXapiPackage } = require('./xapi');

/**
 * Main entry point for package parsing.
 * Detects package type (SCORM 1.2, SCORM 2004, AICC, cmi5, or xAPI), delegates to the
 * appropriate parser, and returns a normalized result.
 *
 * @param {string} packageRoot - Absolute path to extracted package directory
 * @returns {Promise<{ packageType: 'scorm12'|'scorm2004'|'aicc'|'cmi5'|'xapi', entryPoints: string[], scos: object[], manifest: object }>}
 * @throws {Error} - "Could not detect a valid SCORM, AICC, xAPI, or cmi5 manifest."
 * @throws {Error} - "AICC profile 3/4 is not supported. Only profiles 1 and 2 are supported."
 */
async function parsePackage(packageRoot) {
  // Detect package type
  const packageType = await detectPackageType(packageRoot);

  // Route to appropriate parser
  let result;
  if (packageType === 'scorm12' || packageType === 'scorm2004') {
    result = await parseScormPackage(packageRoot, packageType);
  } else if (packageType === 'aicc') {
    result = await parseAiccPackage(packageRoot);
  } else if (packageType === 'cmi5') {
    result = await parseCmi5Package(packageRoot);
  } else if (packageType === 'xapi') {
    result = await parseXapiPackage(packageRoot);
  } else {
    throw new Error('Could not detect a valid SCORM, AICC, xAPI, or cmi5 manifest.');
  }

  // Handle parser errors (e.g., from xAPI parser when no launchable activities)
  if (result.errors) {
    return result;
  }

  return {
    packageType,
    entryPoints: result.entryPoints,
    scos: result.scos || [],
    manifest: result.manifest,
  };
}

module.exports = { parsePackage };
