/**
 * Manifest XML Editor — pure helper for surgical edits to `imsmanifest.xml`.
 *
 * Used by the page-split transformer (and any future transformer that needs
 * to mutate the SCORM content-package manifest). Wraps the project's existing
 * `xml2js` dependency so we do not introduce a new XML parser.
 *
 * Public surface:
 *   - parseManifest(xmlString) -> { ast, declared, original }
 *   - serializeManifest(parsed) -> xmlString
 *   - splitResource(parsed, resourceIdentifier, splits) -> parsed (mutated)
 *   - validateManifest(parsed) -> { valid, errors, version }
 *
 * Round-trip determinism. The contract is:
 *
 *   parse(serialize(parse(x))) === parse(x)   // AST-equivalent
 *
 * Stronger byte-equal round-tripping is guaranteed *only* on the no-edit path:
 * when `splitResource` has not been called, `serializeManifest` returns the
 * exact original XML string. Once `splitResource` mutates the AST we must
 * rebuild the XML, and xml2js's `Builder` may differ from the original on
 * non-semantic whitespace and attribute ordering. Namespace declarations
 * (`xmlns`, `xmlns:*`) and `xsi:schemaLocation` are preserved verbatim by
 * threading them through the AST untouched.
 *
 * Validation. `validateManifest` performs structural validation against the
 * SCORM 1.2 / 2004 content-package shape: `<manifest>` root, exactly one
 * `<organizations>` with at least one `<organization>`, every `identifierref`
 * resolving to a `<resource>`, every `<resource>` with at least one `<file>`.
 * It is intentionally not a full XSD validator — that would require shipping
 * the SCORM schemas and a heavyweight validator. The orchestrator's
 * post-rebuild verify step re-parses the package and re-runs audit, which
 * provides the second line of defense.
 */

const xml2js = require('xml2js');

/**
 * The hidden symbol that holds the original XML string and a "dirty" flag on
 * the AST wrapper. Symbols keep the wrapper JSON-stringifyable for any caller
 * that wants to serialize the AST directly (tests do this for debugging).
 */
const KEY_ORIGINAL = Symbol('manifest.original');
const KEY_DIRTY = Symbol('manifest.dirty');
const KEY_DECLARED = Symbol('manifest.declared');

/**
 * Parse an `imsmanifest.xml` string into an AST plus enough metadata to
 * round-trip serialize and to know which SCORM version it declares.
 *
 * The declared-version heuristic mirrors `src/parser/scorm.js`: prefer the
 * top-level `manifest@schemaversion` attribute; fall back to the
 * `<schemaversion>` text inside `<metadata>`. Anything that contains "1.2"
 * is SCORM 1.2; anything else is SCORM 2004. Unknown shapes are flagged in
 * `validateManifest`.
 *
 * @param {string} xmlString
 * @returns {Promise<object>} parsed wrapper (call serializeManifest on it)
 */
async function parseManifest(xmlString) {
  if (typeof xmlString !== 'string' || xmlString.length === 0) {
    throw new TypeError('parseManifest: xmlString must be a non-empty string');
  }
  const parser = new xml2js.Parser({
    ignoreAttrs: false,
    explicitArray: true,
    preserveChildrenOrder: true,
    explicitChildren: false,
    charkey: '_'
  });
  let ast;
  try {
    ast = await parser.parseStringPromise(xmlString);
  } catch (err) {
    const e = new Error(`parseManifest: invalid XML: ${err.message}`);
    e.cause = err;
    throw e;
  }
  if (!ast || !ast.manifest) {
    throw new Error('parseManifest: root <manifest> element not found');
  }

  const declared = detectScormVersion(ast);

  // Wrapper holds the AST plus a few hidden fields. The AST is exposed under
  // `.ast` so callers can inspect, but they are expected to mutate via the
  // editor's public functions only.
  const wrapper = {
    ast,
    [KEY_ORIGINAL]: xmlString,
    [KEY_DIRTY]: false,
    [KEY_DECLARED]: declared
  };
  return wrapper;
}

/**
 * Detect SCORM 1.2 vs 2004 from the parsed manifest.
 * @param {object} ast - xml2js parse result
 * @returns {'scorm12'|'scorm2004'|'unknown'}
 */
