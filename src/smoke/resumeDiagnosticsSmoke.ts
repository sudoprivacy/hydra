/**
 * Smoke test: read-only resume diagnostics evaluator and CLI surface.
 *
 * Run: node out/smoke/resumeDiagnosticsSmoke.js
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT_CONFLICT } from '../cli/output';
import type { AgentSessionIndexEntry } from '../core/agentSessionIndex';
import { encodeClaudeWorkdir } from '../core/path';
import { diagnoseAgentSessionResume } from '../core/resumeDiagnostics';

const cliPath = path.resolve(__dirname, '..', 'cli', 'index.js');
const NOW = '2026-06-24T00:00:00.000Z';

interface CliContext {
  tmp: string;
  home: string;
  hydraHome: string;
  configPath: string;
  workdir: string;
  env: Record<string, string | undefined>;
}

interface DiagnoseJson {
  status: 'ok';
  session: AgentSessionIndexEntry;
  resume: ReturnType<typeof diagnoseAgentSessionResume>;
}

interface JsonError {
  error: {
    code: number;
    candidates?: Array<{ recordId: string }>;
  };
}

function baseEntry(overrides: Partial<AgentSessionIndexEntry>): AgentSessionIndexEntry {
  return {
    schemaVersion: 1,
    recordId: 'active:worker:test-worker',
    source: 'active',
    role: 'worker',
    hydraSessionName: 'test-worker',
    displayName: 'test-worker',
    agent: 'claude',
    agentSessionId: '11111111-2222-3333-4444-555555555555',
    storedAgentSessionFile: null,
    storedAgentSessionFileExists: false,
    resolvedAgentSessionFile: null,
    agentSessionFileExists: false,
    workdir: null,
    status: 'stopped',
    createdAt: NOW,
    lastSeenAt: NOW,
    archivedAt: null,
    archiveOrdinal: null,
    worker: {
      workerId: 1,
      source: 'repo',
      type: 'code',
      repo: 'fixture',
      repoRoot: null,
      branch: null,
      slug: 'test-worker',
      managedWorkdir: false,
      copilotSessionName: null,
    },
    ...overrides,
  };
}

function runEvaluatorCases(): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-resume-diagnostics-eval-'));
  const workdir = path.join(tmp, 'workdir');
  const sessionFile = path.join(workdir, '.scode', 'sessions', 'workspace', 'session-1.jsonl');
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, '', 'utf-8');

  try {
    fs.mkdirSync(workdir, { recursive: true });

    const claudeResume = diagnoseAgentSessionResume(baseEntry({ workdir }));
    assert.equal(claudeResume.operation, 'start-active');
    assert.equal(claudeResume.outcome, 'resume');
    assert.equal(claudeResume.resumePlan.valid, true);
    assert.equal(claudeResume.resumePlan.commandKind, 'command');

    const noSessionId = diagnoseAgentSessionResume(baseEntry({ workdir, agentSessionId: null }));
    assert.equal(noSessionId.outcome, 'fresh-start');
    assert.equal(noSessionId.resumePlan.valid, false);

    const custom = diagnoseAgentSessionResume(baseEntry({ workdir, agent: 'custom' }));
    assert.equal(custom.outcome, 'fresh-start');
    assert.equal(custom.resumePlan.valid, false);
    assert.match(custom.resumePlan.reason ?? '', /does not support native session resume/);

    const activeRunning = diagnoseAgentSessionResume(baseEntry({ workdir, status: 'running' }));
    assert.equal(activeRunning.operation, 'none');
    assert.equal(activeRunning.outcome, 'already-running');

    const sudoMissingFile = diagnoseAgentSessionResume(baseEntry({
      workdir,
      agent: 'sudocode',
      agentSessionId: 'session-1',
    }));
    assert.equal(sudoMissingFile.outcome, 'fresh-start');
    assert.equal(sudoMissingFile.resumePlan.valid, false);
    assert.equal(sudoMissingFile.resumePlan.requiresSessionFile, true);
    assert.equal(sudoMissingFile.resumePlan.commandKind, 'replSlashCommand');

    const sudoWithFile = diagnoseAgentSessionResume(baseEntry({
      workdir,
      agent: 'sudocode',
      agentSessionId: 'session-1',
      resolvedAgentSessionFile: sessionFile,
      agentSessionFileExists: true,
    }));
    assert.equal(sudoWithFile.outcome, 'resume');
    assert.equal(sudoWithFile.resumePlan.valid, true);
    assert.equal(sudoWithFile.resumePlan.commandKind, 'replSlashCommand');

    const archiveCodeMissingMetadata = diagnoseAgentSessionResume(baseEntry({
      source: 'archive',
      status: 'archived',
      archivedAt: NOW,
      archiveOrdinal: 0,
      workdir,
      worker: {
        workerId: 2,
        source: 'repo',
        type: 'code',
        repo: 'fixture',
        repoRoot: null,
        branch: null,
        slug: 'missing-metadata',
        managedWorkdir: false,
        copilotSessionName: null,
      },
    }));
    assert.equal(archiveCodeMissingMetadata.outcome, 'blocked');
    assert.equal(archiveCodeMissingMetadata.blockers[0].code, 'missing-repository-metadata');

    const archiveCodeInvalidBranch = diagnoseAgentSessionResume(baseEntry({
      source: 'archive',
      status: 'archived',
      archivedAt: NOW,
      archiveOrdinal: 1,
      workdir,
      worker: {
        workerId: 3,
        source: 'repo',
        type: 'code',
        repo: 'fixture',
        repoRoot: workdir,
        branch: 'bad branch',
        slug: 'bad-branch',
        managedWorkdir: false,
        copilotSessionName: null,
      },
    }));
    assert.equal(archiveCodeInvalidBranch.outcome, 'blocked');
    assert.ok(archiveCodeInvalidBranch.blockers.some(blocker => blocker.code === 'invalid-branch-name'));

    const archiveCodeMissingRepoRoot = diagnoseAgentSessionResume(baseEntry({
      source: 'archive',
      status: 'archived',
      archivedAt: NOW,
      archiveOrdinal: 2,
      workdir,
      worker: {
        workerId: 4,
        source: 'repo',
        type: 'code',
        repo: 'fixture',
        repoRoot: path.join(tmp, 'missing-repo'),
        branch: 'feature/restored',
        slug: 'feature-restored',
        managedWorkdir: false,
        copilotSessionName: null,
      },
    }));
    assert.equal(archiveCodeMissingRepoRoot.outcome, 'blocked');
    assert.ok(archiveCodeMissingRepoRoot.blockers.some(blocker => blocker.code === 'repo-root-missing-on-disk'));

    const missingUserTaskDir = path.join(tmp, 'missing-user-task');
    const archiveUserTaskMissing = diagnoseAgentSessionResume(baseEntry({
      source: 'archive',
      status: 'archived',
      archivedAt: NOW,
      archiveOrdinal: 3,
      workdir: missingUserTaskDir,
      worker: {
        workerId: 5,
        source: 'directory',
        type: 'task',
        repo: null,
        repoRoot: null,
        branch: null,
        slug: 'user-task',
        managedWorkdir: false,
        copilotSessionName: null,
      },
    }));
    assert.equal(archiveUserTaskMissing.outcome, 'blocked');
    assert.equal(archiveUserTaskMissing.blockers[0].code, 'missing-user-task-workdir');

    const archiveManagedTaskMissing = diagnoseAgentSessionResume(baseEntry({
      source: 'archive',
      status: 'archived',
      archivedAt: NOW,
      archiveOrdinal: 4,
      workdir: path.join(tmp, 'missing-managed-task'),
      worker: {
        workerId: 6,
        source: 'directory',
        type: 'task',
        repo: null,
        repoRoot: null,
        branch: null,
        slug: 'managed-task',
        managedWorkdir: true,
        copilotSessionName: null,
      },
    }));
    assert.equal(archiveManagedTaskMissing.outcome, 'restore-will-attempt-resume');
    assert.equal(archiveManagedTaskMissing.blockers.length, 0);
    assert.ok(archiveManagedTaskMissing.warnings.some(warning => warning.code === 'managed-task-workdir-missing'));

    const archiveCopilotMissingWorkdir = diagnoseAgentSessionResume(baseEntry({
      recordId: 'archive:0:copilot',
      source: 'archive',
      role: 'copilot',
      status: 'archived',
      archivedAt: NOW,
      archiveOrdinal: 5,
      workdir: null,
      worker: undefined,
      copilot: { mode: 'normal' },
    }));
    assert.equal(archiveCopilotMissingWorkdir.outcome, 'blocked');
    assert.equal(archiveCopilotMissingWorkdir.blockers[0].code, 'missing-workdir');

    const archiveCopilotWorkdirMissingOnDisk = diagnoseAgentSessionResume(baseEntry({
      recordId: 'archive:1:copilot',
      source: 'archive',
      role: 'copilot',
      status: 'archived',
      archivedAt: NOW,
      archiveOrdinal: 6,
      workdir: path.join(tmp, 'missing-copilot-workdir'),
      worker: undefined,
      copilot: { mode: 'normal' },
    }));
    assert.equal(archiveCopilotWorkdirMissingOnDisk.outcome, 'blocked');
    assert.ok(archiveCopilotWorkdirMissingOnDisk.blockers.some(blocker => blocker.code === 'copilot-workdir-missing-on-disk'));

    const archiveSudoNoFile = diagnoseAgentSessionResume(baseEntry({
      source: 'archive',
      status: 'archived',
      archivedAt: NOW,
      archiveOrdinal: 7,
      workdir,
      agent: 'sudocode',
      agentSessionId: 'session-1',
      resolvedAgentSessionFile: null,
      agentSessionFileExists: false,
      worker: {
        workerId: 7,
        source: 'directory',
        type: 'task',
        repo: null,
        repoRoot: null,
        branch: null,
        slug: 'sudo-archive',
        managedWorkdir: true,
        copilotSessionName: null,
      },
    }));
    assert.equal(archiveSudoNoFile.outcome, 'restore-will-attempt-resume');
    assert.equal(archiveSudoNoFile.resumePlan.valid, false);
    assert.ok(archiveSudoNoFile.warnings.some(warning => warning.code === 'missing-required-session-file'));

    const planCopilotGemini = diagnoseAgentSessionResume(baseEntry({
      recordId: 'active:copilot:gemini-plan',
      role: 'copilot',
      worker: undefined,
      copilot: { mode: 'plan' },
      hydraSessionName: 'gemini-plan',
      agent: 'gemini',
      workdir,
    }));
    assert.equal(planCopilotGemini.outcome, 'blocked');
    assert.equal(planCopilotGemini.resumePlan.valid, false);
    assert.ok(planCopilotGemini.blockers.some(blocker => blocker.code === 'unsupported-copilot-mode'));
    assert.ok(planCopilotGemini.warnings.some(warning => warning.code === 'copilot-mode-plan-resume-check'));

    const runningPlanCopilotGemini = diagnoseAgentSessionResume(baseEntry({
      recordId: 'active:copilot:running-gemini-plan',
      role: 'copilot',
      status: 'running',
      worker: undefined,
      copilot: { mode: 'plan' },
      hydraSessionName: 'running-gemini-plan',
      agent: 'gemini',
      workdir,
    }));
    assert.equal(runningPlanCopilotGemini.operation, 'none');
    assert.equal(runningPlanCopilotGemini.outcome, 'already-running');
    assert.equal(runningPlanCopilotGemini.blockers.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function setupCliContext(): CliContext {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-resume-diagnostics-cli-'));
  const home = path.join(tmp, 'home');
  const hydraHome = path.join(tmp, 'hydra');
  const configPath = path.join(hydraHome, 'config.json');
  const workdir = path.join(tmp, 'workdir');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(hydraHome, { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });
  writeClaudeTranscript(home, workdir, '11111111-2222-3333-4444-555555555555');
  seedCliSessions(hydraHome, workdir);
  seedCliArchive(hydraHome, workdir);

  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HYDRA_HOME: hydraHome,
    HYDRA_CONFIG_PATH: configPath,
    HYDRA_TMUX_SOCKET: `hydra-resume-diagnostics-${process.pid}-${Date.now()}`,
    HYDRA_TELEMETRY: '0',
  };

  return { tmp, home, hydraHome, configPath, workdir, env };
}

function writeClaudeTranscript(home: string, workdir: string, sessionId: string): void {
  const transcript = path.join(
    home,
    '.claude',
    'projects',
    encodeClaudeWorkdir(workdir),
    `${sessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '', 'utf-8');
}

function seedCliSessions(hydraHome: string, workdir: string): void {
  const sessions = {
    copilots: {},
    workers: {
      'hydra-diagnose-worker': {
        source: 'repo',
        sessionName: 'hydra-diagnose-worker',
        displayName: 'diagnose-worker',
        workerId: 1,
        repo: 'fixture',
        repoRoot: workdir,
        branch: 'feature/diagnose',
        slug: 'diagnose-worker',
        status: 'stopped',
        attached: false,
        agent: 'claude',
        workdir,
        managedWorkdir: false,
        tmuxSession: 'hydra-diagnose-worker',
        createdAt: NOW,
        lastSeenAt: NOW,
        sessionId: '11111111-2222-3333-4444-555555555555',
        agentSessionFile: null,
        copilotSessionName: null,
      },
    },
    nextWorkerId: 2,
    updatedAt: NOW,
  };
  fs.writeFileSync(path.join(hydraHome, 'sessions.json'), `${JSON.stringify(sessions, null, 2)}\n`, 'utf-8');
}

function seedCliArchive(hydraHome: string, workdir: string): void {
  const worker = {
    source: 'repo',
    sessionName: 'hydra-diagnose-worker',
    displayName: 'archived-diagnose-worker',
    workerId: 2,
    repo: 'fixture',
    repoRoot: workdir,
    branch: 'feature/old-diagnose',
    slug: 'old-diagnose-worker',
    status: 'stopped',
    attached: false,
    agent: 'claude',
    workdir,
    managedWorkdir: false,
    tmuxSession: 'hydra-diagnose-worker',
    createdAt: NOW,
    lastSeenAt: NOW,
    sessionId: '22222222-3333-4444-5555-666666666666',
    agentSessionFile: null,
    copilotSessionName: null,
  };
  const archive = {
    entries: [
      {
        type: 'worker',
        sessionName: 'hydra-diagnose-worker',
        agentSessionId: worker.sessionId,
        agentSessionFile: null,
        archivedAt: NOW,
        data: worker,
      },
    ],
  };
  fs.writeFileSync(path.join(hydraHome, 'archive.json'), `${JSON.stringify(archive, null, 2)}\n`, 'utf-8');
}

function runCli(args: string[], env: Record<string, string | undefined>): string {
  return execFileSync(process.execPath, [cliPath, ...args], {
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runCliFailure(args: string[], env: Record<string, string | undefined>): { status: number | null; stderr: string } {
  const proc = spawnSync(process.execPath, [cliPath, ...args], {
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: proc.status, stderr: proc.stderr };
}

function runCliCases(): void {
  if (!fs.existsSync(cliPath)) {
    console.log(`resumeDiagnosticsSmoke: skipped CLI cases (CLI not built at ${cliPath})`);
    return;
  }

  const ctx = setupCliContext();
  try {
    const sessionsPath = path.join(ctx.hydraHome, 'sessions.json');
    const archivePath = path.join(ctx.hydraHome, 'archive.json');
    const indexPath = path.join(ctx.hydraHome, 'agent-sessions.json');
    const sessionsBefore = fs.readFileSync(sessionsPath, 'utf-8');
    const archiveBefore = fs.readFileSync(archivePath, 'utf-8');
    assert.equal(fs.existsSync(indexPath), false, 'diagnose fixture starts without agent-sessions.json');

    const raw = runCli(['session', 'diagnose', 'active:worker:hydra-diagnose-worker', '--json'], ctx.env);
    const diagnosed = JSON.parse(raw) as DiagnoseJson;
    assert.equal(diagnosed.status, 'ok');
    assert.equal(diagnosed.resume.outcome, 'resume');
    assert.equal(diagnosed.resume.resumePlan.valid, true);
    assert.equal(diagnosed.resume.evidence.commandPreviewExposed, false);
    assert.equal(raw.includes('--resume'), false, 'diagnostics JSON must not expose rendered resume commands');
    assert.equal(raw.includes('/resume '), false, 'diagnostics JSON must not expose slash commands');
    assert.equal(fs.readFileSync(sessionsPath, 'utf-8'), sessionsBefore, 'diagnose must not rewrite sessions.json');
    assert.equal(fs.readFileSync(archivePath, 'utf-8'), archiveBefore, 'diagnose must not rewrite archive.json');
    assert.equal(fs.existsSync(indexPath), false, 'diagnose must not write agent-sessions.json');

    const conflict = runCliFailure(['session', 'diagnose', 'hydra-diagnose-worker', '--json'], ctx.env);
    assert.equal(conflict.status, EXIT_CONFLICT);
    const conflictJson = JSON.parse(conflict.stderr) as JsonError;
    assert.equal(conflictJson.error.code, EXIT_CONFLICT);
    assert.ok((conflictJson.error.candidates?.length ?? 0) >= 2);
  } finally {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
}

function main(): void {
  runEvaluatorCases();
  runCliCases();
  console.log('resumeDiagnosticsSmoke: ok');
}

main();
