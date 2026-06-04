/**
 * E2E smoke: a real CLI copilot create failure writes Hydra diagnostics.
 *
 * The test uses an isolated HYDRA_HOME and a deliberately invalid tmux socket
 * path so session creation fails before any agent process is launched. This
 * mirrors user reports where no worker/copilot pane log exists yet.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function which(cmd: string): string | null {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf-8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function skip(reason: string): never {
  console.log(`loggingCliE2eSmoke: SKIP (${reason})`);
  process.exit(0);
}

if (process.platform === 'win32') {
  skip('Windows is not supported by this smoke (POSIX-only socket paths)');
}
if (!which('tmux')) {
  skip('tmux is not on PATH');
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-logging-cli-e2e-'));
const homeDir = path.join(tempRoot, 'home');
const hydraHome = path.join(homeDir, '.hydra');
const workdir = path.join(tempRoot, 'workdir');
const stubBinDir = path.join(tempRoot, 'bin');
const missingSocket = path.join(os.tmpdir(), `hydra-log-missing-${process.pid}`, 'hydra.sock');
const cliEntry = path.resolve(__dirname, '..', 'cli', 'index.js');

try {
  fs.mkdirSync(hydraHome, { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(stubBinDir, { recursive: true });

  const stubClaude = path.join(stubBinDir, 'claude');
  fs.writeFileSync(stubClaude, '#!/bin/sh\nexec tail -f /dev/null\n', 'utf-8');
  fs.chmodSync(stubClaude, 0o755);

  const childEnv = {
    ...process.env,
    HOME: homeDir,
    HYDRA_HOME: hydraHome,
    HYDRA_CONFIG_PATH: path.join(hydraHome, 'config.json'),
    HYDRA_TMUX_SOCKET: missingSocket,
    PATH: `${stubBinDir}${path.delimiter}${process.env.PATH || ''}`,
  };

  const result = spawnSync(process.execPath, [
    cliEntry,
    'copilot',
    'create',
    '--workdir',
    workdir,
    '--agent',
    'claude',
    '--session',
    'logging-e2e-fail',
  ], {
    cwd: workdir,
    env: childEnv,
    encoding: 'utf-8',
  });

  assert.notEqual(result.status, 0, 'copilot create should fail with an invalid tmux socket');

  const logPath = path.join(hydraHome, 'logs', 'hydra.log');
  assert.ok(fs.existsSync(logPath), `Hydra log should exist at ${logPath}`);
  const raw = fs.readFileSync(logPath, 'utf-8');
  assert.doesNotMatch(raw, /"scope":"cli.start"/, 'default info logs should not include debug CLI startup noise');
  assert.match(raw, /"scope":"session.createCopilot"/, 'log should include copilot creation context');
  assert.match(raw, /"scope":"tmux.createSession"/, 'log should include tmux create context');
  assert.match(raw, /"scope":"exec.failure"/, 'log should include failed shell command');
  assert.match(raw, /logging-e2e-fail/, 'log should include session name');
  assert.match(raw, /hydra-log-missing-/, 'log should include failing socket path context');

  console.log('loggingCliE2eSmoke: ok');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