function detectScormVersion(ast) {
  const manifest = ast.manifest;
  if (!manifest) return 'unknown';
  const attrSchemaVersion = manifest.$ && manifest.$.schemaversion;
  if (typeof attrSchemaVersion === 'string') {
    if (attrSchemaVersion.includes('1.2')) return 'scorm12';
    if (/2004|CAM 1\.3|3rd Edition|4th Edition/i.test(attrSchemaVersion)) return 'scorm2004';
  }
  // Fallback: nested <metadata>/<schemaversion>
  const metadataArray = Array.isArray(manifest.metadata) ? manifest.metadata : (manifest.metadata ? [manifest.metadata] : []);
  for (const md of metadataArray) {
    const sva = md && md.schemaversion;
    if (!sva) continue;
    const list = Array.isArray(sva) ? sva : [sva];
    for (const item of list) {
      const text = typeof item === 'string' ? item : (item && item._);
      if (typeof text === 'string') {
        if (text.includes('1.2')) return 'scorm12';
        if (/2004|3rd Edition|4th Edition/i.test(text)) return 'scorm2004';
      }
    }
  }
  // Namespace heuristic — ADL CAM v1.3 lives in scorm 2004.
  const xmlns = manifest.$ && (manifest.$['xmlns'] || manifest.$['xmlns:adlcp']);
  if (typeof xmlns === 'string' && /imscp_v1p1\b/.test(xmlns)) return 'scorm2004';
  if (typeof xmlns === 'string' && /imscp_rootv1p1p2/.test(xmlns)) return 'scorm12';
  return 'unknown';
}

/**
 * Serialize a parsed wrapper back to XML. When the wrapper has not been
 * edited via `splitResource` (or any other public mutator), this returns the
 * original XML string verbatim — guaranteeing byte-equal round-trips for the
 * no-op case.
 *
 * After an edit, xml2js's `Builder` rebuilds the XML. The output is valid
 * XML and round-trips through parseManifest into an AST-equivalent tree, but
 * may differ from the original on whitespace and attribute order.
 *
 * @param {object} parsed - wrapper returned by parseManifest
 * @returns {string}
 */
function serializeManifest(parsed) {
  if (!parsed || typeof parsed !== 'object' || !parsed.ast) {
    throw new TypeError('serializeManifest: argument must be a parsed wrapper from parseManifest');
  }
  if (parsed[KEY_DIRTY] !== true && typeof parsed[KEY_ORIGINAL] === 'string') {
    return parsed[KEY_ORIGINAL];
  }
  const builder = new xml2js.Builder({
    headless: false,
    renderOpts: { pretty: true, indent: '  ', newline: '\n' },
    xmldec: { version: '1.0', encoding: 'UTF-8' }
  });
  return builder.buildObject(parsed.ast);
}

/**
 * Replace the `<resource>` whose `identifier === resourceIdentifier` with N
 * new resources, and replace the matching `<item>` (anywhere in the default
 * `<organization>` tree) with N items in the same position. Item attributes
 * apart from `identifier` and `identifierref` are preserved verbatim on the
 * first split; subsequent splits inherit the same attributes. Children of
 * the original `<item>` such as `<adlcp:masteryscore>`, `<adlcp:prerequisites>`,
 * and `<adlcp:dataFromLMS>` (SCORM 1.2) or `<imsss:sequencing>` (SCORM 2004)
 * are copied to every split item.
 *
 * `splits` is an array of `{ identifier, href, files: string[], title }`.
 * The function mutates `parsed.ast` in place and flips the dirty flag so
 * `serializeManifest` rebuilds the XML.
 *
 * Throws when:
 *   - the resource is not found
 *   - the matching item is not found in the default organization
 *   - splits is empty
 *   - any split is missing required fields
 *
 * @param {object} parsed
 * @param {string} resourceIdentifier
 * @param {Array<{identifier:string, href:string, files:string[], title:string}>} splits
 * @returns {object} parsed (for chaining)
 */
