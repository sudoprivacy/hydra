// Package the hydra-code VS Code extension into a self-contained .vsix.
//
// Inside an npm-workspaces monorepo, `vsce package` run against packages/extension
// misbehaves: hoisted production deps live at ../../node_modules (vsce then walks
// the whole repo into the archive) and the vendored + hoisted copies collide as
// duplicate entries. To get a clean, self-contained package we:
//   1. build everything and assemble the extension's runtime (npm run compile),
//   2. vendor the extension's full production dependency closure into
//      packages/extension/node_modules (scripts/prepare-vsix.js),
//   3. copy the extension into an isolated, non-workspace staging directory, and
//   4. run `vsce package` there, where the extension looks like an ordinary
//      single-package extension with a complete local node_modules.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const extDir = path.join(repoRoot, 'packages', 'extension');

function run(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'inherit' });
}

// 1 + 2: build + assemble runtime, then vendor production deps locally.
run('npm run compile', repoRoot);
run('node scripts/prepare-vsix.js', repoRoot);

// 3: stage an isolated copy of the extension.
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-vsix-'));
const stageExt = path.join(staging, 'extension');
fs.mkdirSync(stageExt, { recursive: true });

for (const item of ['out', 'resources', 'node_modules', '.vscodeignore']) {
  const src = path.join(extDir, item);
  if (fs.existsSync(src)) {
    fs.cpSync(src, path.join(stageExt, item), { recursive: true, dereference: true });
  }
}

// Marketplace docs (parity with the pre-monorepo package, which shipped these).
for (const doc of ['README.md', 'LICENSE.md', 'CHANGELOG.md']) {
  const src = path.join(repoRoot, doc);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(stageExt, doc));
  }
}

// package.json without scripts/devDependencies: nothing for vsce to run, and the
// dependency list resolves entirely against the local (complete) node_modules.
const pkg = JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf8'));
delete pkg.scripts;
delete pkg.devDependencies;
fs.writeFileSync(path.join(stageExt, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

// 4: package from the isolated directory.
const outFile = path.join(repoRoot, `hydra-${pkg.version}.vsix`);
fs.rmSync(outFile, { force: true });
run(`npx --yes @vscode/vsce package --out ${JSON.stringify(outFile)}`, stageExt);

console.log(`\nPackaged ${path.relative(repoRoot, outFile)}`);
