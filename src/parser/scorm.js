const path = require('path');
const { readText, findFile } = require('./util');
const xml2js = require('xml2js');

/**
 * Parse a SCORM 1.2 or 2004 package.
 * Reads imsmanifest.xml, extracts entry points from organizations/items,
 * resolves resources via the resources section, and extracts SCOs.
 *
 * @param {string} packageRoot - Absolute path to extracted package
 * @param {string} version - 'scorm12' or 'scorm2004'
 * @returns {Promise<{ entryPoints: string[], scos: object[], manifest: object }>}
 */
async function parseScormPackage(packageRoot, version) {
  // Find imsmanifest.xml
  const manifestPath = await findFile(packageRoot, 'imsmanifest.xml', {
    recursive: true,
    preferShallowest: true,
  });

  if (!manifestPath) {
    throw new Error('imsmanifest.xml not found.');
  }

  // Calculate the manifest's directory relative to packageRoot.
  // If manifest is at packageRoot/imsmanifest.xml, manifestDir is empty.
  // If manifest is at packageRoot/Alcohol-and-Drug-Awareness/imsmanifest.xml,
  // manifestDir is "Alcohol-and-Drug-Awareness".
  const manifestDir = path.relative(packageRoot, path.dirname(manifestPath));
  const manifestDirPrefix = manifestDir && manifestDir !== '.' ? manifestDir + '/' : '';

  // Read and parse XML
  const manifestContent = await readText(manifestPath);
  const parser = new xml2js.Parser({ ignoreAttrs: false, attrNameProcessors: [fixAttrCase] });
  const parsed = await parser.parseStringPromise(manifestContent);

  // Extract manifest root
  const manifest = parsed.manifest || {};

  // Get schema version if present
  const schemaversion = manifest.$?.schemaversion || (version === 'scorm2004' ? '2004' : '1.2');

  // Get default organization
  // Note: xml2js wraps elements in arrays by default
  const organizationsArray = manifest.organizations || [];
  const organizationsElement = Array.isArray(organizationsArray) ? organizationsArray[0] : organizationsArray;

  if (!organizationsElement) {
    throw new Error('No <organizations> element found in manifest.');
  }

  const defaultOrgId = organizationsElement.$?.default;
  let defaultOrganization = null;

  const organizationArray = organizationsElement.organization || [];
  const orgs = Array.isArray(organizationArray) ? organizationArray : [organizationArray];

  defaultOrganization = orgs.find((org) => org.$?.identifier === defaultOrgId) || orgs[0];

  // Collect entry points and SCOs from organization items
  const entryPoints = [];
  const scos = [];
  const seenHrefs = new Set();

  if (defaultOrganization) {
    const organizationManifestBase = defaultOrganization.$?.['xml:base'] || manifest.$?.['xml:base'] || './';
    const resourcesArray = manifest.resources || [];
    const resourcesElement = Array.isArray(resourcesArray) ? resourcesArray[0] : resourcesArray;
    collectItemHrefs(defaultOrganization.item, entryPoints, seenHrefs, resourcesElement || {}, organizationManifestBase, packageRoot, scos, manifestDirPrefix);
  }

  // Normalize paths to forward slashes
  const normalizedEntryPoints = Array.from(seenHrefs).map((href) =>
    href.replace(/\\/g, '/')
  );

  // Normalize SCO paths
  scos.forEach((sco) => {
    sco.entryFile = sco.entryFile.replace(/\\/g, '/');
  });

  return {
    entryPoints: normalizedEntryPoints,
    scos,
    manifest: {
      version,
      schemaversion,
      defaultOrganization: defaultOrganization?.$?.identifier || null,
      organizations: organizationsElement,
      resources: manifest.resources || {},
    },
  };
}

/**
 * Recursively collect item identifierrefs and resolve them to href values.
 * Also extract SCO metadata (id, title, entryFile).
 *
 * @param {array|object} items - Array or single item element from <organization>
 * @param {array} entryPoints - Accumulator for entry points
 * @param {Set} seenHrefs - Set to track unique hrefs
 * @param {object} resources - The <resources> element from manifest
 * @param {string} baseUrl - xml:base for resolving relative paths
 * @param {string} packageRoot - Root directory for existence checks
 * @param {array} scos - Accumulator for SCO objects
 * @param {string} manifestDirPrefix - Prefix path to prepend to relative hrefs (e.g., "Alcohol-and-Drug-Awareness/")
 */
function collectItemHrefs(items, entryPoints, seenHrefs, resources, baseUrl, packageRoot, scos, manifestDirPrefix = '') {
  if (!items) return;

  const itemArray = Array.isArray(items) ? items : [items];

  for (const item of itemArray) {
    const identifierref = item.$?.identifierref;

    // Resolve identifierref to href
    if (identifierref) {
      const href = resolveResourceHref(identifierref, resources, baseUrl);
      if (href) {
        // Prepend manifest directory prefix if the href is relative (doesn't start with /)
        const prefixedHref = href.startsWith('/') ? href : manifestDirPrefix + href;
        seenHrefs.add(prefixedHref);
        // Extract SCO metadata
        const itemId = item.$?.identifier;
        const titleElement = item.title;
        const title = Array.isArray(titleElement) ? titleElement[0] : titleElement;
        if (itemId && title) {
          scos.push({
            id: itemId,
            title: typeof title === 'string' ? title : title,
            entryFile: prefixedHref,
          });
        }
      }
    }

    // Recurse into child items
    if (item.item) {
      collectItemHrefs(item.item, entryPoints, seenHrefs, resources, baseUrl, packageRoot, scos, manifestDirPrefix);
    }
  }
}

/**
 * Resolve a resource identifier to its href.
 * Looks up the resource by identifier and extracts href (with xml:base resolution).
 *
 * @param {string} identifier - Resource identifier
 * @param {object} resources - Resources element from manifest
 * @param {string} baseUrl - Base URL for relative path resolution
 * @returns {string|null} - Resolved href or null
 */
function resolveResourceHref(identifier, resources, baseUrl) {
  if (!resources || !resources.resource) return null;

  const resourceArray = Array.isArray(resources.resource) ? resources.resource : [resources.resource];
  const resource = resourceArray.find((r) => r.$?.identifier === identifier);

  if (!resource) return null;

  // Try to get href from the resource element itself
  let href = resource.$?.href;
  if (!href) {
    // Check for <file> child elements
    const files = resource.file;
    if (files) {
      const fileArray = Array.isArray(files) ? files : [files];
      const htmlFile = fileArray.find((f) => {
        const fhref = f.$?.href || '';
        return fhref.toLowerCase().endsWith('.html') || fhref.toLowerCase().endsWith('.htm');
      });
      if (htmlFile) {
        href = htmlFile.$?.href;
      } else if (fileArray.length > 0) {
        href = fileArray[0].$?.href;
      }
    }
  }

  if (!href) return null;

  // Resolve relative path using xml:base
  const resourceBase = resource.$?.['xml:base'] || baseUrl || './';
  const resolvedHref = path.posix.join(resourceBase, href);

  return resolvedHref;
}

/**
 * Process attribute names to handle case-insensitive "xml:base".
 * This is a workaround for xml2js attribute parsing.
 */
function fixAttrCase(name) {
  return name;
}

module.exports = {
  parseScormPackage,
};
