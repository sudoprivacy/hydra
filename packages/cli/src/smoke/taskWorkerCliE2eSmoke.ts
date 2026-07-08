import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const cliPath = path.resolve(__dirname, '..', 'cli', 'index.js');

function tmuxAvailable(): boolean {
  const result = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
  return result.status === 0;
}

function run(
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string,
  expectSuccess = true,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (expectSuccess && result.status !== 0) {
    throw new Error(
      `Command failed: hydra ${args.join(' ')}\nstatus=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
  };
}

function runJson<T>(args: string[], env: Record<string, string | undefined>, cwd: string): T {
  const result = run(['--json', ...args], env, cwd);
  return JSON.parse(result.stdout) as T;
}

function runGit(repoRoot: string, args: string[], env: Record<string, string | undefined>): string {
  return execFileSync('git', args, { cwd: repoRoot, env, encoding: 'utf-8' }).trim();
}

function localBranchListed(repoRoot: string, branchName: string, env: Record<string, string | undefined>): boolean {
  return runGit(repoRoot, ['branch', '--list', branchName], env)
    .split(/\r?\n/)
    .map(line => line.replace(/^[*+]\s*/, '').trim())
    .includes(branchName);
}

function writeExecutable(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  fs.chmodSync(filePath, 0o755);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createRepo(repoRoot: string, env: Record<string, string | undefined>): void {
  fs.mkdirSync(repoRoot, { recursive: true });
  runGit(repoRoot, ['init', '-b', 'main'], env);
  runGit(repoRoot, ['config', 'user.email', 'hydra@example.com'], env);
  runGit(repoRoot, ['config', 'user.name', 'Hydra Smoke'], env);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'initial\n', 'utf-8');
  runGit(repoRoot, ['add', 'README.md'], env);
  runGit(repoRoot, ['commit', '-m', 'initial'], env);
}

function readSessions(hydraHome: string): {
  workers?: Record<string, {
    source?: string;
    repoRoot?: string | null;
    branch?: string | null;
    workdir?: string;
    managedWorkdir?: boolean;
    status?: string;
  }>;
} {
  return JSON.parse(fs.readFileSync(path.join(hydraHome, 'sessions.json'), 'utf-8'));
}

function canonicalFsPath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function assertSameFsPath(actual: string, expected: string, message: string): void {
  assert.equal(canonicalFsPath(actual), canonicalFsPath(expected), message);
}

function killTmuxServer(socket: string): void {
  spawnSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
}

async function main(): Promise<void> {
  if (!tmuxAvailable()) {
    console.log('taskWorkerCliE2eSmoke: skipped (tmux not on PATH)');
    return;
  }
  if (!fs.existsSync(cliPath)) {
    console.log(`taskWorkerCliE2eSmoke: skipped (CLI not built at ${cliPath})`);
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-task-cli-e2e-'));
  const home = path.join(root, 'home');
  const hydraHome = path.join(root, 'hydra');
  const configPath = path.join(root, 'config.json');
  const fakeAgentLog = path.join(root, 'fake-agent.log');
  const fakeAgent = path.join(root, 'bin', 'fake-agent');
  const tmuxSocket = path.join(root, 'tmux.sock');
  const nonGitDir = path.join(root, 'plain-folder');
  const explicitTaskDir = path.join(root, 'explicit-task');
  const repoRoot = path.join(root, 'repo');

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(hydraHome, { recursive: true });
  fs.mkdirSync(nonGitDir, { recursive: true });
  fs.mkdirSync(explicitTaskDir, { recursive: true });

  writeExecutable(fakeAgent, [
    '#!/bin/sh',
    `LOG=${JSON.stringify(fakeAgentLog)}`,
    'printf "START cwd=%s\\n" "$PWD" >> "$LOG"',
    'while IFS= read -r line; do',
    '  printf "INPUT cwd=%s line=%s\\n" "$PWD" "$line" >> "$LOG"',
    '  printf "fake-agent:%s\\n" "$line"',
    'done',
    '',
  ].join('\n'));

  fs.writeFileSync(configPath, JSON.stringify({
    defaultAgent: 'custom',
    agentCommands: {
      custom: fakeAgent,
    },
  }, null, 2));

  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HYDRA_HOME: hydraHome,
    HYDRA_CONFIG_PATH: configPath,
    HYDRA_TMUX_SOCKET: tmuxSocket,
    HYDRA_TELEMETRY: '0',
  };

  try {
    createRepo(repoRoot, env);

    const missingBranch = run(['--json', 'worker', 'create'], env, repoRoot, false);
    assert.equal(missingBranch.status, 2, 'git repo default create should be a validation error');
    const missingBranchError = JSON.parse(missingBranch.stderr) as { error: { message: string } };
    assert.match(missingBranchError.error.message, /--branch is required/, 'missing branch error should guide code worker creation');

    const defaultTask = runJson<{
      status: string;
      type: string;
      name: string;
      session: string;
      workdir: string;
      managedWorkdir: boolean;
    }>(['worker', 'create', '--task', 'default task prompt'], env, nonGitDir);
    assert.equal(defaultTask.status, 'created');
    assert.equal(defaultTask.type, 'task');
    assert.equal(defaultTask.name, path.basename(nonGitDir));
    assertSameFsPath(defaultTask.workdir, nonGitDir, 'default task should use current non-git directory');
    assert.equal(defaultTask.managedWorkdir, false);

    let sessions = readSessions(hydraHome);
    assert.equal(sessions.workers?.[defaultTask.session]?.source, 'directory');
    assert.equal(sessions.workers?.[defaultTask.session]?.branch, null);
    assert.equal(sessions.workers?.[defaultTask.session]?.repoRoot, null);

    const listAfterDefault = runJson<{
      workers: Array<{ session: string; type: string; name: string; managedWorkdir: boolean }>;
    }>(['list'], env, root);
    const listedDefault = listAfterDefault.workers.find(worker => worker.session === defaultTask.session);
    assert.equal(listedDefault?.type, 'task');
    assert.equal(listedDefault?.managedWorkdir, false);

    const sendResult = runJson<{ status: string }>([
      'worker', 'send', defaultTask.session, 'follow-up from e2e',
    ], env, root);
    assert.equal(sendResult.status, 'sent');
    await sleep(300);
    const logs = runJson<{ output: string }>([
      'worker', 'logs', defaultTask.session, '--lines', '80',
    ], env, root);
    assert.match(logs.output, /follow-up from e2e/, 'worker logs should include sent follow-up');

    const stopResult = runJson<{ status: string }>(['worker', 'stop', defaultTask.session], env, root);
    assert.equal(stopResult.status, 'stopped');
    sessions = readSessions(hydraHome);
    assert.equal(sessions.workers?.[defaultTask.session]?.status, 'stopped');

    const startResult = runJson<{ status: string; session: string; workdir: string }>([
      'worker', 'start', defaultTask.session,
    ], env, root);
    assert.equal(startResult.status, 'started');
    assertSameFsPath(startResult.workdir, nonGitDir, 'started task should use saved workdir');

    const unmanagedDeleteFiles = run([
      '--json', 'worker', 'delete', defaultTask.session, '--delete-files',
    ], env, root, false);
    assert.equal(unmanagedDeleteFiles.status, 2, 'unmanaged task delete-files should be validation error');
    assert.ok(fs.existsSync(nonGitDir), 'unmanaged task directory must survive rejected delete-files');

    const deleteDefault = runJson<{ status: string }>(['worker', 'delete', defaultTask.session], env, root);
    assert.equal(deleteDefault.status, 'deleted');
    assert.ok(fs.existsSync(nonGitDir), 'unmanaged task directory must survive normal delete');

    const explicitTask = runJson<{
      type: string;
      session: string;
      name: string;
      workdir: string;
      managedWorkdir: boolean;
    }>([
      'worker', 'create', '--dir', explicitTaskDir, '--name', 'explicit-task', '--task', 'explicit prompt',
    ], env, repoRoot);
    assert.equal(explicitTask.type, 'task');
    assert.equal(explicitTask.name, 'explicit-task');
    assertSameFsPath(explicitTask.workdir, explicitTaskDir, 'explicit task should use --dir path');
    assert.equal(explicitTask.managedWorkdir, false);

    const deleteExplicit = runJson<{ status: string }>(['worker', 'delete', explicitTask.session], env, root);
    assert.equal(deleteExplicit.status, 'deleted');
    assert.ok(fs.existsSync(explicitTaskDir), 'explicit task directory should survive delete before restore');

    const restoredExplicit = runJson<{
      status: string;
      type: string;
      workerType: string;
      session: string;
      name: string;
      workdir: string;
    }>(['archive', 'restore', explicitTask.session], env, root);
    assert.equal(restoredExplicit.status, 'restored');
    assert.equal(restoredExplicit.type, 'worker');
    assert.equal(restoredExplicit.workerType, 'task');
    assert.equal(restoredExplicit.session, explicitTask.session);
    assert.equal(restoredExplicit.name, 'explicit-task');
    assertSameFsPath(restoredExplicit.workdir, explicitTaskDir, 'restored explicit task should use original --dir path');

    sessions = readSessions(hydraHome);
    assert.equal(sessions.workers?.[explicitTask.session]?.source, 'directory');
    assert.equal(sessions.workers?.[explicitTask.session]?.managedWorkdir, false);

    const deleteRestoredExplicit = runJson<{ status: string }>(['worker', 'delete', explicitTask.session], env, root);
    assert.equal(deleteRestoredExplicit.status, 'deleted');
    assert.ok(fs.existsSync(explicitTaskDir), 'explicit task directory should survive delete after restore');

    const managedTask = runJson<{
      type: string;
      session: string;
      workdir: string;
      managedWorkdir: boolean;
    }>([
      'worker', 'create', '--temp', '--name', 'managed-e2e', '--task', 'managed prompt',
    ], env, root);
    assert.equal(managedTask.type, 'task');
    assert.equal(managedTask.managedWorkdir, true);
    assert.equal(managedTask.workdir, path.join(hydraHome, 'tasks', 'managed-e2e'));
    assert.ok(fs.existsSync(managedTask.workdir), 'managed task workdir should exist');

    const managedKeep = runJson<{ status: string }>(['worker', 'delete', managedTask.session], env, root);
    assert.equal(managedKeep.status, 'deleted');
    assert.ok(fs.existsSync(managedTask.workdir), 'managed task workdir should survive default delete');

    const managedTaskForDelete = runJson<{
      session: string;
      workdir: string;
    }>([
      'worker', 'create', '--temp', '--name', 'managed-delete-e2e',
    ], env, root);
    assert.ok(fs.existsSync(managedTaskForDelete.workdir), 'managed delete workdir should exist before delete');
    const managedDelete = runJson<{ status: string; deleteFiles: boolean }>([
      'worker', 'delete', managedTaskForDelete.session, '--delete-files',
    ], env, root);
    assert.equal(managedDelete.status, 'deleted');
    assert.equal(managedDelete.deleteFiles, true);
    assert.equal(fs.existsSync(managedTaskForDelete.workdir), false, 'managed delete-files should remove workdir');

    const codeWorker = runJson<{
      status: string;
      type: string;
      session: string;
      branch: string;
      workdir: string;
    }>([
      'worker', 'create', '--branch', 'feat/e2e-code-worker', '--task', 'code worker prompt',
    ], env, repoRoot);
    assert.equal(codeWorker.status, 'created');
    assert.equal(codeWorker.type, 'code');
    assert.equal(codeWorker.branch, 'feat/e2e-code-worker');
    assert.ok(fs.existsSync(codeWorker.workdir), 'code worker worktree should exist');
    assert.equal(localBranchListed(repoRoot, 'feat/e2e-code-worker', env), true);

    sessions = readSessions(hydraHome);
    assert.equal(sessions.workers?.[codeWorker.session]?.source, 'repo');
    assertSameFsPath(sessions.workers?.[codeWorker.session]?.repoRoot || '', repoRoot, 'code worker should persist repo root');
    assert.equal(sessions.workers?.[codeWorker.session]?.branch, 'feat/e2e-code-worker');

    const codeDelete = runJson<{ status: string }>(['worker', 'delete', codeWorker.session], env, root);
    assert.equal(codeDelete.status, 'deleted');
    assert.equal(fs.existsSync(codeWorker.workdir), false, 'code worker delete should remove worktree');
    assert.equal(localBranchListed(repoRoot, 'feat/e2e-code-worker', env), false);

    console.log('taskWorkerCliE2eSmoke: ok');
  } finally {
    killTmuxServer(tmuxSocket);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
