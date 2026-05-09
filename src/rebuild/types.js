/**
 * Shared rebuild typedefs and small helpers used by every fixer.
 *
 * The shapes below match PRD v4 § "Manifest schema" verbatim. Other modules
 * `require` this file and reference the typedefs in JSDoc comments. Three
 * runtime helpers are exported because every fixer needs them and a separate
 * helper module would add a third file outside this chunk's scope.
 *
 * @typedef {Object} Range
 * @property {number} startLine - 1-based
 * @property {number} startCol  - 1-based
 * @property {number} endLine
 * @property {number} endCol
 *
 * @typedef {Object} Provenance
 * @property {'deterministic'|'llm'|'rule-based'} source
 * @property {string} timestamp - ISO 8601
 * @property {string} [model]            - assisted tier only
 * @property {string} [promptHash]       - assisted tier only
 * @property {number} [modelConfidence]  - assisted tier only
 *
 * @typedef {Object} Patch
 * @property {string} id - patch-NNNN, assigned by manifest.addPatch
 * @property {string} fixer
 * @property {string} criterion
 * @property {string} triage
 * @property {'safe'|'assisted'|'full'} tier
 * @property {'definitive'|'likely'|'needs-review'} confidence
 * @property {Provenance} provenance
 * @property {string} file
 * @property {Range} range
 * @property {string} before
 * @property {string} after
 * @property {string} rationale
 * @property {boolean} reversible
 * @property {'applied'|'reverted'|'rejected'} status
 * @property {string} [transformId] - v5: links a full-tier patch to its parent transform
 *
 * @typedef {Object} TransformScope
 * @property {string[]} files - package-relative paths the transform writes to
 * @property {boolean} manifestEdited - true when the transform edits imsmanifest.xml
 *
 * @typedef {Object} TransformJudgment
 * @property {'llm'} source                                  Always 'llm' in v5.1.
 * @property {'match'|'no-match'|'uncertain'} verdict
 * @property {number} confidence                              0..1
 * @property {string} rationale                               LLM's reason; ≤ 280 chars.
 * @property {string} provider                                e.g. 'anthropic'
 * @property {string} model                                   e.g. 'claude-haiku-4-5'
 * @property {string} promptHash                              `sha256:<hex>`
 * @property {{inputTokens:number, outputTokens:number}} usage
 * @property {number} latencyMs
 * @property {string} generatedAt                             ISO 8601
 *
 * @typedef {Object} Transform
 * @property {string} id - transform-NNNN, assigned by manifest.addTransform
 * @property {string} transformer - id of the transformer module that emitted this
 * @property {'landmark'|'widget'|'page-split'} family
 * @property {string[]} criteria - WCAG criteria the transform addresses
 * @property {'full'} tier
 * @property {TransformScope} scope
 * @property {string[]} patchIds - ids of every patch produced by this transform
 * @property {Provenance} provenance
 * @property {string} rationale
 * @property {string} previewPath - anchor into rebuild-preview.html
 * @property {boolean} requiresCheckpointApproval
 * @property {'pending-checkpoint'|'applied'|'reverted'|'rejected'} status
 * @property {string} [checkpointApprovedBy]
 * @property {string} [checkpointApprovedAt]
 * @property {TransformJudgment} [judgment]  v5.1 — populated when LLM classified the candidate.
 *
 * The Transformer interface is a duck-typed contract — there is no runtime
 * base class. v5 transformers expose:
 *
 *   {
 *     id: string,
 *     name: string,
 *     family: 'landmark'|'widget'|'page-split',
 *     supported: string[],            // 'scorm12' | 'scorm2004' | 'aicc'
 *     criteria: string[],
 *     triage: string,                 // matches v3 triage taxonomy
 *     tier: 'full',
 *     provenance: 'rule-based'|'llm',
 *
 *     canTransform(packageContext): boolean,
 *     async apply(packageContext): { transform: Transform, patches: Patch[], log: string[] },
 *     async revert(packageContext, transform): { patches: Patch[], log: string[] }
 *   }
 *
 * Fixers (v4 / v4.1) and Transformers (v5) coexist. Fixers are unchanged.
 *
 * @typedef {Object} DeferredFinding
 * @property {string} criterion
 * @property {string} triage
 * @property {string} reason
 * @property {string} file
 * @property {number} line
 *
 * @typedef {Object} VerificationCounts
 * @property {number} violations
 * @property {number} criteriaFailed
 * @property {number} section508Failed
 *
 * @typedef {Object} Verification
 * @property {VerificationCounts} before
 * @property {VerificationCounts} after
 * @property {number} resolved
 * @property {number} introduced
 * @property {number} remaining
 *
 * @typedef {Object} ToolMeta
 * @property {string} name
 * @property {string} version
 *
 * @typedef {Object} RebuildManifest
 * @property {string} schemaVersion
 * @property {string} engagementId
 * @property {string} packageName
 * @property {string} inputZipSha256
 * @property {string} outputZipSha256
 * @property {'safe'|'assisted'|'full'} mode
 * @property {'wcag21'|'wcag22'} standard
 * @property {string} createdAt
 * @property {ToolMeta} tool
 * @property {Patch[]} patches
 * @property {Transform[]} [transforms] - v5: present (and serialized) only when non-empty
 * @property {DeferredFinding[]} deferred
 * @property {Verification} verification
 */

