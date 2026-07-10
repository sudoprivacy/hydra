/**
 * Smoke test: structured completion hook installation and CLI ingestion.
 *
 * Run: node packages/cli/out/smoke/completionHookSmoke.js
 */

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CompletionJobStore } from '@hydra/core/completionJobStore';
import { NotificationStore } from '@hydra/core/notifications';
import { setWorkerRuntimeState } from '@hydra/core/workerRuntimeState';
import type {
  HydraRole,
  MultiplexerBackendCore,
  MultiplexerSession,
  SessionStatusInfo,
} from '@hydra/core/types';
import type { WorkerInfo } from '@hydra/core/sessionManager';

class HookBackend implements MultiplexerBackendCore {
  readonly type = 'tmux' as const;
  readonly displayName = 'hook-backend';
  readonly installHint = 'not needed';
  private readonly sessions = new Set<string>();

  async isInstalled(): Promise<boolean> { return true; }
  async listSessions(): Promise<MultiplexerSession[]> {
    return [...this.sessions].map(name => ({ name, attached: false, windows: 1 }));
  }
  async createSession(sessionName: string): Promise<void> { this.sessions.add(sessionName); }
  async killSession(sessionName: string): Promise<void> { this.sessions.delete(sessionName); }
  async renameSession(oldName: string, newName: string): Promise<void> {
    this.sessions.delete(oldName);
    this.sessions.add(newName);
  }
  async hasSession(sessionName: string): Promise<boolean> { return this.sessions.has(sessionName); }
  async getSessionWorkdir(): Promise<string | undefined> { return undefined; }
  async setSessionWorkdir(): Promise<void> {}
  async getSessionRole(): Promise<HydraRole | undefined> { return 'worker'; }
  async setSessionRole(): Promise<void> {}
  async getSessionAgent(): Promise<string | undefined> { return 'claude'; }
  async setSessionAgent(): Promise<void> {}
  async sendKeys(sessionName: string, keys: string): Promise<void> {
    void sessionName;
    void keys;
  }
  async capturePane(): Promise<string> { return '⏵'; }
  async sendMessage(): Promise<void> {}
  async getSessionInfo(): Promise<SessionStatusInfo> { return { attached: false, lastActive: 0 }; }
  async getSessionPaneCount(): Promise<number> { return 1; }
  async getSessionPanePids(): Promise<string[]> { return []; }
  async splitPane(): Promise<void> {}
  async newWindow(): Promise<void> {}
  buildSessionName(repoName: string, slug: string): string { return `${repoName}_${slug}`; }
  sanitizeSessionName(name: string): string { return name; }
}

class PromptBackend extends HookBackend {
  readonly sentPromptKeys: string[] = [];
  private captureIndex = 0;

  constructor(private readonly captures: string[]) {
    super();
  }

  override async hasSession(): Promise<boolean> { return true; }
  override async sendKeys(_sessionName: string, keys: string): Promise<void> {
    this.sentPromptKeys.push(keys);
    this.captureIndex = Math.min(this.captureIndex + 1, this.captures.length - 1);
  }
  override async capturePane(): Promise<string> {
    return this.captures[Math.min(this.captureIndex, this.captures.length - 1)] || '';
  }
}

