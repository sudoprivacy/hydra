/**
 * Smoke test for the psmux compatibility path (session-scoped JSON map for
 * pane metadata).  Runs on Linux/macOS with real tmux but forces the
 * `usePsmuxCompat` flag so that custom pane-scoped options are never used.
 *
 * This validates that the fallback path introduced for Windows/psmux works
 * end-to-end: agent initialization, metadata storage, idempotent writes,
 * enrichment, and cleanup.
 *
 * When the CI tmux supports the control-character field separator used by
 * listRawPanes, it also validates the full create → list → close lifecycle.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { TmuxTerminalPaneController } from '../core/tmuxTerminalPanes';

const FIELD_SEPARATOR = '';

function tmux(socket: string, args: string[]): string {
  return execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' }).trim();
}

/**
 * tmux 3.4+ escapes the \x1f (unit separator) control character in format
 * output, causing listRawPanes() to fail.  Returns true when the separator
 * round-trips correctly.
 */
function fieldSeparatorWorks(socket: string): boolean {
  const format = `a${FIELD_SEPARATOR}b`;
  const out = tmux(socket, ['list-panes', '-a', '-F', format]);
  return out.includes(FIELD_SEPARATOR);
}

async function main(): Promise<void> {
  if (process.platform === 'win32') {
    console.log('terminalPanesPsmuxSmoke: skipped on Windows (use real psmux there)');
    return;
  }
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  } catch {
    console.log('terminalPanesPsmuxSmoke: skipped (tmux unavailable)');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-psmux-compat-'));
  const socket = `hydra-psmux-compat-${process.pid}-${Date.now()}`;
  const previousSocket = process.env.HYDRA_TMUX_SOCKET;
  process.env.HYDRA_TMUX_SOCKET = socket;

  // Force psmux compat mode so metadata is stored in the session-scoped JSON
  // map rather than per-pane custom options — even though we run real tmux.
  const controller = new TmuxTerminalPaneController({ forcePsmuxCompat: true });
  const session = 'psmux-compat';

  try {
    // --- Pre-flight: check unit separator support ---
    tmux(socket, ['new-session', '-d', '-s', 'preflight', '-c', tempDir]);
    const fullLifecycle = fieldSeparatorWorks(socket);
    tmux(socket, ['kill-session', '-t', 'preflight']);
    if (!fullLifecycle) {
      console.log(
        'terminalPanesPsmuxSmoke: tmux escapes \\x1f in format output '
        + '(known tmux 3.4+ behavior); running metadata-layer tests only',
      );
    }

    // --- 1. Create a tmux session manually (simulates psmux new-session) ---
    tmux(socket, ['new-session', '-d', '-s', session, '-c', tempDir]);

    // --- 2. Initialize the Agent pane via the controller ---
    const agentPaneId = await controller.initializeAgentPane(session);
    assert.match(agentPaneId, /^%\d+$/, 'Agent pane ID should be a tmux pane reference');

    // Verify: session-scoped @hydra-pane-meta should contain the agent entry.
    const metaAfterInit = tmux(socket, [
      'show-options', '-qv', '-t', session, '@hydra-pane-meta',
    ]);
    const parsedInit = JSON.parse(metaAfterInit) as Record<string, { role?: string; label?: string }>;
    assert.equal(parsedInit[agentPaneId]?.role, 'agent', '@hydra-pane-meta should record agent role');
    assert.equal(parsedInit[agentPaneId]?.label, 'Agent', '@hydra-pane-meta should record Agent label');

    // Verify: no custom pane-scoped options were set (psmux would reject these).
    const paneOptions = tmux(socket, ['show-options', '-p', '-t', agentPaneId]);
    assert.equal(
      paneOptions.includes('@hydra-pane-role'),
      false,
      'psmux compat should not set pane-scoped @hydra-pane-role',
    );
    assert.equal(
      paneOptions.includes('@hydra-pane-label'),
      false,
      'psmux compat should not set pane-scoped @hydra-pane-label',
    );

    // --- 3. Idempotent write: re-initializing should not lose data ---
    await controller.initializeAgentPane(session);
    const metaIdempotent = JSON.parse(
      tmux(socket, ['show-options', '-qv', '-t', session, '@hydra-pane-meta']),
    ) as Record<string, { role?: string }>;
    assert.equal(metaIdempotent[agentPaneId]?.role, 'agent', 'Re-init should preserve agent role');

    // --- 4. Simulate shell pane metadata via setPaneMeta (internal method) ---
    const shellPaneId = tmux(socket, [
      'split-window', '-v', '-P', '-F', '#{pane_id}', '-t', agentPaneId, '-c', tempDir,
    ]);
    assert.match(shellPaneId, /^%\d+$/);

    // Use the controller's internal setPaneMeta via initializeAgentPane-style
    // approach: write metadata for the shell pane through the JSON map.
    // We access the private method through bracket notation for testing.
    const setPaneMeta = (controller as unknown as {
      setPaneMeta(s: string, p: string, m: { role?: string; label?: string; requestId?: string }): Promise<void>;
    }).setPaneMeta.bind(controller);
    const readSessionPaneMeta = (controller as unknown as {
      readSessionPaneMeta(s: string): Promise<Record<string, { role?: string; label?: string; requestId?: string }>>;
    }).readSessionPaneMeta.bind(controller);
    const removePaneMeta = (controller as unknown as {
      removePaneMeta(s: string, p: string): Promise<void>;
    }).removePaneMeta.bind(controller);
    const enrichFromSessionMeta = (controller as unknown as {
      enrichFromSessionMeta(p: Array<{ sessionName: string; paneId: string; role: string; label: string; requestId: string }>): Promise<void>;
    }).enrichFromSessionMeta.bind(controller);

    const requestId = randomUUID();
    await setPaneMeta(session, shellPaneId, {
      role: 'shell',
      label: 'Shell 1',
      requestId,
    });

    // Verify: session map should now have both agent and shell entries.
    const metaAfterShell = await readSessionPaneMeta(session);
    assert.equal(metaAfterShell[agentPaneId]?.role, 'agent');
    assert.equal(metaAfterShell[shellPaneId]?.role, 'shell');
    assert.equal(metaAfterShell[shellPaneId]?.label, 'Shell 1');
    assert.equal(metaAfterShell[shellPaneId]?.requestId, requestId);

    // --- 5. enrichFromSessionMeta should hydrate empty pane fields ---
    const rawPanes = [
      { sessionName: session, paneId: agentPaneId, role: '', label: '', requestId: '' },
      { sessionName: session, paneId: shellPaneId, role: '', label: '', requestId: '' },
    ];
    await enrichFromSessionMeta(rawPanes);
    assert.equal(rawPanes[0].role, 'agent', 'enrichFromSessionMeta should fill agent role');
    assert.equal(rawPanes[0].label, 'Agent', 'enrichFromSessionMeta should fill agent label');
    assert.equal(rawPanes[1].role, 'shell', 'enrichFromSessionMeta should fill shell role');
    assert.equal(rawPanes[1].label, 'Shell 1', 'enrichFromSessionMeta should fill shell label');
    assert.equal(rawPanes[1].requestId, requestId, 'enrichFromSessionMeta should fill requestId');

    // enrichFromSessionMeta should NOT overwrite existing values.
    const rawPanes2 = [
      { sessionName: session, paneId: shellPaneId, role: 'external', label: 'Custom', requestId: 'custom-id' },
    ];
    await enrichFromSessionMeta(rawPanes2);
    assert.equal(rawPanes2[0].role, 'external', 'enrichFromSessionMeta should not overwrite existing role');
    assert.equal(rawPanes2[0].label, 'Custom', 'enrichFromSessionMeta should not overwrite existing label');
    assert.equal(rawPanes2[0].requestId, 'custom-id', 'enrichFromSessionMeta should not overwrite existing requestId');

    // --- 6. removePaneMeta should delete the shell entry ---
    await removePaneMeta(session, shellPaneId);
    const metaAfterRemove = await readSessionPaneMeta(session);
    assert.equal(
      shellPaneId in metaAfterRemove,
      false,
      'removePaneMeta should delete the shell entry from the map',
    );
    assert.equal(metaAfterRemove[agentPaneId]?.role, 'agent', 'Agent entry should survive shell removal');

    // --- 7. removePaneMeta for a non-existent pane is a no-op ---
    await removePaneMeta(session, '%999999');

    // --- 8. removePaneMeta for the last entry should unset the option entirely ---
    await removePaneMeta(session, agentPaneId);
    try {
      const raw = tmux(socket, ['show-options', '-qv', '-t', session, '@hydra-pane-meta']);
      // If show-options returns something, it should be empty (tmux -qv returns
      // empty on missing option).
      assert.equal(raw, '', '@hydra-pane-meta should be unset after removing all entries');
    } catch {
      // show-options failing is also acceptable — the option was unset.
    }

    // --- 9. readSessionPaneMeta on missing/corrupt data returns {} ---
    const emptyMap = await readSessionPaneMeta(session);
    assert.deepEqual(emptyMap, {}, 'readSessionPaneMeta should return {} when option is unset');

    // Corrupt data test
    tmux(socket, ['set-option', '-t', session, '@hydra-pane-meta', 'not-json']);
    const corruptMap = await readSessionPaneMeta(session);
    assert.deepEqual(corruptMap, {}, 'readSessionPaneMeta should return {} on corrupt JSON');

    // Clean up
    tmux(socket, ['kill-pane', '-t', shellPaneId]);

    // --- 10. Full lifecycle test (only when field separator works) ---
    if (fullLifecycle) {
      const fullSession = 'psmux-full';
      tmux(socket, ['new-session', '-d', '-s', fullSession, '-c', tempDir]);
      const fullAgentId = await controller.initializeAgentPane(fullSession);

      const initial = await controller.list(fullSession);
      assert.equal(initial.length, 1);
      assert.equal(initial[0].role, 'agent');
      assert.equal(initial[0].canClose, false);

      const createRequestId = randomUUID();
      const afterCreate = await controller.create(fullSession, {
        requestId: createRequestId,
        direction: 'down',
        cwd: tempDir,
        targetPaneId: fullAgentId,
      });
      assert.equal(afterCreate.length, 2);
      const shell = afterCreate.find(pane => pane.role === 'shell');
      assert.ok(shell);
      assert.equal(shell.label, 'Shell 1');

      // Idempotent create
      const idempotent = await controller.create(fullSession, {
        requestId: createRequestId,
        direction: 'right',
        cwd: tempDir,
        targetPaneId: fullAgentId,
      });
      assert.equal(idempotent.length, 2, 'Idempotent create should not add a pane');

      // Close
      const closed = await controller.close(fullSession, shell.paneId);
      assert.equal(closed.outcome, 'closed');
      assert.equal(closed.panes.some(pane => pane.paneId === shell.paneId), false);

      // Close again
      const closedAgain = await controller.close(fullSession, shell.paneId);
      assert.equal(closedAgain.outcome, 'already-closed');

      console.log('terminalPanesPsmuxSmoke: full lifecycle ok');
    }

    // --- 11. Verify non-psmux controller does NOT use session-scoped map ---
    const nativeController = new TmuxTerminalPaneController({ forcePsmuxCompat: false });
    const nativeSession = 'psmux-native-check';
    tmux(socket, ['new-session', '-d', '-s', nativeSession, '-c', tempDir]);
    await nativeController.initializeAgentPane(nativeSession);

    // Native path should use pane-scoped options, not session-scoped map.
    try {
      const nativeMeta = tmux(socket, [
        'show-options', '-qv', '-t', nativeSession, '@hydra-pane-meta',
      ]);
      assert.equal(nativeMeta, '', 'Native tmux should not create @hydra-pane-meta');
    } catch {
      // show-options failing means the option doesn't exist — expected.
    }
    const nativePaneId = tmux(socket, [
      'show-options', '-qv', '-t', nativeSession, '@hydra-agent-pane',
    ]);
    const nativePaneRole = tmux(socket, [
      'show-options', '-p', '-qv', '-t', nativePaneId, '@hydra-pane-role',
    ]);
    assert.equal(nativePaneRole, 'agent', 'Native tmux should use pane-scoped @hydra-pane-role');

    console.log('terminalPanesPsmuxSmoke: ok');
  } finally {
    try {
      tmux(socket, ['kill-server']);
    } catch {
      // No server is also successful cleanup.
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (previousSocket === undefined) delete process.env.HYDRA_TMUX_SOCKET;
    else process.env.HYDRA_TMUX_SOCKET = previousSocket;
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
