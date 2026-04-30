#!/usr/bin/env node

/**
 * Smoke test for the reporter module.
 * Creates synthetic scorecard fixtures and verifies output shapes.
 */

const { writeReports } = require('./index');
const { buildScorecard, serializeScorecard } = require('./json');
const { renderMarkdown } = require('./markdown');
const { renderText } = require('./text');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

async function smokeTest() {
  // Create synthetic fixtures
  const mockChecks = [
    {
      id: '1.1.1',
      name: 'Non-text content',
      level: 'A',
      wcagIntroduced: '2.0',
      url: 'https://www.w3.org/WAI/WCAG22/Understanding/non-text-content',
    },
    {
      id: '1.2.1',
      name: 'Audio/Video-only (prerecorded)',
      level: 'A',
      wcagIntroduced: '2.0',
      url: 'https://www.w3.org/WAI/WCAG22/Understanding/audio-video-only-prerecorded',
    },
  ];

  const mockViolations = [
    {
      criterion: '1.1.1',
      file: 'sco1/index.html',
      line: 42,
      column: 12,
      snippet: '<img src="image.png">',
      message: 'Image is missing alt text.',
      severity: 'critical',
    },
  ];

  const mockManualReview = [
    {
      id: '1.2.3',
      name: 'Audio description or media alternative (prerecorded)',
      level: 'A',
      wcagIntroduced: '2.0',
      url: 'https://www.w3.org/WAI/WCAG22/Understanding/audio-description-or-media-alternative-prerecorded',
      guidance: 'Verify that all prerecorded synchronized video content has either an audio description track or a text transcript describing the visual content.',
    },
    {
      id: '1.2.5',
      name: 'Audio description (prerecorded)',
      level: 'AA',
      wcagIntroduced: '2.0',
      url: 'https://www.w3.org/WAI/WCAG22/Understanding/audio-description-prerecorded',
      guidance: 'Verify that all prerecorded video content has an audio description track.',
    },
  ];

  const mockIframeWarnings = [
    {
      file: 'sco1/index.html',
      line: 88,
      iframeUrl: 'https://example.com/embed',
    },
  ];

  // Test 1: buildScorecard and serializeScorecard with json: true
  console.log('Test 1: JSON-only output...');
  try {
    const result = await writeReports({
      violations: mockViolations,
      manualReview: mockManualReview,
      options: {
        json: true,
        format: 'md',
        output: '/tmp',
        standard: 'wcag22',
        packageType: 'scorm12',
        packagePath: '/tmp/test.zip',
        iframeWarnings: mockIframeWarnings,
      },
    });

    if (!result.jsonString) {
      throw new Error('Missing jsonString in JSON-only result');
    }

    // Parse and verify JSON shape
    const parsed = JSON.parse(result.jsonString);

    // Check required fields
    const required = [
      'tool',
      'version',
      'wcagVersion',
      'packageType',
      'packagePath',
      'scannedAt',
      'passed',
      'score',
      'summary',
      'criteria',
      'violations',
      'manualReviewRequired',
      'iframeWarnings',
    ];

    for (const field of required) {
      if (!(field in parsed)) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    if (parsed.tool !== 'open-pathways') {
      throw new Error(`Expected tool name 'open-pathways', got '${parsed.tool}'`);
    }

    if (parsed.wcagVersion !== '2.2') {
      throw new Error(`Expected wcagVersion '2.2', got '${parsed.wcagVersion}'`);
    }

    if (parsed.violations.length !== 1) {
      throw new Error(`Expected 1 violation, got ${parsed.violations.length}`);
    }

    if (!parsed.violations[0].criterionName) {
      throw new Error('Violation missing criterionName field');
    }

    if (parsed.iframeWarnings.length !== 1) {
      throw new Error(`Expected 1 iframe warning, got ${parsed.iframeWarnings.length}`);
    }

    console.log('  ✓ JSON shape verified');
  } catch (err) {
    console.error(`  ✗ Test 1 failed: ${err.message}`);
    process.exit(1);
  }

  // Test 2: File write output
  console.log('Test 2: File output (markdown)...');
  try {
    const tempDir = path.join(os.tmpdir(), `smoke-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    const result = await writeReports({
      violations: mockViolations,
      manualReview: mockManualReview,
      options: {
        json: false,
        format: 'md',
        output: tempDir,
        standard: 'wcag22',
        packageType: 'scorm12',
        packagePath: '/tmp/test.zip',
        iframeWarnings: mockIframeWarnings,
      },
    });

    if (!result.jsonPath || !result.mdPath) {
      throw new Error('Missing jsonPath or mdPath in file output result');
    }

    // Verify files exist and are readable
    const jsonContent = await fs.readFile(result.jsonPath, 'utf8');
    const mdContent = await fs.readFile(result.mdPath, 'utf8');

    if (!jsonContent || !mdContent) {
      throw new Error('File contents are empty');
    }

    // Verify JSON is parseable
    const parsed = JSON.parse(jsonContent);
    if (!parsed.violations) {
      throw new Error('JSON file missing violations');
    }

    // Verify markdown contains key sections
    if (!mdContent.includes('WCAG 2.2')) {
      throw new Error('Markdown missing expected header');
    }
    if (!mdContent.includes('Manual Review Required')) {
      throw new Error('Markdown missing Manual Review section');
    }

    // Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });

    console.log('  ✓ Markdown files written and verified');
  } catch (err) {
    console.error(`  ✗ Test 2 failed: ${err.message}`);
    process.exit(1);
  }

  // Test 3: Text format output
  console.log('Test 3: File output (text)...');
  try {
    const tempDir = path.join(os.tmpdir(), `smoke-test-txt-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    const result = await writeReports({
      violations: mockViolations,
      manualReview: mockManualReview,
      options: {
        json: false,
        format: 'txt',
        output: tempDir,
        standard: 'wcag22',
        packageType: 'scorm12',
        packagePath: '/tmp/test.zip',
      },
    });

    if (!result.jsonPath || !result.txtPath) {
      throw new Error('Missing jsonPath or txtPath in text output result');
    }

    const txtContent = await fs.readFile(result.txtPath, 'utf8');
    if (!txtContent || !txtContent.includes('WCAG 2.2')) {
      throw new Error('Text file missing expected content');
    }

    // Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });

    console.log('  ✓ Text files written and verified');
  } catch (err) {
    console.error(`  ✗ Test 3 failed: ${err.message}`);
    process.exit(1);
  }

  console.log('\nOK');
  process.exit(0);
}

// Run if invoked directly
if (require.main === module) {
  smokeTest().catch((err) => {
    console.error(`Smoke test error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { smokeTest };