function createWorker(
  workerId: number,
  agent: string,
  workdir: string,
  copilotSessionName: string | null = null,
): WorkerInfo {
  const sessionName = `worker-${agent}`;
  const now = new Date().toISOString();
  return {
    source: 'repo',
    sessionName,
    displayName: `feat/${agent}`,
    workerId,
    repo: 'hydra',
    repoRoot: '/tmp/hydra',
    branch: `feat/${agent}`,
    slug: `feat-${agent}`,
    status: 'running',
    attached: false,
    agent,
    workdir,
    tmuxSession: sessionName,
    createdAt: now,
    lastSeenAt: now,
    sessionId: null,
    copilotSessionName,
  };
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-completion-hook-'));
  const home = path.join(root, 'home');
  const hydraHome = path.join(root, 'hydra');
  const configPath = path.join(hydraHome, 'config.json');
  const workdir = path.join(root, 'worktree');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(hydraHome, { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });

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
  process.env.HYDRA_CONFIG_PATH = configPath;
  process.env.HYDRA_TELEMETRY = '0';

  try {
    const { SessionManager } = await import('@hydra/core/sessionManager');
    const backend = new HookBackend();
    // Private hook installation is exercised deliberately as a core integration seam.
    const sessionManager = new SessionManager(backend) as unknown as {
      injectCompletionHook(
        worktreePath: string,
        agentType: string,
        info: { sessionName: string; workerId: number; lifecycleEpoch: string; agentType: string },
        includeCompletion?: boolean,
      ): boolean;
      launchPreparedWorker(input: Record<string, unknown>): Promise<{
        workerInfo: WorkerInfo;
        postCreatePromise: Promise<void>;
      }>;
    };

    const agents = [
      { agent: 'claude', workerId: 71, epoch: 'epoch-claude' },
      { agent: 'codex', workerId: 72, epoch: 'epoch-codex' },
      { agent: 'gemini', workerId: 73, epoch: 'epoch-gemini' },
      { agent: 'antigravity', workerId: 74, epoch: 'epoch-antigravity' },
    ];

    for (const item of agents) {
      assert.equal(sessionManager.injectCompletionHook(workdir, item.agent, {
        sessionName: `worker-${item.agent}`,
        workerId: item.workerId,
        lifecycleEpoch: item.epoch,
        agentType: item.agent,
      }), true);
      const scriptPath = path.join(hydraHome, 'hooks', `completion-worker-${item.workerId}.sh`);
      const script = fs.readFileSync(scriptPath, 'utf-8');
      assert.match(script, /hooks complete/);
      assert.match(script, new RegExp(`WORKER_ID='${item.workerId}'`));
      assert.match(script, new RegExp(`LIFECYCLE_EPOCH='${item.epoch}'`));
      assert.equal(script.includes(`worker-${item.agent}`), false, 'script must not copy the mutable session route');
      assert.equal(script.includes('copilot'), false, 'script must not copy parent routing');
      assert.equal(script.includes('.pending'), false, 'script must not read or write legacy pending state');
      assert.equal(script.includes('notify create'), false, 'script must emit a structured completion signal only');
      assert.notEqual(fs.statSync(scriptPath).mode & 0o111, 0, 'POSIX hook script should be executable');
    }

    const claudeConfig = readJson(path.join(workdir, '.claude', 'settings.json')) as {
      hooks?: Record<string, Array<{ hooks: Array<{ command: string; async?: boolean }> }>>;
    };
    assert.equal(claudeConfig.hooks?.Stop?.length, 1);
    assert.equal(claudeConfig.hooks?.Stop?.[0].hooks[0].async, true);
    assert.match(claudeConfig.hooks?.Stop?.[0].hooks[0].command || '', /completion-worker-71\.sh/);
    assert.match(claudeConfig.hooks?.PermissionRequest?.[0].hooks[0].command || '', /hooks needs-input/);
    assert.match(claudeConfig.hooks?.PreToolUse?.[0].hooks[0].command || '', /hooks needs-input/);

    const codexConfig = readJson(path.join(workdir, '.codex', 'hooks.json')) as {
      hooks?: { Stop?: Array<{ hooks: Array<{ command: string }> }> };
    };
    assert.match(codexConfig.hooks?.Stop?.[0].hooks[0].command || '', /completion-worker-72\.sh/);
    assert.match(codexConfig.hooks?.Stop?.[0].hooks[0].command || '', /printf '\{\}'/);

    const geminiConfig = readJson(path.join(workdir, '.gemini', 'settings.json')) as {
      hooks?: { AfterAgent?: Array<{ hooks: Array<{ command: string }> }> };
    };
    assert.match(geminiConfig.hooks?.AfterAgent?.[0].hooks[0].command || '', /completion-worker-73\.sh/);

    const antigravityConfig = readJson(path.join(home, '.gemini', 'config', 'hooks.json')) as Record<
      string,
      { Stop: Array<{ command: string }> }
    >;
    const antigravityCommand = antigravityConfig['hydra-notify-worker-antigravity'].Stop[0].command;
    assert.match(antigravityCommand, /completion-worker-74\.sh/);
    assert.match(antigravityCommand, /printf '%s' "\$payload" \|/);
    assert.match(antigravityCommand, new RegExp(workdir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const malformedWorkdir = path.join(root, 'malformed');
    const malformedConfig = path.join(malformedWorkdir, '.codex', 'hooks.json');
    fs.mkdirSync(path.dirname(malformedConfig), { recursive: true });
    fs.writeFileSync(malformedConfig, '{"hooks":[', 'utf-8');
    assert.equal(sessionManager.injectCompletionHook(malformedWorkdir, 'codex', {
      sessionName: 'worker-malformed',
      workerId: 99,
      lifecycleEpoch: 'epoch-malformed',
      agentType: 'codex',
    }), false);
    assert.equal(fs.readFileSync(malformedConfig, 'utf-8'), '{"hooks":[');
    assert.equal(fs.existsSync(path.join(hydraHome, 'hooks', 'completion-worker-99.sh')), false);

    const codexPromptBackend = new PromptBackend([
      [
        'Do you trust the contents of this directory?',
        '› 1. Yes, continue',
        '  2. No, quit',
      ].join('\n'),
      [
        'Hooks need review',
        '› 1. Review hooks',
        '  2. Trust all and continue',
        "  3. Continue without trusting (hooks won't run)",
      ].join('\n'),
      '› ',
    ]);
    const codexPromptManager = new SessionManager(codexPromptBackend) as unknown as {
      waitForAgentReady(sessionName: string, agentType: string): Promise<void>;
    };
    await codexPromptManager.waitForAgentReady('codex-prompt-test', 'codex');
    assert.deepEqual(codexPromptBackend.sentPromptKeys, ['', 'Down']);

    const geminiPromptBackend = new PromptBackend([
      [
        'Do you trust the files in this folder?',
        '● 1. Trust folder',
        "  2. Don't trust",
      ].join('\n'),
      '⏵',
    ]);
    const geminiPromptManager = new SessionManager(geminiPromptBackend) as unknown as {
      waitForAgentReady(sessionName: string, agentType: string): Promise<void>;
    };
    await geminiPromptManager.waitForAgentReady('gemini-prompt-test', 'gemini');
    assert.deepEqual(geminiPromptBackend.sentPromptKeys, ['']);

    const noParentWorkdir = path.join(root, 'no-parent-worktree');
    fs.mkdirSync(noParentWorkdir, { recursive: true });
    const noParent = await sessionManager.launchPreparedWorker({
      source: 'directory',
      sessionName: 'worker-no-parent',
      displayName: 'no-parent',
      slug: 'no-parent',
      workdir: noParentWorkdir,
      repo: null,
      repoRoot: null,
      branch: null,
      managedWorkdir: false,
      agentType: 'claude',
      agentCommand: 'claude',
      task: undefined,
      copilotSessionName: undefined,
      notifyCopilot: true,
    });
    await noParent.postCreatePromise;
    assert.equal(noParent.workerInfo.copilotSessionName, null);
    assert.equal(
      fs.existsSync(path.join(hydraHome, 'hooks', `completion-worker-${noParent.workerInfo.workerId}.sh`)),
      true,
      'workers without a parent still install completion signal hooks for global attention',
    );

    if (process.platform !== 'win32') {
      const workers = agents.map(item => createWorker(item.workerId, item.agent, workdir));
      fs.writeFileSync(path.join(hydraHome, 'sessions.json'), `${JSON.stringify({
        copilots: {},
        workers: Object.fromEntries(workers.map(worker => [worker.sessionName, worker])),
        nextWorkerId: 100,
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`, 'utf-8');

      const binDir = path.join(root, 'bin');
      const hydraWrapper = path.join(binDir, 'hydra');
      const cliEntry = path.resolve(__dirname, '..', 'cli', 'index.js');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(
        hydraWrapper,
        `#!/bin/sh\nexec node ${shellQuote(cliEntry)} "$@"\n`,
        { encoding: 'utf-8', mode: 0o755 },
      );

      const commands = [
        { ...agents[0], command: claudeConfig.hooks!.Stop![0].hooks[0].command, stdin: '{}' },
        { ...agents[1], command: codexConfig.hooks!.Stop![0].hooks[0].command, stdin: '{}' },
        { ...agents[2], command: geminiConfig.hooks!.AfterAgent![0].hooks[0].command, stdin: '{}' },
        {
          ...agents[3],
          command: antigravityCommand,
          stdin: JSON.stringify({ workspacePaths: [workdir], fullyIdle: true }),
        },
      ];
      const jobStore = new CompletionJobStore(path.join(hydraHome, 'completion-jobs.json'));
      for (const item of commands) {
        const worker = workers.find(candidate => candidate.workerId === item.workerId)!;
        const runId = `run-${item.agent}`;
        setWorkerRuntimeState({
          sessionName: worker.sessionName,
          state: 'running',
          origin: 'manual',
          reason: 'hook-smoke-dispatch',
          workerId: worker.workerId,
          lifecycleEpoch: item.epoch,
          runId,
          revision: 0,
          signalId: `dispatch-${item.agent}`,
          agent: worker.agent,
          workdir: worker.workdir,
        }, 'cli');
        jobStore.armForDispatch({
          workerId: worker.workerId,
          lifecycleEpoch: item.epoch,
          runId,
        }, {
          runtimeActive: true,
          runtimeRunId: runId,
        });
      }

      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        HYDRA_HOME: hydraHome,
        HYDRA_CONFIG_PATH: configPath,
        HYDRA_TELEMETRY: '0',
        PATH: `${binDir}:${process.env.PATH || ''}`,
      };
      for (const item of commands) {
        if (item.agent === 'antigravity') {
          execSync(item.command, {
            env,
            input: JSON.stringify({ workspacePaths: ['/other/worktree'] }),
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          assert.equal(jobStore.getPending(item.workerId)?.status, 'pending');
        }
        execSync(item.command, {
          env,
          input: item.stdin,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        execSync(item.command, {
          env,
          input: item.stdin,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        assert.equal(jobStore.getForRun(item.workerId, item.epoch, `run-${item.agent}`)?.status, 'fired');
      }

      const notifications = new NotificationStore().listOccurrences('active');
      assert.equal(notifications.length, agents.length);
      for (const item of agents) {
        const occurrences = notifications.filter(notification => notification.workerId === item.workerId);
        assert.equal(occurrences.length, 1, `${item.agent} repeated hook must stay idempotent`);
        assert.equal(occurrences[0].targetSession, null, 'global completion occurrence must not require a parent');
      }
    }

    console.log('completionHookSmoke: ok');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
