import assert from 'node:assert/strict';
import { HYDRA_COPILOT_SESSION_ENV } from '../core/env';
import {
  buildSanitizedTmuxCommand,
  buildStoredTmuxEnvScrubCommand,
  getTmuxSanitizedEnvKeys,
  parseListSessionsOutput,
  parseSessionInfoOutput,
} from '../core/tmux';
import { buildTmuxMouseScrollbackCommand } from '../core/tmuxAttach';
import { withUtf8Locale } from '../core/path';

function main(): void {
  const previousSocket = process.env.HYDRA_TMUX_SOCKET;
  const previousCopilotSession = process.env[HYDRA_COPILOT_SESSION_ENV];

  try {
    delete process.env.HYDRA_TMUX_SOCKET;
    const plainCommand = buildTmuxMouseScrollbackCommand("repo_worker's-task");

    if (process.platform === 'win32') {
      assert.equal(
        plainCommand,
        "psmux set-option -t 'repo_worker''s-task' mouse on *>$null",
      );
    } else {
      assert.equal(
        plainCommand,
        "tmux set-option -t 'repo_worker'\\''s-task' mouse on >/dev/null 2>&1 || true",
      );

      process.env.HYDRA_TMUX_SOCKET = 'hydra test socket';
      assert.equal(
        buildTmuxMouseScrollbackCommand('repo_worker'),
        "tmux '-L' 'hydra test socket' set-option -t 'repo_worker' mouse on >/dev/null 2>&1 || true",
      );
    }

    // Sanitization is no longer baked into the command string (env -u doesn't
    // exist on Windows). Callers pass the keys to exec via unsetEnv instead.
    delete process.env.HYDRA_TMUX_SOCKET;
    process.env[HYDRA_COPILOT_SESSION_ENV] = 'hydra-copilot-codex';
    const expectedBinary = process.platform === 'win32' ? 'psmux' : 'tmux';
    assert.equal(
      buildSanitizedTmuxCommand('new-session -d -s worker'),
      `${expectedBinary} new-session -d -s worker`,
    );
    assert.ok(
      getTmuxSanitizedEnvKeys().includes(HYDRA_COPILOT_SESSION_ENV),
      `getTmuxSanitizedEnvKeys() should include ${HYDRA_COPILOT_SESSION_ENV}`,
    );
    assert.match(
      buildStoredTmuxEnvScrubCommand('worker'),
      new RegExp(HYDRA_COPILOT_SESSION_ENV),
    );

    const sessions = parseListSessionsOutput([
      'detached|||1|||0|||worker|||codex|||/tmp/hydra worker',
      'one-client|||2|||1|||copilot|||claude|||/tmp/copilot',
      'two-clients|||1|||2|||||||||',
      'three-clients|||1|||3|||worker|||custom|||/tmp/with|||delimiter',
      'pane-aware|||1|||0|||hydra-pane-v1|||%42|||worker|||codex|||/tmp/pane-aware',
    ].join('\n'));
    assert.deepEqual(
      sessions.map(session => ({
        name: session.name,
        attached: session.attached,
        attachedClients: session.attachedClients,
      })),
      [
        { name: 'detached', attached: false, attachedClients: 0 },
        { name: 'one-client', attached: true, attachedClients: 1 },
        { name: 'two-clients', attached: true, attachedClients: 2 },
        { name: 'three-clients', attached: true, attachedClients: 3 },
        { name: 'pane-aware', attached: false, attachedClients: 0 },
      ],
    );
    assert.equal(sessions[0].role, 'worker');
    assert.equal(sessions[0].agent, 'codex');
    assert.equal(sessions[0].workdir, '/tmp/hydra worker');
    assert.equal(sessions[1].role, 'copilot');
    assert.equal(sessions[2].role, undefined);
    assert.equal(sessions[2].agent, undefined);
    assert.equal(sessions[2].workdir, undefined);
    assert.equal(sessions[3].workdir, '/tmp/with|||delimiter');
    assert.equal(sessions[4].agentPaneId, '%42');
    assert.equal(sessions[4].workdir, '/tmp/pane-aware');
    assert.deepEqual(
      parseSessionInfoOutput('3|||1710000000'),
      { attached: true, attachedClients: 3, lastActive: 1710000000 },
    );
    assert.deepEqual(
      parseSessionInfoOutput('0|||invalid'),
      { attached: false, attachedClients: 0, lastActive: 0 },
    );

    const guiEnv = withUtf8Locale({ PATH: '/usr/bin' }, 'darwin');
    assert.equal(guiEnv.LC_ALL, 'en_US.UTF-8');
    assert.equal(guiEnv.LC_CTYPE, 'en_US.UTF-8');
    assert.equal(guiEnv.LANG, 'en_US.UTF-8');
    assert.equal(
      withUtf8Locale({ LANG: 'zh_CN.UTF-8' }, 'darwin').LANG,
      'zh_CN.UTF-8',
    );
    assert.deepEqual(
      withUtf8Locale({ PATH: 'C:\\Windows' }, 'win32'),
      { PATH: 'C:\\Windows' },
    );
  } finally {
    if (previousSocket === undefined) {
      delete process.env.HYDRA_TMUX_SOCKET;
    } else {
      process.env.HYDRA_TMUX_SOCKET = previousSocket;
    }
    if (previousCopilotSession === undefined) {
      delete process.env[HYDRA_COPILOT_SESSION_ENV];
    } else {
      process.env[HYDRA_COPILOT_SESSION_ENV] = previousCopilotSession;
    }
  }

  console.log('tmuxAttachSmoke: ok');
}

main();
