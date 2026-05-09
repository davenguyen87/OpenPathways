/**
 * page-split transformer — splits a single oversized SCO HTML file into
 * multiple SCOs and rewrites `imsmanifest.xml` to register the new
 * resources in the original sequence.
 *
 * Tier:        full
 * Family:      page-split
 * Criteria:    2.4.1, 3.3.x, 1.3.1
 * Triage:      author rework
 * Provenance:  rule-based by default; lights up to llm when v4.1's assisted
 *              provider is available AND opts.allowLLMSplit !== false.
 *
 * Detection (canTransform). True when:
 *   - the package is SCORM 1.2 or 2004 (declines AICC, cmi5, xAPI), AND
 *   - at least one HTML SCO is over the size threshold, OR contains > 1
 *     top-level <h1>, OR contains an explicit split marker
 *     (`<hr role="separator" data-prism-split>` or `<!-- prism-split -->`),
 *     OR has a 2.4.1 finding in the audit results.
 *
 * Apply choreography:
 *   1. Pick the first qualifying SCO file in iteration order. v5 splits one
 *      SCO per transform — multi-file packages produce N transforms across
 *      successive orchestrator passes (the orchestrator handles iteration).
 *   2. Choose split points (heuristic by default, LLM when configured).
 *   3. Materialize <stem>-part-N.html files (each inherits the original
 *      <head>; one split's body each; nav block at bottom).
 *   4. Edit the manifest via splitResource: replace the original <resource>
 *      with N resources, and the matching <item> with N items.
 *   5. Emit one Transform whose patches[] contains:
 *        - one create-from-empty patch per new file
 *        - one delete patch for the original (after === '')
 *        - one edit patch for imsmanifest.xml
 *
 * Revert is the reverse: recreate original from the deletion patch's
 * `before`, drop every new file, restore manifest from the manifest patch's
 * `before`. Atomic — every patch reverts together or none.
 *
 * Conservative declines (per PRD § Risks). Decline silently when:
 *   - the page contains <form> elements that would span the proposed splits
 *   - the page contains inline scripts referencing IDs that span splits
 *   - the package's <organization> tree is non-standard (no <item>
 *     descendants, or items lack identifier attributes)
 *
 * @typedef {import('../rebuild/types').Patch} Patch
 * @typedef {import('../rebuild/types').Transform} Transform
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cheerio = require('cheerio');

const {
  parseManifest,
  serializeManifest,
  splitResource,
  validateManifest
} = require('../lib/manifest-xml-editor');

const TRANSFORMER_ID = 'page-split';

// Threshold above which a single HTML file is a candidate. The PRD calls out
// 50KB. Configurable via opts.sizeThresholdBytes for testing; production
// callers should accept the default.
const DEFAULT_SIZE_THRESHOLD_BYTES = 50 * 1024;

// Title format for split SCOs — referenced by the test suite. Documenting
// here so the format is locked: any change must update the test expectation.
const PART_TITLE_FORMAT = (originalTitle, n, k) => `${originalTitle} (Part ${n} of ${k})`;

// Filename suffix format. "lesson.html" -> "lesson-part-1.html".
const PART_FILENAME_FORMAT = (stem, ext, n) => `${stem}-part-${n}${ext}`;

// Markers honoured by the heuristic split-point chooser.
const SPLIT_COMMENT_MARKER = 'prism-split';
const SPLIT_HR_SELECTOR = 'hr[role="separator"][data-prism-split]';

/**
 * Stable resource-id hash. Resource identifiers stay deterministic across
 * runs so a re-run of rebuild on identical input produces byte-identical
 * splits. A 12-char hex prefix gives ~2^48 distinct ids per original — more
 * than any real package will ever need.
 */
function deriveResourceId(originalId, splitIndex) {
  const h = crypto.createHash('sha256');
  h.update(`${originalId}|${splitIndex}`);
  return `${originalId}-PART-${splitIndex}-${h.digest('hex').slice(0, 12)}`;
}

