/**
 * Smoke test: Hydra CLI compatibility contract.
 *
 * Run: node out/smoke/cliContractSmoke.js
 */

import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT_OK, EXIT_VALIDATION } from '../cli/output';

const cliPath = path.resolve(__dirname, '..', 'cli', 'index.js');

interface TestContext {
  tmp: string;
  home: string;
  hydraHome: string;
  configPath: string;
  env: Record<string, string | undefined>;
}

interface JsonError {
  error: {
    code: number;
    message: string;
    retryable: boolean;
    hint?: string;
  };
}

function setupContext(label: string): TestContext {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `hydra-cli-contract-${label}-`));
  const home = path.join(tmp, 'home');
  const hydraHome = path.join(tmp, 'hydra');
  const configPath = path.join(hydraHome, 'config.json');
  fs.mkdirSync(home, { recursive: true });

  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HYDRA_HOME: hydraHome,
    HYDRA_CONFIG_PATH: configPath,
    HYDRA_TMUX_SOCKET: `hydra-cli-contract-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    HYDRA_TELEMETRY: '0',
  };

  return { tmp, home, hydraHome, configPath, env };
}

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  cwd?: string,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function assertSuccess(proc: SpawnSyncReturns<string>, label: string): void {
  assert.equal(
    proc.status,
    EXIT_OK,
    `${label} should exit 0\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`,
  );
}

function assertOutputContains(proc: SpawnSyncReturns<string>, needle: string, label: string): void {
  const merged = `${proc.stdout}\n${proc.stderr}`;
  assert.match(merged, new RegExp(escapeRegExp(needle)), `${label} should contain ${needle}`);
}

function parseStdoutJson<T>(proc: SpawnSyncReturns<string>, label: string): T {
  assertSuccess(proc, label);
  assert.equal(proc.stderr.trim(), '', `${label} should not write stderr`);
  return JSON.parse(proc.stdout) as T;
}

function parseStderrJson<T>(proc: SpawnSyncReturns<string>, label: string): T {
  assert.ok(proc.status !== 0, `${label} should fail`);
  assert.equal(proc.stdout.trim(), '', `${label} should not write stdout`);
  return JSON.parse(proc.stderr) as T;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertNoStateHelpProbe(
  args: string[],
  expected: string,
  baseEnv: Record<string, string | undefined>,
): void {
  const env = {
    ...baseEnv,
    // Help probes must not rely on tmux, git, or other PATH executables.
    PATH: '',
  };
  const proc = runCli(args, env);
  const label = `hydra ${args.join(' ')}`;
  assertSuccess(proc, label);
  assertOutputContains(proc, expected, label);
}

function assertHelpProbes(baseEnv: Record<string, string | undefined>): void {
  const probes: Array<{ args: string[]; expected: string }> = [
    { args: ['--help'], expected: 'Usage: hydra [options] [command]' },
    { args: ['--help'], expected: 'CLI for managing Hydra copilots and workers' },
    { args: ['help'], expected: 'Usage: hydra [options] [command]' },
    { args: ['worker', 'create', '--help'], expected: 'Usage: hydra worker create [options]' },
    { args: ['worker', 'delete', '--help'], expected: 'Usage: hydra worker delete [options] <session>' },
    { args: ['worker', 'logs', '--help'], expected: 'Usage: hydra worker logs [options] <session>' },
    { args: ['worker', 'send', '--help'], expected: 'Usage: hydra worker send [options] <session> <message>' },
    { args: ['copilot', 'create', '--help'], expected: 'Usage: hydra copilot create [options]' },
    { args: ['copilot', 'restore', '--help'], expected: 'Usage: hydra copilot restore [options] <session>' },
    { args: ['copilot', 'logs', '--help'], expected: 'Usage: hydra copilot logs [options] <session>' },
    { args: ['copilot', 'send', '--help'], expected: 'Usage: hydra copilot send [options] <session> <message>' },
    { args: ['config', 'get', '--help'], expected: 'Usage: hydra config get [options] <key>' },
  ];

  for (const probe of probes) {
    assertNoStateHelpProbe(probe.args, probe.expected, baseEnv);
  }

  const version = runCli(['--version'], { ...baseEnv, PATH: '' });
  assertSuccess(version, 'hydra --version');
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/, 'hydra --version should print package version');
}

function assertJsonContracts(ctx: TestContext): void {
  const config = parseStdoutJson<{
    status: string;
    key: string;
    value: string;
    source: string;
    path: string;
  }>(
    runCli(['config', 'get', 'default-agent', '--json'], ctx.env),
    'hydra config get default-agent --json',
  );
  assert.equal(config.status, 'ok');
  assert.equal(config.key, 'default-agent');
  assert.equal(config.value, 'claude');
  assert.equal(config.source, 'fallback');
  assert.equal(config.path, ctx.configPath);

  const pipedConfig = parseStdoutJson<typeof config>(
    runCli(['config', 'get', 'default-agent'], ctx.env),
    'hydra config get default-agent with piped stdout',
  );
  assert.deepEqual(pipedConfig, config, 'piped stdout should auto-enable JSON output');

  const list = parseStdoutJson<{ copilots: unknown[]; workers: unknown[]; count: number }>(
    runCli(['list', '--json'], ctx.env),
    'hydra list --json',
  );
  assert.ok(Array.isArray(list.copilots), 'list.copilots must be an array');
  assert.ok(Array.isArray(list.workers), 'list.workers must be an array');
  assert.equal(list.count, list.copilots.length + list.workers.length, 'list.count');
}

function assertErrorContracts(ctx: TestContext): void {
  const invalidConfig = runCli(['config', 'set', 'default-agent', 'codxe', '--json'], ctx.env);
  assert.equal(invalidConfig.status, EXIT_VALIDATION, 'invalid default-agent exit code');
  const invalidConfigError = parseStderrJson<JsonError>(invalidConfig, 'invalid default-agent');
  assert.equal(invalidConfigError.error.code, EXIT_VALIDATION);
  assert.match(invalidConfigError.error.message, /Invalid default agent "codxe"/);
  assert.equal(invalidConfigError.error.retryable, false);

  const missingBranch = runCli(['worker', 'create', '--repo', '.'], ctx.env);
  assert.equal(missingBranch.status, EXIT_VALIDATION, 'worker create missing branch exit code');
  const missingBranchError = parseStderrJson<JsonError>(missingBranch, 'worker create missing branch');
  assert.equal(missingBranchError.error.code, EXIT_VALIDATION);
  assert.equal(missingBranchError.error.message, '--branch is required when using --repo.');
  assert.equal(missingBranchError.error.retryable, false);
}

function main(): void {
  if (!fs.existsSync(cliPath)) {
    console.log(`cliContractSmoke: skipped (CLI not built at ${cliPath})`);
    return;
  }

  const helpCtx = setupContext('help');
  try {
    assertHelpProbes(helpCtx.env);
  } finally {
    fs.rmSync(helpCtx.tmp, { recursive: true, force: true });
  }

  const ctx = setupContext('json');
  try {
    assertJsonContracts(ctx);
    assertErrorContracts(ctx);
    console.log('cliContractSmoke: ok');
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

main();
