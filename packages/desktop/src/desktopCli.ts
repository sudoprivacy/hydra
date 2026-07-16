import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  ensurePathInShellProfile,
  installCli,
  type ShellProfileStatus,
} from '@hydra/core/cliInstaller';

export interface DesktopCliInstallResult {
  runtimeRoot: string;
  version: string;
  installed: boolean;
  updated: boolean;
  shellProfileStatus?: ShellProfileStatus;
}

export interface DesktopCliInstallOptions {
  appVersion: string;
  cliPackageJsonPath: string;
}

export function installBundledDesktopCli(options: DesktopCliInstallOptions): DesktopCliInstallResult {
  const cliPackageJson = readCliPackageJson(options.cliPackageJsonPath);
  if (cliPackageJson.version !== options.appVersion) {
    throw new Error(
      `Bundled Hydra CLI version ${cliPackageJson.version} does not match Desktop ${options.appVersion}`,
    );
  }

  const runtimeRoot = path.dirname(options.cliPackageJsonPath);
  const cliEntryPoint = path.join(runtimeRoot, 'out', 'cli', 'index.js');
  try {
    if (!fs.statSync(cliEntryPoint).isFile()) {
      throw new Error('not a file');
    }
    fs.accessSync(cliEntryPoint, fs.constants.R_OK);
  } catch {
    throw new Error(`Bundled Hydra CLI entry point is unavailable at ${cliEntryPoint}`);
  }

  const result = installCli(runtimeRoot, options.appVersion);
  const shellProfileStatus = result.installed ? ensurePathInShellProfile() : undefined;
  return {
    runtimeRoot,
    version: options.appVersion,
    ...result,
    shellProfileStatus,
  };
}

function readCliPackageJson(packageJsonPath: string): { version: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  } catch {
    throw new Error(`Bundled Hydra CLI package metadata is unavailable at ${packageJsonPath}`);
  }

  const version = (parsed as { version?: unknown })?.version;
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error(`Bundled Hydra CLI package metadata has no valid version at ${packageJsonPath}`);
  }
  return { version: version.trim() };
}
