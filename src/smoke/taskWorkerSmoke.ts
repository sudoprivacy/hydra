import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  HydraRole,
  MultiplexerBackendCore,
  MultiplexerSession,
  SessionStatusInfo,
} from '../core/types';

class TaskWorkerBackend implements MultiplexerBackendCore {
  readonly type = 'tmux' as const;
  readonly displayName = 'fake-tmux';
  readonly installHint = 'not needed';

  readonly sessions = new Set<string>();
  readonly workdirs = new Map<string, string>();
  readonly roles = new Map<string, HydraRole>();
  readonly agents = new Map<string, string>();
  readonly keys: Array<{ sessionName: string; keys: string }> = [];
  readonly messages: Array<{ sessionName: string; message: string }> = [];
  readonly killed: string[] = [];

  async isInstalled(): Promise<boolean> {
    return true;
  }

  async listSessions(): Promise<MultiplexerSession[]> {
    return [...this.sessions].map(name => ({
      name,
      windows: 1,
      attached: false,
      workdir: this.workdirs.get(name),
      slug: name,
    }));
  }

  async createSession(sessionName: string, workdir: string): Promise<void> {
    this.sessions.add(sessionName);
    this.workdirs.set(sessionName, workdir);
  }

  async killSession(sessionName: string): Promise<void> {
    this.sessions.delete(sessionName);
    this.killed.push(sessionName);
  }

  async renameSession(oldName: string, newName: string): Promise<void> {
    if (!this.sessions.delete(oldName)) return;
    this.sessions.add(newName);
    const workdir = this.workdirs.get(oldName);
    if (workdir) this.workdirs.set(newName, workdir);
  }

  async hasSession(sessionName: string): Promise<boolean> {
    return this.sessions.has(sessionName);
  }

  async getSessionWorkdir(sessionName: string): Promise<string | undefined> {
    return this.workdirs.get(sessionName);
  }

  async setSessionWorkdir(sessionName: string, workdir: string): Promise<void> {
    this.workdirs.set(sessionName, workdir);
  }

  async getSessionRole(sessionName: string): Promise<HydraRole | undefined> {
    return this.roles.get(sessionName);
  }

  async setSessionRole(sessionName: string, role: HydraRole): Promise<void> {
    this.roles.set(sessionName, role);
  }

  async getSessionAgent(sessionName: string): Promise<string | undefined> {
    return this.agents.get(sessionName);
  }

  async setSessionAgent(sessionName: string, agent: string): Promise<void> {
    this.agents.set(sessionName, agent);
  }

  async sendKeys(sessionName: string, keys: string): Promise<void> {
    this.keys.push({ sessionName, keys });
  }

  async capturePane(): Promise<string> {
    return '⏵';
  }

  async sendMessage(sessionName: string, message: string): Promise<void> {
    this.messages.push({ sessionName, message });
  }

  async getSessionInfo(): Promise<SessionStatusInfo> {
    return { attached: false, lastActive: Math.floor(Date.now() / 1000) };
  }

  async getSessionPaneCount(): Promise<number> {
    return 1;
  }

  async getSessionPanePids(): Promise<string[]> {
    return [];
  }

  async splitPane(): Promise<void> {
    return;
  }

  async newWindow(): Promise<void> {
    return;
  }

  buildSessionName(namespace: string, slug: string): string {
    return `${namespace}_${slug}`;
  }

