import assert from 'node:assert/strict';
import {
  buildListSessionsCommand,
  buildSessionInfoCommand,
  buildSessionPanePidsCommand,
} from '../core/tmux';
import { buildListLocalBranchesCommand } from '../core/git';
import { buildCurrentTmuxSessionNameCommand } from '../core/sessionIdentity';

// Regression test for issue #225 §1: every tmux/git format-spec argument must
// be wrapped in DOUBLE quotes, not single. cmd.exe on Windows does not strip
// single quotes, so single-quoted format specs reach git/tmux verbatim and
// silently corrupt every downstream parser (listSessions, getSessionInfo,
// getSessionPanePids, localBranchExists, getCurrentTmuxSessionName).
function main(): void {
  const previousSocket = process.env.HYDRA_TMUX_SOCKET;
  try {
    delete process.env.HYDRA_TMUX_SOCKET;

    const sessionName = 'repo_main';
    const commands: Array<[string, string]> = [
      ['buildListSessionsCommand', buildListSessionsCommand()],
      ['buildSessionInfoCommand', buildSessionInfoCommand(sessionName)],
      ['buildSessionPanePidsCommand', buildSessionPanePidsCommand(sessionName)],
      ['buildListLocalBranchesCommand', buildListLocalBranchesCommand()],
      ['buildCurrentTmuxSessionNameCommand', buildCurrentTmuxSessionNameCommand()],
    ];

    for (const [name, cmd] of commands) {
      assert.doesNotMatch(
        cmd,
        /'#\{/,
        `${name}: single-quoted tmux format spec found in: ${cmd}`,
      );
      assert.doesNotMatch(
        cmd,
        /'%\(/,
        `${name}: single-quoted git format spec found in: ${cmd}`,
      );
      assert.doesNotMatch(
        cmd,
        /'#S'/,
        `${name}: single-quoted #S format found in: ${cmd}`,
      );
    }

    assert.match(
      buildListSessionsCommand(),
      /-F "#\{session_name\}\|\|\|#\{session_windows\}\|\|\|#\{session_attached\}\|\|\|hydra-pane-v1\|\|\|#\{@hydra-agent-pane\}\|\|\|#\{@hydra-role\}\|\|\|#\{@hydra-agent\}\|\|\|#\{@workdir\}"$/,
    );
    assert.match(
      buildSessionInfoCommand(sessionName),
      /-p -t .*?repo_main.*? "#\{session_attached\}\|\|\|#\{session_activity\}"$/,
    );
    assert.match(
      buildSessionPanePidsCommand(sessionName),
      /-F "#\{pane_pid\}"$/,
    );
    assert.match(
      buildListLocalBranchesCommand(),
      /^git for-each-ref --format="%\(refname:short\)" refs\/heads$/,
    );
    assert.match(
      buildCurrentTmuxSessionNameCommand(),
      / display-message -p "#S"$/,
    );
  } finally {
    if (previousSocket === undefined) {
      delete process.env.HYDRA_TMUX_SOCKET;
    } else {
      process.env.HYDRA_TMUX_SOCKET = previousSocket;
    }
  }

  console.log('windowsFormatQuotingSmoke: ok');
}

main();
