// postinstall fix for node-pty on macOS/Linux (risk #1 from the terminal spike).
//
// node-pty ships a prebuilt `spawn-helper` binary that MUST be executable — it's
// what actually posix_spawn()s the child in a PTY. npm's tarball extraction does
// not always preserve the execute bit on prebuild binaries, so a fresh
// `npm install` can leave it as 0644, and every PTY spawn then fails with the
// very unhelpful `Error: posix_spawnp failed.` (EACCES). The desktop app's
// terminal layer (packages/sidecar `node-pty` ⇄ `tmux attach`) depends on this.
//
// This restores +x on every `spawn-helper` under any hoisted node-pty in the
// workspace. It's a no-op on Windows (no spawn-helper) and idempotent, so it is
// safe to run on every install. Reference: spikes/terminal-bridge FINDINGS §7.1.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

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
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findSpawnHelpers(full, out);
    } else if (entry.name === 'spawn-helper') {
      out.push(full);
    }
  }
}

// npm workspaces hoist node-pty to the repo-root node_modules, but a nested copy
// under packages/*/node_modules is possible too — collect every `node-pty` tree.
function collectPtyRoots() {
  const roots = [];
  const candidates = [path.join(repoRoot, 'node_modules')];
  const packagesDir = path.join(repoRoot, 'packages');
  try {
    for (const pkg of fs.readdirSync(packagesDir)) {
      candidates.push(path.join(packagesDir, pkg, 'node_modules'));
    }
  } catch {
    // no packages dir — fine
  }
  for (const nm of candidates) {
    const ptyRoot = path.join(nm, 'node-pty');
    if (fs.existsSync(ptyRoot)) {
      roots.push(ptyRoot);
    }
  }
  return roots;
}

const helpers = [];
for (const ptyRoot of collectPtyRoots()) {
  findSpawnHelpers(ptyRoot, helpers);
}

let fixed = 0;
for (const helper of helpers) {
  if (chmodx(helper)) {
    fixed += 1;
  }
}
if (fixed) {
  console.log(`[ensure-pty-helper] made ${fixed} node-pty spawn-helper binary(ies) executable`);
}