/**
 * Heuristic split-point chooser. Returns `{ mode, boundaries }` where:
 *
 *   - mode === 'h1-anchor':   each <h1> is the start of its own split.
 *                             N h1s yield N splits. Pre-first-h1 content
 *                             attaches to split 1.
 *   - mode === 'separator':   each marker (HR or comment) sits BETWEEN
 *                             splits. The marker is dropped. M markers
 *                             yield M+1 splits.
 *   - mode === 'none':        no split possible.
 *
 * If both kinds of signal are present (markers AND >1 h1), markers win —
 * an explicit marker is authorial intent and overrides the heuristic.
 */
function chooseHeuristicSplitPoints($, $body) {
  // Explicit HR markers
  const hrMarkers = $body.find(SPLIT_HR_SELECTOR).toArray();
  if (hrMarkers.length > 0) {
    return { mode: 'separator', boundaries: hrMarkers };
  }
  // Explicit HTML-comment markers — cheerio does not surface comments
  // through normal selectors. Replace them with sentinel HRs so the rest
  // of the pipeline can address them as nodes.
  const html = $body.html() || '';
  if (new RegExp(`<!--\\s*${SPLIT_COMMENT_MARKER}\\s*-->`).test(html)) {
    const sentinelClass = '__prism_split_sentinel__';
    const replaced = html.replace(
      new RegExp(`<!--\\s*${SPLIT_COMMENT_MARKER}\\s*-->`, 'g'),
      `<hr data-prism-sentinel="${sentinelClass}">`
    );
    $body.html(replaced);
    const sentinels = $body.find(`hr[data-prism-sentinel="${sentinelClass}"]`).toArray();
    if (sentinels.length > 0) return { mode: 'separator', boundaries: sentinels };
  }
  // Default: top-level <h1>. With >= 2 h1s, every h1 anchors a split.
  const h1s = $body.children('h1').toArray();
  if (h1s.length >= 2) {
    return { mode: 'h1-anchor', boundaries: h1s };
  }
  return { mode: 'none', boundaries: [] };
}

/**
 * Split the body's children into N groups according to the chosen mode.
 * Returns an array of HTML-string bodies, one per split.
 *
 * h1-anchor mode:
 *   - Each h1 is the start of a new split.
 *   - Whitespace and content before the first h1 are folded into split 1
 *     (so the first <h1> still leads its own split visually but no
 *     opening text is lost).
 *
 * separator mode:
 *   - Each marker node sits between splits.
 *   - The marker itself is dropped.
 *   - M markers yield M+1 splits.
 */
function buildSplitBodies($, $body, plan) {
  const { mode, boundaries } = plan;
  if (mode === 'none' || boundaries.length === 0) return [$body.html() || ''];

  const allChildren = $body.contents().toArray();
  const boundarySet = new Set(boundaries);

  if (mode === 'h1-anchor') {
    // Pre-first-h1 content is folded into split 1 as its prefix. Each h1
    // (including the first) opens a split that runs until the next h1. With
    // N h1s, there are exactly N groups.
    const groups = [];
    let current = [];
    let crossedFirst = false;
    for (const node of allChildren) {
      if (boundarySet.has(node)) {
        if (crossedFirst) {
          groups.push(current);
          current = [node];
        } else {
          // First h1 — fold any prefix content (typically whitespace) into
          // this group, then mark that we've started.
          current.push(node);
          crossedFirst = true;
        }
      } else {
        current.push(node);
      }
    }
    if (current.length > 0) groups.push(current);
    return groups.map((nodes) => nodes.map((n) => $.html(n)).join(''));
  }

  if (mode === 'separator') {
    const groups = [];
    let current = [];
    for (const node of allChildren) {
      if (boundarySet.has(node)) {
        groups.push(current);
        current = [];
      } else {
        current.push(node);
      }
    }
    groups.push(current);
    return groups.map((nodes) => nodes.map((n) => $.html(n)).join(''));
  }

  return [$body.html() || ''];
}

