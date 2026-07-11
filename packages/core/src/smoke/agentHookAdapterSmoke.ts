import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getAgentHookDiagnostic,
  getAgentHookReceiptPath,
  installAgentHooks,
  listAgentHookDiagnostics,
  removeAgentHooks,
  type AgentHookInstallRequest,
} from '../core/agentHookAdapter';

interface TestContext {
  root: string;
  home: string;
  hydraHome: string;
  workdir: string;
}

function withContext<T>(fn: (ctx: TestContext) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-agent-hook-adapter-'));
  const home = path.join(root, 'home');
  const hydraHome = path.join(root, 'hydra');
  const workdir = path.join(root, 'workdir');
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HYDRA_HOME: process.env.HYDRA_HOME,
    HYDRA_CONFIG_PATH: process.env.HYDRA_CONFIG_PATH,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.HYDRA_HOME = hydraHome;
  process.env.HYDRA_CONFIG_PATH = path.join(hydraHome, 'config.json');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(hydraHome, { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });
  try {
    return fn({ root, home, hydraHome, workdir });
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testCapabilityDiagnostics(): void {
  const diagnostics = listAgentHookDiagnostics();
  assert.deepEqual(diagnostics.map(diagnostic => diagnostic.agentType), [
    'claude',
    'codex',
    'gemini',
    'antigravity',
    'sudocode',
    'custom',
  ]);
  assert.deepEqual(getAgentHookDiagnostic('claude').capabilities, {
    complete: 'hook',
    needsInput: 'hook',
    inputResolved: 'unsupported',
    aborted: 'unsupported',
    runtimeError: 'unsupported',
  });
  assert.equal(getAgentHookDiagnostic('codex').capabilities.needsInput, 'transcript');
  assert.equal(getAgentHookDiagnostic('codex').capabilities.inputResolved, 'transcript');
  assert.equal(getAgentHookDiagnostic('codex').capabilities.aborted, 'transcript');
  assert.equal(getAgentHookDiagnostic('sudocode').capabilities.complete, 'unsupported');
  assert.deepEqual(getAgentHookDiagnostic('unknown-agent'), {
    agentType: 'unknown-agent',
    adapter: 'custom',
    configScope: 'none',
    capabilities: {
      complete: 'unsupported',
      needsInput: 'unsupported',
      inputResolved: 'unsupported',
      aborted: 'unsupported',
      runtimeError: 'unsupported',
    },
  });
}

function testClaudeInstallAndRemovePreservesUserConfig(): void {
  withContext((ctx) => {
    const sessionName = 'repo_claude-safe-config';
    const configPath = path.join(ctx.workdir, '.claude', 'settings.json');
    const userConfig = {
      permissions: { allow: ['Read'] },
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'user-stop-hook' }] }],
        PermissionRequest: [],
        CustomEvent: [{ hooks: [{ type: 'command', command: 'user-custom-hook' }] }],
      },
      userFlag: true,
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(userConfig), 'utf-8');
    const request = createInstallRequest(ctx, 'claude', sessionName);

    const installed = installAgentHooks(request);
    assert.equal(installed.status, 'changed');
    const installedConfig = readJson<{
      permissions: typeof userConfig.permissions;
      userFlag: boolean;
      hooks: {
        Stop: unknown[];
        PermissionRequest: unknown[];
        PreToolUse: unknown[];
        CustomEvent: unknown[];
      };
    }>(configPath);
    assert.deepEqual(installedConfig.permissions, userConfig.permissions);
    assert.deepEqual(installedConfig.userFlag, userConfig.userFlag);
    assert.deepEqual(installedConfig.hooks.CustomEvent, userConfig.hooks.CustomEvent);
    assert.equal(installedConfig.hooks.Stop.length, 2);
    assert.equal(installedConfig.hooks.PermissionRequest.length, 1);
    assert.equal(installedConfig.hooks.PreToolUse.length, 1);

    const firstWrite = fs.readFileSync(configPath, 'utf-8');
    const secondInstall = installAgentHooks(request);
    assert.equal(secondInstall.status, 'unchanged');
    assert.equal(fs.readFileSync(configPath, 'utf-8'), firstWrite);
    assert.equal(fs.existsSync(getAgentHookReceiptPath(sessionName, 'claude')), true);
    assert.equal(fs.existsSync(request.completion!.path), true);
    if (process.platform !== 'win32') {
      assert.notEqual(fs.statSync(request.completion!.path).mode & 0o111, 0);
    }

    const removed = removeAgentHooks({
      agentType: 'claude',
      workdir: ctx.workdir,
      sessionName,
      completionScriptPath: request.completion!.path,
    });
    assert.equal(removed.status, 'changed');
    assert.deepEqual(readJson(configPath), userConfig);
    assert.equal(fs.existsSync(getAgentHookReceiptPath(sessionName, 'claude')), false);
    assert.deepEqual(findHydraArtifacts(path.dirname(configPath)), []);
  });
}

