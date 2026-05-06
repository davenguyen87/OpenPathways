/**
 * Network traffic trap for CI verification.
 *
 * This module monkey-patches Node's http/https request methods to track
 * outbound network traffic. It allowlists known safe hosts (Playwright CDN)
 * and reports any unexpected traffic to a temp file.
 *
 * Usage: Set NODE_OPTIONS=--require ./scripts/network-trap.js when spawning
 * the child process, then read the tally from the file named in
 * process.env.NETWORK_TRAP_FILE.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Allowlisted hosts for known, documented outbound traffic.
// Playwright's chromium binary is installed from Azure CDN on first run only.
const ALLOWLIST = [
  'playwright.azureedge.net',
  // If more hosts are needed, add them here
];

// Track all observed hosts that are not allowlisted
const offendingHosts = new Set();

// Function to extract hostname from request options
function getHostname(options) {
  if (typeof options === 'string') {
    // URL string
    const url = new URL(options);
    return url.hostname;
  }
  if (options && options.hostname) {
    return options.hostname;
  }
  if (options && options.host) {
    // host might include port; extract just the hostname
    return options.host.split(':')[0];
  }
  return null;
}

// Function to check if a host is allowlisted
function isAllowlisted(hostname) {
  if (!hostname) return false;
  return ALLOWLIST.some(allowed =>
    hostname === allowed || hostname.endsWith('.' + allowed)
  );
}

// Trap for http.request
const originalHttpRequest = http.request;
http.request = function(...args) {
  let options = args[0];
  const hostname = getHostname(options);

  if (hostname && !isAllowlisted(hostname)) {
    offendingHosts.add(hostname);
  }

  return originalHttpRequest.apply(this, args);
};

// Trap for https.request
const originalHttpsRequest = https.request;
https.request = function(...args) {
  let options = args[0];
  const hostname = getHostname(options);

  if (hostname && !isAllowlisted(hostname)) {
    offendingHosts.add(hostname);
  }

  return originalHttpsRequest.apply(this, args);
};

// On exit, write the tally to the temp file
process.on('exit', () => {
  const trapFile = process.env.NETWORK_TRAP_FILE;
  if (!trapFile) return;

  try {
    const tally = {
      count: offendingHosts.size,
      hosts: Array.from(offendingHosts).sort(),
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(trapFile, JSON.stringify(tally, null, 2));
  } catch (err) {
    // Best effort; if the trap file can't be written, don't crash the process
    process.stderr.write(`[network-trap] Failed to write tally: ${err.message}\n`);
  }
});