  sanitizeSessionName(name: string): string {
    return name.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  }
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function readEvents(hydraHome: string): Array<{ type: string; session?: string; payload?: Record<string, unknown> }> {
  const eventsPath = path.join(hydraHome, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) {
    return [];
  }
  return fs.readFileSync(eventsPath, 'utf-8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as { type: string; session?: string; payload?: Record<string, unknown> });
}

async function main(): Promise<void> {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-task-worker-'));
  process.env.HOME = tempHome;
  process.env.HYDRA_HOME = path.join(tempHome, '.hydra');
  delete process.env.HYDRA_CONFIG_PATH;

  const { SessionManager } = await import('../core/sessionManager');
  const { getHydraArchiveFile, getHydraSessionsFile, getHydraTasksRoot } = await import('../core/path');

  const backend = new TaskWorkerBackend();
  const sm = new SessionManager(backend);
  const userDir = path.join(tempHome, 'research notes');
  fs.mkdirSync(userDir, { recursive: true });

  const unmanaged = await sm.createDirectoryWorker({
    workdir: userDir,
    agentType: 'claude',
    task: 'summarize the notes',
  });
  await unmanaged.postCreatePromise;

  assert.equal(unmanaged.workerInfo.source, 'directory');
  assert.equal(unmanaged.workerInfo.displayName, 'research-notes');
  assert.equal(unmanaged.workerInfo.repoRoot, null);
  assert.equal(unmanaged.workerInfo.branch, null);
  assert.equal(unmanaged.workerInfo.managedWorkdir, false);
  assert.equal(unmanaged.workerInfo.workdir, userDir);
  assert.equal(backend.messages.at(-1)?.message, 'summarize the notes');
  const unmanagedCreatedEvent = readEvents(process.env.HYDRA_HOME!)
    .find(event => event.type === 'worker.created' && event.session === unmanaged.workerInfo.sessionName);
  assert.ok(unmanagedCreatedEvent, 'task worker creation should emit worker.created');
  assert.equal(unmanagedCreatedEvent?.payload?.source, 'directory');

  await assert.rejects(
    () => sm.deleteWorker(unmanaged.workerInfo.sessionName, { deleteFiles: true }),
    /user-provided directory/,
  );
  assert.ok(fs.existsSync(userDir), 'unmanaged directory should survive rejected delete');
  assert.equal(backend.killed.includes(unmanaged.workerInfo.sessionName), false);

  await sm.deleteWorker(unmanaged.workerInfo.sessionName);
  assert.ok(fs.existsSync(userDir), 'unmanaged directory should survive normal delete');
  const unmanagedDeletedEvent = readEvents(process.env.HYDRA_HOME!)
    .find(event => event.type === 'worker.deleted' && event.session === unmanaged.workerInfo.sessionName);
  assert.ok(unmanagedDeletedEvent, 'task worker deletion should emit worker.deleted');
  const stateAfterDelete = readJson<{ workers: Record<string, unknown> }>(getHydraSessionsFile());
  assert.equal(stateAfterDelete.workers[unmanaged.workerInfo.sessionName], undefined);

  const archive = readJson<{ entries: Array<{ sessionName: string; data: { source?: string } }> }>(getHydraArchiveFile());
  const archived = archive.entries.find(entry => entry.sessionName === unmanaged.workerInfo.sessionName);
  assert.equal(archived?.data.source, 'directory');

  const managed = await sm.createDirectoryWorker({
    managedWorkdir: true,
    name: 'temp-report',
    agentType: 'claude',
  });
  await managed.postCreatePromise;

  assert.equal(managed.workerInfo.managedWorkdir, true);
  assert.equal(managed.workerInfo.workdir, path.join(getHydraTasksRoot(), 'temp-report'));
  assert.ok(fs.existsSync(managed.workerInfo.workdir), 'managed task directory should be created');

  await sm.deleteWorker(managed.workerInfo.sessionName);
  assert.ok(fs.existsSync(managed.workerInfo.workdir), 'managed task directory should survive default delete');

  const managedDeleteFiles = await sm.createDirectoryWorker({
    managedWorkdir: true,
    name: 'temp-delete-files',
    agentType: 'claude',
  });
  await managedDeleteFiles.postCreatePromise;
  const managedDeletePath = managedDeleteFiles.workerInfo.workdir;
  await sm.deleteWorker(managedDeleteFiles.workerInfo.sessionName, { deleteFiles: true });
  assert.equal(fs.existsSync(managedDeletePath), false, 'managed task directory should be deleted with deleteFiles');
  const managedDeletedEvent = readEvents(process.env.HYDRA_HOME!)
    .find(event => event.type === 'worker.deleted' && event.session === managedDeleteFiles.workerInfo.sessionName);
  assert.equal(managedDeletedEvent?.payload?.deletedFiles, true, 'deleteFiles should be recorded as event metadata');

  fs.rmSync(tempHome, { recursive: true, force: true });
  console.log('taskWorkerSmoke: ok');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
