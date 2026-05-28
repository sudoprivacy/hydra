import assert from 'node:assert/strict';
import { HYDRA_COPILOT_SESSION_ENV } from '../core/env';
import { buildSanitizedTmuxCommand, buildStoredTmuxEnvScrubCommand } from '../core/tmux';
import { buildTmuxMouseScrollbackCommand } from '../core/tmuxAttach';

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

    process.env[HYDRA_COPILOT_SESSION_ENV] = 'hydra-copilot-codex';
    assert.match(
      buildSanitizedTmuxCommand('new-session -d -s worker'),
      new RegExp(HYDRA_COPILOT_SESSION_ENV),
    );
    assert.match(
      buildStoredTmuxEnvScrubCommand('worker'),
      new RegExp(HYDRA_COPILOT_SESSION_ENV),
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