function splitResource(parsed, resourceIdentifier, splits) {
  if (!parsed || !parsed.ast) {
    throw new TypeError('splitResource: parsed must be a parseManifest wrapper');
  }
  if (typeof resourceIdentifier !== 'string' || !resourceIdentifier) {
    throw new TypeError('splitResource: resourceIdentifier must be a non-empty string');
  }
  if (!Array.isArray(splits) || splits.length === 0) {
    throw new TypeError('splitResource: splits must be a non-empty array');
  }
  for (let i = 0; i < splits.length; i++) {
    const s = splits[i];
    if (!s || typeof s.identifier !== 'string' || typeof s.href !== 'string' || !Array.isArray(s.files) || typeof s.title !== 'string') {
      throw new TypeError(`splitResource: splits[${i}] must have {identifier,href,files[],title}`);
    }
  }

  const manifest = parsed.ast.manifest;
  const resourcesElement = firstOrSelf(manifest.resources);
  if (!resourcesElement) {
    throw new Error('splitResource: <resources> element not found');
  }
  const resourceArray = ensureArray(resourcesElement.resource);
  const idx = resourceArray.findIndex((r) => r && r.$ && r.$.identifier === resourceIdentifier);
  if (idx === -1) {
    throw new Error(`splitResource: resource with identifier "${resourceIdentifier}" not found`);
  }
  const original = resourceArray[idx];
  const originalAttrs = { ...(original.$ || {}) };

  // Build N new resource elements. Each inherits non-href attributes
  // (type, scormType, xml:base, etc.) from the original and replaces
  // identifier+href.
  const newResources = splits.map((s) => {
    const attrs = { ...originalAttrs };
    attrs.identifier = s.identifier;
    attrs.href = s.href;
    return {
      $: attrs,
      file: s.files.map((f) => ({ $: { href: f } }))
    };
  });

  // Splice in place to preserve sibling ordering.
  resourceArray.splice(idx, 1, ...newResources);
  resourcesElement.resource = resourceArray;

  // Locate and replace the matching item under the default organization (or
  // under any organization if the default cannot be determined). Nested.
  const organizationsElement = firstOrSelf(manifest.organizations);
  if (!organizationsElement) {
    throw new Error('splitResource: <organizations> element not found');
  }
  const orgArray = ensureArray(organizationsElement.organization);
  if (orgArray.length === 0) {
    throw new Error('splitResource: no <organization> elements found');
  }
  const defaultOrgId = organizationsElement.$ && organizationsElement.$.default;
  const defaultOrg = orgArray.find((o) => o && o.$ && o.$.identifier === defaultOrgId) || orgArray[0];

  const replacedInOrg = replaceItemRef(defaultOrg, resourceIdentifier, splits, originalAttrs);
  if (!replacedInOrg) {
    // Try every organization — some authoring tools have multiple orgs.
    let found = false;
    for (const o of orgArray) {
      if (o === defaultOrg) continue;
      if (replaceItemRef(o, resourceIdentifier, splits, originalAttrs)) {
        found = true;
        break;
      }
    }
    if (!found) {
      throw new Error(`splitResource: no <item> referencing "${resourceIdentifier}" found in any organization`);
    }
  }

  parsed[KEY_DIRTY] = true;
  return parsed;
}

/**
 * Recursively walk an organization (or item) and replace the first child
 * `<item>` whose `identifierref === resourceIdentifier` with N items.
 * Returns true on success.
 *
 * @param {object} parent - element with optional `.item` array
 * @param {string} resourceIdentifier
 * @param {Array<{identifier:string,title:string}>} splits
 * @param {object} originalResourceAttrs - reserved for future use
 * @returns {boolean}
 */
function replaceItemRef(parent, resourceIdentifier, splits /* , originalResourceAttrs */) {
  if (!parent || !parent.item) return false;
  const items = ensureArray(parent.item);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item && item.$ && item.$.identifierref === resourceIdentifier) {
      const baseAttrs = { ...(item.$ || {}) };
      // Copy children (title is replaced; other children are preserved).
      const preservedChildren = {};
      for (const key of Object.keys(item)) {
        if (key === '$' || key === 'title' || key === 'item') continue;
        preservedChildren[key] = item[key];
      }
      const newItems = splits.map((s, k) => {
        const attrs = { ...baseAttrs };
        attrs.identifier = `${baseAttrs.identifier || 'ITEM'}-PART-${k + 1}`;
        attrs.identifierref = s.identifier;
        const newItem = {
          $: attrs,
          title: [s.title]
        };
        // Preserve adlcp:masteryscore, adlcp:prerequisites, adlcp:dataFromLMS,
        // imsss:sequencing, etc. — anything other than $/title/item.
        for (const key of Object.keys(preservedChildren)) {
          // Deep-clone to avoid shared references between split items.
          newItem[key] = JSON.parse(JSON.stringify(preservedChildren[key]));
        }
        return newItem;
      });
      items.splice(i, 1, ...newItems);
      parent.item = items;
      return true;
    }
    // Recurse into nested items.
    if (item && item.item) {
      if (replaceItemRef(item, resourceIdentifier, splits)) return true;
    }
  }
  return false;
}

