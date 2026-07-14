/**
 * Focused creation-options smoke for the Desktop dialogs.
 *
 * Proves that machine-resolved agent defaults and repository suggestions cross
 * the real client/sidecar seam, including linked-worktree primary-root
 * resolution and registered repositories.
 *
 * Run: node packages/sidecar/out/smoke/creationOptionsSmoke.js
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createHydraControlClient, transportFactory } from '@hydra/protocol';
import type { SessionState } from '@hydra/core/sessionManager';
import { FakeBackend } from './fakeBackend';

function runGit(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function buildRepository(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], {
    cwd: root,
    stdio: 'ignore',
  });
  runGit(['config', 'user.email', 'creation-options@hydra.test'], root);
  runGit(['config', 'user.name', 'Creation Options Smoke'], root);
  runGit(['config', 'commit.gpgsign', 'false'], root);
  fs.writeFileSync(path.join(root, 'README.md'), '# creation options\n');
  runGit(['add', '.'], root);
  runGit(['commit', '-q', '-m', 'initial'], root);
}

async function main(): Promise<void> {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-creation-options-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.HYDRA_HOME = path.join(tempHome, '.hydra');
  process.env.HYDRA_TELEMETRY = '0';
  delete process.env.HYDRA_CONFIG_PATH;

  try {
    const { writeHydraGlobalConfig } = await import('@hydra/core/hydraGlobalConfig');
    const { getRegistryRepoPath } = await import('@hydra/core/repoRegistry');
    const { SessionManager } = await import('@hydra/core/sessionManager');
    const { HydraAppService } = await import('../appService');

    writeHydraGlobalConfig({
      defaultAgent: 'codex',
      agentCommands: { codex: process.execPath },
    });

    const recentRepo = path.join(tempHome, 'projects', 'recent-repo');
    const recentWorktree = path.join(tempHome, 'worktrees', 'recent-repo');
    const registeredRepo = getRegistryRepoPath('acme', 'registered-repo');
    buildRepository(recentRepo);
    buildRepository(registeredRepo);
    fs.mkdirSync(path.dirname(recentWorktree), { recursive: true });
    runGit(['worktree', 'add', '-q', '-b', 'feat/creation-options', recentWorktree, 'main'], recentRepo);

    const backend = new FakeBackend();
    const now = '2026-07-14T00:00:00.000Z';
    const state: SessionState = {
      nextWorkerId: 2,
      updatedAt: now,
      copilots: {
        'hydra-copilot-codex': {
          sessionName: 'hydra-copilot-codex',
          displayName: 'hydra-copilot-codex',
          status: 'running',
          attached: false,
          agent: 'codex',
          copilotMode: 'normal',
          workdir: tempHome,
          tmuxSession: 'hydra-copilot-codex',
          createdAt: now,
          lastSeenAt: now,
          sessionId: null,
        },
      },
      workers: {
        'recent-repo_feat-creation-options': {
          source: 'repo',
          sessionName: 'recent-repo_feat-creation-options',
          displayName: 'creation-options',
          workerId: 1,
          repo: 'recent-repo',
          repoRoot: recentRepo,
          branch: 'feat/creation-options',
          slug: 'creation-options',
          status: 'running',
          attached: false,
          agent: 'codex',
          workdir: recentWorktree,
          managedWorkdir: false,
          tmuxSession: 'recent-repo_feat-creation-options',
          createdAt: now,
          lastSeenAt: now,
          sessionId: null,
          copilotSessionName: 'hydra-copilot-codex',
        },
      },
    };
    class CreationSessionManager extends SessionManager {
      override async sync(): Promise<SessionState> {
        return state;
      }
    }
    const sessionManager = new CreationSessionManager(backend);
    const client = createHydraControlClient(transportFactory({
      kind: 'in-process',
      appService: new HydraAppService({ backend, sessionManager }),
    }));

    const options = await client.getCreationOptions();

    assert.equal(options.defaultAgent, 'codex');
    assert.equal(options.homeDir, tempHome);
    const codex = options.agents.find(option => option.id === 'codex');
    assert.ok(codex, 'configured default agent is included');
    assert.equal(codex.isDefault, true);
    assert.equal(codex.available, true, 'configured executable is resolved on PATH or by absolute path');
    assert.equal(codex.supportsPlanMode, true);
    assert.equal(codex.suggestedCopilotName, 'hydra-copilot-codex-2');
    assert.equal(codex.suggestedPlanName, 'hydra-plan-codex');

    const primaryRepo = fs.realpathSync(recentRepo);
    const recent = options.repositories.find(option => option.path === primaryRepo);
    assert.ok(recent, 'recent worker repository is suggested by primary root');
    assert.ok(recent.sources.includes('recent'));
    assert.ok(recent.aliases.includes(recentWorktree), 'linked worktree is retained as a context alias');
    assert.equal(recent.defaultBranch, 'main');

    const registered = options.repositories.find(option => option.path === registeredRepo);
    assert.ok(registered, 'registered repository is suggested');
    assert.equal(registered.label, 'acme/registered-repo');
    assert.ok(registered.sources.includes('registered'));
    assert.equal(registered.defaultBranch, 'main');

    console.log('creationOptionsSmoke: ok');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
