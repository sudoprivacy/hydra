#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ROOT_PREFIX = path.join(os.tmpdir(), 'hydra-e2e-');
const CLI_ENTRY = path.join(REPO_ROOT, 'packages', 'cli', 'out', 'cli', 'index.js');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function printUsage() {
  const lines = [
    'Usage:',
    '  node scripts/e2e-isolated-runner.js [options] [-- <command> [args...]]',
    '',
    'Options:',
    '  --keep          Preserve the isolated temp root after exit.',
    '  --cleanup       Remove the isolated temp root even when it would normally be kept.',
    '  --root <path>   Reuse or create a specific isolated root directory.',
    '  --shell         Launch an interactive shell inside the isolated environment.',
    '  --help          Show this help.',
    '',
    'Examples:',
    '  npm run e2e:isolated',
    '  npm run e2e:isolated -- --keep -- hydra list --json',
    '  npm run e2e:isolated -- --keep -- code --disable-extensions --extensionDevelopmentPath=packages/extension /tmp/hydra-test-$(date +%s)',
    '  npm run e2e:isolated:shell',
  ];
  console.error(lines.join('\n'));
}

function parseArgs(argv) {
  const args = [...argv];
  const commandIndex = args.indexOf('--');
  const command = commandIndex >= 0 ? args.slice(commandIndex + 1) : [];
  const optionArgs = commandIndex >= 0 ? args.slice(0, commandIndex) : args;
  const options = {
    cleanup: false,
    keep: false,
    root: undefined,
    shell: false,
    command,
  };

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    if (arg === '--keep') {
      options.keep = true;
      continue;
    }
    if (arg === '--cleanup') {
      options.cleanup = true;
      continue;
    }
    if (arg === '--shell') {
      options.shell = true;
      continue;
    }
    if (arg === '--root') {
      const next = optionArgs[index + 1];
      if (!next) {
        throw new Error('--root requires a path');
      }
      options.root = path.resolve(next);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.shell && options.command.length > 0) {
    throw new Error('--shell cannot be combined with a command after --');
  }

  return options;
}

function detectExecutable(command) {
  const lookup = spawnSync('/bin/sh', ['-lc', `command -v ${shellQuote(command)}`], {
    encoding: 'utf8',
  });
  if (lookup.status !== 0) {
    return '';
  }
  return lookup.stdout.trim();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureSymlink(linkPath, targetPath) {
  try {
    const stats = fs.lstatSync(linkPath);
    if (stats.isSymbolicLink() && fs.readlinkSync(linkPath) === targetPath) {
      return;
    }
    fs.rmSync(linkPath, { recursive: true, force: true });
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw error;
    }
  }
  fs.symlinkSync(targetPath, linkPath);
}

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

function ensureJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '{}\n', 'utf8');
  }
}