function isWhitespaceTextNode(n) {
  if (!n) return false;
  if (n.type !== 'text') return false;
  const data = n.data || '';
  return /^\s*$/.test(data);
}

/**
 * Detect whether splitting at the given boundaries would break <form>
 * scoping or inline-script DOM references. Returns a string reason on
 * decline, or null when safe.
 */
function detectSplitHazards($, $body, boundaries) {
  if (boundaries.length === 0) return null;

  // Compute which split each top-level child belongs to.
  const allChildren = $body.contents().toArray();
  const boundarySet = new Set(boundaries);
  const childToSplit = new Map();
  let splitIdx = 0;
  for (const node of allChildren) {
    if (boundarySet.has(node) && childToSplit.size > 0) {
      splitIdx += 1;
    }
    childToSplit.set(node, splitIdx);
  }

  // <form> hazard: walk the descendants of every form and ensure they all
  // belong to the same split as the <form>'s top-level ancestor.
  let hazard = null;
  $body.find('form').each((_, form) => {
    if (hazard) return;
    const ancestor = topLevelAncestor($, $body, form);
    const formSplit = ancestor ? childToSplit.get(ancestor) : undefined;
    let crosses = false;
    $(form).find('*').each((__, descendant) => {
      // Cheerio descendants are always inside the form ancestor; the hazard
      // arises only if the form's *content* is the split boundary itself.
      // We instead detect when a form contains an explicit split marker.
      if (boundarySet.has(descendant)) crosses = true;
    });
    // Additional check: if the form starts in one split and the next sibling
    // boundary is *inside* the form's subtree, that's also a hazard.
    if (formSplit !== undefined) {
      $(form).find('hr[role="separator"][data-prism-split], hr[data-prism-sentinel]').each(() => {
        crosses = true;
      });
    }
    if (crosses) hazard = 'form spans split boundary';
  });
  if (hazard) return hazard;

  // Inline-script hazard: any inline <script> that references an id present
  // in a different split is a hazard. Cheap regex; deeper analysis is v5.1+.
  const idsBySplit = new Map();
  $body.find('[id]').each((_, el) => {
    const ancestor = topLevelAncestor($, $body, el);
    const split = ancestor ? childToSplit.get(ancestor) : undefined;
    if (split === undefined) return;
    const id = $(el).attr('id');
    if (!id) return;
    if (!idsBySplit.has(split)) idsBySplit.set(split, new Set());
    idsBySplit.get(split).add(id);
  });

  $body.find('script:not([src])').each((_, scriptEl) => {
    if (hazard) return;
    const ancestor = topLevelAncestor($, $body, scriptEl);
    const split = ancestor ? childToSplit.get(ancestor) : undefined;
    if (split === undefined) return;
    const text = $(scriptEl).html() || '';
    // Look for getElementById('foo') or document.querySelector('#foo')
    const refRegex = /getElementById\(\s*['"]([^'"]+)['"]\s*\)|querySelector(?:All)?\(\s*['"]\s*#([^'"\s]+)/g;
    let m;
    while ((m = refRegex.exec(text)) !== null) {
      const id = m[1] || m[2];
      if (!id) continue;
      const ownIds = idsBySplit.get(split) || new Set();
      // If the id exists in a different split but not in this script's
      // split, decline.
      let foundElsewhere = false;
      for (const [otherSplit, ids] of idsBySplit.entries()) {
        if (otherSplit === split) continue;
        if (ids.has(id)) {
          foundElsewhere = true;
          break;
        }
      }
      if (foundElsewhere && !ownIds.has(id)) {
        hazard = `inline script references id "${id}" in a different split`;
        break;
      }
    }
  });
  return hazard;
}

function topLevelAncestor($, $body, node) {
  let cur = node;
  while (cur && cur.parent && cur.parent !== $body[0] && cur.parentNode !== $body[0]) {
    cur = cur.parent || cur.parentNode;
    if (!cur) break;
  }
  return cur;
}

/**
 * Build the full HTML for a split file. Inherits the original <head> and
 * appends a navigation block at the bottom of the new <body>.
 */
function buildSplitHtml(originalHtml, $original, splitIndex, splitCount, splitBodyHtml, splitFilenames) {
  const $ = cheerio.load(originalHtml, { decodeEntities: false });
  const $body = $('body');
  $body.empty();
  $body.append(splitBodyHtml);

  // Navigation: prev/next anchors. We do not generate links for nonexistent
  // siblings (first split has no prev; last has no next). Lang-neutral
  // labels per PRD; consultants localize as needed during review.
  const nav = $('<nav class="prism-split-nav" aria-label="Page navigation"></nav>');
  if (splitIndex > 0) {
    const prev = $('<a></a>')
      .attr('href', splitFilenames[splitIndex - 1])
      .attr('rel', 'prev')
      .text('Previous part');
    nav.append(prev);
  }
  if (splitIndex < splitCount - 1) {
    const next = $('<a></a>')
      .attr('href', splitFilenames[splitIndex + 1])
      .attr('rel', 'next')
      .text('Next part');
    nav.append(next);
  }
  $body.append('\n');
  $body.append(nav);
  $body.append('\n');
  return $.html();
}

/**
 * Produce a deterministic ISO timestamp. Defaulting to `new Date()` makes
 * timestamps drift run-to-run, but the rest of the patch (file content,
 * range, before, after) stays byte-identical, which is what the
 * "deterministic across runs" contract actually requires. Tests inject a
 * fixed clock when they care.
 */
function nowIso(opts) {
  if (opts && typeof opts.now === 'function') {
    const v = opts.now();
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'string') return v;
  }
  return new Date().toISOString();
}

/**
 * Build a Patch shape for create-from-empty / delete / manifest-edit cases.
 * These bypass `buildPatch` because that helper assumes a localized
 * substring edit; full-file replacements need a different range model
 * (whole-file: 1:1 to last:lastCol).
 */
function buildFullFilePatch({ fixer, criterion, file, before, after, rationale, confidence, provenance }) {
  const range = computeWholeFileRange(after.length > 0 ? after : before);
  return {
    fixer,
    criterion,
    triage: 'author rework',
    tier: 'full',
    confidence,
    provenance,
    file,
    range,
    before,
    after,
    rationale,
    reversible: true,
    status: 'applied'
  };
}

function computeWholeFileRange(content) {
  if (!content) {
    return { startLine: 1, startCol: 1, endLine: 1, endCol: 1 };
  }
  const lines = content.split('\n');
  const last = lines[lines.length - 1];
  return {
    startLine: 1,
    startCol: 1,
    endLine: lines.length,
    endCol: last.length + 1
  };
}

/**
 * canTransform — package-level claim. See module docstring.
 *
 * @param {object} ctx - { packageRoot, parser, files: [{path, content, size}], audit }
 * @returns {boolean}
 */
function canTransform(ctx) {
  if (!ctx) return false;
  // SCORM-only — explicit decline of AICC, cmi5, xAPI.
  const version = ctx.parserVersion || (ctx.parser && ctx.parser.version);
  if (version && version !== 'scorm12' && version !== 'scorm2004') {
    return false;
  }
  const files = Array.isArray(ctx.files) ? ctx.files : [];
  for (const file of files) {
    if (!isHtml(file.path)) continue;
    if (qualifies(file, ctx)) return true;
  }
  return false;
}

function isHtml(p) {
  if (!p) return false;
  const lower = p.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm');
}

function qualifies(file, ctx) {
  const sizeThreshold = (ctx && ctx.opts && ctx.opts.sizeThresholdBytes) || DEFAULT_SIZE_THRESHOLD_BYTES;
  const size = typeof file.size === 'number' ? file.size : Buffer.byteLength(file.content || '', 'utf8');
  if (size > sizeThreshold) return true;
  const content = file.content || '';
  // Quick signal probes — cheerio is the source of truth, but we avoid
  // parsing files we already know don't qualify.
  if (content.indexOf('data-prism-split') !== -1) return true;
  if (content.indexOf(`<!--`) !== -1 && content.indexOf(SPLIT_COMMENT_MARKER) !== -1) return true;
  // Multiple top-level <h1>: parse properly, since regex misfires on
  // nested h1s and string literals.
  try {
    const $ = cheerio.load(content, { decodeEntities: false });
    if ($('body').children('h1').length > 1) return true;
  } catch (_) { /* malformed HTML — skip */ }

  // Audit-driven: any 2.4.1 finding for this file.
  if (Array.isArray(ctx && ctx.audit && ctx.audit.violations)) {
    const hit = ctx.audit.violations.find((v) => v && v.file === file.path && (v.criterion === '2.4.1' || /^3\.3\./.test(v.criterion || '')));
    if (hit) return true;
  }
  return false;
}

/**
 * apply — package-level rewrite. See module docstring.
 *
 * @param {object} ctx
 * @returns {Promise<{ transform: Transform, patches: Patch[], log: string[] }>}
 */
async function apply(ctx) {
  const log = [];
  if (!ctx || !Array.isArray(ctx.files) || ctx.files.length === 0) {
    throw new Error('page-split.apply: ctx.files must be a non-empty array');
  }
  const opts = ctx.opts || {};
  const provenanceMode = pickProvenanceMode(opts);

  // Find the first qualifying file. canTransform already returned true; we
  // re-scan here in case the orchestrator changed the file set between
  // claim and apply (rare, but possible for chained transforms).
  const target = ctx.files.find((f) => isHtml(f.path) && qualifies(f, ctx));
  if (!target) {
    throw new Error('page-split.apply: no qualifying HTML file found');
  }

  // Locate the manifest path: prefer ctx.manifestPath, fall back to scanning
  // for an imsmanifest.xml in ctx.files.
  const manifestEntry = ctx.files.find((f) => /(^|\/)imsmanifest\.xml$/i.test(f.path));
  if (!manifestEntry) {
    throw new Error('page-split.apply: imsmanifest.xml not found in package files');
  }

  const $ = cheerio.load(target.content, { decodeEntities: false });
  const $body = $('body');
  if ($body.length === 0) {
    throw new Error(`page-split.apply: ${target.path} has no <body>`);
  }

  const plan = chooseHeuristicSplitPoints($, $body);
  if (plan.mode === 'none' || plan.boundaries.length === 0) {
    throw new Error(`page-split.apply: no split boundaries detected in ${target.path}`);
  }
  // Compute the resulting split count up-front to enforce >= 2 splits.
  const projectedSplits = plan.mode === 'separator'
    ? plan.boundaries.length + 1
    : plan.boundaries.length;
  if (projectedSplits < 2) {
    throw new Error(`page-split.apply: too few splits projected in ${target.path}`);
  }

  const hazard = detectSplitHazards($, $body, plan.boundaries);
  if (hazard) {
    throw new Error(`page-split.apply: declines ${target.path} — ${hazard}`);
  }

  // Resolve the resource identifier for this file by reading the manifest
  // BEFORE we mutate it.
  const parsed = await parseManifest(manifestEntry.content);
  const resourceIdentifier = findResourceIdentifierForHref(parsed, target.path);
  if (!resourceIdentifier) {
    throw new Error(`page-split.apply: could not locate resource for ${target.path} in manifest`);
  }

  // Decline non-standard <organization> structures: any organization whose
  // items lack identifiers, or which has no <item> children at all.
  const orgIssue = detectNonStandardOrganization(parsed);
  if (orgIssue) {
    throw new Error(`page-split.apply: declines — ${orgIssue}`);
  }

  // Compute split bodies + filenames.
  const splitBodies = buildSplitBodies($, $body, plan);
  const k = splitBodies.length;
  const dir = path.posix.dirname(target.path);
  const base = path.posix.basename(target.path);
  const ext = path.posix.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  const splitFilenames = splitBodies.map((_, i) => PART_FILENAME_FORMAT(stem, ext, i + 1));
  const splitPaths = splitFilenames.map((f) => (dir === '.' || dir === '' ? f : `${dir}/${f}`));

  // Read the original title from the manifest (preferred) or from <title>.
  const originalTitle = readItemTitle(parsed, resourceIdentifier) || ($('title').first().text() || stem);

  // Build new HTML files.
  const splitContents = splitBodies.map((bodyHtml, i) =>
    buildSplitHtml(target.content, $, i, k, bodyHtml, splitFilenames)
  );

  // Build manifest splits — one entry per new file.
  const splits = splitContents.map((_, i) => ({
    identifier: deriveResourceId(resourceIdentifier, i + 1),
    href: splitFilenames[i],
    files: [splitFilenames[i]],
    title: PART_TITLE_FORMAT(originalTitle, i + 1, k)
  }));

  // Mutate the manifest AST.
  splitResource(parsed, resourceIdentifier, splits);
  const newManifestXml = serializeManifest(parsed);

  // Verify the resulting manifest validates structurally.
  const reparsed = await parseManifest(newManifestXml);
  const result = validateManifest(reparsed);
  if (!result.valid) {
    throw new Error(`page-split.apply: post-edit manifest invalid: ${result.errors.join('; ')}`);
  }

  // Write new files to disk. Stage to ctx.workDir if provided; else fall
  // back to relying on the orchestrator to materialize patches.
  if (ctx.workDir) {
    for (let i = 0; i < splitContents.length; i++) {
      const full = path.join(ctx.workDir, splitPaths[i]);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, splitContents[i], 'utf8');
    }
    // Delete the original.
    const origFull = path.join(ctx.workDir, target.path);
    try { fs.unlinkSync(origFull); } catch (_) { /* may already be gone */ }
    // Overwrite the manifest.
    const manifestFull = path.join(ctx.workDir, manifestEntry.path);
    fs.writeFileSync(manifestFull, newManifestXml, 'utf8');
  }

  // Build patches.
  const provenance = buildProvenance(provenanceMode, opts);
  const confidence = computeConfidence(provenanceMode, opts);
  const patches = [];
  for (let i = 0; i < splitContents.length; i++) {
    patches.push(buildFullFilePatch({
      fixer: TRANSFORMER_ID,
      criterion: '2.4.1',
      file: splitPaths[i],
      before: '',
      after: splitContents[i],
      rationale: `Split from ${target.path} as part ${i + 1} of ${k}.`,
      confidence,
      provenance
    }));
  }
  patches.push(buildFullFilePatch({
    fixer: TRANSFORMER_ID,
    criterion: '2.4.1',
    file: target.path,
    before: target.content,
    after: '',
    rationale: `Removed in favour of ${k} part files.`,
    confidence,
    provenance
  }));
  patches.push(buildFullFilePatch({
    fixer: TRANSFORMER_ID,
    criterion: '2.4.1',
    file: manifestEntry.path,
    before: manifestEntry.content,
    after: newManifestXml,
    rationale: `Replaced resource ${resourceIdentifier} with ${k} split resources; updated organization items.`,
    confidence,
    provenance
  }));

  // Build the Transform record. The orchestrator (chunk 01) calls
  // `manifest.addTransform`, which assigns the final id. We leave id unset
  // here just like fixers leave patch.id unset.
  const transform = {
    transformer: TRANSFORMER_ID,
    family: 'page-split',
    criteria: ['2.4.1', '3.3.x', '1.3.1'],
    tier: 'full',
    scope: {
      files: [...splitPaths, target.path, manifestEntry.path],
      manifestEdited: true
    },
    patchIds: [], // populated by the orchestrator after addPatch returns ids
    provenance,
    rationale: `Split ${target.path} into ${k} pages and rewrote imsmanifest.xml to register ${k} new SCOs in place of the original.`,
    previewPath: 'rebuild-preview.html',
    requiresCheckpointApproval: true,
    status: 'pending-checkpoint'
  };

  log.push(`split ${target.path} into ${k} parts (${splitFilenames.join(', ')})`);
  log.push(`replaced resource ${resourceIdentifier} with ${k} resources in imsmanifest.xml`);

  return { transform, patches, log };
}

