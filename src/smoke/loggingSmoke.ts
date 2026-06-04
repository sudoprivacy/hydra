import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../core/logger';
import { isSecretLikeKey, redactText } from '../core/logRedaction';
import { exec } from '../core/exec';
import { SessionManager, type WorkerInfo } from '../core/sessionManager';
import type { HydraRole, MultiplexerBackendCore, MultiplexerSession, SessionStatusInfo } from '../core/types';

class FakeBackend implements MultiplexerBackendCore {
  readonly type = 'tmux' as const;
  readonly displayName = 'fake';
  readonly installHint = '';

  async isInstalled(): Promise<boolean> { return true; }
  async listSessions(): Promise<MultiplexerSession[]> { return []; }
  async createSession(): Promise<void> {}
  async killSession(): Promise<void> {}
  async renameSession(): Promise<void> {}
  async hasSession(): Promise<boolean> { return false; }
  async getSessionWorkdir(): Promise<string | undefined> { return undefined; }
  async setSessionWorkdir(): Promise<void> {}
  async getSessionRole(): Promise<HydraRole | undefined> { return undefined; }
  async setSessionRole(): Promise<void> {}
  async getSessionAgent(): Promise<string | undefined> { return undefined; }
  async setSessionAgent(): Promise<void> {}
  async sendKeys(): Promise<void> {}
  async capturePane(): Promise<string> { return ''; }
  async sendMessage(): Promise<void> {}
  async getSessionInfo(): Promise<SessionStatusInfo> { return { attached: false, lastActive: 0 }; }
  async getSessionPaneCount(): Promise<number> { return 1; }
  async getSessionPanePids(): Promise<string[]> { return []; }
  async splitPane(): Promise<void> {}
  async newWindow(): Promise<void> {}
  buildSessionName(repoName: string, slug: string): string { return `${repoName}_${slug}`; }
  sanitizeSessionName(name: string): string { return name.replace(/[^A-Za-z0-9_.-]/g, '-'); }
}

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-logging-smoke-'));
}

function resetLogger(filePath: string, maxFileSizeBytes = 5 * 1024 * 1024, maxFiles = 5): void {
  logger.resetForTests();
  logger.configure({
    level: 'debug',
    filePath,
    flushDelayMs: 0,
    maxFileSizeBytes,
    maxFiles,
  });
}

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

async function testRedaction(): Promise<void> {
  const text = [
    'OPENAI_API_KEY=sk-proj-secret1234567890',
    'Authorization: Bearer secret-token-value',
    'GITHUB_TOKEN=ghp_123456789012345678901234567890123456',
    'safe text',
  ].join('\n');
  const redacted = redactText(text);
  assert.ok(!redacted.includes('sk-proj-secret1234567890'), 'OpenAI key should be redacted');
  assert.ok(!redacted.includes('secret-token-value'), 'Bearer token should be redacted');
  assert.ok(!redacted.includes('ghp_123456789012345678901234567890123456'), 'GitHub token should be redacted');
  assert.ok(redacted.includes('safe text'), 'non-secret text should remain');
  assert.ok(isSecretLikeKey('apiKey'), 'camelCase apiKey fields should be treated as secret');
  assert.ok(isSecretLikeKey('accessToken'), 'camelCase accessToken fields should be treated as secret');
}