/**
 * Convert a string offset to {line, col}, both 1-based.
 *
 * @param {string} content
 * @param {number} offset
 * @returns {{ line: number, col: number }}
 */
function offsetToLineCol(content, offset) {
  if (typeof content !== 'string') {
    throw new TypeError('content must be a string');
  }
  if (typeof offset !== 'number' || offset < 0 || offset > content.length) {
    throw new RangeError(`offset ${offset} out of range [0, ${content.length}]`);
  }
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, col };
}

/**
 * Default per-side context width for `captureContext`. Sized so the
 * `after` substring is unique enough for `revertPatch`'s indexOf to land
 * on the correct site, while staying well under any copyright-reproduction
 * threshold. Diff renderers (chunk 05) MUST NOT use the patch alone for a
 * multi-line view — they need to read the actual file for surrounding lines.
 */
const PATCH_CONTEXT_CHARS = 24;

/**
 * Capture small leading and trailing context strings around a range.
 * Context is clipped to the surrounding line so the diff renderer never
 * pulls in a whole page (avoids embedding source content wholesale).
 *
 * @param {string} content
 * @param {number} startOffset
 * @param {number} endOffset
 * @param {number} [contextChars=PATCH_CONTEXT_CHARS] - max chars of context per side
 * @returns {{ left: string, right: string }}
 */
function captureContext(content, startOffset, endOffset, contextChars = PATCH_CONTEXT_CHARS) {
  const lineStart = content.lastIndexOf('\n', startOffset - 1) + 1;
  const nlAfter = content.indexOf('\n', endOffset);
  const lineEnd = nlAfter === -1 ? content.length : nlAfter;
  const left = content.slice(Math.max(lineStart, startOffset - contextChars), startOffset);
  const right = content.slice(endOffset, Math.min(lineEnd, endOffset + contextChars));
  return { left, right };
}

/**
 * Build a Patch from a localized edit. Caller supplies the pre-edit content,
 * the offset and original substring, and the replacement substring.
 * The patch's `id` is left unset — the manifest assigns sequential ids.
 *
 * Timestamps live in `provenance` so the patch body itself stays stable
 * across re-runs on identical input (id and range are deterministic).
 *
 * @param {Object} opts
 * @param {string} opts.fixer
 * @param {string} opts.criterion
 * @param {string} [opts.triage='auto-fix safe']
 * @param {'safe'|'assisted'|'full'} [opts.tier='safe']
 * @param {'definitive'|'likely'|'needs-review'} opts.confidence
 * @param {'deterministic'|'llm'|'rule-based'} [opts.provenanceSource='deterministic']
 * @param {Object} [opts.provenanceExtras] - Extra fields merged into `provenance`
 *   alongside `source` and `timestamp`. Used by assisted-tier fixers to carry
 *   `provider`, `model`, `promptHash`, `usage`, `latencyMs`. Caller-controlled
 *   shape; manifest validation only requires `source` + `timestamp`.
 * @param {string} opts.file
 * @param {string} opts.content - pre-edit content
 * @param {number} opts.originalOffset
 * @param {string} opts.originalText
 * @param {string} opts.replacementText
 * @param {string} opts.rationale
 * @param {number} [opts.contextChars=PATCH_CONTEXT_CHARS]
 * @returns {Patch}
 */
