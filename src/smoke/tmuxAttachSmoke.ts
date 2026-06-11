import assert from 'node:assert/strict';
import { HYDRA_COPILOT_SESSION_ENV } from '../core/env';
import {
  buildSanitizedTmuxCommand,
  buildStoredTmuxEnvScrubCommand,
  getTmuxSanitizedEnvKeys,
  isTmuxDuplicateSessionError,
} from '../core/tmux';
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

    const duplicateError = new Error('Command failed: tmux new-session\nduplicate session: hydra-copilot-sudocode');
    assert.equal(
      isTmuxDuplicateSessionError(duplicateError),
      true,
      'tmux/psmux duplicate-session failures should be classified for createSession reuse',
    );
    assert.equal(
      isTmuxDuplicateSessionError(new Error('no server running')),
      false,
      'unrelated tmux failures must not be treated as duplicates',
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