async function testRotation(): Promise<void> {
  const root = makeTempRoot();
  const logPath = path.join(root, 'hydra.log');
  try {
    resetLogger(logPath, 1024, 3);
    for (let i = 0; i < 5; i++) {
      logger.info('smoke.rotation', 'rotation payload', {
        index: i,
        payload: 'x'.repeat(1500),
      });
      await logger.flush();
    }

    assert.ok(fs.existsSync(logPath), 'active log should exist');
    assert.ok(fs.existsSync(path.join(root, 'hydra.1.log')), 'first rotated log should exist');
    assert.ok(fs.existsSync(path.join(root, 'hydra.2.log')), 'second rotated log should exist');
    assert.ok(!fs.existsSync(path.join(root, 'hydra.3.log')), 'rotation should respect maxFiles including active file');
  } finally {
    logger.resetForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testExecFailureLogging(): Promise<void> {
  const root = makeTempRoot();
  const logPath = path.join(root, 'hydra.log');
  const previousHydraHome = process.env.HYDRA_HOME;
  const previousHydraConfigPath = process.env.HYDRA_CONFIG_PATH;
  process.env.HYDRA_HOME = root;
  process.env.HYDRA_CONFIG_PATH = path.join(root, 'config.json');

  try {
    resetLogger(logPath);
    await assert.rejects(
      () => exec('node -e "console.error(\'OPENAI_API_KEY=sk-proj-secret1234567890\'); process.exit(7)"', { cwd: root }),
      /Command failed/,
    );
    await logger.flush();

    const entries = readJsonLines(logPath);
    const failure = entries.find(entry => entry.scope === 'exec.failure');
    assert.ok(failure, 'exec.failure entry should be written');
    assert.equal(failure?.cwd, root);
    assert.equal(failure?.exitCode, 7);
    const serialized = JSON.stringify(failure);
    assert.ok(serialized.includes('OPENAI_API_KEY='), 'failure should include stderr context');
    assert.ok(!serialized.includes('sk-proj-secret1234567890'), 'stderr secret should be redacted');
  } finally {
    logger.resetForTests();
    if (previousHydraHome === undefined) {
      delete process.env.HYDRA_HOME;
    } else {
      process.env.HYDRA_HOME = previousHydraHome;
    }
    if (previousHydraConfigPath === undefined) {
      delete process.env.HYDRA_CONFIG_PATH;
    } else {
      process.env.HYDRA_CONFIG_PATH = previousHydraConfigPath;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testSuppressedProbeFailureLogging(): Promise<void> {
  const root = makeTempRoot();
  const logPath = path.join(root, 'hydra.log');
  try {
    resetLogger(logPath);
    await assert.rejects(
      () => exec('node -e "process.exit(3)"', { cwd: root, logFailure: false }),
      /Command failed/,
    );
    await logger.flush();

    const entries = readJsonLines(logPath);
    assert.ok(!entries.some(entry => entry.scope === 'exec.failure'), 'probe failures should not write exec.failure');
    assert.ok(entries.some(entry => entry.scope === 'exec.probeFailure'), 'debug probe failure should remain available');
  } finally {
    logger.resetForTests();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testWorkerDeleteLifecycleLogging(): Promise<void> {
  const root = makeTempRoot();
  const hydraHome = path.join(root, '.hydra');
  const logPath = path.join(hydraHome, 'logs', 'hydra.log');
  const sessionsPath = path.join(hydraHome, 'sessions.json');
  const previousHydraHome = process.env.HYDRA_HOME;
  const previousHydraConfigPath = process.env.HYDRA_CONFIG_PATH;
  const now = new Date().toISOString();
  const worker: WorkerInfo = {
    source: 'directory',
    sessionName: 'task_log-test',
    displayName: 'log-test',
    workerId: 1,
    repo: null,
    repoRoot: null,
    branch: null,
    slug: 'log-test',
    status: 'running',
    attached: false,
    agent: 'custom',
    workdir: path.join(root, 'task-workdir'),
    managedWorkdir: false,
    tmuxSession: 'task_log-test',
    createdAt: now,
    lastSeenAt: now,
    sessionId: 'agent-session-1',
    agentSessionFile: null,
    copilotSessionName: null,
  };

  process.env.HYDRA_HOME = hydraHome;
  process.env.HYDRA_CONFIG_PATH = path.join(hydraHome, 'config.json');

  try {
    fs.mkdirSync(worker.workdir, { recursive: true });
    fs.mkdirSync(hydraHome, { recursive: true });
    fs.writeFileSync(sessionsPath, JSON.stringify({
      copilots: {},
      workers: { [worker.sessionName]: worker },
      nextWorkerId: 2,
      updatedAt: now,
    }, null, 2), 'utf-8');

    resetLogger(logPath);
    const sm = new SessionManager(new FakeBackend());
    await sm.deleteWorker(worker.sessionName);
    await logger.flush();

    const entries = readJsonLines(logPath);
    const deleteEntries = entries.filter(entry => entry.scope === 'session.delete');
    assert.ok(deleteEntries.some(entry => entry.phase === 'start'), 'delete should log start phase');
    assert.ok(deleteEntries.some(entry => entry.phase === 'archive'), 'delete should log archive phase');
    assert.ok(deleteEntries.some(entry => entry.phase === 'complete'), 'delete should log complete phase');
    assert.ok(entries.some(entry => entry.scope === 'session.archive'), 'archive helper should log archived metadata');

    const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8')) as { workers: Record<string, unknown> };
    assert.ok(!sessions.workers[worker.sessionName], 'worker should be removed from sessions.json');
    const archive = JSON.parse(fs.readFileSync(path.join(hydraHome, 'archive.json'), 'utf-8')) as {
      entries: Array<{ sessionName: string }>;
    };
    assert.ok(archive.entries.some(entry => entry.sessionName === worker.sessionName), 'worker should be archived');
  } finally {
    logger.resetForTests();
    if (previousHydraHome === undefined) {
      delete process.env.HYDRA_HOME;
    } else {
      process.env.HYDRA_HOME = previousHydraHome;
    }
    if (previousHydraConfigPath === undefined) {
      delete process.env.HYDRA_CONFIG_PATH;
    } else {
      process.env.HYDRA_CONFIG_PATH = previousHydraConfigPath;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testRedaction();
  await testRotation();
  await testExecFailureLogging();
  await testSuppressedProbeFailureLogging();
  await testWorkerDeleteLifecycleLogging();
  console.log('loggingSmoke: ok');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