function readJsonObject(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

function writeJsonObject(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createIsolatedEnvironment(requestedRoot) {
  const root = requestedRoot
    ? path.resolve(requestedRoot)
    : fs.mkdtempSync(DEFAULT_ROOT_PREFIX);

  const homeDir = path.join(root, 'home');
  const hydraHome = path.join(root, 'hydra-home');
  const hydraConfigPath = path.join(root, 'config.json');
  const hydraBinDir = path.join(hydraHome, 'bin');
  const shimBinDir = path.join(root, 'bin');
  const tmuxDir = path.join(hydraHome, 'tmux');
  const tmpDir = path.join(root, 'tmp');
  const zdotdir = path.join(root, 'zdotdir');
  const vscodeUserDataDir = path.join(root, 'vscode-user-data');
  const vscodeUserDir = path.join(vscodeUserDataDir, 'User');
  const vscodeSettingsPath = path.join(vscodeUserDir, 'settings.json');
  const tmuxSocket = path.join(tmuxDir, 'hydra.sock');
  const activateScript = path.join(root, 'activate.sh');
  const metadataFile = path.join(root, 'context.json');
  const realTmuxPath = detectExecutable('tmux');
  const realCodePath = detectExecutable('code');
  const nodePath = process.execPath;

  ensureDir(root);
  ensureDir(homeDir);
  ensureDir(hydraHome);
  ensureDir(hydraBinDir);
  ensureDir(shimBinDir);
  ensureDir(tmuxDir);
  ensureDir(tmpDir);
  ensureDir(zdotdir);
  ensureDir(vscodeUserDir);
  ensureSymlink(path.join(homeDir, '.hydra'), hydraHome);
  ensureJsonFile(hydraConfigPath);
  writeJsonObject(vscodeSettingsPath, {
    ...readJsonObject(vscodeSettingsPath),
    'security.workspace.trust.enabled': false,
    'security.workspace.trust.startupPrompt': 'never',
    'security.workspace.trust.untrustedFiles': 'open',
    'security.workspace.trust.emptyWindow': true,
  });

  writeExecutable(
    path.join(hydraBinDir, 'hydra'),
    [
      '#!/bin/sh',
      'set -eu',
      `CLI_ENTRY=${shellQuote(CLI_ENTRY)}`,
      `NODE_BIN=${shellQuote(nodePath)}`,
      'if [ ! -f "$CLI_ENTRY" ]; then',
      '  echo "Hydra CLI build output is missing. Run npm run compile first." >&2',
      '  exit 1',
      'fi',
      'exec "$NODE_BIN" "$CLI_ENTRY" "$@"',
      '',
    ].join('\n'),
  );

  writeExecutable(
    path.join(shimBinDir, 'tmux'),
    [
      '#!/bin/sh',
      'set -eu',
      `REAL_TMUX=${shellQuote(realTmuxPath)}`,
      'if [ -z "$REAL_TMUX" ]; then',
      '  echo "tmux is not installed or not on PATH." >&2',
      '  exit 127',
      'fi',
      'has_custom_socket=0',
      'previous=""',
      'for arg in "$@"; do',
      '  if [ "$previous" = "-S" ] || [ "$previous" = "-L" ]; then',
      '    has_custom_socket=1',
      '    break',
      '  fi',
      '  case "$arg" in',
      '    -S|-L)',
      '      has_custom_socket=1',
      '      break',
      '      ;;',
      '  esac',
      '  previous="$arg"',
      'done',
      'if [ "$has_custom_socket" -eq 0 ] && [ -n "${HYDRA_TMUX_SOCKET:-}" ]; then',
      '  exec "$REAL_TMUX" -S "$HYDRA_TMUX_SOCKET" "$@"',
      'fi',
      'exec "$REAL_TMUX" "$@"',
      '',
    ].join('\n'),
  );

  writeExecutable(
    path.join(shimBinDir, 'code'),
    [
      '#!/bin/sh',
      'set -eu',
      `REAL_CODE=${shellQuote(realCodePath)}`,
      `VSCODE_USER_DATA_DIR=${shellQuote(vscodeUserDataDir)}`,
      'if [ -z "$REAL_CODE" ]; then',
      '  echo "VS Code CLI (code) is not installed or not on PATH." >&2',
      '  exit 127',
      'fi',
      'has_user_data_dir=0',
      'previous=""',
      'for arg in "$@"; do',
      '  if [ "$previous" = "--user-data-dir" ]; then',
      '    has_user_data_dir=1',
      '    break',
      '  fi',
      '  case "$arg" in',
      '    --user-data-dir)',
      '      has_user_data_dir=1',
      '      break',
      '      ;;',
      '    --user-data-dir=*)',
      '      has_user_data_dir=1',
      '      break',
      '      ;;',
      '  esac',
      '  previous="$arg"',
      'done',
      'if [ "$has_user_data_dir" -eq 0 ]; then',
      '  exec "$REAL_CODE" --user-data-dir "$VSCODE_USER_DATA_DIR" "$@"',
      'fi',
      'exec "$REAL_CODE" "$@"',
      '',
    ].join('\n'),
  );

  const shellExports = [
    `export HYDRA_HOME=${shellQuote(hydraHome)}`,
    `export HYDRA_CONFIG_PATH=${shellQuote(hydraConfigPath)}`,
    `export HYDRA_TMUX_SOCKET=${shellQuote(tmuxSocket)}`,
    `export HYDRA_E2E_ROOT=${shellQuote(root)}`,
    `export TMPDIR=${shellQuote(tmpDir)}`,
    `export TMP=${shellQuote(tmpDir)}`,
    `export TEMP=${shellQuote(tmpDir)}`,
    `export PATH=${shellQuote([hydraBinDir, shimBinDir, process.env.PATH || ''].filter(Boolean).join(':'))}`,
    'unset TMUX',
    'unset TMUX_PANE',
    '',
  ].join('\n');

  const zshInit = [
    '# Hydra isolated shell init',
    '[ -f "$HOME/.zshrc" ] && ZDOTDIR="$HOME" . "$HOME/.zshrc"',
    shellExports,
  ].join('\n');

  const bashInit = [
    '# Hydra isolated shell init',
    '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
    shellExports,
  ].join('\n');

  fs.writeFileSync(path.join(zdotdir, '.zshrc'), zshInit, 'utf8');
  fs.writeFileSync(path.join(zdotdir, '.bashrc'), bashInit, 'utf8');

  const env = {
    ...process.env,
    HYDRA_HOME: hydraHome,
    HYDRA_CONFIG_PATH: hydraConfigPath,
    HYDRA_TMUX_SOCKET: tmuxSocket,
    HYDRA_E2E_ROOT: root,
    ZDOTDIR: zdotdir,
    PATH: [hydraBinDir, shimBinDir, process.env.PATH || ''].filter(Boolean).join(':'),
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
  };
  delete env.TMUX;
  delete env.TMUX_PANE;

  writeExecutable(
    activateScript,
    [
      '#!/bin/sh',
      `export HYDRA_HOME=${shellQuote(hydraHome)}`,
      `export HYDRA_CONFIG_PATH=${shellQuote(hydraConfigPath)}`,
      `export HYDRA_TMUX_SOCKET=${shellQuote(tmuxSocket)}`,
      `export HYDRA_E2E_ROOT=${shellQuote(root)}`,
      `export ZDOTDIR=${shellQuote(zdotdir)}`,
      `export TMPDIR=${shellQuote(tmpDir)}`,
      `export TMP=${shellQuote(tmpDir)}`,
      `export TEMP=${shellQuote(tmpDir)}`,
      `export PATH=${shellQuote(env.PATH)}`,
      'unset TMUX',
      'unset TMUX_PANE',
      '',
    ].join('\n'),
  );

  const sampleInvocation = `npm run e2e:isolated -- --root ${shellQuote(root)} -- hydra list --json`;
  const context = {
    root,
    homeDir,
    hydraHome,
    hydraConfigPath,
    zdotdir,
    tmuxSocket,
    vscodeUserDataDir,
    activateScript,
    sampleInvocation,
  };
  fs.writeFileSync(metadataFile, `${JSON.stringify(context, null, 2)}\n`, 'utf8');

  return {
    context,
    env,
    rootWasProvided: Boolean(requestedRoot),
  };
}

function printSummary(context) {
  const lines = [
    'Hydra isolated env ready',
    `  root: ${context.root}`,
    `  HYDRA_HOME: ${context.hydraHome}`,
    `  HYDRA_CONFIG_PATH: ${context.hydraConfigPath}`,
    `  HYDRA_TMUX_SOCKET: ${context.tmuxSocket}`,
    `  VS Code user data: ${context.vscodeUserDataDir}`,
    `  activate: source ${shellQuote(context.activateScript)}`,
    `  sample: ${context.sampleInvocation}`,
  ];
  console.error(lines.join('\n'));
}

function cleanupRoot(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function runChild(options, env) {
  if (options.shell) {
    const shellPath = process.env.SHELL || '/bin/sh';
    return spawnSync(shellPath, {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
    });
  }
  if (options.command.length === 0) {
    return null;
  }
  const [command, ...args] = options.command;
  return spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const isolated = createIsolatedEnvironment(options.root);
  const hasChild = options.shell || options.command.length > 0;
  const preserveByDefault = options.keep || isolated.rootWasProvided || !hasChild;

  printSummary(isolated.context);

  let exitCode = 0;
  const result = runChild(options, isolated.env);

  if (result && result.error) {
    console.error(result.error.message);
    exitCode = typeof result.status === 'number' ? result.status : 1;
  } else if (result && result.signal) {
    console.error(`Child process exited from signal ${result.signal}`);
    exitCode = 1;
  } else if (result && typeof result.status === 'number') {
    exitCode = result.status;
  }

  const shouldPreserve = options.cleanup
    ? false
    : preserveByDefault || exitCode !== 0;

  if (shouldPreserve) {
    console.error(`Preserved isolated env at ${isolated.context.root}`);
  } else {
    cleanupRoot(isolated.context.root);
    console.error(`Cleaned up isolated env at ${isolated.context.root}`);
  }

  process.exit(exitCode);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
