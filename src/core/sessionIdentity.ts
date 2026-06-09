import * as fs from 'fs';
import * as path from 'path';
import { exec } from './exec';
import { HYDRA_COPILOT_SESSION_ENV } from './env';
import { getHydraSessionsFile, getTmuxCommand, toCanonicalPath } from './path';
import { shellQuote } from './shell';

export interface HydraIdentity {
  role: 'worker' | 'copilot';
  sessionName: string;
  displayName: string;
  agent: string;
  sessionId: string | null;
  workdir: string;
  /** Worker-specific fields */
  workerId?: number;
  branch?: string;
  repo?: string;
  copilotSessionName?: string | null;
}

interface RawSession {
  sessionName?: string;
  displayName?: string;
  agent?: string;
  sessionId?: string | null;
  workdir?: string;
  status?: string;
  workerId?: number;
  branch?: string;
  repo?: string;
  copilotSessionName?: string | null;
}

interface RawSessionState {
  copilots?: Record<string, RawSession>;
  workers?: Record<string, RawSession>;
}

function isInsidePath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function readSessionState(): RawSessionState | null {
  try {
    const sessionsFile = getHydraSessionsFile();
    if (!fs.existsSync(sessionsFile)) return null;
    return JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
  } catch {
    return null;
  }
}

function buildCopilotIdentity(copilot: RawSession): HydraIdentity {
  return {
    role: 'copilot',
    sessionName: copilot.sessionName || '',
    displayName: copilot.displayName || copilot.sessionName || '',
    agent: copilot.agent || 'unknown',
    sessionId: copilot.sessionId ?? null,
    workdir: copilot.workdir || '',
  };
}

function buildWorkerIdentity(worker: RawSession): HydraIdentity {
  return {
    role: 'worker',
    sessionName: worker.sessionName || '',
    displayName: worker.displayName || worker.sessionName || '',
    agent: worker.agent || 'unknown',
    sessionId: worker.sessionId ?? null,
    workdir: worker.workdir || '',
    workerId: worker.workerId,
    branch: worker.branch,
    repo: worker.repo,
    copilotSessionName: worker.copilotSessionName ?? null,
  };
}

function isActiveSession(session: RawSession): boolean {
  return session.status !== 'stopped';
}

function withSessionName(sessionName: string, session: RawSession): RawSession {
  return { ...session, sessionName: session.sessionName || sessionName };
}

function findBestMatch(cwd: string, state: RawSessionState): HydraIdentity | null {
  let bestIdentity: HydraIdentity | null = null;
  let bestDepth = -1;
  let bestTie = false;

  const consider = (identity: HydraIdentity): void => {
    if (!identity.workdir) return;
    const workdir = toCanonicalPath(identity.workdir) || path.resolve(identity.workdir);
    if (!isInsidePath(cwd, workdir)) return;

    const depth = workdir.length;
    if (depth > bestDepth) {
      bestIdentity = { ...identity, workdir: identity.workdir };
      bestDepth = depth;
      bestTie = false;
    } else if (depth === bestDepth) {
      bestTie = true;
    }
  };

  for (const [sessionName, copilot] of Object.entries(state.copilots || {})) {
    consider(buildCopilotIdentity(withSessionName(sessionName, copilot)));
  }

  for (const [sessionName, worker] of Object.entries(state.workers || {})) {
    consider(buildWorkerIdentity(withSessionName(sessionName, worker)));
  }

  return bestTie ? null : bestIdentity;
}

function findIdentityBySessionName(state: RawSessionState, sessionName: string): HydraIdentity | null {
  for (const [stateKey, worker] of Object.entries(state.workers || {})) {
    const identitySessionName = worker.sessionName || stateKey;
    if (identitySessionName === sessionName) {
      return buildWorkerIdentity(withSessionName(stateKey, worker));
    }
  }

  for (const [stateKey, copilot] of Object.entries(state.copilots || {})) {
    const identitySessionName = copilot.sessionName || stateKey;
    if (identitySessionName === sessionName) {
      return buildCopilotIdentity(withSessionName(stateKey, copilot));
    }
  }

  return null;
}

function detectCopilotIdentityByEnv(state: RawSessionState): HydraIdentity | null {
  const sessionName = process.env[HYDRA_COPILOT_SESSION_ENV]?.trim();
  if (!sessionName) return null;

  for (const [stateKey, copilot] of Object.entries(state.copilots || {})) {
    const identitySessionName = copilot.sessionName || stateKey;
    if (identitySessionName === sessionName && isActiveSession(copilot)) {
      return buildCopilotIdentity(withSessionName(stateKey, copilot));
    }
  }

  return null;
}

export function detectIdentityBySessionName(sessionName: string): HydraIdentity | null {
  const state = readSessionState();
  if (!state) return null;

  return findIdentityBySessionName(state, sessionName);
}

/**
 * Lightweight identity detection — reads sessions.json (no tmux sync)
 * and uses process-scoped copilot identity before falling back to cwd.
 * Returns null if not running inside a known Hydra session.
 */
export function detectIdentity(cwd?: string): HydraIdentity | null {
  const dir = toCanonicalPath(cwd || process.cwd()) || path.resolve(cwd || process.cwd());
  const state = readSessionState();
  if (!state) return null;

  return detectCopilotIdentityByEnv(state) || findBestMatch(dir, state);
}

// Use double quotes around the tmux `-p` format. cmd.exe on Windows does not
// strip single quotes, so the returned session name would be wrapped in
// literal '…' — breaking the subsequent show-options query. See issue #225 §1.
export function buildCurrentTmuxSessionNameCommand(): string {
  return `${getTmuxCommand()} display-message -p "#S"`;
}

async function getCurrentTmuxSessionName(): Promise<string | null> {
  if (!process.env.TMUX && process.platform !== 'win32') {
    return null;
  }

  try {
    const sessionName = await exec(buildCurrentTmuxSessionNameCommand());
    return sessionName.trim() || null;
  } catch {
    return null;
  }
}

async function detectCurrentTmuxMetadataIdentity(sessionName: string): Promise<HydraIdentity | null> {
  try {
    const tmuxCommand = getTmuxCommand();
    const role = await exec(`${tmuxCommand} show-options -qv -t ${shellQuote(sessionName)} @hydra-role`);
    if (role !== 'worker' && role !== 'copilot') {
      return null;
    }

    const [workdir, agent] = await Promise.all([
      exec(`${tmuxCommand} show-options -qv -t ${shellQuote(sessionName)} @workdir`).catch(() => ''),
      exec(`${tmuxCommand} show-options -qv -t ${shellQuote(sessionName)} @hydra-agent`).catch(() => ''),
    ]);

    return {
      role,
      sessionName,
      displayName: sessionName,
      agent: agent || 'unknown',
      sessionId: null,
      workdir,
    };
  } catch {
    return null;
  }
}

export async function detectCurrentTmuxIdentity(): Promise<HydraIdentity | null> {
  const sessionName = await getCurrentTmuxSessionName();
  if (!sessionName) return null;

  return detectIdentityBySessionName(sessionName)
    || await detectCurrentTmuxMetadataIdentity(sessionName);
}

export function getWorkerCreationBlockedMessage(identity: HydraIdentity): string {
  const parent = identity.role === 'worker' && identity.copilotSessionName
    ? ` Ask parent copilot "${identity.copilotSessionName}" to create the worker instead.`
    : ' Ask the parent copilot to create the worker instead.';
  return `Hydra workers cannot create other workers directly.${parent}`;
}
