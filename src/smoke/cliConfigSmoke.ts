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

function runCli(args: string[], env: Record<string, string | undefined>, cwd?: string): string {
  return execFileSync('node', [cliPath, ...args], {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runGit(args: string[], cwd: string, env: Record<string, string | undefined>): void {
  execFileSync('git', args, {
    cwd,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
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

    const project = path.join(tmp, 'project');
    fs.mkdirSync(path.join(project, '.hydra'), { recursive: true });
    runGit(['init', '-b', 'main'], project, env);
    fs.writeFileSync(path.join(project, 'README.md'), '# Project\n', 'utf-8');
    runGit(['add', 'README.md'], project, env);
    runGit(['-c', 'user.name=Hydra Smoke', '-c', 'user.email=hydra-smoke@example.com', 'commit', '-m', 'initial'], project, env);
    fs.writeFileSync(
      path.join(project, '.hydra', 'config.json'),
      `${JSON.stringify({
        defaultAgent: 'gemini',
        baseBranch: 'main',
        worker: { notifyCopilot: false },
        notifications: { hooks: [{ command: 'echo done' }] },
      }, null, 2)}\n`,
      'utf-8',
    );

    const listOut = runCli(['config', 'list', '--json'], env, project);
    const list = JSON.parse(listOut) as {
      status: string;
      path: string;
      config: { defaultAgent: { value: string; source: string } };
      projectPolicy: { found: boolean; path: string | null; requiresTrust: unknown[] };
      effective: {
        defaultAgent: { value: string; source: string };
        baseBranch: { value: string | null; source: string };
        worker: { notifyCopilot: { value: boolean; source: string } };
      };
    };
    assert.equal(list.status, 'ok');
    assert.equal(list.path, configPath);
    assert.equal(list.config.defaultAgent.value, 'codex');
    assert.equal(list.config.defaultAgent.source, 'configured');
    assert.equal(list.projectPolicy.found, true);
    assert.equal(list.projectPolicy.path, fs.realpathSync(path.join(project, '.hydra', 'config.json')));
    assert.equal(list.projectPolicy.requiresTrust.length, 1);
    assert.deepEqual(list.effective.defaultAgent, { value: 'gemini', source: 'project' });
    assert.deepEqual(list.effective.baseBranch, { value: 'main', source: 'project' });
    assert.deepEqual(list.effective.worker.notifyCopilot, { value: false, source: 'project' });

    const doctorOut = runCli(['config', 'doctor', '--path', project, '--json'], env);
    const doctor = JSON.parse(doctorOut) as {
      status: string;
      path: string;
      projectPolicy: { found: boolean; blockers: unknown[]; warnings: unknown[] };
      effective: { defaultAgent: { value: string; source: string } };
      requiresTrust: unknown[];
      blockers: unknown[];
      warnings: unknown[];
    };
    assert.equal(doctor.status, 'ok');
    assert.equal(doctor.path, configPath);
    assert.equal(doctor.projectPolicy.found, true);
    assert.equal(doctor.blockers.length, 0);
    assert.equal(doctor.requiresTrust.length, 1);
    assert.equal(doctor.warnings.length, 1);
    assert.deepEqual(doctor.effective.defaultAgent, { value: 'gemini', source: 'project' });

    const invalidProject = path.join(tmp, 'invalid-project');
    fs.mkdirSync(path.join(invalidProject, '.hydra'), { recursive: true });
    fs.writeFileSync(path.join(invalidProject, '.hydra', 'config.json'), '{', 'utf-8');
    const invalidDoctor = JSON.parse(runCli(['config', 'doctor', '--path', invalidProject, '--json'], env)) as {
      status: string;
      effective: null;
      blockers: Array<{ code: string }>;
    };
    assert.equal(invalidDoctor.status, 'blocked');
    assert.equal(invalidDoctor.effective, null);
    assert.equal(invalidDoctor.blockers[0].code, 'policy-invalid-json');

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