/**
 * Reverse the transform. Recreates the original file, deletes the split
 * files, and restores the manifest from the manifest patch's `before`.
 *
 * @param {object} ctx
 * @param {Transform} transform
 * @returns {Promise<{ patches: Patch[], log: string[] }>}
 */
async function revert(ctx, transform) {
  const log = [];
  if (!ctx || !Array.isArray(ctx.patches)) {
    throw new Error('page-split.revert: ctx.patches must be an array');
  }
  if (!transform) {
    throw new Error('page-split.revert: transform is required');
  }
  const transformPatches = ctx.patches.filter((p) => p && p.transformId === transform.id);
  if (transformPatches.length === 0) {
    throw new Error(`page-split.revert: no patches associated with transform ${transform.id}`);
  }

  // Atomic guarantee: snapshot the workDir state before mutating, restore
  // on error. We use a JS-level rollback: collect every (path, oldBytes)
  // pair before writing, and on failure rewrite each one.
  const rollbacks = [];
  try {
    for (const patch of [...transformPatches].reverse()) {
      const full = ctx.workDir ? path.join(ctx.workDir, patch.file) : null;
      // Capture current bytes for rollback.
      let prior = null;
      if (full && fs.existsSync(full)) {
        prior = fs.readFileSync(full);
      }
      rollbacks.push({ full, prior, existed: prior !== null });

      // Three patch shapes for page-split: create-from-empty, delete, edit.
      const isCreate = patch.before === '' && patch.after !== '';
      const isDelete = patch.before !== '' && patch.after === '';
      // Otherwise: an edit patch (manifest).

      if (full) {
        if (isCreate) {
          try { fs.unlinkSync(full); } catch (_) { /* already gone */ }
        } else if (isDelete) {
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, patch.before, 'utf8');
        } else {
          fs.writeFileSync(full, patch.before, 'utf8');
        }
      }
    }
    const reverted = transformPatches.map((p) => ({ ...p, status: 'reverted' }));
    log.push(`reverted ${reverted.length} patches for transform ${transform.id}`);
    return { patches: reverted, log };
  } catch (err) {
    // Rollback in reverse order so files appear/disappear back to their
    // pre-revert state.
    for (const rb of rollbacks.reverse()) {
      if (!rb.full) continue;
      try {
        if (rb.existed) {
          fs.writeFileSync(rb.full, rb.prior);
        } else if (fs.existsSync(rb.full)) {
          fs.unlinkSync(rb.full);
        }
      } catch (_) { /* best-effort */ }
    }
    throw new Error(`page-split.revert: atomic rollback triggered: ${err.message}`);
  }
}

