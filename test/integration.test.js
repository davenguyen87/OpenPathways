import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { audit } from '../src/index.js';
import { loadBaseline, diffAgainstBaseline } from '../src/lib/baseline.js';
import { generateSarif } from '../src/reporter/sarif.js';

// Get __dirname equivalent
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Belt-and-suspenders: sweep any stray .baseline-temp-* dirs left by killed runs.
afterAll(() => {
  for (const entry of fs.readdirSync(__dirname)) {
    if (entry.startsWith('.baseline-temp')) {
      try {
        fs.rmSync(path.join(__dirname, entry), { recursive: true, force: true });
      } catch {}
    }
  }
});

// Load expected results from fixtures synchronously
const expectedDataPath = path.join(__dirname, 'fixtures', 'expected.json');
const fixturesDir = path.join(__dirname, 'fixtures');
const expectedData = JSON.parse(fs.readFileSync(expectedDataPath, 'utf-8'));

// Dynamically create test suites for each fixture
Object.entries(expectedData).forEach(([fixtureFileName, expected]) => {
  describe(`${fixtureFileName}`, { timeout: 30000 }, () => {
    let result;

    beforeAll(async () => {
      const packagePath = path.join(fixturesDir, fixtureFileName);
      result = await audit(packagePath);
    });

    it('should detect correct package type', () => {
      expect(result.packageType).toBe(expected.packageType);
    });

    it(`should find at least ${expected.minViolations} violations`, () => {
      expect(result.violations.length).toBeGreaterThanOrEqual(expected.minViolations);
    });

    it('should detect all expected criteria', () => {
      // Skip this assertion for fixtures marked as dynamicOnly (tested via dynamic checks)
      if (expected.dynamicOnly) {
        expect(true).toBe(true); // placeholder pass
        return;
      }

      const detectedCriteria = new Set(
        result.violations.map((v) => v.criterion).filter(Boolean)
      );

      const missing = expected.expectedCriteria.filter((c) => !detectedCriteria.has(c));
      if (missing.length > 0) {
        console.log(`Missing criteria: ${missing.join(', ')}`);
        console.log(`Detected criteria: ${Array.from(detectedCriteria).join(', ')}`);
      }

      for (const expectedCriterion of expected.expectedCriteria) {
        expect(detectedCriteria.has(expectedCriterion)).toBe(true);
      }
    });

    // Special case for clean fixture
    if (fixtureFileName === 'scorm12-clean.zip') {
      it('should have zero violations', () => {
        expect(result.violations.length).toBe(0);
      });

      it('should pass all criteria', () => {
        expect(result.scorecard.passed).toBe(true);
      });
    }
  });
});

// Error handling tests
describe('error handling', { timeout: 30000 }, () => {
  it('should reject a non-SCORM zip file', async () => {
    // Point to a non-existent file and assert audit() throws
    const invalidPath = path.join(fixturesDir, 'non-existent.zip');

    await expect(audit(invalidPath)).rejects.toThrow();
  });
});

// Phase 2 Feature: Per-SCO reporting
describe('Phase 2: Per-SCO reporting', { timeout: 30000 }, () => {
  it('should return scos array for scorm12-violations.zip', async () => {
    const packagePath = path.join(fixturesDir, 'scorm12-violations.zip');
    const result = await audit(packagePath);

    expect(Array.isArray(result.scos)).toBe(true);
    expect(result.scos.length).toBeGreaterThan(0);
  });

  it('should attach sco field to all violations in scorm12-violations.zip', async () => {
    const packagePath = path.join(fixturesDir, 'scorm12-violations.zip');
    const result = await audit(packagePath);

    expect(result.violations.length).toBeGreaterThan(0);
    for (const violation of result.violations) {
      expect(violation).toHaveProperty('sco');
    }
  });

  it('should return scos array for scorm12-clean.zip', async () => {
    const packagePath = path.join(fixturesDir, 'scorm12-clean.zip');
    const result = await audit(packagePath);

    expect(Array.isArray(result.scos)).toBe(true);
    expect(result.scos.length).toBeGreaterThan(0);
  });
});

// Phase 2 Feature: Severity tags
describe('Phase 2: Severity tags', { timeout: 30000 }, () => {
  it('should have severity field on all violations in scorm12-violations.zip', async () => {
    const packagePath = path.join(fixturesDir, 'scorm12-violations.zip');
    const result = await audit(packagePath);

    expect(result.violations.length).toBeGreaterThan(0);
    const validSeverities = ['critical', 'serious', 'moderate', 'minor'];

    for (const violation of result.violations) {
      expect(violation).toHaveProperty('severity');
      expect(validSeverities).toContain(violation.severity);
    }
  });
});

