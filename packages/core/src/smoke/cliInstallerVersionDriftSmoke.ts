/**
 * Smoke coverage for multi-editor CLI installer version drift handling.
 *
 * Run: node packages/core/out/smoke/cliInstallerVersionDriftSmoke.js
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { installCli } from '../core/cliInstaller';

interface CaseOptions {
  name: string;
  configuredVersion: string;
  activatingVersion: string;
  configuredPathUsable?: boolean;
  expectPreserved: boolean;
  expectedResult: { installed: boolean; updated: boolean };
}

function createExtension(root: string, name: string): string {
  const extensionPath = path.join(root, name);
  const cliEntryPoint = path.join(extensionPath, 'out', 'cli', 'index.js');
  fs.mkdirSync(path.dirname(cliEntryPoint), { recursive: true });
  fs.writeFileSync(cliEntryPoint, '// smoke fixture\n', 'utf-8');
  return extensionPath;
}

function runCase(options: CaseOptions): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hydra-cli-drift-${options.name}-`));
  const hydraHome = path.join(root, 'hydra-home');
  const configPath = path.join(hydraHome, 'config.json');
  const wrapperPath = path.join(hydraHome, 'bin', process.platform === 'win32' ? 'hydra.cmd' : 'hydra');
  const configuredExtensionPath = options.configuredPathUsable
    ? createExtension(root, 'configured-extension')
    : path.join(root, 'missing-extension');
  const activatingExtensionPath = createExtension(root, 'activating-extension');
  const wrapperSentinel = process.platform === 'win32' ? '@echo off\r\nrem newer wrapper\r\n' : '#!/bin/sh\n# newer wrapper\n';

  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
  fs.writeFileSync(wrapperPath, wrapperSentinel, { encoding: 'utf-8', mode: 0o755 });
  fs.writeFileSync(configPath, `${JSON.stringify({
    cli: {
      extensionPath: configuredExtensionPath,
      version: options.configuredVersion,
    },
  }, null, 2)}\n`, 'utf-8');

  process.env.HYDRA_HOME = hydraHome;
  process.env.HYDRA_CONFIG_PATH = configPath;

  try {
    const result = installCli(activatingExtensionPath, options.activatingVersion);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      cli: { extensionPath: string; version: string };
    };
    const wrapper = fs.readFileSync(wrapperPath, 'utf-8');

    assert.deepEqual(result, options.expectedResult, `${options.name}: install result`);
    assert.equal(
      config.cli.extensionPath,
      options.expectPreserved ? configuredExtensionPath : activatingExtensionPath,
      `${options.name}: configured extension path`,
    );
    assert.equal(
      config.cli.version,
      options.expectPreserved ? options.configuredVersion : options.activatingVersion,
      `${options.name}: configured version`,
    );
    assert.equal(
      wrapper === wrapperSentinel,
      options.expectPreserved,
      `${options.name}: wrapper preservation`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function main(): void {
  const previousHydraHome = process.env.HYDRA_HOME;
  const previousHydraConfigPath = process.env.HYDRA_CONFIG_PATH;

  try {
    runCase({
      name: 'newer-activation',
      configuredVersion: '1.2.3',
      activatingVersion: '1.3.0',
      configuredPathUsable: true,
      expectPreserved: false,
      expectedResult: { installed: false, updated: true },
    });
    runCase({
      name: 'older-activation',
      configuredVersion: '1.3.0',
      activatingVersion: '1.2.3',
      configuredPathUsable: true,
      expectPreserved: true,
      expectedResult: { installed: false, updated: false },
    });
    runCase({
      name: 'same-version',
      configuredVersion: '1.2.3',
      activatingVersion: '1.2.3',
      configuredPathUsable: true,
      expectPreserved: false,
      expectedResult: { installed: false, updated: false },
    });
    runCase({
      name: 'missing-configured-path',
      configuredVersion: '1.3.0',
      activatingVersion: '1.2.3',
      expectPreserved: false,
      expectedResult: { installed: false, updated: true },
    });
  } finally {
    if (previousHydraHome === undefined) delete process.env.HYDRA_HOME;
    else process.env.HYDRA_HOME = previousHydraHome;
    if (previousHydraConfigPath === undefined) delete process.env.HYDRA_CONFIG_PATH;
    else process.env.HYDRA_CONFIG_PATH = previousHydraConfigPath;
  }

  console.log('cliInstallerVersionDriftSmoke: ok');
}

main();
