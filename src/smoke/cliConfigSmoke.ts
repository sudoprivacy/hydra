/**
 * Smoke test: CLI config defaults for worker/copilot agent selection.
 *
 * Run: node out/smoke/cliConfigSmoke.js
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT_VALIDATION } from '../cli/output';

const cliPath = path.resolve(__dirname, '..', 'cli', 'index.js');

interface ConfigValueJson {
  status: string;
  key: string;
  value: string;
  source: string;
  path: string;
}

function runCli(args: string[], env: Record<string, string | undefined>): string {
  return execFileSync('node', [cliPath, ...args], {
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function main(): void {
  if (!fs.existsSync(cliPath)) {
    console.log(`cliConfigSmoke: skipped (CLI not built at ${cliPath})`);
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-cli-config-'));
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
    HYDRA_TELEMETRY: '0',
  };

  try {
    const fallbackOut = runCli(['config', 'get', 'default-agent', '--json'], env);
    const fallback = JSON.parse(fallbackOut) as ConfigValueJson;
    assert.equal(fallback.status, 'ok');
    assert.equal(fallback.key, 'default-agent');
    assert.equal(fallback.value, 'claude');
    assert.equal(fallback.source, 'fallback');
    assert.equal(fallback.path, configPath);

    const setOut = runCli(['config', 'set', 'default-agent', 'codex', '--json'], env);
    const set = JSON.parse(setOut) as ConfigValueJson;
    assert.equal(set.status, 'updated');
    assert.equal(set.value, 'codex');
    assert.equal(set.source, 'configured');
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf-8')).defaultAgent, 'codex');

    const getOut = runCli(['config', 'get', 'defaultAgent', '--json'], env);
    const get = JSON.parse(getOut) as ConfigValueJson;
    assert.equal(get.status, 'ok');
    assert.equal(get.value, 'codex');
    assert.equal(get.source, 'configured');

    const listOut = runCli(['config', 'list', '--json'], env);
    const list = JSON.parse(listOut) as {
      status: string;
      config: { defaultAgent: { value: string; source: string } };
    };
    assert.equal(list.status, 'ok');
    assert.equal(list.config.defaultAgent.value, 'codex');
    assert.equal(list.config.defaultAgent.source, 'configured');

    const invalid = spawnSync('node', [cliPath, 'config', 'set', 'default-agent', 'codxe', '--json'], {
      env,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(invalid.status, EXIT_VALIDATION);
    const invalidError = JSON.parse(invalid.stderr) as { error: { message: string } };
    assert.match(invalidError.error.message, /Invalid default agent "codxe"/);

    const unsetOut = runCli(['config', 'unset', 'default-agent', '--json'], env);
    const unset = JSON.parse(unsetOut) as ConfigValueJson;
    assert.equal(unset.status, 'updated');
    assert.equal(unset.value, 'claude');
    assert.equal(unset.source, 'fallback');
    assert.equal('defaultAgent' in JSON.parse(fs.readFileSync(configPath, 'utf-8')), false);

    console.log('cliConfigSmoke: ok');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