function testMalformedConfigurationFailsClosed(): void {
  withContext((ctx) => {
    const sessionName = 'repo_malformed-config';
    const configPath = path.join(ctx.workdir, '.claude', 'settings.json');
    const original = '{"hooks":[';
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, original, 'utf-8');
    const request = createInstallRequest(ctx, 'claude', sessionName);

    assert.throws(() => installAgentHooks(request), /is not valid JSON/);
    assert.equal(fs.readFileSync(configPath, 'utf-8'), original);
    assert.equal(fs.existsSync(request.completion!.path), false);
    assert.equal(fs.existsSync(getAgentHookReceiptPath(sessionName, 'claude')), false);
    assert.deepEqual(findHydraArtifacts(path.dirname(configPath)), []);
  });

  withContext((ctx) => {
    const sessionName = 'repo_invalid-hook-shape';
    const configPath = path.join(ctx.workdir, '.claude', 'settings.json');
    const original = '{"userFlag":true,"hooks":{"Stop":{"command":"user"}}}\n';
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, original, 'utf-8');
    const request = createInstallRequest(ctx, 'claude', sessionName);

    assert.throws(() => installAgentHooks(request), /non-array Stop hook/);
    assert.equal(fs.readFileSync(configPath, 'utf-8'), original);
    assert.equal(fs.existsSync(request.completion!.path), false);
    assert.equal(fs.existsSync(getAgentHookReceiptPath(sessionName, 'claude')), false);
  });
}

function testClaudeCompletionCanBeDisabledReversibly(): void {
  withContext((ctx) => {
    const sessionName = 'repo_claude-needs-only';
    const configPath = path.join(ctx.workdir, '.claude', 'settings.json');
    const original = { userFlag: 'keep' };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(original), 'utf-8');
    const request = createInstallRequest(ctx, 'claude', sessionName);

    installAgentHooks(request);
    installAgentHooks({ ...request, completion: undefined });
    const needsOnly = readJson<{
      userFlag: string;
      hooks: { Stop?: unknown[]; PermissionRequest: unknown[]; PreToolUse: unknown[] };
    }>(configPath);
    assert.equal(needsOnly.hooks.Stop, undefined);
    assert.equal(needsOnly.hooks.PermissionRequest.length, 1);
    assert.equal(needsOnly.hooks.PreToolUse.length, 1);

    removeAgentHooks({ agentType: 'claude', workdir: ctx.workdir, sessionName });
    assert.deepEqual(readJson(configPath), original);
  });
}

function testCodexTomlRemainsByteExact(): void {
  withContext((ctx) => {
    const sessionName = 'repo_codex-config';
    const codexDir = path.join(ctx.workdir, '.codex');
    const hooksPath = path.join(codexDir, 'hooks.json');
    const tomlPath = path.join(codexDir, 'config.toml');
    const toml = '# user config\n[features]\nhooks = false\nexperimental = true\n';
    const userHooks = { hooks: { Custom: [] }, userFlag: 'preserve-me' };
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(tomlPath, toml, 'utf-8');
    fs.writeFileSync(hooksPath, JSON.stringify(userHooks), 'utf-8');
    const request = createInstallRequest(ctx, 'codex', sessionName);

    installAgentHooks(request);
    assert.equal(fs.readFileSync(tomlPath, 'utf-8'), toml);
    const installed = readJson<{
      userFlag: string;
      hooks: {
        Custom: unknown[];
        Stop: Array<{ hooks: Array<{ command: string }> }>;
      };
    }>(hooksPath);
    assert.equal(installed.userFlag, userHooks.userFlag);
    assert.equal(installed.hooks.Stop.length, 1);
    assert.match(installed.hooks.Stop[0].hooks[0].command, /printf '\{\}'/);

    removeAgentHooks({
      agentType: 'codex',
      workdir: ctx.workdir,
      sessionName,
      completionScriptPath: request.completion!.path,
    });
    assert.equal(fs.readFileSync(tomlPath, 'utf-8'), toml);
    assert.deepEqual(readJson(hooksPath), userHooks);
  });
}

