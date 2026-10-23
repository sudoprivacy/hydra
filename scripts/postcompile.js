const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const cliOut = path.join(repoRoot, 'packages', 'cli', 'out');
const extOut = path.join(repoRoot, 'packages', 'extension', 'out');

function ensureShebang(file) {
  if (!fs.existsSync(file)) {
    return;
  }
  const content = fs.readFileSync(file, 'utf8');
  if (!content.startsWith('#!/usr/bin/env node')) {
    fs.writeFileSync(file, '#!/usr/bin/env node\n' + content);
  }
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o755);
  }
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// 1. Make the built @hydra/cli entry a runnable bin (shebang + exec bit).
ensureShebang(path.join(cliOut, 'cli', 'index.js'));

// 2. Assemble the VS Code extension's self-contained runtime. The installed CLI
//    wrapper (`~/.hydra/bin/hydra` -> `<extensionPath>/out/cli/index.js`, see
//    core/cliInstaller.ts) and the extension `bin` both expect the compiled CLI
//    at `out/cli/index.js`. Vendor the compiled CLI plus its `e2e`/`share`
//    siblings into the extension's out/. `@hydra/core` is resolved at runtime
//    from the extension's node_modules (workspace symlink in dev; a real copy
//    dereferenced by scripts/prepare-vsix.js inside the packaged .vsix).
if (fs.existsSync(extOut)) {
  for (const sub of ['cli', 'e2e', 'share']) {
    copyDir(path.join(cliOut, sub), path.join(extOut, sub));
  }
  ensureShebang(path.join(extOut, 'cli', 'index.js'));
}