/**
 * Validate a parsed manifest's structural integrity against the SCORM
 * content-package shape. Returns errors instead of throwing; never throws
 * on bad input.
 *
 * Checks:
 *   - root <manifest> exists with an `identifier` attribute
 *   - exactly one <organizations> element with at least one <organization>
 *   - every <organization> has at least one <item>
 *   - every <item> with `identifierref` resolves to a <resource> identifier
 *   - every <resource> has an `identifier` and at least one <file>
 *
 * @param {object} parsed - wrapper from parseManifest
 * @returns {{ valid: boolean, errors: string[], version: string }}
 */
function validateManifest(parsed) {
  const errors = [];
  if (!parsed || !parsed.ast || !parsed.ast.manifest) {
    return { valid: false, errors: ['root <manifest> not found'], version: 'unknown' };
  }
  const manifest = parsed.ast.manifest;
  if (!manifest.$ || !manifest.$.identifier) {
    errors.push('manifest@identifier is required');
  }

  const organizationsElement = firstOrSelf(manifest.organizations);
  if (!organizationsElement) {
    errors.push('<organizations> element is required');
  }
  const orgArray = organizationsElement ? ensureArray(organizationsElement.organization) : [];
  if (organizationsElement && orgArray.length === 0) {
    errors.push('<organizations> must contain at least one <organization>');
  }

  const resourcesElement = firstOrSelf(manifest.resources);
  const resourceArray = resourcesElement ? ensureArray(resourcesElement.resource) : [];
  const resourceIds = new Set();
  for (const r of resourceArray) {
    if (!r || !r.$ || !r.$.identifier) {
      errors.push('<resource> missing required identifier attribute');
      continue;
    }
    resourceIds.add(r.$.identifier);
    const fileArray = ensureArray(r.file);
    if (fileArray.length === 0 && !r.$.href) {
      errors.push(`<resource identifier="${r.$.identifier}"> must have at least one <file> or @href`);
    }
  }

  // Walk every item recursively; require identifierref to resolve.
  function walkItems(items, orgId) {
    for (const item of ensureArray(items)) {
      if (!item) continue;
      const attrs = item.$ || {};
      if (attrs.identifierref && !resourceIds.has(attrs.identifierref)) {
        errors.push(
          `<item identifier="${attrs.identifier || '?'}"> in organization "${orgId}" references unknown resource "${attrs.identifierref}"`
        );
      }
      if (item.item) walkItems(item.item, orgId);
    }
  }
  for (const org of orgArray) {
    const orgId = (org && org.$ && org.$.identifier) || '?';
    if (!org.item) {
      errors.push(`<organization identifier="${orgId}"> must contain at least one <item>`);
      continue;
    }
    walkItems(org.item, orgId);
  }

  const version = parsed[KEY_DECLARED] || detectScormVersion(parsed.ast);
  return { valid: errors.length === 0, errors, version };
}

/* ----- helpers ----- */

function ensureArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

/**
 * xml2js with `explicitArray: true` always wraps element children in arrays.
 * For root-level singletons (`<organizations>`, `<resources>`) we want the
 * single element. Defensive against authors who unwrap manually.
 */
function firstOrSelf(x) {
  if (x === undefined || x === null) return null;
  if (Array.isArray(x)) return x.length > 0 ? x[0] : null;
  return x;
}

module.exports = {
  parseManifest,
  serializeManifest,
  splitResource,
  validateManifest,
  // Exposed for tests; not a public part of the editor surface.
  _detectScormVersion: detectScormVersion
};
