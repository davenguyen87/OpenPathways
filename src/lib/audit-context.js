const cheerio = require('cheerio');

/**
 * Builds the AuditContext object that checks consume.
 * Lazy-loads cheerio for HTML files to avoid parsing overhead.
 *
 * @param {object} config - { packageRoot, packageType, manifest, entryPoints, scos, files }
 * @returns {object} AuditContext
 */
function buildAuditContext(config) {
  const { packageRoot, packageType, manifest, entryPoints, scos, files } = config;

  // Memoized cheerio loaders for each HTML file
  const cheerioCache = new Map();

  // Add memoized $ getter to each HTML file
  const htmlFiles = files.html.map((file) => {
    return {
      ...file,
      $: () => {
        if (!cheerioCache.has(file.path)) {
          cheerioCache.set(file.path, cheerio.load(file.content));
        }
        return cheerioCache.get(file.path);
      },
    };
  });

  // Build a lookup map: file path -> SCO
  const pathToSco = new Map();
  if (scos && scos.length > 0) {
    scos.forEach((sco) => {
      pathToSco.set(sco.entryFile, sco);
      // Also map files in the same folder to the SCO
      const scoDir = sco.entryFile.split('/').slice(0, -1).join('/');
      // Store both exact match and folder prefix
      if (!pathToSco.has(scoDir)) {
        pathToSco.set(scoDir, sco);
      }
    });
  }

  return {
    packageRoot,
    packageType,
    manifest,
    entryPoints,
    scos,
    pathToSco,
    files: {
      html: htmlFiles,
      css: files.css,
      js: files.js,
      all: files.all,
    },
  };
}

module.exports = { buildAuditContext };
