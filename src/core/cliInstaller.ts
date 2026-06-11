import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getDefaultHydraHome, getHydraBinDir, getHydraConfig, writeHydraConfig } from './path';

function getWrapperPath(): string {
  if (process.platform === 'win32') {
    return path.join(getHydraBinDir(), 'hydra.cmd');
  }
  return path.join(getHydraBinDir(), 'hydra');
}

export function buildWrapperScriptWindows(): string {
  return `@echo off
setlocal DisableDelayedExpansion

set "HYDRA_DEFAULT_HOME=%USERPROFILE%\\.hydra"
if defined HYDRA_HOME (
  set "HYDRA_HOME_DIR=%HYDRA_HOME%"
) else (
  set "HYDRA_HOME_DIR=%HYDRA_DEFAULT_HOME%"
)

if defined HYDRA_CONFIG_PATH (
  set "CONFIG_PATH=%HYDRA_CONFIG_PATH%"
) else (
  set "CONFIG_PATH=%HYDRA_HOME_DIR%\\config.json"
)

node -e "const fs=require('fs'),path=require('path'),os=require('os');function expandHomeDir(p){if(p==='~')return os.homedir();if(p.startsWith('~/')||p.startsWith('~\\\\'))return path.join(os.homedir(),p.slice(2));return p}function resolveConfigPathValue(v,c){if(typeof v!=='string'||!v.trim())return undefined;const e=expandHomeDir(v.trim());const a=path.isAbsolute(e)?e:path.resolve(path.dirname(c),e);return path.normalize(a)}const configPath=process.env.HYDRA_CONFIG_PATH||path.join(process.env.HYDRA_HOME||path.join(os.homedir(),'.hydra'),'config.json');let cfg={};try{if(fs.existsSync(configPath))cfg=JSON.parse(fs.readFileSync(configPath,'utf8'))||{}}catch{}const extPath=typeof(cfg.cli||{}).extensionPath==='string'?cfg.cli.extensionPath:'';if(!extPath||!fs.existsSync(path.join(extPath,'out','cli','index.js'))){console.error('Error: Hydra VS Code extension not found. Open VS Code with Hydra installed.');process.exit(1)}const {spawnSync}=require('child_process');const r=spawnSync(process.execPath,[path.join(extPath,'out','cli','index.js'),...process.argv.slice(1)],{stdio:'inherit',env:{...process.env,HYDRA_HOME:process.env.HYDRA_HOME||path.join(os.homedir(),'.hydra'),HYDRA_CONFIG_PATH:configPath}});if(r.error){console.error(r.error.message);process.exit(1)}process.exit(typeof r.status==='number'?r.status:1)" -- %*
`;
}

function buildWrapperScript(): string {
  if (process.platform === 'win32') {
    return buildWrapperScriptWindows();
  }
  return `#!/bin/sh
exec node - "$@" <<'NODE'
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function expandHomeDir(targetPath) {
  if (targetPath === '~') return os.homedir();
  if (targetPath.startsWith('~/') || targetPath.startsWith('~\\\\')) {
    return path.join(os.homedir(), targetPath.slice(2));
  }
  return targetPath;
}

function toCanonicalPath(targetPath) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    return undefined;
  }
  const expanded = expandHomeDir(targetPath.trim());
  return path.normalize(path.resolve(expanded));
}

function resolveConfigPathValue(value, configPath) {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const expanded = expandHomeDir(value.trim());
  const absolute = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(path.dirname(configPath), expanded);
  return path.normalize(absolute);
}

function readHydraConfigFile(configPath) {
  try {
    if (!fs.existsSync(configPath)) {
      return {};
    }
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

const defaultHydraHome = path.join(os.homedir(), '.hydra');
const envHydraHome = toCanonicalPath(process.env.HYDRA_HOME);
const envHydraConfigPath = toCanonicalPath(process.env.HYDRA_CONFIG_PATH);
const bootstrapConfigPath = envHydraConfigPath
  || path.join(envHydraHome || defaultHydraHome, 'config.json');

let hydraConfig = readHydraConfigFile(bootstrapConfigPath);
let hydraHome = envHydraHome
  || resolveConfigPathValue(hydraConfig.hydraHome || hydraConfig.HYDRA_HOME, bootstrapConfigPath)
  || defaultHydraHome;
let hydraConfigPath = envHydraConfigPath
  || resolveConfigPathValue(hydraConfig.hydraConfigPath || hydraConfig.HYDRA_CONFIG_PATH, bootstrapConfigPath)
  || path.join(hydraHome, 'config.json');

if (!envHydraConfigPath && hydraConfigPath !== bootstrapConfigPath && fs.existsSync(hydraConfigPath)) {
  hydraConfig = readHydraConfigFile(hydraConfigPath);
  hydraHome = envHydraHome
    || resolveConfigPathValue(hydraConfig.hydraHome || hydraConfig.HYDRA_HOME, hydraConfigPath)
    || hydraHome;
  hydraConfigPath = resolveConfigPathValue(hydraConfig.hydraConfigPath || hydraConfig.HYDRA_CONFIG_PATH, hydraConfigPath)
    || hydraConfigPath;
}

const extPath = typeof hydraConfig.cli?.extensionPath === 'string'
  ? hydraConfig.cli.extensionPath
  : '';

if (!extPath || !fs.existsSync(path.join(extPath, 'out', 'cli', 'index.js'))) {
  console.error('Error: Hydra VS Code extension not found. Open VS Code with Hydra installed.');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [path.join(extPath, 'out', 'cli', 'index.js'), ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      HYDRA_HOME: hydraHome,
      HYDRA_CONFIG_PATH: hydraConfigPath,
    },
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(1);
NODE
`;
}

