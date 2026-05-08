/**
 * Tests for src/rebuild/packager.js — round-trip integrity, entry order,
 * and SHA-256 correctness against an independently-computed digest.
 *
 * Round-trip is the load-bearing invariant: SCORM packages contain binary
 * blobs (images, fonts, audio) that must survive unpack -> pack with byte
 * identity. We verify by re-extracting the produced zip into a second
 * temp dir and comparing every regular file pairwise.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const { unpack, pack, sha256, ENTRY_ORDER_FILENAME } = require('../../src/rebuild/packager.js');
const yauzl = require('yauzl');

const FIXTURE = path.resolve(__dirname, '../fixtures/scorm12-clean.zip');

/** Recursively collect relative file paths under `root`, skipping the sidecar. */
function listFiles(root) {
  const out = [];
  function walk(dir, rel) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, r);
      } else if (entry.isFile() && entry.name !== ENTRY_ORDER_FILENAME) {
        out.push(r);
      }
    }
  }
  walk(root, '');
  out.sort();
  return out;
}

/** List entry order from a zip file using yauzl directly. */
function readEntryOrder(zipPath) {
  return new Promise((resolve, reject) => {
    const order = [];
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        order.push(entry.fileName);
        zipfile.readEntry();
      });
      zipfile.on('end', () => resolve(order));
      zipfile.on('error', reject);
    });
  });
}

const tmpDirs = [];
function makeTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tmpDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch (_) {
      // best-effort
    }
  }
});

describe('packager.unpack + pack — round-trip', () => {
  it('produces byte-identical files for every entry', async () => {
    const dir1 = makeTmp('rb-rt-a');
    const dir2 = makeTmp('rb-rt-b');
    const zipOut = path.join(makeTmp('rb-rt-zip'), 'roundtrip.zip');

    const { entryOrder } = await unpack(FIXTURE, dir1);
    expect(entryOrder.length).toBeGreaterThan(0);

    await pack(dir1, zipOut, {});
    expect(fs.existsSync(zipOut)).toBe(true);

    await unpack(zipOut, dir2);

    const files1 = listFiles(dir1);
    const files2 = listFiles(dir2);
    expect(files2).toEqual(files1);

    for (const rel of files1) {
      const a = fs.readFileSync(path.join(dir1, rel));
      const b = fs.readFileSync(path.join(dir2, rel));
      expect(a.equals(b), `bytes differ for ${rel}`).toBe(true);
    }
  });

  it('preserves entry order across the round-trip', async () => {
    const dir1 = makeTmp('rb-order-a');
    const zipOut = path.join(makeTmp('rb-order-zip'), 'order.zip');

    const { entryOrder } = await unpack(FIXTURE, dir1);
    await pack(dir1, zipOut, {});

    const order2 = await readEntryOrder(zipOut);
    expect(order2).toEqual(entryOrder);
  });

  it('does not include the .prism-entry-order.json sidecar in the output zip', async () => {
    const dir1 = makeTmp('rb-side-a');
    const zipOut = path.join(makeTmp('rb-side-zip'), 'no-sidecar.zip');

    await unpack(FIXTURE, dir1);
    await pack(dir1, zipOut, {});
    const order = await readEntryOrder(zipOut);
    expect(order).not.toContain(ENTRY_ORDER_FILENAME);
  });
});

describe('packager.sha256', () => {
  it('matches an independently-computed crypto.createHash digest', async () => {
    const expected = crypto
      .createHash('sha256')
      .update(fs.readFileSync(FIXTURE))
      .digest('hex');
    const actual = await sha256(FIXTURE);
    expect(actual).toBe(expected);
    // sanity: hex string of the right length
    expect(actual).toMatch(/^[0-9a-f]{64}$/);
  });
});
