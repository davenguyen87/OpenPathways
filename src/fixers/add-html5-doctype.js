/**
 * Add HTML5 DOCTYPE declaration
 * Ensures HTML files start with proper <!DOCTYPE html> for standards mode
 */

module.exports = {
  id: 'add-html5-doctype',
  name: 'Add HTML5 DOCTYPE declaration',
  supported: ['scorm12', 'scorm2004', 'aicc', 'xapi', 'cmi5'],
  confidence: 'definitive',
  criterion: '',

  /**
   * Check if this fixer can repair missing DOCTYPE
   * When violation is provided, return false (no specific violation maps to this).
   * When violation is null (scan mode), check if file lacks DOCTYPE.
   * @param {object} file - { path, content, isHtml }
   * @param {object} violation - violation object or null
   * @returns {boolean} true if we can fix this
   */
  canFix(file, violation) {
    if (!file.isHtml) return false;

    // Don't act on specific violations; only scan mode
    if (violation !== null) return false;

    // Check if content starts with DOCTYPE (case-insensitive, after BOM/whitespace)
    const trimmed = file.content.replace(/^﻿/, '').trimStart();
    const hasDoctype = /^<!doctype\s+html/i.test(trimmed);

    return !hasDoctype;
  },

  /**
   * Repair by prepending HTML5 DOCTYPE
   * @param {object} file - { path, content, isHtml }
   * @param {array} violations - violations this fixer can fix (empty in scan mode)
   * @returns {object} { changed: bool, newContent: string, log: [] }
   */
  async fix(file, violations) {
    let newContent = file.content;
    const log = [];

    // Remove any BOM
    newContent = newContent.replace(/^﻿/, '');

    // Check if DOCTYPE already exists (case-insensitive)
    const trimmed = newContent.trimStart();
    if (/^<!doctype\s+html/i.test(trimmed)) {
      log.push('File already has HTML5 DOCTYPE');
      return { changed: false, newContent, log };
    }

    // Prepend DOCTYPE, preserving any leading whitespace
    const leadingWhitespace = newContent.match(/^\s*/)[0];
    const contentAfterWhitespace = newContent.slice(leadingWhitespace.length);
    newContent = `${leadingWhitespace}<!DOCTYPE html>\n${contentAfterWhitespace}`;

    log.push('Prepended HTML5 DOCTYPE');
    return { changed: true, newContent, log };
  }
};
