/**
 * Library-level rebuild rollup renderer.
 *
 * `rebuildLibrary` (in `src/rebuild/index.js`) calls these to summarize
 * per-package results into one HTML and one Markdown rollup at the
 * engagement root. The CLI's `rebuild-library` action is a thin wrapper
 * around `rebuildLibrary` and renders the same rollup.
 *
 * @typedef {Object} RollupRow
 * @property {string} packageName
 * @property {number} exitCode               - 0/1/2 per per-package status
 * @property {{ resolved: number, remaining: number, introduced: number }|null} verification
 */

/**
 * Build a Markdown rollup summary.
 *
 * @param {string} engagementId
 * @param {RollupRow[]} results
 * @returns {string}
 */
function buildRollupMarkdown(engagementId, results) {
  const lines = [
    `# Rebuild rollup — ${engagementId}`,
    '',
    `**Packages rebuilt:** ${results.length}`,
    '',
    '| Package | Resolved | Remaining | Introduced | Status |',
    '|---------|----------|-----------|------------|--------|'
  ];

  let totalResolved = 0;
  let totalRemaining = 0;
  let totalIntroduced = 0;

  for (const r of results) {
    const v = r.verification;
    const resolved = v ? v.resolved : '—';
    const remaining = v ? v.remaining : '—';
    const introduced = v ? v.introduced : '—';
    const status = r.exitCode === 2 ? 'Error' : v && v.remaining === 0 ? 'Clean' : 'Remaining';

    if (v) {
      totalResolved += v.resolved || 0;
      totalRemaining += v.remaining || 0;
      totalIntroduced += v.introduced || 0;
    }

    lines.push(`| ${r.packageName} | ${resolved} | ${remaining} | ${introduced} | ${status} |`);
  }

  lines.push(
    '',
    `**Totals:** Resolved: ${totalResolved} | Remaining: ${totalRemaining} | Introduced: ${totalIntroduced}`,
    ''
  );
  return lines.join('\n');
}

/**
 * Build a self-contained HTML rollup. Minimal styling that mirrors the
 * brand palette without pulling in the full report stylesheet — the rollup
 * is a quick-glance view, not a per-fix audit.
 *
 * @param {string} engagementId
 * @param {RollupRow[]} results
 * @returns {string}
 */
function buildRollupHtml(engagementId, results) {
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const rows = results
    .map((r) => {
      const v = r.verification;
      const resolved = v ? v.resolved : '—';
      const remaining = v ? v.remaining : '—';
      const introduced = v != null ? v.introduced : '—';
      const status = r.exitCode === 2 ? 'Error' : v && v.remaining === 0 ? 'Clean' : 'Remaining';
      const statusClass =
        r.exitCode === 2 ? 'st-error' : v && v.remaining === 0 ? 'st-clean' : 'st-remaining';
      const introClass = v && v.introduced > 0 ? 'st-error' : '';
      return [
        '<tr>',
        `<td>${esc(r.packageName)}</td>`,
        `<td>${esc(String(resolved))}</td>`,
        `<td>${esc(String(remaining))}</td>`,
        `<td class="${introClass}">${esc(String(introduced))}</td>`,
        `<td class="${statusClass}">${esc(status)}</td>`,
        '</tr>'
      ].join('');
    })
    .join('');

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${esc(engagementId)} — Rebuild rollup</title>`,
    '<style>',
    'body{font-family:system-ui,sans-serif;background:#f3efe6;color:#111633;margin:0;padding:32px 40px}',
    'h1{font-size:24px;margin-bottom:16px}',
    'table{width:100%;border-collapse:collapse;border:2px solid #111633;font-size:14px}',
    'th{background:#111633;color:#f3efe6;padding:8px 12px;text-align:left;font-size:11px;letter-spacing:.1em;text-transform:uppercase}',
    'td{padding:8px 12px;border-top:1px solid #c8bfa8}',
    '.st-clean{color:#1b7a3d;font-weight:700}',
    '.st-error{color:#c46a14;font-weight:700}',
    '.st-remaining{color:#2a3158}',
    '</style>',
    '</head>',
    '<body>',
    `<h1>Rebuild rollup — ${esc(engagementId)}</h1>`,
    `<p>Packages rebuilt: <strong>${results.length}</strong></p>`,
    '<table>',
    '<thead><tr>',
    '<th>Package</th><th>Resolved</th><th>Remaining</th><th>Introduced</th><th>Status</th>',
    '</tr></thead>',
    '<tbody>',
    rows,
    '</tbody>',
    '</table>',
    '</body>',
    '</html>',
    ''
  ].join('\n');
}

module.exports = { buildRollupMarkdown, buildRollupHtml };