/* ----- helpers ----- */

function findResourceIdentifierForHref(parsed, hrefPath) {
  const manifest = parsed.ast.manifest;
  const resourcesElement = firstOrSelf(manifest.resources);
  if (!resourcesElement) return null;
  const arr = ensureArray(resourcesElement.resource);
  // Match by basename so manifest hrefs ("page.html") align with package
  // paths ("course/page.html"). The basename of the package path is the
  // canonical comparison key.
  const targetBase = path.posix.basename(hrefPath);
  for (const r of arr) {
    const id = r && r.$ && r.$.identifier;
    const href = r && r.$ && r.$.href;
    if (id && href && path.posix.basename(href) === targetBase) return id;
    // Some resources keep the entry as <file href>; check those too.
    const files = ensureArray(r && r.file);
    for (const f of files) {
      const fhref = f && f.$ && f.$.href;
      if (fhref && path.posix.basename(fhref) === targetBase) return id;
    }
  }
  return null;
}

function detectNonStandardOrganization(parsed) {
  const manifest = parsed.ast.manifest;
  const organizationsElement = firstOrSelf(manifest.organizations);
  if (!organizationsElement) return '<organizations> element missing';
  const orgArray = ensureArray(organizationsElement.organization);
  if (orgArray.length === 0) return 'no <organization> elements found';
  for (const org of orgArray) {
    if (!org.item) return 'organization has no <item> children';
    const items = ensureArray(org.item);
    for (const item of items) {
      if (!item.$ || !item.$.identifier) return '<item> missing identifier attribute';
    }
  }
  return null;
}

