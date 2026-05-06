#!/usr/bin/env node

/**
 * Network traffic CI check for Prism v3.0
 *
 * This script runs a representative audit (scorm12-clean.zip) with network
 * traffic monitoring enabled. It ensures that the tool produces no unexpected
 * outbound connections during a normal audit run.
 *
 * Usage:
 *   node scripts/check-no-network.js
 *
 * Exit codes:
 *   0 — audit completed with no unexpected network traffic
 *   1 — unexpected network traffic detected (lists offending hosts)
 *   2 — audit failed or script error
 *
 * The network trap module (network-trap.js) is loaded via NODE_OPTIONS.
 * All outbound traffic is logged; allowlisted hosts (playwright.azureedge.net)
 * are permitted for the Playwright install on first run.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

async function main() {
  // Create a temp file to collect the network tally
  const trapFile = path.join(os.tmpdir(), `network-trap-${Date.now()}.json`);

  // Compute paths relative to the script location
  const scriptDir = path.dirname(__filename);
  const projectRoot = path.resolve(scriptDir, '..');
  const fixturePath = path.join(projectRoot, 'test', 'fixtures', 'scorm12-clean.zip');
  const networkTrapPath = path.join(scriptDir, 'network-trap.js');

  // Verify the fixture exists
  if (!fs.existsSync(fixturePath)) {
    console.error(`Error: Test fixture not found: ${fixturePath}`);
    process.exit(2);
  }

  // Verify the network trap module exists
  if (!fs.existsSync(networkTrapPath)) {
    console.error(`Error: Network trap module not found: ${networkTrapPath}`);
    process.exit(2);
  }

  console.log('Starting network traffic audit...');
  console.log(`Fixture: ${fixturePath}`);
  console.log(`Trap output: ${trapFile}`);

  // Spawn the audit in a child process with the network trap loaded
  const childEnv = Object.assign({}, process.env, {
    NODE_OPTIONS: `--require ${networkTrapPath}`,
    NETWORK_TRAP_FILE: trapFile,
  });

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        path.join(projectRoot, 'src', 'cli.js'),
        'audit',
        fixturePath,
        '--engagement', 'TEST-NET-CHECK',
      ],
      {
        cwd: projectRoot,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    let auditStdout = '';
    let auditStderr = '';

    child.stdout.on('data', (chunk) => {
      auditStdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      auditStderr += chunk.toString();
    });

    child.on('close', (auditExitCode) => {
      // Audit may have completed or failed; either way, check the network tally
      let tally = { count: 0, hosts: [] };
      let tallyError = null;

      if (fs.existsSync(trapFile)) {
        try {
          tally = JSON.parse(fs.readFileSync(trapFile, 'utf8'));
        } catch (err) {
          tallyError = err;
        }
      }

      // Clean up the temp file
      try {
        fs.unlinkSync(trapFile);
      } catch (_) {
        // Ignore cleanup errors
      }

      // Print audit output (for debugging)
      if (auditStdout) {
        console.log('\n--- Audit stdout ---');
        console.log(auditStdout);
      }
      if (auditStderr) {
        console.log('\n--- Audit stderr ---');
        console.log(auditStderr);
      }

      // Check results
      console.log('\n--- Network traffic report ---');
      if (tallyError) {
        console.error(`Error reading network tally: ${tallyError.message}`);
        process.exit(2);
      }

      if (tally.count === 0) {
        console.log('✓ No unexpected network traffic detected');
        process.exit(0);
      } else {
        console.error(`✗ Detected ${tally.count} unexpected network host(s):`);
        tally.hosts.forEach(host => {
          console.error(`  - ${host}`);
        });
        process.exit(1);
      }

      resolve();
    });
  });
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(2);
});
