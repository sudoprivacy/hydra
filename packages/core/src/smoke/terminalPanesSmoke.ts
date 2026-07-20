import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { TmuxBackendCore } from '../core/tmux';
import { SessionManager } from '../core/sessionManager';

function tmux(socket: string, args: string[]): string {
  return execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' }).trim();
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main(): Promise<void> {
  if (process.platform === 'win32') {
    console.log('terminalPanesSmoke: skipped on Windows');
    return;
  }
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  } catch {
    console.log('terminalPanesSmoke: skipped (tmux unavailable)');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-terminal-panes-'));
  const socket = `hydra-terminal-panes-${process.pid}-${Date.now()}`;
  const previousSocket = process.env.HYDRA_TMUX_SOCKET;
  const previousHydraHome = process.env.HYDRA_HOME;
  process.env.HYDRA_TMUX_SOCKET = socket;
  process.env.HYDRA_HOME = path.join(tempDir, '.hydra');
  const backend = new TmuxBackendCore();
  const controller = backend.terminalPanes;
  const session = 'managed';

  try {
    await backend.createSession(session, tempDir);
    await backend.setSessionRole(session, 'copilot');
    await backend.setSessionWorkdir(session, tempDir);
    await backend.setSessionAgent(session, 'codex');
    const initial = await controller.list(session);
    assert.equal(initial.length, 1);
    assert.equal(initial[0].role, 'agent');
    assert.equal(initial[0].canClose, false);
    const agentPaneId = initial[0].paneId;

    await backend.sendKeys(session, "printf 'AGENT_BEFORE_SPLIT\\n'");
    await waitFor(
      async () => (await backend.capturePane(session, 30)).includes('AGENT_BEFORE_SPLIT'),
      'initial Agent output',
    );

    const firstRequestId = randomUUID();
    const afterFirst = await controller.create(session, {
      requestId: firstRequestId,
      direction: 'down',
      cwd: tempDir,
      targetPaneId: agentPaneId,
      command: "printf 'SHELL_COMMAND_OK\\n'",
    });
    assert.equal(afterFirst.length, 2);
    const shellOne = afterFirst.find(pane => pane.role === 'shell');
    assert.ok(shellOne);
    assert.equal(shellOne.label, 'Shell 1');
    assert.equal(shellOne.canClose, true);
    await waitFor(
      () => tmux(socket, ['capture-pane', '-p', '-t', shellOne.paneId, '-S', '-30'])
        .includes('SHELL_COMMAND_OK'),
      'optional shell command',
    );

    // A lost create response can retry with the same ID without duplicating a pane.
    const idempotent = await controller.create(session, {
      requestId: firstRequestId,
      direction: 'right',
      cwd: tempDir,
      targetPaneId: shellOne.paneId,
    });
    assert.equal(idempotent.length, 2);

    // The newly created shell is active; Agent automation must still hit the Agent pane.
    await backend.sendKeys(session, "printf 'AGENT_AFTER_SPLIT\\n'");
    await waitFor(
      async () => (await backend.capturePane(session, 30)).includes('AGENT_AFTER_SPLIT'),
      'Agent routing after shell focus',
    );
    assert.doesNotMatch(
      tmux(socket, ['capture-pane', '-p', '-t', shellOne.paneId, '-S', '-30']),
      /AGENT_AFTER_SPLIT/,
    );

    const afterSecond = await controller.create(session, {
      requestId: randomUUID(),
      direction: 'right',
      cwd: tempDir,
      targetPaneId: shellOne.paneId,
    });
    assert.equal(afterSecond.filter(pane => pane.role === 'shell').length, 2);

    const externalPaneId = tmux(socket, [
      'split-window', '-v', '-P', '-F', '#{pane_id}', '-t', agentPaneId, '-c', tempDir,
    ]);
    const withExternal = await controller.list(session);
    assert.equal(withExternal.length, 4);
    assert.equal(withExternal.find(pane => pane.paneId === externalPaneId)?.role, 'external');
    await assert.rejects(
      () => controller.close(session, agentPaneId),
      /protected/,
    );
    await assert.rejects(
      () => controller.close(session, externalPaneId),
      /external/,
    );
    await assert.rejects(
      () => controller.create(session, {
        requestId: randomUUID(),
        direction: 'down',
        cwd: tempDir,
        targetPaneId: agentPaneId,
      }),
      /already has 4 panes/,
    );

    const focused = await controller.focus(session, shellOne.paneId);
    assert.equal(focused.find(pane => pane.paneId === shellOne.paneId)?.active, true);
    const closed = await controller.close(session, shellOne.paneId);
    assert.equal(closed.outcome, 'closed');
    assert.equal(closed.panes.some(pane => pane.paneId === shellOne.paneId), false);
    const closedAgain = await controller.close(session, shellOne.paneId);
    assert.equal(closedAgain.outcome, 'already-closed');

    const legacySingle = 'legacy-single';
    tmux(socket, ['new-session', '-d', '-s', legacySingle, '-c', tempDir]);
    const migratedPane = await controller.resolveAgentPane(legacySingle);
    assert.match(migratedPane, /^%\d+$/);
    assert.equal(
      tmux(socket, ['show-options', '-qv', '-t', legacySingle, '@hydra-agent-pane']),
      migratedPane,
    );
    await assert.rejects(
      () => controller.close(session, migratedPane),
      /another tmux session/,
    );

    const legacyMulti = 'legacy-multi';
    tmux(socket, ['new-session', '-d', '-s', legacyMulti, '-c', tempDir]);
    tmux(socket, ['split-window', '-v', '-t', legacyMulti, '-c', tempDir]);
    await assert.rejects(
      () => controller.resolveAgentPane(legacyMulti),
      /multiple panes but no Agent pane metadata/,
    );

    // A surviving shell must not make a session look healthy after Agent loss.
    tmux(socket, ['kill-pane', '-t', agentPaneId]);
    const foreignStale = 'foreign-stale';
    tmux(socket, ['new-session', '-d', '-s', foreignStale, '-c', tempDir]);
    tmux(socket, [
      'set-option', '-t', foreignStale, '@hydra-agent-pane', '%999999',
    ]);
    tmux(socket, ['set-option', '-t', foreignStale, '@hydra-role', 'copilot']);
    tmux(socket, ['set-option', '-t', foreignStale, '@workdir', tempDir]);
    const listed = await backend.listSessions();
    const managed = listed.find(candidate => candidate.name === session);
    assert.equal(managed?.agentPaneId, agentPaneId);
    assert.equal(managed?.agentPaneAlive, false);

    fs.mkdirSync(process.env.HYDRA_HOME, { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(process.env.HYDRA_HOME, 'sessions.json'), JSON.stringify({
      copilots: {
        [session]: {
          sessionName: session,
          displayName: session,
          status: 'running',
          attached: false,
          agent: 'codex',
          copilotMode: 'normal',
          workdir: tempDir,
          tmuxSession: session,
          createdAt: now,
          lastSeenAt: now,
          sessionId: null,
          agentSessionFile: null,
        },
      },
      workers: {},
      nextWorkerId: 1,
      updatedAt: now,
    }));
    const reconciled = await new SessionManager(backend).sync();
    assert.equal(reconciled.copilots[session].status, 'stopped');
    assert.equal(await backend.hasSession(session), false, 'orphan shells are cleaned after Agent loss');
    assert.equal(
      await backend.hasSession(foreignStale),
      true,
      'stale metadata never authorizes cleanup of an unknown tmux session',
    );

    console.log('terminalPanesSmoke: ok');
  } finally {
    try {
      tmux(socket, ['kill-server']);
    } catch {
      // No server is also successful cleanup.
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (previousSocket === undefined) delete process.env.HYDRA_TMUX_SOCKET;
    else process.env.HYDRA_TMUX_SOCKET = previousSocket;
    if (previousHydraHome === undefined) delete process.env.HYDRA_HOME;
    else process.env.HYDRA_HOME = previousHydraHome;
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
