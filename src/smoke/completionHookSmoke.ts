/**
 * Smoke test for the agent completion hook injection.
 *
 * Part 1: Verifies that injectCompletionHook writes the correct hook
 *          config files and notification script for each agent type.
 *
 * Part 2: Runs the generated notification script against real tmux
 *          sessions and verifies the copilot receives the message.
 */

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const COPILOT_SESSION = 'hydra-smoke-hook-copilot';
const CAT_VISIBLE_COPIES_PER_NOTIFICATION = 2;
const CLI_PATH = path.resolve(__dirname, '..', 'cli', 'index.js');

interface StoredNotificationSmoke {
  id: string;
  kind: string;
  targetSession: string | null;
  sourceSession: string | null;
  dedupeKey?: string;
  action?: { type: string; session: string };
  context?: { workerId?: number; branch?: string | null; workdir?: string | null };
}

interface StoredEventSmoke {
  type: string;
  source: string;
  session?: string;
  payload?: {
    sourceSession?: string | null;
    targetSession?: string | null;
    notificationId?: string;
  };
}

function sq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function killSession(name: string): void {
  try { execSync(`tmux kill-session -t ${sq(name)}`, { stdio: 'ignore', timeout: 5000 }); } catch { /* */ }
}

function captureSession(name: string): string {
  return execSync(
    `tmux capture-pane -p -S -200 -t ${sq(name)}`,
    { encoding: 'utf-8', timeout: 5000 },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function installHydraCliShim(binDir: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  const posixShim = path.join(binDir, 'hydra');
  fs.writeFileSync(
    posixShim,
    ['#!/bin/sh', `exec ${sq(process.execPath)} ${sq(CLI_PATH)} "$@"`, ''].join('\n'),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binDir, 'hydra.cmd'),
    `@echo off\r\n"${process.execPath}" "${CLI_PATH}" %*\r\n`,
    'utf-8',
  );
}

function readStoredNotifications(hydraHome: string): StoredNotificationSmoke[] {
  const storePath = path.join(hydraHome, 'notifications.json');
  if (!fs.existsSync(storePath)) {
    return [];
  }
  const parsed = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as { notifications?: unknown[] };
  return (parsed.notifications || []) as StoredNotificationSmoke[];
}

function readStoredEvents(hydraHome: string): StoredEventSmoke[] {
  const eventsPath = path.join(hydraHome, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) {
    return [];
  }
  return fs.readFileSync(eventsPath, 'utf-8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as StoredEventSmoke);
}

class PromptBackend {
  readonly type = 'tmux' as const;
  readonly displayName = 'tmux';
  readonly installHint = '';
  readonly sentKeys: string[] = [];
  private captureIndex = 0;

  constructor(private readonly captures: string[]) {}

  async isInstalled(): Promise<boolean> { return true; }
  async listSessions(): Promise<unknown[]> { return []; }
  async createSession(): Promise<void> {}
  async killSession(): Promise<void> {}
  async renameSession(): Promise<void> {}
  async hasSession(): Promise<boolean> { return true; }
  async getSessionWorkdir(): Promise<string | undefined> { return undefined; }
  async setSessionWorkdir(): Promise<void> {}
  async getSessionRole(): Promise<undefined> { return undefined; }
  async setSessionRole(): Promise<void> {}
  async getSessionAgent(): Promise<string | undefined> { return undefined; }
  async setSessionAgent(): Promise<void> {}
  async sendKeys(_sessionName: string, keys: string): Promise<void> {
    this.sentKeys.push(keys);
    this.captureIndex = Math.min(this.captureIndex + 1, this.captures.length - 1);
  }
  async capturePane(): Promise<string> {
    return this.captures[Math.min(this.captureIndex, this.captures.length - 1)] || '';
  }
  async sendMessage(): Promise<void> {}
  async getSessionInfo(): Promise<{ attached: boolean; lastActive: number }> {
    return { attached: false, lastActive: 0 };
  }
  async getSessionPaneCount(): Promise<number> { return 1; }
  async getSessionPanePids(): Promise<string[]> { return []; }
  async splitPane(): Promise<void> {}
  async newWindow(): Promise<void> {}
  buildSessionName(repoName: string, slug: string): string { return `${repoName}_${slug}`; }
  sanitizeSessionName(name: string): string { return name; }
}

async function main(): Promise<void> {
  // Redirect Hydra state to a temp directory so we don't pollute the real one
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-smoke-hook-'));
  const origHome = process.env.HOME;
  const origPath = process.env.PATH;
  const origHydraHome = process.env.HYDRA_HOME;
  const origHydraConfigPath = process.env.HYDRA_CONFIG_PATH;
  process.env.HOME = tempHome;

  const hydraDir = path.join(tempHome, '.hydra');
  process.env.HYDRA_HOME = hydraDir;
  process.env.HYDRA_CONFIG_PATH = path.join(hydraDir, 'config.json');
  const shimDir = path.join(tempHome, 'bin');
  installHydraCliShim(shimDir);
  process.env.PATH = `${shimDir}${path.delimiter}${origPath || ''}`;
  const sessionsFile = path.join(hydraDir, 'sessions.json');

  // Seed a minimal sessions.json so readSessionState doesn't fail
  fs.mkdirSync(hydraDir, { recursive: true });
  fs.writeFileSync(sessionsFile, JSON.stringify({
    copilots: {}, workers: {}, nextWorkerId: 7, updatedAt: new Date().toISOString(),
  }));

  // Dynamic import so HOME override is in effect when modules resolve paths
  const { SessionManager } = await import('../core/sessionManager');
  const { TmuxBackendCore } = await import('../core/tmux');

  const backend = new TmuxBackendCore();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sm = new SessionManager(backend) as any;

  const fakeWorktree = path.join(tempHome, 'worktree');
  fs.mkdirSync(fakeWorktree, { recursive: true });

  const hookInfo = {
    copilotSessionName: 'repo_my-copilot',
    sessionName: 'repo_feat-auth',
    workerId: 7,
    displayName: 'feat-auth',
    source: 'repo',
    branch: 'feat/auth',
    workdir: fakeWorktree,
  };

  // ── Part 1: Verify hook config files for each agent ──

  // Claude
  sm['injectCompletionHook'](fakeWorktree, 'claude', hookInfo);
  const claudeConfig = JSON.parse(fs.readFileSync(path.join(fakeWorktree, '.claude', 'settings.json'), 'utf-8'));
  assert.ok(claudeConfig.hooks?.Stop, 'Claude config should have Stop hook');
  assert.equal(claudeConfig.hooks.Stop.length, 1);
  assert.equal(claudeConfig.hooks.Stop[0].hooks[0].type, 'command');
  assert.equal(claudeConfig.hooks.Stop[0].hooks[0].async, true, 'Claude hook should be async');
  const claudeCmd: string = claudeConfig.hooks.Stop[0].hooks[0].command;
  assert.ok(claudeCmd.includes('notify-repo_feat-auth.sh'), `Hook command should reference script, got: ${claudeCmd}`);

  // Codex
  sm['injectCompletionHook'](fakeWorktree, 'codex', hookInfo);
  const codexConfig = JSON.parse(fs.readFileSync(path.join(fakeWorktree, '.codex', 'hooks.json'), 'utf-8'));
  assert.ok(codexConfig.hooks?.Stop, 'Codex config should have Stop hook');
  assert.equal(codexConfig.hooks.Stop[0].hooks[0].type, 'command');
  assert.ok(
    codexConfig.hooks.Stop[0].hooks[0].command.includes("printf '{}'"),
    'Codex hook should emit JSON on stdout',
  );
  // Verify hooks feature flag is enabled in config.toml
  const codexToml = fs.readFileSync(path.join(fakeWorktree, '.codex', 'config.toml'), 'utf-8');
  assert.ok(codexToml.includes('hooks = true'), 'Codex config.toml should enable hooks feature flag');

  // Verify existing Codex [features] table is updated instead of duplicated
  const codexTomlPath = path.join(fakeWorktree, '.codex', 'config.toml');
  fs.writeFileSync(codexTomlPath, '[features]\nexperimental = true\n\n[model]\nname = "gpt-5"\n');
  sm['ensureCodexHooksEnabled'](codexTomlPath);
  const mergedCodexToml = fs.readFileSync(codexTomlPath, 'utf-8');
  assert.equal((mergedCodexToml.match(/^\[features\]$/gm) || []).length, 1);
  assert.ok(
    mergedCodexToml.includes('[features]\nhooks = true\nexperimental = true\n\n[model]'),
    `Codex config.toml should merge into existing [features], got:\n${mergedCodexToml}`,
  );

  // Gemini
  sm['injectCompletionHook'](fakeWorktree, 'gemini', hookInfo);
  const geminiConfig = JSON.parse(fs.readFileSync(path.join(fakeWorktree, '.gemini', 'settings.json'), 'utf-8'));
  assert.ok(geminiConfig.hooks?.AfterAgent, 'Gemini config should have AfterAgent hook');
  assert.equal(geminiConfig.hooks.AfterAgent[0].matcher, '*', 'Gemini hook should have matcher: "*"');
  assert.equal(geminiConfig.hooks.AfterAgent[0].hooks[0].name, 'hydra-notify-copilot');
  assert.equal(geminiConfig.hooks.AfterAgent[0].hooks[0].type, 'command');
  assert.equal(geminiConfig.hooks.AfterAgent[0].hooks[0].timeout, 5000);
  assert.ok(
    geminiConfig.hooks.AfterAgent[0].hooks[0].command.includes("printf '{}'"),
    'Gemini hook should emit JSON on stdout',
  );

  // Custom (should produce no config)
  sm['injectCompletionHook'](fakeWorktree, 'custom', hookInfo);
  assert.ok(!fs.existsSync(path.join(fakeWorktree, '.custom')), 'Custom agent should not produce config');

  // Verify notification script exists and is executable
  const scriptPath = path.join(hydraDir, 'hooks', `notify-${hookInfo.sessionName}.sh`);
  assert.ok(fs.existsSync(scriptPath), 'Notification script should exist');
  const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
  assert.ok(scriptContent.includes('load-buffer'), 'Script should use load-buffer');
  assert.ok(scriptContent.includes('paste-buffer'), 'Script should use paste-buffer');
  assert.ok(scriptContent.includes(hookInfo.copilotSessionName), 'Script should reference copilot session');
  assert.ok(scriptContent.includes('HYDRA_TMUX_SOCKET'), 'Script should handle custom tmux socket');
  assert.ok(scriptContent.includes('PENDING='), 'Script should have a per-message pending marker');
  assert.ok(scriptContent.includes('LOCKDIR='), 'Script should use a lock for duplicate hook entries');
  assert.ok(scriptContent.includes('notify create'), 'Script should create structured notifications');
  assert.ok(scriptContent.includes('DEDUPE='), 'Script should use a notification dedupe key');

  const codexLaunch = sm['withCodexCompletionHookOverrides'](
    'codex',
    ['/tmp/hydra-primary-repo', '/tmp/hydra-worker-worktree'],
    scriptPath,
  );
  assert.ok(codexLaunch.includes('"/tmp/hydra-primary-repo"={trust_level="trusted"}'));
  assert.ok(codexLaunch.includes('"/tmp/hydra-worker-worktree"={trust_level="trusted"}'));

  // Verify merge behavior: inject again and check Claude has 2 Stop entries
  sm['injectCompletionHook'](fakeWorktree, 'claude', hookInfo);
  const claudeConfig2 = JSON.parse(fs.readFileSync(path.join(fakeWorktree, '.claude', 'settings.json'), 'utf-8'));
  assert.equal(claudeConfig2.hooks.Stop.length, 2, 'Merge should append, not overwrite');

  console.log('  Part 1 (config injection): ok');

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
  const codexPromptSm = new SessionManager(codexPromptBackend as never) as never as { waitForAgentReady: (sessionName: string, agentType: string) => Promise<void> };
  await codexPromptSm.waitForAgentReady('codex-prompt-test', 'codex');
  assert.deepEqual(codexPromptBackend.sentKeys, ['', 'Down']);

  const geminiPromptBackend = new PromptBackend([
    [
      'Do you trust the files in this folder?',
      '● 1. Trust folder',
      "  2. Don't trust",
    ].join('\n'),
    '⏵',
  ]);
  const geminiPromptSm = new SessionManager(geminiPromptBackend as never) as never as { waitForAgentReady: (sessionName: string, agentType: string) => Promise<void> };
  await geminiPromptSm.waitForAgentReady('gemini-prompt-test', 'gemini');
  assert.deepEqual(geminiPromptBackend.sentKeys, ['']);

  console.log('  Part 1b (trust prompt handling): ok');

  // ── Part 1c: Two-step worker creation (no --task) still installs hook ──
  // Drives the real launchPreparedWorker path with task=undefined to make
  // sure the gate fix sticks. Notification firing is covered in Part 2.

  const noTaskBackend = new PromptBackend(['⏵']);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noTaskSm = new SessionManager(noTaskBackend as never) as any;

  const noTaskWorktree = path.join(tempHome, 'no-task-worktree');
  fs.mkdirSync(noTaskWorktree, { recursive: true });

  const noTaskSession = 'repo_no-task-worker';
  const noTaskResult = await noTaskSm['launchPreparedWorker']({
    source: 'directory',
    sessionName: noTaskSession,
    displayName: 'no-task-worker',
    slug: 'no-task-worker',
    workdir: noTaskWorktree,
    repo: null,
    repoRoot: null,
    branch: null,
    managedWorkdir: false,
    agentType: 'claude',
    agentCommand: 'claude',
    task: undefined,
    copilotSessionName: 'repo_copilot',
    notifyCopilot: true,
  });
  await noTaskResult.postCreatePromise;

  const noTaskScriptPath = path.join(hydraDir, 'hooks', `notify-${noTaskSession}.sh`);
  assert.ok(
    fs.existsSync(noTaskScriptPath),
    'Two-step worker: notify script should be written even without --task',
  );
  const noTaskClaudeConfig = JSON.parse(
    fs.readFileSync(path.join(noTaskWorktree, '.claude', 'settings.json'), 'utf-8'),
  );
  assert.ok(
    Array.isArray(noTaskClaudeConfig.hooks?.Stop) && noTaskClaudeConfig.hooks.Stop.length >= 1,
    'Two-step worker: .claude/settings.json should have Stop hook',
  );

  const noTaskPending = path.join(hydraDir, 'hooks', `notify-${noTaskSession}.pending`);
  assert.ok(
    !fs.existsSync(noTaskPending),
    'Two-step worker: no .pending should exist before any worker send',
  );

  // Simulate `hydra worker send`: arming creates the pending marker.
  noTaskSm['armCompletionNotification'](noTaskSession);
  assert.ok(
    fs.existsSync(noTaskPending),
    'Two-step worker: .pending should exist after armCompletionNotification',
  );
  fs.rmSync(noTaskPending);

  // Verify the gate still blocks workers with no copilot (real-CLI worker case).
  const noCopilotBackend = new PromptBackend(['⏵']);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noCopilotSm = new SessionManager(noCopilotBackend as never) as any;
  const noCopilotWorktree = path.join(tempHome, 'no-copilot-worktree');
  fs.mkdirSync(noCopilotWorktree, { recursive: true });
  const noCopilotSession = 'repo_no-copilot-worker';
  const noCopilotResult = await noCopilotSm['launchPreparedWorker']({
    source: 'directory',
    sessionName: noCopilotSession,
    displayName: 'no-copilot-worker',
    slug: 'no-copilot-worker',
    workdir: noCopilotWorktree,
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
  await noCopilotResult.postCreatePromise;
  assert.ok(
    !fs.existsSync(path.join(noCopilotWorktree, '.claude', 'settings.json')),
    'No-copilot worker: hook config must not be installed when there is no parent copilot',
  );
  assert.ok(
    !fs.existsSync(path.join(hydraDir, 'hooks', `notify-${noCopilotSession}.sh`)),
    'No-copilot worker: notify script must not be written when there is no parent copilot',
  );

  console.log('  Part 1c (two-step worker creation hook install): ok');

  // ── Part 2: Run the notification script against real tmux ──

  try {
    execSync('which tmux', { stdio: 'ignore' });
  } catch {
    console.log('  Part 2: SKIP (tmux not available)');
    console.log('completionHookSmoke: ok');
    return;
  }

  killSession(COPILOT_SESSION);

  try {
    // Create a copilot session running cat (to receive the notification)
    execSync(
      `tmux new-session -d -s ${sq(COPILOT_SESSION)} -x 80 -y 24 -- cat`,
      { timeout: 5000 },
    );
    await sleep(500);

    // Write test-specific hook configs that target our test copilot
    const runtimeWorktree = path.join(tempHome, 'runtime-worktree');
    fs.mkdirSync(runtimeWorktree, { recursive: true });
    const runtimeInfos = {
      claude: {
        ...hookInfo,
        copilotSessionName: COPILOT_SESSION,
        sessionName: 'repo_feat-auth-claude',
        workerId: 71,
        displayName: 'feat-auth-claude',
        branch: 'feat/auth-claude',
        workdir: runtimeWorktree,
      },
      codex: {
        ...hookInfo,
        copilotSessionName: COPILOT_SESSION,
        sessionName: 'repo_feat-auth-codex',
        workerId: 72,
        displayName: 'feat-auth-codex',
        branch: 'feat/auth-codex',
        workdir: runtimeWorktree,
      },
      gemini: {
        ...hookInfo,
        copilotSessionName: COPILOT_SESSION,
        sessionName: 'repo_feat-auth-gemini',
        workerId: 73,
        displayName: 'feat-auth-gemini',
        branch: 'feat/auth-gemini',
        workdir: runtimeWorktree,
      },
    };
    sm['injectCompletionHook'](runtimeWorktree, 'claude', runtimeInfos.claude);
    sm['injectCompletionHook'](runtimeWorktree, 'codex', runtimeInfos.codex);
    sm['injectCompletionHook'](runtimeWorktree, 'gemini', runtimeInfos.gemini);

    const runtimeClaudeConfig = JSON.parse(
      fs.readFileSync(path.join(runtimeWorktree, '.claude', 'settings.json'), 'utf-8'),
    );
    const runtimeCodexConfig = JSON.parse(
      fs.readFileSync(path.join(runtimeWorktree, '.codex', 'hooks.json'), 'utf-8'),
    );
    const runtimeGeminiConfig = JSON.parse(
      fs.readFileSync(path.join(runtimeWorktree, '.gemini', 'settings.json'), 'utf-8'),
    );

    const hookCommands = [
      {
        agent: 'claude',
        command: runtimeClaudeConfig.hooks.Stop[0].hooks[0].command,
        expectedStdout: '',
        info: runtimeInfos.claude,
      },
      {
        agent: 'codex',
        command: runtimeCodexConfig.hooks.Stop[0].hooks[0].command,
        expectedStdout: '{}',
        info: runtimeInfos.codex,
      },
      {
        agent: 'gemini',
        command: runtimeGeminiConfig.hooks.AfterAgent[0].hooks[0].command,
        expectedStdout: '{}',
        info: runtimeInfos.gemini,
      },
    ];

    // Without a Hydra-armed pending marker, the hook should be a no-op. This
    // covers users typing directly in an attached worker terminal.
    for (const { agent, command, expectedStdout, info } of hookCommands) {
      const stdout = execSync(command, {
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env, HOME: tempHome },
      });
      assert.equal(stdout, expectedStdout, `${agent} unarmed hook stdout should match agent contract`);
      const pendingPath = path.join(hydraDir, 'hooks', `notify-${info.sessionName}.pending`);
      assert.ok(!fs.existsSync(pendingPath), `${agent} unarmed hook should not create pending marker`);
    }

    await sleep(500);
    let paneOutput = captureSession(COPILOT_SESSION);
    assert.equal(
      countOccurrences(paneOutput, 'has completed'),
      0,
      `Unarmed hooks should not notify copilot, got:\n${paneOutput}`,
    );

    // Execute the exact command each agent hook config would run twice after
    // arming. The first run should notify and consume pending; the second run
    // should be a no-op until Hydra arms another copilot-originated message.
    for (const { agent, command, expectedStdout, info } of hookCommands) {
      sm['armCompletionNotification'](info.sessionName);
      const pendingPath = path.join(hydraDir, 'hooks', `notify-${info.sessionName}.pending`);
      assert.ok(fs.existsSync(pendingPath), `${agent} pending marker should exist before hook`);

      for (let run = 1; run <= 2; run++) {
        const stdout = execSync(command, {
          encoding: 'utf-8',
          timeout: 5000,
          env: { ...process.env, HOME: tempHome },
        });
        assert.equal(stdout, expectedStdout, `${agent} hook stdout should match agent contract on run ${run}`);
      }

      assert.ok(!fs.existsSync(pendingPath), `${agent} hook should consume pending marker after notification`);
    }

    await sleep(1000);

    // Capture the copilot pane and verify one notification arrived per agent.
    paneOutput = captureSession(COPILOT_SESSION);

    assert.equal(
      countOccurrences(paneOutput, 'has completed'),
      hookCommands.length * CAT_VISIBLE_COPIES_PER_NOTIFICATION,
      `Copilot pane should contain one notification per agent, got:\n${paneOutput}`,
    );
    for (const { agent, info } of hookCommands) {
      assert.equal(
        countOccurrences(paneOutput, `Worker #${info.workerId}`),
        CAT_VISIBLE_COPIES_PER_NOTIFICATION,
        `${agent} notification should appear exactly once, got:\n${paneOutput}`,
      );
    }
    const firstNotifications = readStoredNotifications(hydraDir);
    assert.equal(
      firstNotifications.length,
      hookCommands.length,
      `Structured store should contain one completion notification per agent, got:\n${JSON.stringify(firstNotifications, null, 2)}`,
    );
    const firstEvents = readStoredEvents(hydraDir).filter(event => event.type === 'notify.created' && event.source === 'hook');
    assert.equal(firstEvents.length, hookCommands.length, 'Hook notifications should emit notify.created events');
    for (const { agent, info } of hookCommands) {
      const stored = firstNotifications.filter(notification => notification.sourceSession === info.sessionName);
      assert.equal(stored.length, 1, `${agent} should create exactly one structured notification`);
      assert.equal(stored[0].kind, 'complete');
      assert.equal(stored[0].targetSession, COPILOT_SESSION);
      assert.equal(stored[0].action?.type, 'open-session');
      assert.equal(stored[0].action?.session, info.sessionName);
      assert.equal(stored[0].context?.workerId, info.workerId);
      assert.equal(stored[0].context?.branch, info.branch);
      assert.equal(stored[0].context?.workdir, info.workdir);
      assert.ok(stored[0].dedupeKey?.startsWith(`completion:${info.sessionName}:`));
      const event = firstEvents.find(candidate => candidate.payload?.sourceSession === info.sessionName);
      assert.ok(event, `${agent} should create a hook-sourced notify.created event`);
      assert.equal(event?.payload?.targetSession, COPILOT_SESSION);
    }

    // Re-arm to simulate a later copilot-originated worker message. The hook
    // should notify again after that message completes.
    for (const { command, expectedStdout, info } of hookCommands) {
      sm['armCompletionNotification'](info.sessionName);
      const stdout = execSync(command, {
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env, HOME: tempHome },
      });
      assert.equal(stdout, expectedStdout);
    }

    await sleep(1000);
    paneOutput = captureSession(COPILOT_SESSION);
    for (const { agent, info } of hookCommands) {
      assert.equal(
        countOccurrences(paneOutput, `Worker #${info.workerId}`),
        2 * CAT_VISIBLE_COPIES_PER_NOTIFICATION,
        `${agent} notification should appear again after re-arm, got:\n${paneOutput}`,
      );
    }
    const secondNotifications = readStoredNotifications(hydraDir);
    assert.equal(
      secondNotifications.length,
      hookCommands.length * 2,
      'Structured store should append one new notification per re-armed hook',
    );

    console.log('  Part 2 (live tmux arm/consume notification): ok');

    // ── Part 2b: Two-step worker (no --task) → arm later → notification fires ──
    // Drives launchPreparedWorker with task=undefined, then mimics the CLI's
    // worker-send path (arm + run the agent-configured hook) and checks the
    // copilot pane receives one paste-buffer message.

    const twoStepBackend = new PromptBackend(['⏵']);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const twoStepSm = new SessionManager(twoStepBackend as never) as any;
    const twoStepWorktree = path.join(tempHome, 'two-step-runtime-worktree');
    fs.mkdirSync(twoStepWorktree, { recursive: true });
    const twoStepSession = 'repo_two-step-claude';
    const twoStepWorkerId = 99;

    const twoStepResult = await twoStepSm['launchPreparedWorker']({
      source: 'directory',
      sessionName: twoStepSession,
      displayName: 'two-step-claude',
      slug: 'two-step-claude',
      workdir: twoStepWorktree,
      repo: null,
      repoRoot: null,
      branch: null,
      managedWorkdir: false,
      agentType: 'claude',
      agentCommand: 'claude',
      task: undefined,
      copilotSessionName: COPILOT_SESSION,
      notifyCopilot: true,
      preservedWorkerInfo: {
        source: 'directory',
        sessionName: twoStepSession,
        displayName: 'two-step-claude',
        workerId: twoStepWorkerId,
        repo: null,
        repoRoot: null,
        branch: null,
        slug: 'two-step-claude',
        status: 'running',
        attached: false,
        agent: 'claude',
        workdir: twoStepWorktree,
        managedWorkdir: false,
        tmuxSession: twoStepSession,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        sessionId: null,
        agentSessionFile: null,
        copilotSessionName: COPILOT_SESSION,
      },
    });
    await twoStepResult.postCreatePromise;

    const twoStepClaudeConfig = JSON.parse(
      fs.readFileSync(path.join(twoStepWorktree, '.claude', 'settings.json'), 'utf-8'),
    );
    const twoStepHookCommand: string = twoStepClaudeConfig.hooks.Stop[0].hooks[0].command;
    const twoStepPending = path.join(hydraDir, 'hooks', `notify-${twoStepSession}.pending`);
    assert.ok(
      !fs.existsSync(twoStepPending),
      'Two-step E2E: no .pending before any worker send',
    );

    twoStepSm['armCompletionNotification'](twoStepSession);
    assert.ok(
      fs.existsSync(twoStepPending),
      'Two-step E2E: .pending exists after armCompletionNotification',
    );

    // Directory-source notification reads "Task worker #N" (lowercase 'worker').
    const twoStepMarker = `worker #${twoStepWorkerId}`;
    const paneBefore = captureSession(COPILOT_SESSION);
    const noticesBefore = countOccurrences(paneBefore, twoStepMarker);

    execSync(twoStepHookCommand, {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, HOME: tempHome },
    });

    await sleep(1000);
    assert.ok(
      !fs.existsSync(twoStepPending),
      'Two-step E2E: hook should consume .pending after firing',
    );

    const paneAfter = captureSession(COPILOT_SESSION);
    const noticesAfter = countOccurrences(paneAfter, twoStepMarker);
    assert.equal(
      noticesAfter - noticesBefore,
      CAT_VISIBLE_COPIES_PER_NOTIFICATION,
      `Two-step E2E: copilot pane should gain one notification, got:\n${paneAfter}`,
    );
    const twoStepNotifications = readStoredNotifications(hydraDir)
      .filter(notification => notification.sourceSession === twoStepSession);
    assert.equal(twoStepNotifications.length, 1, 'Two-step E2E: structured notification should be created');
    assert.equal(twoStepNotifications[0].kind, 'complete');
    assert.equal(twoStepNotifications[0].targetSession, COPILOT_SESSION);
    assert.equal(twoStepNotifications[0].context?.workerId, twoStepWorkerId);
    const twoStepEvents = readStoredEvents(hydraDir)
      .filter(event => event.type === 'notify.created' && event.source === 'hook' && event.payload?.sourceSession === twoStepSession);
    assert.equal(twoStepEvents.length, 1, 'Two-step E2E: notify.created event should be created');

    console.log('  Part 2b (two-step worker end-to-end notification): ok');
  } finally {
    killSession(COPILOT_SESSION);
  }

  // Restore environment
  if (origHome) process.env.HOME = origHome;
  else delete process.env.HOME;
  if (origPath) process.env.PATH = origPath;
  else delete process.env.PATH;
  if (origHydraHome) process.env.HYDRA_HOME = origHydraHome;
  else delete process.env.HYDRA_HOME;
  if (origHydraConfigPath) process.env.HYDRA_CONFIG_PATH = origHydraConfigPath;
  else delete process.env.HYDRA_CONFIG_PATH;
  fs.rmSync(tempHome, { recursive: true, force: true });

  console.log('completionHookSmoke: ok');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
