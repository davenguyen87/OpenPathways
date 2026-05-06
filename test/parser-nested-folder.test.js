import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { audit } from '../src/index.js';

// Get __dirname equivalent
const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('SCORM nested-folder parser', { timeout: 30000 }, () => {
  let result;

  beforeAll(async () => {
    const packagePath = path.join(__dirname, 'fixtures', 'scorm12-clean-nested.zip');
    result = await audit(packagePath);
  });

  it('should detect SCORM 1.2 package type', () => {
    expect(result.packageType).toBe('scorm12');
  });

  it('should mark audit as complete (dynamic checks ran)', () => {
    expect(result.complete).toBe(true);
  });

  it('should have run dynamic checks successfully', () => {
    expect(result.dynamicReport).toBeDefined();
    expect(result.dynamicReport.skipped).toBe(false);
  });

  it('should not report entry-point load failure', () => {
    // Verify that entryPoints are prefixed with the nested folder
    expect(result.entryPoints.length).toBeGreaterThan(0);

    // Entry points should contain the nested folder path
    const allPrefixed = result.entryPoints.every((ep) =>
      ep.includes('nested-folder/') || ep.startsWith('/')
    );
    expect(allPrefixed).toBe(true);
  });

  it('should extract SCO metadata with correct prefixed paths', () => {
    expect(result.scos.length).toBeGreaterThan(0);

    // All SCO entryFile paths should be prefixed with the nested folder
    const allPrefixed = result.scos.every((sco) =>
      sco.entryFile.includes('nested-folder/') || sco.entryFile.startsWith('/')
    );
    expect(allPrefixed).toBe(true);
  });
});
