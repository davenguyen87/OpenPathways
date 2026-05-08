/**
 * Add HTML5 DOCTYPE declaration.
 * Ensures HTML files start with <!DOCTYPE html> for standards mode.
 */

const { buildPatch, revertPatch, applyMods } = require('../rebuild/types');

const FIXER_ID = 'add-html5-doctype';

module.exports = {
  id: FIXER_ID,
  name: 'Add HTML5 DOCTYPE declaration',
  supported: ['scorm12', 'scorm2004', 'aicc', 'xapi', 'cmi5'],
  confidence: 'definitive',
  criterion: '',
  triage: 'auto-fix safe',
  tier: 'safe',
  provenance: 'deterministic',

  canFix(file, violation) {
    if (!file.isHtml) return false;
    if (violation !== null) return false;

    const trimmed = file.content.replace(/^﻿/, '').trimStart();
    return !/^<!doctype\s+html/i.test(trimmed);
  },

  async apply(file /* , violations */) {
    const original = file.content;
    const log = [];

    const bomLen = original.charCodeAt(0) === 0xFEFF ? 1 : 0;
    const wsMatch = original.slice(bomLen).match(/^\s*/);
    const ws = wsMatch ? wsMatch[0] : '';
    const prefixLen = bomLen + ws.length;

    if (/^<!doctype\s+html/i.test(original.slice(prefixLen))) {
      log.push('File already has HTML5 DOCTYPE');
      return { changed: false, newContent: original, patches: [], log };
    }

    const originalPrefix = original.slice(0, prefixLen); // BOM (if any) + leading whitespace
    const replacementPrefix = `${ws}<!DOCTYPE html>\n`;

    const patch = buildPatch({
      fixer: FIXER_ID,
      criterion: '',
      confidence: 'definitive',
      file: file.path,
      content: original,
      originalOffset: 0,
      originalText: originalPrefix,
      replacementText: replacementPrefix,
      rationale: 'HTML5 DOCTYPE was absent; prepended <!DOCTYPE html> so browsers render in standards mode.'
    });

    const newContent = applyMods(original, [
      { offset: 0, originalText: originalPrefix, replacementText: replacementPrefix }
    ]);

    log.push('Prepended HTML5 DOCTYPE');

    return { changed: true, newContent, patches: [patch], log };
  },

  async revert(file, patch) {
    return revertPatch(file, patch);
  },

  async fix(file, violations) {
    const result = await this.apply(file, violations);
    return { changed: result.changed, newContent: result.newContent, log: result.log };
  }
};