export function installCli(extensionPath: string, version: string): { installed: boolean; updated: boolean } {
  const binDir = getHydraBinDir();
  // Create Hydra CLI directory.
  fs.mkdirSync(binDir, { recursive: true });

  // Write wrapper script (mode is ignored on Windows)
  fs.writeFileSync(getWrapperPath(), buildWrapperScript(), { encoding: 'utf-8', mode: 0o755 });

  const hydraConfig = getHydraConfig();
  const previousVersion = hydraConfig.cli?.version?.trim();
  writeHydraConfig({
    ...hydraConfig,
    cli: {
      ...hydraConfig.cli,
      extensionPath,
      version,
    },
  });

  if (!previousVersion) {
    return { installed: true, updated: false };
  }
  if (previousVersion !== version) {
    return { installed: false, updated: true };
  }
  // Same version, no change
  return { installed: false, updated: false };
}

export type ShellProfileStatus = 'added' | 'already_present' | 'skipped_custom_home';

export function ensurePathInShellProfile(): ShellProfileStatus {
  const defaultBinDir = path.join(getDefaultHydraHome(), 'bin');
  if (getHydraBinDir() !== defaultBinDir) {
    return 'skipped_custom_home';
  }

  const snippet = getShellConfigSnippet();
  const marker = '# Hydra CLI';

  if (process.platform === 'win32') {
    // On Windows, look for PowerShell profile paths
    const candidates = [
      path.join(os.homedir(), 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
      path.join(os.homedir(), 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
    ];
    for (const rc of candidates) {
      const rcDir = path.dirname(rc);
      if (!fs.existsSync(rcDir)) continue;
      if (fs.existsSync(rc)) {
        const content = fs.readFileSync(rc, 'utf-8');
        if (content.includes(snippet) || content.includes(marker)) return 'already_present';
        fs.appendFileSync(rc, `\n# Hydra CLI\n${snippet}\n`);
        return 'added';
      }
    }
    // Create the first profile directory and file
    const profileDir = path.dirname(candidates[0]);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(candidates[0], `# Hydra CLI\n${snippet}\n`, 'utf-8');
    return 'added';
  }

  const candidates = [
    path.join(os.homedir(), '.zshrc'),
    path.join(os.homedir(), '.bashrc'),
  ];
  for (const rc of candidates) {
    if (!fs.existsSync(rc)) continue;
    const content = fs.readFileSync(rc, 'utf-8');
    if (content.includes(snippet) || content.includes(marker)) return 'already_present';
    fs.appendFileSync(rc, `\n# Hydra CLI\n${snippet}\n`);
    return 'added';
  }
  // No rc file found — create ~/.zshrc (macOS default)
  fs.writeFileSync(candidates[0], `# Hydra CLI\n${snippet}\n`, 'utf-8');
  return 'added';
}

export function isCliOnPath(): boolean {
  const binDir = getHydraBinDir();
  const envPath = process.env.PATH || '';
  return envPath.split(path.delimiter).some(p => {
    try {
      return fs.realpathSync(p) === fs.realpathSync(binDir);
    } catch {
      return p === binDir;
    }
  });
}

export function getShellConfigSnippet(): string {
  const binDir = path.join(getDefaultHydraHome(), 'bin');
  if (process.platform === 'win32') {
    return `$env:PATH = "${binDir};$env:PATH"`;
  }
  return `export PATH="${binDir}:$PATH"`;
}