function readItemTitle(parsed, resourceIdentifier) {
  const manifest = parsed.ast.manifest;
  const organizationsElement = firstOrSelf(manifest.organizations);
  if (!organizationsElement) return null;
  const orgArray = ensureArray(organizationsElement.organization);
  for (const org of orgArray) {
    const t = walkForItemTitle(org, resourceIdentifier);
    if (t) return t;
  }
  return null;
}

function walkForItemTitle(parent, resourceIdentifier) {
  if (!parent || !parent.item) return null;
  for (const item of ensureArray(parent.item)) {
    if (item && item.$ && item.$.identifierref === resourceIdentifier) {
      const t = ensureArray(item.title);
      if (t.length === 0) return null;
      const v = t[0];
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object' && v._) return v._;
      return null;
    }
    if (item && item.item) {
      const r = walkForItemTitle(item, resourceIdentifier);
      if (r) return r;
    }
  }
  return null;
}

function ensureArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function firstOrSelf(x) {
  if (x === undefined || x === null) return null;
  if (Array.isArray(x)) return x.length > 0 ? x[0] : null;
  return x;
}

/**
 * Decide whether to run in heuristic or LLM mode. LLM mode requires the v4.1
 * provider abstraction to be present *and* the caller to pass an explicit
 * `allowLLMSplit !== false`. v4.1's provider has not landed in the branch
 * this prompt was written against; the LLM branch is therefore dead-coded
 * and falls back cleanly to heuristic mode without throwing.
 */
