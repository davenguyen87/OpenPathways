import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import { audit } from '../src/index';
import { writeReports } from '../src/reporter';

const TEST_FIXTURES_DIR = path.join(__dirname, 'fixtures');
const ENGAGEMENTS_DIR = path.join(process.cwd(), 'engagements');

describe('Engagement isolation contract', () => {
  afterEach(async () => {
    // Clean up test engagements
    try {
      await fs.rm(ENGAGEMENTS_DIR, { recursive: true, force: true });
    } catch (err) {
      // Silent fail on cleanup
    }
  });

  it('should isolate output for two different engagement IDs on same fixture', async () => {
    // Setup
    const packagePath = path.join(TEST_FIXTURES_DIR, 'scorm12-clean.zip');
    const engagement1 = 'SL-2026-A';
    const engagement2 = 'SL-2026-B';
    const packageName = 'scorm12-clean';

    // Audit 1
    const result1 = await audit(packagePath, {
      packageType: 'auto',
      standard: 'wcag21',
      browser: 'chromium',
      timeoutDynamic: 30000,
    });

    const reportOpts1 = {
      json: false,
      format: 'md',
      output: path.join(ENGAGEMENTS_DIR, engagement1, packageName),
      standard: 'wcag21',
      packageType: result1.packageType,
      packagePath,
      engagementId: engagement1,
      engagementRedact: false,
      brandConfigPath: null,
    };

    const report1 = await writeReports({
      scorecard: result1.scorecard,
      violations: result1.violations,
      manualReview: result1.manualReview,
      scos: result1.scos,
      dynamicReport: result1.dynamicReport,
      fixesApplied: result1.fixesApplied,
      options: reportOpts1,
    });

    // Audit 2
    const result2 = await audit(packagePath, {
      packageType: 'auto',
      standard: 'wcag21',
      browser: 'chromium',
      timeoutDynamic: 30000,
    });

    const reportOpts2 = {
      json: false,
      format: 'md',
      output: path.join(ENGAGEMENTS_DIR, engagement2, packageName),
      standard: 'wcag21',
      packageType: result2.packageType,
      packagePath,
      engagementId: engagement2,
      engagementRedact: false,
      brandConfigPath: null,
    };

    const report2 = await writeReports({
      scorecard: result2.scorecard,
      violations: result2.violations,
      manualReview: result2.manualReview,
      scos: result2.scos,
      dynamicReport: result2.dynamicReport,
      fixesApplied: result2.fixesApplied,
      options: reportOpts2,
    });

    // Assert output directories exist and are separate
    const dir1 = path.dirname(report1.htmlPath);
    const dir2 = path.dirname(report2.htmlPath);

    expect(dir1).toBeDefined();
    expect(dir2).toBeDefined();
    expect(dir1).not.toEqual(dir2);
    expect(dir1).toContain(engagement1);
    expect(dir2).toContain(engagement2);

    // Assert files exist
    await expect(fs.access(report1.htmlPath)).resolves.toBeUndefined();
    await expect(fs.access(report1.mdPath)).resolves.toBeUndefined();
    await expect(fs.access(report1.jsonPath)).resolves.toBeUndefined();

    await expect(fs.access(report2.htmlPath)).resolves.toBeUndefined();
    await expect(fs.access(report2.mdPath)).resolves.toBeUndefined();
    await expect(fs.access(report2.jsonPath)).resolves.toBeUndefined();

    // Assert no cross-references: read both JSON files and verify no engagement ID leak
    const json1Str = await fs.readFile(report1.jsonPath, 'utf8');
    const json2Str = await fs.readFile(report2.jsonPath, 'utf8');

    // The engagement ID should appear in its own output but not in the other's
    // (This is a basic smoke test; in production you'd parse JSON and check metadata)
    expect(json1Str).toContain(engagement1);
    expect(json1Str).not.toContain(engagement2);

    expect(json2Str).toContain(engagement2);
    expect(json2Str).not.toContain(engagement1);
  });

  it('should prevent directory traversal attacks via engagement ID', async () => {
    const packagePath = path.join(TEST_FIXTURES_DIR, 'scorm12-clean.zip');
    const maliciousId = '../../../etc/passwd';
    const packageName = 'scorm12-clean';

    const result = await audit(packagePath, {
      packageType: 'auto',
      standard: 'wcag21',
      browser: 'chromium',
      timeoutDynamic: 30000,
    });

    const reportOpts = {
      json: false,
      format: 'md',
      output: path.join(ENGAGEMENTS_DIR, maliciousId, packageName),
      standard: 'wcag21',
      packageType: result.packageType,
      packagePath,
      engagementId: maliciousId,
      engagementRedact: false,
      brandConfigPath: null,
    };

    const report = await writeReports({
      scorecard: result.scorecard,
      violations: result.violations,
      manualReview: result.manualReview,
      scos: result.scos,
      dynamicReport: result.dynamicReport,
      fixesApplied: result.fixesApplied,
      options: reportOpts,
    });

    // Assert the output path is within ./engagements/
    expect(report.htmlPath).toContain('engagements');
    expect(report.htmlPath).not.toContain('/etc/');
  });
});
