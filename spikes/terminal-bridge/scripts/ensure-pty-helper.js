'use strict';

/**
 * postinstall fix for node-pty on macOS/Linux.
 *
 * node-pty ships a prebuilt `spawn-helper` binary that MUST be executable — it's
 * what actually posix_spawn()s the child in a PTY. npm's tarball extraction does
 * not always preserve the execute bit on prebuild binaries, so a fresh
 * `npm install` can leave it as 0644, and every spawn then fails with the very
 * unhelpful `Error: posix_spawnp failed.` (EACCES).
 *
 * This script restores +x on any spawn-helper under node-pty. It's a no-op on
 * Windows (no spawn-helper) and idempotent, so it's safe to run on every install.
 */

const fs = require('fs');
const path = require('path');

function chmodx(file) {
  try {
    fs.chmodSync(file, 0o755);
    return true;
  } catch {
    return false;
  }
}

function findSpawnHelpers(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findSpawnHelpers(full, out);
    else if (e.name === 'spawn-helper') out.push(full);
  }
}

const ptyRoot = path.join(__dirname, '..', 'node_modules', 'node-pty');
if (!fs.existsSync(ptyRoot)) process.exit(0);

const helpers = [];
findSpawnHelpers(ptyRoot, helpers);
let fixed = 0;
for (const h of helpers) if (chmodx(h)) fixed++;
if (fixed) console.log(`[ensure-pty-helper] made ${fixed} node-pty spawn-helper binary(ies) executable`);