function buildPatch(opts) {
  const {
    fixer,
    criterion,
    triage = 'auto-fix safe',
    tier = 'safe',
    confidence,
    provenanceSource = 'deterministic',
    provenanceExtras,
    file,
    content,
    originalOffset,
    originalText,
    replacementText,
    rationale,
    contextChars = PATCH_CONTEXT_CHARS
  } = opts;

  const start = originalOffset;
  const end = originalOffset + originalText.length;
  const startLC = offsetToLineCol(content, start);
  const endLC = offsetToLineCol(content, end);
  const { left, right } = captureContext(content, start, end, contextChars);

  return {
    fixer,
    criterion,
    triage,
    tier,
    confidence,
    provenance: {
      source: provenanceSource,
      timestamp: new Date().toISOString(),
      ...(provenanceExtras && typeof provenanceExtras === 'object' ? provenanceExtras : {})
    },
    file,
    range: {
      startLine: startLC.line,
      startCol: startLC.col,
      endLine: endLC.line,
      endCol: endLC.col
    },
    before: left + originalText + right,
    after: left + replacementText + right,
    rationale,
    reversible: true,
    status: 'applied'
  };
}

/**
 * Reverse a single patch against the file's current content.
 * Locates `patch.after` literally and substitutes `patch.before`. Because
 * before/after share identical leading and trailing context, the round-trip
 * is byte-identical when the substring occurs uniquely (which the captured
 * context window is sized to ensure for typical inputs).
 *
 * If the after-text cannot be located (e.g., another fixer rewrote the same
 * region), the content is returned unchanged and the reason is logged.
 *
 * @param {{ path: string, content: string }} file
 * @param {Patch} patch
 * @returns {{ newContent: string, log: string[] }}
 */
function revertPatch(file, patch) {
  const log = [];
  const idx = file.content.indexOf(patch.after);
  if (idx === -1) {
    log.push(`[revert] could not locate after-text for ${patch.id || patch.fixer} in ${file.path}`);
    return { newContent: file.content, log };
  }
  const newContent =
    file.content.slice(0, idx) + patch.before + file.content.slice(idx + patch.after.length);
  log.push(`[revert] ${patch.fixer} at ${patch.range.startLine}:${patch.range.startCol} in ${file.path}`);
  return { newContent, log };
}

/**
 * Apply a list of localized edits to `original` and return the result.
 * Each mod is `{ offset, originalText, replacementText }` referenced against
 * `original`. Edits are applied in reverse offset order so earlier offsets
 * stay valid as content is rewritten.
 *
 * @param {string} original
 * @param {Array<{ offset: number, originalText: string, replacementText: string }>} mods
 * @returns {string}
 */
function applyMods(original, mods) {
  const sorted = [...mods].sort((a, b) => b.offset - a.offset);
  let out = original;
  for (const m of sorted) {
    out = out.slice(0, m.offset) + m.replacementText + out.slice(m.offset + m.originalText.length);
  }
  return out;
}

/**
 * Pure helper: return a copy of `patch` with `transformId` set. Does not
 * mutate the input. Used by `manifest.addTransform` to link every patch in a
 * transform's `patchIds` back to its parent transform.
 *
 * @param {Patch} patch
 * @param {string} transformId
 * @returns {Patch}
 */
function linkPatchToTransform(patch, transformId) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('patch must be an object');
  }
  if (typeof transformId !== 'string' || transformId.length === 0) {
    throw new TypeError('transformId must be a non-empty string');
  }
  return { ...patch, transformId };
}

module.exports = {
  offsetToLineCol,
  captureContext,
  buildPatch,
  revertPatch,
  applyMods,
  linkPatchToTransform,
  PATCH_CONTEXT_CHARS
};
