import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageDir, '..', '..');
const desktopPackage = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
const updateConfig = await readFile(path.join(packageDir, 'build', 'app-update.yml'), 'utf8');
const releaseScript = await readFile(path.join(packageDir, 'scripts', 'dist-mac-release.mjs'), 'utf8');
const publishWorkflow = await readFile(path.join(repoRoot, '.github', 'workflows', 'publish.yml'), 'utf8');

assert.equal(desktopPackage.dependencies['electron-updater']?.startsWith('^6.'), true);
assert.equal(desktopPackage.dependencies['@hydra/cli'], '*');
assert.equal(desktopPackage.dependencies['@hydra/core'], '*');
assert.equal(desktopPackage.scripts['build:runtime'], 'npm --prefix ../.. run compile');
assert.match(desktopPackage.scripts['pack:mac'], /^npm run build:runtime &&/);
assert.match(desktopPackage.scripts['dist:mac'], /^npm run build:runtime &&/);
assert.deepEqual(desktopPackage.build.publish, [{ provider: 'github', owner: 'sudoprivacy', repo: 'hydra' }]);
assert.deepEqual(desktopPackage.build.extraResources, [{ from: 'build/app-update.yml', to: 'app-update.yml' }]);
assert.match(updateConfig, /^provider: github$/m);
assert.match(updateConfig, /^owner: sudoprivacy$/m);
assert.match(updateConfig, /^repo: hydra$/m);

assert.match(releaseScript, /APPLE_APP_SPECIFIC_PASSWORD/);
assert.match(releaseScript, /latest-mac\.yml/);
assert.match(releaseScript, /zipBlockmapPath/);
assert.match(releaseScript, /validateBundledCli/);
assert.match(releaseScript, /node_modules', '@hydra', 'cli', 'out', 'cli', 'index\.js'/);
const runtimeBuildIndex = releaseScript.indexOf("await run('npm', ['run', 'build:runtime']);");
const appBuildIndex = releaseScript.indexOf("await run('npm', ['run', 'build']);");
const packageAppIndex = releaseScript.indexOf("await run(builderPath, ['--mac', '--dir', '--arm64']");
assert.ok(runtimeBuildIndex !== -1, 'release script must build the bundled runtime');
assert.ok(runtimeBuildIndex < appBuildIndex, 'bundled runtime must build before the Desktop app');
assert.ok(appBuildIndex < packageAppIndex, 'Desktop app must build before electron-builder packages it');
assert.match(
  releaseScript,
  /\['--mac', 'dmg', '--prepackaged', appOutDir, '--publish', 'never'\]/,
);
assert.match(
  releaseScript,
  /\['--mac', 'zip', '--prepackaged', appPath, '--arm64', '--publish', 'never'\]/,
);

for (const requiredWorkflowFragment of [
  'build-desktop:',
  'create-github-release:',
  'MACOS_CERTIFICATE_P12',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'latest-mac.yml',
  'needs: [publish-extension, build-desktop]',
]) {
  assert.equal(
    publishWorkflow.includes(requiredWorkflowFragment),
    true,
    `publish workflow is missing ${requiredWorkflowFragment}`,
  );
}

console.log('releaseConfigurationSmoke: ok');
