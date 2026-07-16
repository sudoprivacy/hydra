import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { installBundledDesktopCli } from '../desktopCli';

function main(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-desktop-cli-'));
  const hydraHome = path.join(root, '.hydra');
  const configPath = path.join(hydraHome, 'config.json');
  const desktopPackage = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf-8'),
  ) as { version: string };
  const cliPackageJsonPath = require.resolve('@hydra/cli/package.json');
  const previousHydraHome = process.env.HYDRA_HOME;
  const previousHydraConfigPath = process.env.HYDRA_CONFIG_PATH;

  fs.mkdirSync(hydraHome, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    defaultAgent: 'codex',
    cli: {
      extensionPath: path.join(root, 'missing-old-runtime'),
      version: '0.0.1',
    },
  }, null, 2)}\n`, 'utf-8');
  process.env.HYDRA_HOME = hydraHome;
  process.env.HYDRA_CONFIG_PATH = configPath;

  try {
    const result = installBundledDesktopCli({
      appVersion: desktopPackage.version,
      cliPackageJsonPath,
    });
    assert.equal(result.updated, true, 'desktop replaces an older unusable CLI runtime');
    assert.equal(result.version, desktopPackage.version);
    assert.equal(result.runtimeRoot, path.dirname(cliPackageJsonPath));

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      defaultAgent?: string;
      cli?: { extensionPath?: string; version?: string };
    };
    assert.equal(config.defaultAgent, 'codex', 'desktop CLI registration preserves unrelated config');
    assert.equal(config.cli?.extensionPath, result.runtimeRoot);
    assert.equal(config.cli?.version, desktopPackage.version);

    const wrapperPath = path.join(hydraHome, 'bin', process.platform === 'win32' ? 'hydra.cmd' : 'hydra');
    assert.equal(fs.existsSync(wrapperPath), true, 'desktop CLI registration creates the shared wrapper');
    const invocation = spawnSync(wrapperPath, ['--version'], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        HYDRA_HOME: hydraHome,
        HYDRA_CONFIG_PATH: configPath,
      },
      shell: process.platform === 'win32',
    });
    assert.equal(invocation.status, 0, invocation.stderr || invocation.error?.message);
    assert.equal(invocation.stdout.trim(), desktopPackage.version, 'shared wrapper runs the bundled CLI version');

    assert.throws(
      () => installBundledDesktopCli({ appVersion: '0.0.0', cliPackageJsonPath }),
      /does not match Desktop/,
      'desktop rejects mismatched bundled CLI metadata',
    );
  } finally {
    if (previousHydraHome === undefined) delete process.env.HYDRA_HOME;
    else process.env.HYDRA_HOME = previousHydraHome;
    if (previousHydraConfigPath === undefined) delete process.env.HYDRA_CONFIG_PATH;
    else process.env.HYDRA_CONFIG_PATH = previousHydraConfigPath;
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('desktopCliSmoke: ok');
}

main();
