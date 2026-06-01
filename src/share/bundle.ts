import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { resolveAgentSessionFile } from '../core/path';
import { isDirectoryWorker, type CopilotInfo, type WorkerInfo } from '../core/sessionManager';
import { exportCodexNativeSession } from './codexAdapter';
import { collectRepoInfo } from './repo';
import type { HydraShareBundle, ShareHydraSessionInfo } from './types';

export type ShareableSession =
  | { type: 'copilot'; data: CopilotInfo }
  | { type: 'worker'; data: WorkerInfo };

export function generateShareId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function assertCodexSession(session: ShareableSession): string {
  if (session.data.agent !== 'codex') {
    throw new Error(`Only Codex sessions can be shared natively. Session agent is "${session.data.agent}".`);
  }
  if (!session.data.sessionId) {
    throw new Error(`Session "${session.data.sessionName}" does not have a captured Codex session ID yet.`);
  }
  const sessionFile = resolveAgentSessionFile('codex', session.data.workdir, session.data.sessionId);
  if (!sessionFile) {
    throw new Error(`Codex session file not found for session "${session.data.sessionName}".`);
  }
  return session.data.sessionId;
}

function buildHydraSessionInfo(session: ShareableSession, sessionId: string): ShareHydraSessionInfo {
  if (session.type === 'copilot') {
    return {
      type: 'copilot',
      sessionName: session.data.sessionName,
      displayName: session.data.displayName || session.data.sessionName,
      agent: 'codex',
      workdir: session.data.workdir,
      agentSessionId: sessionId,
    };
  }

  if (isDirectoryWorker(session.data)) {
    throw new Error('Task workers cannot be shared yet. Share currently supports copilots and code workers only.');
  }
  if (!session.data.repo || !session.data.repoRoot || !session.data.branch) {
    throw new Error(`Code worker "${session.data.sessionName}" is missing repository metadata and cannot be shared.`);
  }

  return {
    type: 'worker',
    sessionName: session.data.sessionName,
    displayName: session.data.displayName || session.data.slug || session.data.sessionName,
    agent: 'codex',
    workdir: session.data.workdir,
    agentSessionId: sessionId,
    worker: {
      workerId: session.data.workerId,
      repo: session.data.repo,
      repoRoot: session.data.repoRoot,
      branch: session.data.branch,
      slug: session.data.slug,
      copilotSessionName: session.data.copilotSessionName,
    },
  };
}

export async function createShareBundle(
  session: ShareableSession,
  shareId = generateShareId(),
): Promise<HydraShareBundle> {
  if (session.type === 'worker' && isDirectoryWorker(session.data)) {
    throw new Error('Task workers cannot be shared yet. Share currently supports copilots and code workers only.');
  }
  const sessionId = assertCodexSession(session);
  const repo = await collectRepoInfo(session.data.workdir);

  return {
    schemaVersion: 1,
    shareId,
    createdAt: new Date().toISOString(),
    encryption: {
      enabled: false,
      algorithm: null,
      keyHint: null,
    },
    repo,
    hydraSession: buildHydraSessionInfo(session, sessionId),
    agents: {
      codex: exportCodexNativeSession(session.data.workdir, sessionId),
    },
  };
}

export function writeBundle(filePath: string, bundle: HydraShareBundle): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
}

export function readBundle(filePath: string): HydraShareBundle {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as HydraShareBundle;
  validateBundle(parsed);
  return parsed;
}

export function validateBundle(bundle: HydraShareBundle): void {
  if (!bundle || typeof bundle !== 'object') {
    throw new Error('Invalid share bundle');
  }
  if (bundle.schemaVersion !== 1) {
    throw new Error(`Unsupported share bundle schema version: ${bundle.schemaVersion}`);
  }
  if (bundle.encryption?.enabled) {
    throw new Error('Encrypted share bundles are not supported by this Hydra version yet.');
  }
  if (!bundle.shareId) {
    throw new Error('Share bundle is missing shareId');
  }
  if (bundle.hydraSession?.agent !== 'codex') {
    throw new Error('Only Codex share bundles are supported');
  }
  if (!bundle.hydraSession?.agentSessionId) {
    throw new Error('Share bundle is missing agentSessionId');
  }
  if (bundle.agents?.codex?.adapter !== 'codex') {
    throw new Error('Share bundle is missing Codex native session payload');
  }
}
