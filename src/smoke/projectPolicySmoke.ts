/**
 * Smoke test: trusted project-level Hydra policy parsing and precedence.
 *
 * Run: node out/smoke/projectPolicySmoke.js
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  inspectProjectPolicy,
  resolveEffectiveProjectConfig,
} from '../core/projectPolicy';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function assertRejectsPolicy(anchorPath: string, message: RegExp): Promise<void> {
  await assert.rejects(
    () => resolveEffectiveProjectConfig({
      anchorPath,
      globalDefaultAgent: { agent: 'claude', source: 'fallback' },
    }),
    message,
  );
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-project-policy-'));
  const originalEnv = {
    HYDRA_HOME: process.env.HYDRA_HOME,
    HYDRA_CONFIG_PATH: process.env.HYDRA_CONFIG_PATH,
  };

  try {
    const home = path.join(tmp, 'home');
    const hydraHome = path.join(tmp, 'hydra-home');
    process.env.HYDRA_HOME = hydraHome;
    process.env.HYDRA_CONFIG_PATH = path.join(hydraHome, 'config.json');

    const project = path.join(tmp, 'project');
    const nested = path.join(project, 'src', 'feature');
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    writeJson(path.join(project, '.hydra', 'config.json'), {
      defaultAgent: 'codex',
      baseBranch: 'main',
      worker: {
        notifyCopilot: false,
        allowTaskWorkers: false,
      },
      notifications: {
        hooks: [{ command: 'notify-send done' }],
      },
    });

    const inspection = await inspectProjectPolicy(nested);
    assert.equal(inspection.found, true);
    assert.equal(inspection.projectRoot, project);
    assert.equal(inspection.policy.defaultAgent, 'codex');
    assert.equal(inspection.policy.baseBranch, 'main');
    assert.equal(inspection.policy.worker?.notifyCopilot, false);
    assert.equal(inspection.policy.worker?.allowTaskWorkers, false);
    assert.equal(inspection.requiresTrust.length, 1);
    assert.equal(inspection.requiresTrust[0].field, 'notifications.hooks');
    assert.equal(inspection.requiresTrust[0].count, 1);
    assert.ok(inspection.warnings.some(warning => warning.code === 'policy-hooks-doctor-only'));
    assert.ok(inspection.warnings.some(warning => warning.code === 'policy-allow-task-workers-preview'));
    assert.equal(inspection.blockers.length, 0);

    const projectEffective = await resolveEffectiveProjectConfig({
      anchorPath: nested,
      globalDefaultAgent: { agent: 'gemini', source: 'configured' },
    });
    assert.deepEqual(projectEffective.effective.defaultAgent, { value: 'codex', source: 'project' });
    assert.deepEqual(projectEffective.effective.baseBranch, { value: 'main', source: 'project' });
    assert.deepEqual(projectEffective.effective.worker.notifyCopilot, { value: false, source: 'project' });
    assert.deepEqual(projectEffective.effective.worker.allowTaskWorkers, { value: false, source: 'project' });

    const cliEffective = await resolveEffectiveProjectConfig({
      anchorPath: nested,
      globalDefaultAgent: { agent: 'gemini', source: 'configured' },
      cliDefaultAgent: 'hydra-smoke-stub-agent',
      cliBaseBranch: 'release',
      cliNotifyCopilot: true,
    });
    assert.deepEqual(cliEffective.effective.defaultAgent, { value: 'hydra-smoke-stub-agent', source: 'cli' });
    assert.deepEqual(cliEffective.effective.baseBranch, { value: 'release', source: 'cli' });
    assert.deepEqual(cliEffective.effective.worker.notifyCopilot, { value: true, source: 'cli' });

    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    const globalEffective = await resolveEffectiveProjectConfig({
      anchorPath: outside,
      globalDefaultAgent: { agent: 'gemini', source: 'configured' },
    });
    assert.equal(globalEffective.projectPolicy.found, false);
    assert.deepEqual(globalEffective.effective.defaultAgent, { value: 'gemini', source: 'global' });
    assert.deepEqual(globalEffective.effective.baseBranch, { value: null, source: 'fallback' });
    assert.deepEqual(globalEffective.effective.worker.notifyCopilot, { value: true, source: 'fallback' });
    assert.deepEqual(globalEffective.effective.worker.allowTaskWorkers, { value: true, source: 'fallback' });

    const parentPolicy = path.join(tmp, '.hydra', 'config.json');
    writeJson(parentPolicy, { defaultAgent: 'gemini' });
    const repoWithoutPolicy = path.join(tmp, 'repo-without-policy');
    const repoNested = path.join(repoWithoutPolicy, 'src');
    fs.mkdirSync(path.join(repoWithoutPolicy, '.git'), { recursive: true });
    fs.mkdirSync(repoNested, { recursive: true });
    const stoppedAtGitRoot = await inspectProjectPolicy(repoNested);
    assert.equal(stoppedAtGitRoot.found, false);
    assert.equal(stoppedAtGitRoot.searchStop, repoWithoutPolicy);
    fs.rmSync(path.dirname(parentPolicy), { recursive: true, force: true });

    const globalConfigPath = path.join(home, '.hydra', 'config.json');
    process.env.HYDRA_HOME = path.join(home, '.hydra');
    process.env.HYDRA_CONFIG_PATH = globalConfigPath;
    writeJson(globalConfigPath, { defaultAgent: 'codex' });
    const homeNested = path.join(home, 'nested');
    fs.mkdirSync(homeNested, { recursive: true });
    const ignoredGlobalCollision = await inspectProjectPolicy(homeNested);
    assert.equal(ignoredGlobalCollision.found, false);

    const invalidJsonProject = path.join(tmp, 'invalid-json');
    fs.mkdirSync(path.join(invalidJsonProject, '.hydra'), { recursive: true });
    fs.writeFileSync(path.join(invalidJsonProject, '.hydra', 'config.json'), '{', 'utf-8');
    const invalidJson = await inspectProjectPolicy(invalidJsonProject);
    assert.equal(invalidJson.blockers[0].code, 'policy-invalid-json');
    await assertRejectsPolicy(invalidJsonProject, /Project Hydra policy is invalid/);

    const invalidAgentProject = path.join(tmp, 'invalid-agent');
    writeJson(path.join(invalidAgentProject, '.hydra', 'config.json'), { defaultAgent: 'codxe' });
    const invalidAgent = await inspectProjectPolicy(invalidAgentProject);
    assert.equal(invalidAgent.blockers[0].code, 'policy-invalid-agent');

    const invalidWorkerProject = path.join(tmp, 'invalid-worker');
    writeJson(path.join(invalidWorkerProject, '.hydra', 'config.json'), { worker: [] });
    const invalidWorker = await inspectProjectPolicy(invalidWorkerProject);
    assert.equal(invalidWorker.blockers[0].code, 'policy-invalid-worker');

    const unknownKeyProject = path.join(tmp, 'unknown-key');
    writeJson(path.join(unknownKeyProject, '.hydra', 'config.json'), {
      defaultAgent: 'codex',
      typoTopLevel: true,
      worker: { typoNested: true },
      notifications: { typoHook: true },
    });
    const unknownKey = await inspectProjectPolicy(unknownKeyProject);
    assert.equal(unknownKey.blockers.length, 0);
    assert.equal(unknownKey.warnings.filter(warning => warning.code === 'policy-unknown-key').length, 3);

    const symlinkProject = path.join(tmp, 'symlink-policy');
    fs.mkdirSync(path.join(symlinkProject, '.hydra'), { recursive: true });
    const symlinkTarget = path.join(tmp, 'symlink-target.json');
    fs.writeFileSync(symlinkTarget, '{}\n', 'utf-8');
    try {
      fs.symlinkSync(symlinkTarget, path.join(symlinkProject, '.hydra', 'config.json'));
      const symlinkPolicy = await inspectProjectPolicy(symlinkProject);
      assert.equal(symlinkPolicy.blockers[0].code, 'policy-symlink');
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== 'EPERM') {
        throw error;
      }
    }

    console.log('projectPolicySmoke: ok');
  } finally {
    if (originalEnv.HYDRA_HOME === undefined) {
      delete process.env.HYDRA_HOME;
    } else {
      process.env.HYDRA_HOME = originalEnv.HYDRA_HOME;
    }
    if (originalEnv.HYDRA_CONFIG_PATH === undefined) {
      delete process.env.HYDRA_CONFIG_PATH;
    } else {
      process.env.HYDRA_CONFIG_PATH = originalEnv.HYDRA_CONFIG_PATH;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

void main();
