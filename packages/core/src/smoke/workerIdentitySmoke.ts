/**
 * Smoke test: stable worker identity, lifecycle epochs, aliases, and migration.
 *
 * Run: node packages/core/out/smoke/workerIdentitySmoke.js
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as coreGit from '../core/git';
import { CompletionCoordinator } from '../core/completionCoordinator';
import { CompletionJobStore } from '../core/completionJobStore';
import { EventLog } from '../core/events';
import { NotificationStore } from '../core/notifications';
import { lookupWorkerId, SessionManager, type WorkerInfo } from '../core/sessionManager';
import type {
  HydraRole,
  MultiplexerBackendCore,
  MultiplexerSession,
  SessionStatusInfo,
} from '../core/types';
import { WorkerLifecycleService } from '../core/workerLifecycleService';
import { WorkerRuntimeCoordinator } from '../core/workerRuntimeCoordinator';
import { WorkerRuntimeStateStore } from '../core/workerRuntimeState';
import { WorkerRuntimeStateStoreV2 } from '../core/workerRuntimeV2';

class IdentityBackend implements MultiplexerBackendCore {
  readonly type = 'tmux' as const;
  readonly displayName = 'identity-backend';
  readonly installHint = 'not needed';
  readonly sessions = new Set<string>();
  readonly roles = new Map<string, HydraRole>();
  readonly workdirs = new Map<string, string>();
  readonly agents = new Map<string, string>();
  readonly workerIds = new Map<string, number>();

  async isInstalled(): Promise<boolean> { return true; }
  async listSessions(): Promise<MultiplexerSession[]> {
    return [...this.sessions].map(name => ({ name, attached: false, windows: 1 }));
  }
  async createSession(sessionName: string, workdir: string): Promise<void> {
    this.sessions.add(sessionName);
    this.workdirs.set(sessionName, workdir);
  }
  async killSession(sessionName: string): Promise<void> { this.sessions.delete(sessionName); }
  async renameSession(oldName: string, newName: string): Promise<void> {
    this.sessions.delete(oldName);
    this.sessions.add(newName);
    moveMapValue(this.roles, oldName, newName);
    moveMapValue(this.workdirs, oldName, newName);
    moveMapValue(this.agents, oldName, newName);
    moveMapValue(this.workerIds, oldName, newName);
  }
  async hasSession(sessionName: string): Promise<boolean> { return this.sessions.has(sessionName); }
  async getSessionWorkdir(sessionName: string): Promise<string | undefined> { return this.workdirs.get(sessionName); }
  async setSessionWorkdir(sessionName: string, workdir: string): Promise<void> { this.workdirs.set(sessionName, workdir); }
  async getSessionRole(sessionName: string): Promise<HydraRole | undefined> { return this.roles.get(sessionName); }
  async setSessionRole(sessionName: string, role: HydraRole): Promise<void> { this.roles.set(sessionName, role); }
  async getSessionAgent(sessionName: string): Promise<string | undefined> { return this.agents.get(sessionName); }
  async setSessionAgent(sessionName: string, agent: string): Promise<void> { this.agents.set(sessionName, agent); }
  async getSessionWorkerId(sessionName: string): Promise<number | undefined> { return this.workerIds.get(sessionName); }
  async setSessionWorkerId(sessionName: string, workerId: number): Promise<void> { this.workerIds.set(sessionName, workerId); }
  async sendKeys(): Promise<void> {}
  async capturePane(): Promise<string> { return '⏵'; }
  async sendMessage(): Promise<void> {}
  async getSessionInfo(): Promise<SessionStatusInfo> { return { attached: false, lastActive: 0 }; }
  async getSessionPaneCount(): Promise<number> { return 1; }
  async getSessionPanePids(): Promise<string[]> { return []; }
  async splitPane(): Promise<void> {}
  async newWindow(): Promise<void> {}
  buildSessionName(repoName: string, slug: string): string { return `${repoName}_${slug}`; }
  sanitizeSessionName(name: string): string { return name.replace(/[^a-zA-Z0-9_-]+/g, '-'); }
}

interface TestContext {
  root: string;
  home: string;
  hydraHome: string;
  sessionsFile: string;
}

async function withContext(fn: (ctx: TestContext) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-worker-identity-'));
  const home = path.join(root, 'home');
  const hydraHome = path.join(root, 'hydra');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(hydraHome, { recursive: true });
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HYDRA_HOME: process.env.HYDRA_HOME,
    HYDRA_CONFIG_PATH: process.env.HYDRA_CONFIG_PATH,
    HYDRA_TELEMETRY: process.env.HYDRA_TELEMETRY,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.HYDRA_HOME = hydraHome;
  process.env.HYDRA_CONFIG_PATH = path.join(hydraHome, 'config.json');
  process.env.HYDRA_TELEMETRY = '0';
  try {
    await fn({ root, home, hydraHome, sessionsFile: path.join(hydraHome, 'sessions.json') });
  } finally {
    restoreEnv(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function worker(
  workdir: string,
  overrides: Partial<WorkerInfo> = {},
): WorkerInfo {
  const now = new Date().toISOString();
  return {
    source: 'directory',
    sessionName: 'worker-current',
    displayName: 'worker-current',
    workerId: 7,
    lifecycleEpoch: 'epoch-before-recreation',
    sessionAliases: ['worker-old'],
    repo: null,
    repoRoot: null,
    branch: null,
    slug: 'worker-current',
    status: 'stopped',
    attached: false,
    agent: 'claude',
    workdir,
    managedWorkdir: false,
    tmuxSession: 'worker-current',
    createdAt: now,
    lastSeenAt: now,
    sessionId: null,
    agentSessionFile: null,
    copilotSessionName: null,
    ...overrides,
  };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function testLegacyMigrationAndBackup(): Promise<void> {
  await withContext(async (ctx) => {
    const workdir = path.join(ctx.root, 'legacy-worker');
    fs.mkdirSync(workdir, { recursive: true });
    const legacy = worker(workdir);
    delete legacy.lifecycleEpoch;
    delete legacy.sessionAliases;
    const duplicateWorkdir = path.join(ctx.root, 'duplicate-worker');
    fs.mkdirSync(duplicateWorkdir, { recursive: true });
    const duplicate = worker(duplicateWorkdir, {
      sessionName: 'worker-duplicate',
      displayName: 'worker-duplicate',
      slug: 'worker-duplicate',
      tmuxSession: 'worker-duplicate',
    });
    delete duplicate.lifecycleEpoch;
    delete duplicate.sessionAliases;
    writeJson(ctx.sessionsFile, {
      copilots: {},
      workers: {
        [legacy.sessionName]: legacy,
        [duplicate.sessionName]: duplicate,
      },
      nextWorkerId: 8,
      updatedAt: new Date().toISOString(),
    });
    for (const [name, value] of Object.entries({
      'archive.json': { entries: [] },
      'worker-runtime-state.json': { version: 1, workers: {} },
      'worker-runtime-state-v2.json': { version: 2, workers: {}, processedSignalIds: {}, pendingCompatibilityClears: {} },
      'notifications.json': { version: 1, notifications: [] },
      'notifications-v2.json': { version: 2, notifications: [], signalReceipts: {}, tombstones: {}, pendingCompatibility: {} },
      'completion-jobs.json': { version: 1, jobs: [] },
    })) {
      writeJson(path.join(ctx.hydraHome, name), value);
    }

    const manager = new SessionManager(new IdentityBackend());
    const state = await manager.sync();
    assert.equal(state.workers[legacy.sessionName].lifecycleEpoch, 'legacy-worker-7');
    assert.deepEqual(state.workers[legacy.sessionName].sessionAliases, []);
    assert.equal(state.workers[duplicate.sessionName].workerId, 8);
    assert.notEqual(state.workers[duplicate.sessionName].lifecycleEpoch, 'legacy-worker-7');

    const markerPath = path.join(ctx.hydraHome, 'migrations', 'worker-identity-v1.json');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as {
      createdAt: string;
      backupDirectory: string;
      files: Array<{ source: string; backup: string }>;
    };
    assert.equal(marker.files.length, 7);
    const sessionsBackup = marker.files.find(file => file.source === ctx.sessionsFile);
    assert.ok(sessionsBackup);
    const backedUpSessions = JSON.parse(fs.readFileSync(sessionsBackup.backup, 'utf-8'));
    assert.equal(backedUpSessions.workers[legacy.sessionName].lifecycleEpoch, undefined);

    await manager.sync();
    const repeatedMarker = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as { createdAt: string };
    assert.equal(repeatedMarker.createdAt, marker.createdAt);
    assert.equal(fs.readdirSync(path.join(ctx.hydraHome, 'backups')).length, 1);
  });
}

async function testRecreationRotatesEpochAndCleansLegacyState(): Promise<void> {
  await withContext(async (ctx) => {
    const workdir = path.join(ctx.root, 'recreated-worker');
    fs.mkdirSync(workdir, { recursive: true });
    const original = worker(workdir);
    writeJson(ctx.sessionsFile, {
      copilots: {},
      workers: { [original.sessionName]: original },
      nextWorkerId: 8,
      updatedAt: new Date().toISOString(),
    });

    const hooksDir = path.join(ctx.hydraHome, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const legacyCommands: Array<{ hooks: Array<{ type: string; command: string; async: boolean }> }> = [];
    for (const route of [original.sessionName, ...(original.sessionAliases ?? [])]) {
      const legacyScript = path.join(hooksDir, `notify-${route}.sh`);
      fs.writeFileSync(legacyScript, '# legacy', 'utf-8');
      fs.writeFileSync(path.join(hooksDir, `notify-${route}.ps1`), '# legacy', 'utf-8');
      fs.writeFileSync(path.join(hooksDir, `notify-${route}.pending`), 'legacy-token\n', 'utf-8');
      legacyCommands.push({
        hooks: [{ type: 'command', command: `sh '${legacyScript}'`, async: true }],
      });
    }
    writeJson(path.join(workdir, '.claude', 'settings.json'), {
      hooks: { Stop: legacyCommands },
    });

    const jobStore = new CompletionJobStore(path.join(ctx.hydraHome, 'completion-jobs.json'));
    const oldJob = jobStore.armForDispatch({
      workerId: original.workerId,
      lifecycleEpoch: original.lifecycleEpoch!,
      runId: 'run-before-recreation',
    }, {
      runtimeActive: true,
      runtimeRunId: 'run-before-recreation',
    });
    const backend = new IdentityBackend();
    const manager = new SessionManager(backend);
    forceFastSleeps(manager);
    const runtimeV2 = new WorkerRuntimeStateStoreV2(path.join(ctx.hydraHome, 'worker-runtime-state-v2.json'));
    const lifecycle = new WorkerLifecycleService({
      backend,
      sessionManager: manager,
      completionJobStore: jobStore,
      runtimeStateStore: new WorkerRuntimeStateStore(path.join(ctx.hydraHome, 'worker-runtime-state.json')),
      runtimeV2Store: runtimeV2,
      eventSource: 'cli',
    });

    const result = await lifecycle.startWorker('worker-old');
    await result.postCreatePromise;
    assert.equal(result.workerInfo.workerId, original.workerId);
    assert.notEqual(result.workerInfo.lifecycleEpoch, original.lifecycleEpoch);
    assert.equal(jobStore.get(oldJob.job.jobId)?.status, 'cancelled');
    assert.equal(runtimeV2.get(original.workerId)?.lifecycleEpoch, result.workerInfo.lifecycleEpoch);
    assert.equal(manager.getPersistedWorker('worker-old')?.sessionName, original.sessionName);
    assert.equal(lookupWorkerId('worker-old'), original.workerId);

    const stableScript = path.join(hooksDir, `completion-worker-${original.workerId}.sh`);
    const stableContent = fs.readFileSync(stableScript, 'utf-8');
    assert.match(stableContent, new RegExp(`LIFECYCLE_EPOCH='${result.workerInfo.lifecycleEpoch}'`));
    const migratedClaudeConfig = JSON.parse(
      fs.readFileSync(path.join(workdir, '.claude', 'settings.json'), 'utf-8'),
    ) as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } };
    assert.equal(migratedClaudeConfig.hooks.Stop.length, 1);
    assert.match(migratedClaudeConfig.hooks.Stop[0].hooks[0].command, /completion-worker-7\.sh/);
    for (const route of [original.sessionName, ...(original.sessionAliases ?? [])]) {
      assert.equal(fs.existsSync(path.join(hooksDir, `notify-${route}.sh`)), false);
      assert.equal(fs.existsSync(path.join(hooksDir, `notify-${route}.ps1`)), false);
      assert.equal(fs.existsSync(path.join(hooksDir, `notify-${route}.pending`)), true);
    }

    await lifecycle.stopWorker(original.sessionName);
    for (const route of [original.sessionName, ...(original.sessionAliases ?? [])]) {
      assert.equal(fs.existsSync(path.join(hooksDir, `notify-${route}.pending`)), false);
    }
    assert.equal(runtimeV2.get(original.workerId), undefined);
  });
}

async function testMigrationFailsClosedOnInvalidMarker(): Promise<void> {
  await withContext(async (ctx) => {
    const workdir = path.join(ctx.root, 'invalid-marker-worker');
    fs.mkdirSync(workdir, { recursive: true });
    const legacy = worker(workdir);
    delete legacy.lifecycleEpoch;
    writeJson(ctx.sessionsFile, {
      copilots: {},
      workers: { [legacy.sessionName]: legacy },
      nextWorkerId: 8,
      updatedAt: new Date().toISOString(),
    });
    writeJson(path.join(ctx.hydraHome, 'migrations', 'worker-identity-v1.json'), { invalid: true });

    const manager = new SessionManager(new IdentityBackend());
    await assert.rejects(manager.sync(), /migration marker.*invalid shape/);
    const persisted = JSON.parse(fs.readFileSync(ctx.sessionsFile, 'utf-8'));
    assert.equal(persisted.workers[legacy.sessionName].lifecycleEpoch, undefined);
  });
}

async function testRenamePreservesIdentityAndAddsAlias(): Promise<void> {
  await withContext(async (ctx) => {
    const repoRoot = path.join(ctx.root, 'repo');
    fs.mkdirSync(repoRoot, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'identity@example.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Identity Smoke'], { cwd: repoRoot });
    fs.writeFileSync(path.join(repoRoot, 'README.md'), 'identity\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: repoRoot });
    execFileSync('git', ['branch', 'feat/old'], { cwd: repoRoot });

    const backend = new IdentityBackend();
    const namespace = coreGit.getRepoSessionNamespace(repoRoot, backend);
    const oldSlug = coreGit.branchNameToSlug('feat/old', backend);
    const oldSession = backend.buildSessionName(namespace, oldSlug);
    const managedDir = coreGit.getManagedRepoWorktreesDir(repoRoot);
    const oldWorkdir = path.join(managedDir, oldSlug);
    fs.mkdirSync(managedDir, { recursive: true });
    execFileSync('git', ['worktree', 'add', '-q', oldWorkdir, 'feat/old'], { cwd: repoRoot });

    const original = worker(oldWorkdir, {
      source: 'repo',
      sessionName: oldSession,
      displayName: oldSlug,
      lifecycleEpoch: 'epoch-stable-across-rename',
      sessionAliases: [],
      repo: path.basename(repoRoot),
      repoRoot,
      branch: 'feat/old',
      slug: oldSlug,
      agent: 'custom',
      tmuxSession: oldSession,
    });
    writeJson(ctx.sessionsFile, {
      copilots: {},
      workers: { [oldSession]: original },
      nextWorkerId: 8,
      updatedAt: new Date().toISOString(),
    });

    const eventLog = new EventLog(
      path.join(ctx.hydraHome, 'events.jsonl'),
      path.join(ctx.hydraHome, 'events.state.json'),
    );
    const compatibilityStore = new WorkerRuntimeStateStore(
      path.join(ctx.hydraHome, 'worker-runtime-state.json'),
      eventLog,
    );
    const runtimeV2 = new WorkerRuntimeStateStoreV2(
      path.join(ctx.hydraHome, 'worker-runtime-state-v2.json'),
    );
    const runtimeCoordinator = new WorkerRuntimeCoordinator(
      workerId => workerId === original.workerId ? {
        workerId,
        sessionName: original.sessionName,
        lifecycleEpoch: original.lifecycleEpoch!,
        agent: original.agent,
        workdir: original.workdir,
      } : undefined,
      runtimeV2,
      compatibilityStore,
      eventLog,
    );
    assert.equal(runtimeCoordinator.apply({
      workerId: original.workerId,
      sessionName: original.sessionName,
      lifecycleEpoch: original.lifecycleEpoch!,
      runId: 'run-during-rename',
      revision: 0,
      state: 'running',
      signalId: 'dispatch-before-rename',
      origin: 'lifecycle',
      reason: 'worker-send',
      observedAt: new Date().toISOString(),
      agent: original.agent,
      workdir: original.workdir,
    }, 'cli').outcome, 'applied');

    const jobStore = new CompletionJobStore(path.join(ctx.hydraHome, 'completion-jobs.json'));
    const pendingCompletion = jobStore.armForDispatch({
      workerId: original.workerId,
      lifecycleEpoch: original.lifecycleEpoch!,
      runId: 'run-during-rename',
    }, {
      runtimeActive: true,
      runtimeRunId: 'run-during-rename',
    });
    assert.equal(runtimeCoordinator.apply({
      workerId: original.workerId,
      sessionName: original.sessionName,
      lifecycleEpoch: original.lifecycleEpoch!,
      runId: 'run-during-rename',
      revision: 1,
      state: 'needs-input',
      signalId: 'question-before-rename',
      occurrenceId: 'question-occurrence-before-rename',
      origin: 'hook',
      reason: 'needs-input',
      observedAt: new Date().toISOString(),
      agent: original.agent,
      workdir: original.workdir,
    }, 'hook').outcome, 'applied');
    const notificationStore = new NotificationStore(
      path.join(ctx.hydraHome, 'notifications.json'),
      1000,
      eventLog,
    );
    const needsInput = notificationStore.create({
      kind: 'needs-input',
      title: 'Worker needs input during rename',
      sourceSession: original.sessionName,
      targetSession: original.copilotSessionName,
      action: { type: 'open-session', session: original.sessionName },
      context: { workerId: original.workerId },
      occurrenceId: 'question-occurrence-before-rename',
      lifecycleEpoch: original.lifecycleEpoch,
      runId: 'run-during-rename',
      signalId: 'question-before-rename',
    }).occurrence!;

    const manager = new SessionManager(backend, eventLog, compatibilityStore);
    const lifecycle = new WorkerLifecycleService({
      backend,
      sessionManager: manager,
      runtimeStateStore: compatibilityStore,
      runtimeV2Store: runtimeV2,
      completionJobStore: jobStore,
      notificationStore,
      eventLog,
      eventSource: 'cli',
    });
    const renamed = await lifecycle.renameWorker(oldSession, 'feat/new');
    assert.equal(renamed.workerId, original.workerId);
    assert.equal(renamed.lifecycleEpoch, original.lifecycleEpoch);
    assert.ok(renamed.sessionAliases?.includes(oldSession));
    assert.equal(manager.getPersistedWorker(oldSession)?.sessionName, renamed.sessionName);
    assert.equal(lookupWorkerId(oldSession), original.workerId);
    assert.equal(runtimeV2.get(original.workerId)?.sessionName, renamed.sessionName);
    assert.equal(runtimeV2.get(original.workerId)?.state, 'needs-input');
    assert.equal(jobStore.get(pendingCompletion.job.jobId)?.status, 'pending');
    const routedNeedsInput = notificationStore.listOccurrences('active')
      .find(notification => notification.id === needsInput.id);
    assert.equal(routedNeedsInput?.sourceSession, renamed.sessionName);
    assert.equal(routedNeedsInput?.action?.session, renamed.sessionName);
    assert.equal(notificationStore.list({ sourceSession: renamed.sessionName, kind: 'needs-input' }).count, 1);
    assert.equal(compatibilityStore.get(oldSession), undefined);
    assert.equal(compatibilityStore.get(renamed.sessionName)?.state, 'needs-input');
  });
}

async function testRestoreRotatesEpochAndRejectsOldHook(): Promise<void> {
  await withContext(async (ctx) => {
    const workdir = path.join(ctx.root, 'restored-worker');
    fs.mkdirSync(workdir, { recursive: true });
    const archivedWorker = worker(workdir, {
      sessionName: 'worker-restored',
      displayName: 'worker-restored',
      workerId: 9,
      lifecycleEpoch: 'epoch-before-restore',
      sessionAliases: ['worker-restored-old-route'],
      slug: 'worker-restored',
      tmuxSession: 'worker-restored',
    });
    writeJson(path.join(ctx.hydraHome, 'archive.json'), {
      entries: [{
        type: 'worker',
        sessionName: archivedWorker.sessionName,
        agentSessionId: null,
        agentSessionFile: null,
        archivedAt: new Date().toISOString(),
        data: archivedWorker,
      }],
    });
    writeJson(ctx.sessionsFile, {
      copilots: {},
      workers: {},
      nextWorkerId: 10,
      updatedAt: new Date().toISOString(),
    });

    const jobStore = new CompletionJobStore(path.join(ctx.hydraHome, 'completion-jobs.json'));
    const oldJob = jobStore.armForDispatch({
      workerId: archivedWorker.workerId,
      lifecycleEpoch: archivedWorker.lifecycleEpoch!,
      runId: 'run-before-restore',
    }, {
      runtimeActive: true,
      runtimeRunId: 'run-before-restore',
    });
    const eventLog = new EventLog(
      path.join(ctx.hydraHome, 'events.jsonl'),
      path.join(ctx.hydraHome, 'events.state.json'),
    );
    const compatibilityStore = new WorkerRuntimeStateStore(
      path.join(ctx.hydraHome, 'worker-runtime-state.json'),
      eventLog,
    );
    const runtimeV2 = new WorkerRuntimeStateStoreV2(
      path.join(ctx.hydraHome, 'worker-runtime-state-v2.json'),
    );
    const notificationStore = new NotificationStore(
      path.join(ctx.hydraHome, 'notifications.json'),
      1000,
      eventLog,
    );
    const oldRuntimeCoordinator = new WorkerRuntimeCoordinator(
      workerId => workerId === archivedWorker.workerId ? {
        workerId,
        sessionName: archivedWorker.sessionName,
        lifecycleEpoch: archivedWorker.lifecycleEpoch!,
        agent: archivedWorker.agent,
        workdir: archivedWorker.workdir,
      } : undefined,
      runtimeV2,
      compatibilityStore,
      eventLog,
    );
    assert.equal(oldRuntimeCoordinator.apply({
      workerId: archivedWorker.workerId,
      sessionName: archivedWorker.sessionName,
      lifecycleEpoch: archivedWorker.lifecycleEpoch!,
      runId: 'run-before-restore',
      revision: 0,
      state: 'running',
      signalId: 'dispatch-before-restore',
      origin: 'lifecycle',
      reason: 'worker-send',
      observedAt: new Date().toISOString(),
      agent: archivedWorker.agent,
      workdir: archivedWorker.workdir,
    }, 'cli').outcome, 'applied');
    assert.equal(oldRuntimeCoordinator.apply({
      workerId: archivedWorker.workerId,
      sessionName: archivedWorker.sessionName,
      lifecycleEpoch: archivedWorker.lifecycleEpoch!,
      runId: 'run-before-restore',
      revision: 1,
      state: 'needs-input',
      signalId: 'question-before-restore',
      occurrenceId: 'question-occurrence-before-restore',
      origin: 'hook',
      reason: 'needs-input',
      observedAt: new Date().toISOString(),
      agent: archivedWorker.agent,
      workdir: archivedWorker.workdir,
    }, 'hook').outcome, 'applied');
    const oldNeedsInput = notificationStore.create({
      kind: 'needs-input',
      title: 'Worker needs input before restore',
      sourceSession: archivedWorker.sessionName,
      action: { type: 'open-session', session: archivedWorker.sessionName },
      context: { workerId: archivedWorker.workerId },
      occurrenceId: 'question-occurrence-before-restore',
      lifecycleEpoch: archivedWorker.lifecycleEpoch,
      runId: 'run-before-restore',
      signalId: 'question-before-restore',
    }).occurrence!;
    const backend = new IdentityBackend();
    const manager = new SessionManager(backend, eventLog, compatibilityStore);
    forceFastSleeps(manager);
    const lifecycle = new WorkerLifecycleService({
      backend,
      sessionManager: manager,
      completionJobStore: jobStore,
      notificationStore,
      runtimeStateStore: compatibilityStore,
      runtimeV2Store: runtimeV2,
      eventLog,
      eventSource: 'cli',
    });

    const result = await lifecycle.restoreWorker(archivedWorker.sessionName);
    await result.postCreatePromise;
    assert.equal(result.workerInfo.workerId, archivedWorker.workerId);
    assert.notEqual(result.workerInfo.lifecycleEpoch, archivedWorker.lifecycleEpoch);
    assert.equal(jobStore.get(oldJob.job.jobId)?.status, 'cancelled');
    assert.equal(notificationStore.listOccurrences('active').some(item => item.id === oldNeedsInput.id), false);
    assert.equal(notificationStore.listOccurrences('resolved').some(item => item.id === oldNeedsInput.id), true);

    const runtimeCoordinator = new WorkerRuntimeCoordinator(
      workerId => workerId === result.workerInfo.workerId ? {
        workerId,
        sessionName: result.workerInfo.sessionName,
        lifecycleEpoch: result.workerInfo.lifecycleEpoch!,
        agent: result.workerInfo.agent,
        workdir: result.workerInfo.workdir,
      } : undefined,
      runtimeV2,
      compatibilityStore,
      eventLog,
    );
    const completion = new CompletionCoordinator({
      resolveWorker: workerId => workerId === result.workerInfo.workerId ? {
        worker: result.workerInfo,
        lifecycleEpoch: result.workerInfo.lifecycleEpoch!,
      } : undefined,
      jobStore,
      runtimeStore: runtimeV2,
      runtimeCoordinator,
      eventSource: 'hook',
      readLegacyPendingToken: () => undefined,
      removeLegacyPendingFiles: () => [],
    });
    const stale = await completion.complete({
      workerId: archivedWorker.workerId,
      lifecycleEpoch: archivedWorker.lifecycleEpoch!,
    });
    assert.equal(stale.outcome, 'stale-epoch');
  });
}

function forceFastSleeps(manager: SessionManager): void {
  (manager as unknown as { sleep(ms: number): Promise<void> }).sleep = async () => {};
}

function moveMapValue<T>(map: Map<string, T>, oldName: string, newName: string): void {
  const value = map.get(oldName);
  map.delete(oldName);
  if (value !== undefined) map.set(newName, value);
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function main(): Promise<void> {
  await testLegacyMigrationAndBackup();
  await testMigrationFailsClosedOnInvalidMarker();
  await testRecreationRotatesEpochAndCleansLegacyState();
  await testRenamePreservesIdentityAndAddsAlias();
  await testRestoreRotatesEpochAndRejectsOldHook();
  console.log('workerIdentitySmoke: ok');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
