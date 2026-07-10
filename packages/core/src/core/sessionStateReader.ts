import * as fs from 'fs';
import { getHydraSessionsFile } from './path';
import type { WorkerInfo } from './sessionManager';

interface SessionStateLike {
  workers?: Record<string, Partial<WorkerInfo>>;
}

function withSessionName(sessionName: string, worker: Partial<WorkerInfo>): WorkerInfo | null {
  if (!worker || typeof worker !== 'object') {
    return null;
  }
  const resolvedSessionName = typeof worker.sessionName === 'string' && worker.sessionName
    ? worker.sessionName
    : sessionName;
  if (!resolvedSessionName || typeof worker.workdir !== 'string' || typeof worker.agent !== 'string') {
    return null;
  }
  return {
    source: worker.source,
    sessionName: resolvedSessionName,
    displayName: worker.displayName || resolvedSessionName,
    workerId: typeof worker.workerId === 'number' ? worker.workerId : 0,
    repo: worker.repo ?? null,
    repoRoot: worker.repoRoot ?? null,
    branch: worker.branch ?? null,
    slug: worker.slug || resolvedSessionName,
    status: worker.status === 'stopped' ? 'stopped' : 'running',
    attached: worker.attached === true,
    agent: worker.agent,
    workdir: worker.workdir,
    managedWorkdir: worker.managedWorkdir,
    tmuxSession: worker.tmuxSession || resolvedSessionName,
    createdAt: worker.createdAt || '',
    lastSeenAt: worker.lastSeenAt || '',
    sessionId: worker.sessionId ?? null,
    agentSessionFile: worker.agentSessionFile ?? null,
    copilotSessionName: worker.copilotSessionName ?? null,
  };
}

export function readWorkerSessions(sessionsFile = getHydraSessionsFile()): WorkerInfo[] {
  try {
    if (!fs.existsSync(sessionsFile)) {
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8')) as SessionStateLike;
    return Object.entries(parsed.workers || {})
      .map(([sessionName, worker]) => withSessionName(sessionName, worker))
      .filter((worker): worker is WorkerInfo => worker != null);
  } catch {
    return [];
  }
}

export function readWorkerSessionByName(sessionName: string, sessionsFile = getHydraSessionsFile()): WorkerInfo | null {
  const target = sessionName.trim();
  if (!target) {
    return null;
  }
  return readWorkerSessions(sessionsFile)
    .find(worker => worker.sessionName === target)
    ?? null;
}

export function readWorkerSessionById(workerId: number, sessionsFile = getHydraSessionsFile()): WorkerInfo | null {
  if (!Number.isSafeInteger(workerId) || workerId <= 0) {
    return null;
  }
  return readWorkerSessions(sessionsFile)
    .find(worker => worker.workerId === workerId)
    ?? null;
}
