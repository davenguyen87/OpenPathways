'use strict';

/**
 * Build rebuild-assisted-judgment.zip — the v4.1 fixture that exercises
 * generate-alt-text (1.1.1), rewrite-link-text (2.4.4), and
 * generate-form-label (3.3.2).
 *
 * Usage: node scripts/build-fixtures-v41.js
 */

const fs = require('fs');
const path = require('path');
const yazl = require('yazl');

const FIXTURES_DIR = path.resolve(__dirname, '../test/fixtures');

// ─── Shared SCORM 1.2 manifest (copied from build-fixtures.js) ────────────

function scormManifest(resources) {
  const resourceElems = resources
    .map((r) => `    <resource identifier="${r.id}" type="webcontent" href="${r.href}" adlcp:scormtype="sco">\n      <file href="${r.href}"/>\n    </resource>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="com.prism.fixture" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="org1">
    <organization identifier="org1">
      <title>Prism Test Fixture — Assisted Tier Judgment</title>
      <item identifier="item1" identifierref="res1">
        <title>Module 1</title>
      </item>
    </organization>
  </organizations>
  <resources>
${resourceElems}
  </resources>
</manifest>
`;
}

// ─── Deterministic zip builder ─────────────────────────────────────────────

function buildZip(destPath, entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const ws = fs.createWriteStream(destPath);
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    ws.on('finish', () => { if (!settled) { settled = true; resolve(); } });
    ws.on('error', fail);
    zip.outputStream.on('error', fail);
    zip.outputStream.pipe(ws);

    for (const entry of entries) {
      const buf = Buffer.isBuffer(entry.content)
        ? entry.content
        : Buffer.from(entry.content, 'utf8');
      zip.addBuffer(buf, entry.name, { mtime: new Date(0) });
    }
    zip.end();
  });
}

// ─── index.html — single page with all three violation types ──────────────
//
// Violations:
//   1.1.1 — <img src="revenue-2025.png"> with no alt (content image, rich context)
//            a decorative <img src="spacer.gif" role="presentation"> is also present
//            so the safe-tier fixer claims the decorative one, NOT the content image.
//   2.4.4 — <a href="report-q4.pdf">click here</a> with preceding paragraph context
//   3.3.2 — <input type="email" name="contact_email"> with no label at all,
//            inside a <fieldset><legend>Contact us</legend></fieldset>

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Annual Performance Review — Module 1</title>
</head>
<body>
  <h1>Annual Performance Review</h1>

  <!-- ── 1.1.1 CONTENT IMAGE: no alt, non-generic filename, rich surrounding text ── -->
  <section>
    <h2>Financial Overview</h2>
    <p>This chart shows quarterly revenue growth across 2025. Each bar represents
    one quarter; the trendline shows year-over-year improvement of 14 percent.</p>
    <img src="revenue-2025.png">
    <p>Revenue increased most sharply in Q3 due to the product launch in July.</p>
  </section>

  <!-- ── DECORATIVE IMAGE: safe-tier fixer claims this, NOT the assisted fixer ── -->
  <section>
    <h2>Section Divider</h2>
    <img src="spacer.gif" role="presentation">
    <p>The next section covers operational metrics.</p>
  </section>

  <!-- ── 2.4.4 VAGUE LINK: "click here" with clear preceding paragraph context ── -->
  <section>
    <h2>Financial Reports</h2>
    <p>Download the Q4 financial report to review year-end earnings, operating
    expenses, and projections for the upcoming fiscal year.</p>
    <a href="report-q4.pdf">click here</a>
  </section>

  <!-- ── 3.3.2 FORM CONTROL with NO label at all ── -->
  <section>
    <h2>Contact</h2>
    <form action="#" method="post">
      <fieldset>
        <legend>Contact us</legend>
        <input type="email" name="contact_email">
        <button type="submit">Send</button>
      </fieldset>
    </form>
  </section>
</body>
</html>
`;

// ─── Build the fixture ─────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  await buildZip(path.join(FIXTURES_DIR, 'rebuild-assisted-judgment.zip'), [
    {
      name: 'imsmanifest.xml',
      content: scormManifest([{ id: 'res1', href: 'index.html' }])
    },
    { name: 'index.html', content: INDEX_HTML },
    // Stub image binaries — the HTML check works on source, not image data.
    { name: 'revenue-2025.png', content: Buffer.alloc(4, 0) },
    { name: 'spacer.gif', content: Buffer.alloc(4, 0) },
    { name: 'report-q4.pdf', content: Buffer.alloc(4, 0) }
  ]);

  console.log('wrote test/fixtures/rebuild-assisted-judgment.zip');
}

main().catch((err) => {
  console.error('build-fixtures-v41 failed:', err);
  process.exitCode = 1;
});