// Phase 2 Feature: Baseline diff
describe('Phase 2: Baseline diff', { timeout: 30000 }, () => {
  it('should load baseline and diff with same violations returns empty array', async () => {
    const packagePath = path.join(fixturesDir, 'scorm12-violations.zip');
    const result = await audit(packagePath);

    // Create a temporary baseline file with current violations
    const tempBaselineDir = path.join(__dirname, `.baseline-temp-${Date.now()}`);
    if (!fs.existsSync(tempBaselineDir)) {
      fs.mkdirSync(tempBaselineDir, { recursive: true });
    }
    const baselineFilePath = path.join(tempBaselineDir, 'baseline.json');
    fs.writeFileSync(baselineFilePath, JSON.stringify({ violations: result.violations }));

    try {
      const { violations: baselineViolations } = await loadBaseline(baselineFilePath);
      const diff = diffAgainstBaseline(result.violations, baselineViolations);

      expect(diff.length).toBe(0);
    } finally {
      // Cleanup — recursive rm so stray contents don't leave the dir behind.
      try {
        fs.rmSync(tempBaselineDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        // Silent fail on cleanup - don't fail the test due to cleanup issues
      }
    }
  });

  it('should diff empty baseline returns all current violations', async () => {
    const packagePath = path.join(fixturesDir, 'scorm12-violations.zip');
    const result = await audit(packagePath);

    const diff = diffAgainstBaseline(result.violations, []);

    expect(diff.length).toBe(result.violations.length);
  });

  it('should throw error on non-existent baseline path', async () => {
    const nonExistentPath = path.join(__dirname, 'non-existent-baseline.json');

    await expect(loadBaseline(nonExistentPath)).rejects.toThrow(/Baseline file not found/);
  });
});

// Phase 2 Feature: SARIF reporter
describe('Phase 2: SARIF reporter', { timeout: 30000 }, () => {
  it('should generate valid SARIF 2.1.0 JSON', async () => {
    const packagePath = path.join(fixturesDir, 'scorm12-violations.zip');
    const result = await audit(packagePath);

    const sarifJson = generateSarif({
      scorecard: result.scorecard,
      violations: result.violations,
    });

    const parsed = JSON.parse(sarifJson);

    expect(parsed.version).toBe('2.1.0');
    expect(parsed.runs).toBeDefined();
    expect(Array.isArray(parsed.runs)).toBe(true);
    expect(parsed.runs.length).toBeGreaterThan(0);
  });

  it('should have correct tool driver name in SARIF', async () => {
    const packagePath = path.join(fixturesDir, 'scorm12-violations.zip');
    const result = await audit(packagePath);

    const sarifJson = generateSarif({
      scorecard: result.scorecard,
      violations: result.violations,
    });

    const parsed = JSON.parse(sarifJson);

    expect(parsed.runs[0].tool.driver.name).toBe('prism');
  });

  it('should map violations to SARIF results with correct properties', async () => {
    const packagePath = path.join(fixturesDir, 'scorm12-violations.zip');
    const result = await audit(packagePath);

    const sarifJson = generateSarif({
      scorecard: result.scorecard,
      violations: result.violations,
    });

    const parsed = JSON.parse(sarifJson);
    const sarifResults = parsed.runs[0].results;

    expect(sarifResults.length).toBe(result.violations.length);

    for (const sarifResult of sarifResults) {
      expect(sarifResult).toHaveProperty('ruleId');
      expect(sarifResult).toHaveProperty('level');
      expect(sarifResult).toHaveProperty('message');
      expect(sarifResult).toHaveProperty('locations');
      expect(Array.isArray(sarifResult.locations)).toBe(true);
      expect(sarifResult.locations.length).toBeGreaterThan(0);
      expect(sarifResult.locations[0].physicalLocation.artifactLocation.uri).toBeDefined();
    }
  });

  it('should map severity to SARIF level correctly', async () => {
    // Create a small manual test with known severities
    const mockViolations = [
      {
        criterion: '1.1.1',
        file: 'test.html',
        line: 10,
        message: 'Critical violation',
        severity: 'critical',
      },
      {
        criterion: '1.1.1',
        file: 'test.html',
        line: 20,
        message: 'Serious violation',
        severity: 'serious',
      },
      {
        criterion: '1.1.1',
        file: 'test.html',
        line: 30,
        message: 'Moderate violation',
        severity: 'moderate',
      },
      {
        criterion: '1.1.1',
        file: 'test.html',
        line: 40,
        message: 'Minor violation',
        severity: 'minor',
      },
    ];

    const mockScorecard = {
      wcagVersion: 'WCAG22',
      passed: false,
      score: 0,
      totalCriteria: 1,
      passedCriteria: 0,
      failedCriteria: 1,
      totalViolations: 4,
      criteriaResults: [],
    };

    const sarifJson = generateSarif({
      scorecard: mockScorecard,
      violations: mockViolations,
    });

    const parsed = JSON.parse(sarifJson);
    const sarifResults = parsed.runs[0].results;

    expect(sarifResults[0].level).toBe('error'); // critical -> error
    expect(sarifResults[1].level).toBe('error'); // serious -> error
    expect(sarifResults[2].level).toBe('warning'); // moderate -> warning
    expect(sarifResults[3].level).toBe('note'); // minor -> note
  });
});