function pickProvenanceMode(opts) {
  if (opts && opts.allowLLMSplit === false) return 'rule-based';
  // Look for a v4.1 provider — kept as a soft check so the day v4.1 lands,
  // this transformer flips automatically. Until then, the require either
  // throws (no module) or returns a no-op; both routes fall through to
  // heuristic. The `try/catch` keeps `npm run check-no-network` silent —
  // we never *call* a provider here, only inspect that the module exists.
  try {
    // eslint-disable-next-line global-require
    const provider = require('../lib/llm-provider'); // hypothetical v4.1 module
    if (provider && typeof provider.suggestSplitPoints === 'function') {
      return 'llm';
    }
  } catch (_) { /* expected — v4.1 not merged */ }
  return 'rule-based';
}

function buildProvenance(mode, opts) {
  const ts = nowIso(opts);
  if (mode === 'llm') {
    return {
      source: 'llm',
      timestamp: ts,
      // Real values land when v4.1's provider wires through here.
      model: opts.llmModel || 'unknown',
      promptHash: opts.promptHash || 'unknown',
      modelConfidence: typeof opts.modelConfidence === 'number' ? opts.modelConfidence : 0
    };
  }
  return { source: 'rule-based', timestamp: ts };
}

function computeConfidence(mode, opts) {
  if (mode === 'llm' && typeof opts.modelConfidence === 'number' && opts.modelConfidence >= 0.85) {
    return 'likely';
  }
  return 'needs-review';
}

module.exports = {
  id: TRANSFORMER_ID,
  name: 'Split overflowing SCO into multiple pages',
  family: 'page-split',
  supported: ['scorm12', 'scorm2004'],
  criteria: ['2.4.1', '3.3.x', '1.3.1'],
  triage: 'author rework',
  tier: 'full',
  provenance: 'rule-based',

  canTransform,
  apply,
  revert,

  // Exposed for tests.
  _internals: {
    deriveResourceId,
    chooseHeuristicSplitPoints,
    detectSplitHazards,
    PART_TITLE_FORMAT,
    PART_FILENAME_FORMAT,
    DEFAULT_SIZE_THRESHOLD_BYTES
  }
};