function testAntigravityGlobalEntryIsReversible(): void {
  withContext((ctx) => {
    const firstSession = 'task_antigravity-one';
    const secondSession = 'task_antigravity-two';
    const configPath = path.join(ctx.home, '.gemini', 'config', 'hooks.json');
    const reservedEntry = { Stop: [{ type: 'command', command: 'previous-hydra-command' }] };
    const userConfig = {
      userHook: { Stop: [{ type: 'command', command: 'user-command' }] },
      [`hydra-notify-${firstSession}`]: reservedEntry,
    };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(userConfig), 'utf-8');
    const first = createInstallRequest(ctx, 'antigravity', firstSession);
    const second = createInstallRequest(ctx, 'antigravity', secondSession);

    installAgentHooks(first);
    installAgentHooks(second);
    const installed = readJson(configPath);
    assert.deepEqual(installed.userHook, userConfig.userHook);
    assert.notDeepEqual(installed[`hydra-notify-${firstSession}`], reservedEntry);
    assert.ok(installed[`hydra-notify-${secondSession}`]);

    removeAgentHooks({
      agentType: 'antigravity',
      workdir: ctx.workdir,
      sessionName: firstSession,
      completionScriptPath: first.completion!.path,
    });
    const afterFirst = readJson(configPath);
    assert.deepEqual(afterFirst[`hydra-notify-${firstSession}`], reservedEntry);
    assert.ok(afterFirst[`hydra-notify-${secondSession}`]);

    removeAgentHooks({
      agentType: 'antigravity',
      workdir: ctx.workdir,
      sessionName: secondSession,
      completionScriptPath: second.completion!.path,
    });
    assert.deepEqual(readJson(configPath), userConfig);
    assert.deepEqual(findHydraArtifacts(path.dirname(configPath)), []);
  });
}

function testUnsupportedAgentDoesNotWrite(): void {
  withContext((ctx) => {
    const request = createInstallRequest(ctx, 'sudocode', 'task_sudocode');
    const result = installAgentHooks(request);
    assert.equal(result.status, 'unsupported');
    assert.deepEqual(result.configPaths, []);
    assert.equal(fs.existsSync(request.completion!.path), false);
  });
}

function testChangedGlobalHookFailsClosed(): void {
  withContext((ctx) => {
    const sessionName = 'task_antigravity-user-change';
    const configPath = path.join(ctx.home, '.gemini', 'config', 'hooks.json');
    const request = createInstallRequest(ctx, 'antigravity', sessionName);
    installAgentHooks(request);

    const config = readJson<Record<string, unknown>>(configPath);
    config[`hydra-notify-${sessionName}`] = { userChanged: true };
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
    const before = fs.readFileSync(configPath, 'utf-8');

    assert.throws(() => removeAgentHooks({
      agentType: 'antigravity',
      workdir: ctx.workdir,
      sessionName,
      completionScriptPath: request.completion!.path,
    }), /changed after Hydra installed it/);
    assert.equal(fs.readFileSync(configPath, 'utf-8'), before);
    assert.equal(fs.existsSync(getAgentHookReceiptPath(sessionName, 'antigravity')), true);
  });
}

function createInstallRequest(
  ctx: TestContext,
  agentType: string,
  sessionName: string,
): AgentHookInstallRequest {
  return {
    agentType,
    workdir: ctx.workdir,
    sessionName,
    completion: {
      path: path.join(ctx.hydraHome, 'hooks', `notify-${sessionName}.sh`),
      content: `#!/bin/sh\necho ${sessionName}\n`,
      mode: 0o755,
    },
  };
}

function readJson<T = Record<string, unknown>>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function findHydraArtifacts(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => name.includes('.hydra-lock') || name.endsWith('.tmp'));
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function main(): void {
  testCapabilityDiagnostics();
  testClaudeInstallAndRemovePreservesUserConfig();
  testMalformedConfigurationFailsClosed();
  testClaudeCompletionCanBeDisabledReversibly();
  testCodexTomlRemainsByteExact();
  testAntigravityGlobalEntryIsReversible();
  testUnsupportedAgentDoesNotWrite();
  testChangedGlobalHookFailsClosed();
  console.log('agentHookAdapterSmoke: ok');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}
