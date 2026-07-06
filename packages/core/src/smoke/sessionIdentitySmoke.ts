import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HYDRA_COPILOT_SESSION_ENV } from '../core/env';
import {
  detectCurrentTmuxIdentity,
  detectIdentity,
  detectIdentityBySessionName,
  getWorkerCreationBlockedMessage,
} from '../core/sessionIdentity';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

async function main(): Promise<void> {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-session-identity-'));
  process.env.HOME = tempHome;
  process.env.HYDRA_HOME = path.join(tempHome, '.hydra');
  delete process.env.HYDRA_TMUX_SOCKET;

  const workerWorkdir = path.join(tempHome, '.hydra', 'worktrees', 'repo-id', 'fix-nested-workers');
  const workerChildDir = path.join(workerWorkdir, 'src', 'commands');
  fs.mkdirSync(workerChildDir, { recursive: true });

  const copilotWorkdir = tempHome;
  const sessionsFile = path.join(process.env.HYDRA_HOME, 'sessions.json');
  writeJson(sessionsFile, {
    copilots: {
      'hydra-copilot-codex': {
        sessionName: 'hydra-copilot-codex',
        displayName: 'hydra-copilot-codex',
        agent: 'codex',
        workdir: copilotWorkdir,
        sessionId: 'copilot-session-id',
      },
    },
    workers: {
      'repo-id_fix-nested-workers': {
        sessionName: 'repo-id_fix-nested-workers',
        displayName: 'fix-nested-workers',
        workerId: 7,
        repo: 'repo',
        repoRoot: path.join(tempHome, 'repo'),
        branch: 'fix/nested-workers',
        slug: 'fix-nested-workers',
        status: 'running',
        attached: false,
        agent: 'codex',
        workdir: workerWorkdir,
        tmuxSession: 'repo-id_fix-nested-workers',
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        sessionId: 'worker-session-id',
        copilotSessionName: 'hydra-copilot-codex',
      },
    },
    nextWorkerId: 8,
    updatedAt: new Date().toISOString(),
  });

  const workerIdentity = detectIdentity(workerChildDir);
  assert.equal(workerIdentity?.role, 'worker');
  assert.equal(workerIdentity?.sessionName, 'repo-id_fix-nested-workers');
  assert.match(getWorkerCreationBlockedMessage(workerIdentity!), /parent copilot "hydra-copilot-codex"/);

  const workerSessionIdentity = detectIdentityBySessionName('repo-id_fix-nested-workers');
  assert.equal(workerSessionIdentity?.role, 'worker');
  assert.equal(workerSessionIdentity?.sessionName, 'repo-id_fix-nested-workers');

  const fakeBinDir = path.join(tempHome, 'bin');
  fs.mkdirSync(fakeBinDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBinDir, 'tmux'),
    '#!/bin/sh\nif [ "$1" = "display-message" ]; then printf "%s\\n" "repo-id_fix-nested-workers"; exit 0; fi\nexit 1\n',
    { mode: 0o755 },
  );
  process.env.PATH = `${fakeBinDir}${path.delimiter}${process.env.PATH || ''}`;
  process.env.TMUX = '/tmp/fake-tmux,1,0';
  const tmuxIdentity = await detectCurrentTmuxIdentity();
  assert.equal(tmuxIdentity?.role, 'worker');
  assert.equal(tmuxIdentity?.sessionName, 'repo-id_fix-nested-workers');

  const copilotIdentity = detectIdentity(path.join(tempHome, 'notes'));
  assert.equal(copilotIdentity?.role, 'copilot');
  assert.equal(copilotIdentity?.sessionName, 'hydra-copilot-codex');

  writeJson(sessionsFile, {
    copilots: {
      'hydra-copilot-codex': {
        sessionName: 'hydra-copilot-codex',
        displayName: 'hydra-copilot-codex',
        agent: 'codex',
        workdir: copilotWorkdir,
        sessionId: 'copilot-session-id',
      },
      'hydra-copilot-claude': {
        sessionName: 'hydra-copilot-claude',
        displayName: 'hydra-copilot-claude',
        agent: 'claude',
        workdir: copilotWorkdir,
        sessionId: 'claude-copilot-session-id',
      },
      'hydra-copilot-stopped': {
        sessionName: 'hydra-copilot-stopped',
        displayName: 'hydra-copilot-stopped',
        status: 'stopped',
        agent: 'codex',
        workdir: copilotWorkdir,
        sessionId: 'stopped-copilot-session-id',
      },
    },
    workers: {
      'repo-id_fix-nested-workers': {
        sessionName: 'repo-id_fix-nested-workers',
        displayName: 'fix-nested-workers',
        workerId: 7,
        repo: 'repo',
        repoRoot: path.join(tempHome, 'repo'),
        branch: 'fix/nested-workers',
        slug: 'fix-nested-workers',
        status: 'running',
        attached: false,
        agent: 'codex',
        workdir: workerWorkdir,
        tmuxSession: 'repo-id_fix-nested-workers',
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        sessionId: 'worker-session-id',
        copilotSessionName: 'hydra-copilot-codex',
      },
    },
    nextWorkerId: 8,
    updatedAt: new Date().toISOString(),
  });

  delete process.env[HYDRA_COPILOT_SESSION_ENV];
  const ambiguousCopilotIdentity = detectIdentity(path.join(tempHome, 'notes'));
  assert.equal(ambiguousCopilotIdentity, null);

  process.env[HYDRA_COPILOT_SESSION_ENV] = 'hydra-copilot-claude';
  const envCopilotIdentity = detectIdentity(path.join(tempHome, 'notes'));
  assert.equal(envCopilotIdentity?.role, 'copilot');
  assert.equal(envCopilotIdentity?.sessionName, 'hydra-copilot-claude');

  process.env[HYDRA_COPILOT_SESSION_ENV] = 'repo-id_fix-nested-workers';
  const workerEnvIdentity = detectIdentity(path.join(tempHome, 'notes'));
  assert.equal(workerEnvIdentity, null);

  process.env[HYDRA_COPILOT_SESSION_ENV] = 'hydra-copilot-stopped';
  const stoppedEnvIdentity = detectIdentity(path.join(tempHome, 'notes'));
  assert.equal(stoppedEnvIdentity, null);

  delete process.env[HYDRA_COPILOT_SESSION_ENV];

  const outsideIdentity = detectIdentity(path.dirname(tempHome));
  assert.equal(outsideIdentity, null);

  console.log('sessionIdentitySmoke: ok');
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
