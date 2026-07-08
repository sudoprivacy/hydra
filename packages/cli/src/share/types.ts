export type ShareSessionType = 'copilot' | 'worker';

export interface ShareEncryptionInfo {
  enabled: false;
  algorithm: null;
  keyHint: null;
}

export interface ShareRepoInfo {
  repoName: string | null;
  repoRoot: string | null;
  branch: string | null;
  headCommit: string | null;
  remotes: Record<string, string>;
}

export interface ShareHydraWorkerInfo {
  workerId: number;
  repo: string;
  repoRoot: string;
  branch: string;
  slug: string;
  copilotSessionName: string | null;
}

export interface ShareHydraSessionInfo {
  type: ShareSessionType;
  sessionName: string;
  displayName: string;
  agent: 'codex';
  workdir: string;
  agentSessionId: string;
  worker?: ShareHydraWorkerInfo;
}

export interface NativeSessionFile {
  homeRelativePath: string;
  mode: number;
  size: number;
  sha256: string;
  contentBase64: string;
}

export interface CodexNativeSessionPayload {
  adapter: 'codex';
  adapterVersion: 1;
  sessionId: string;
  files: NativeSessionFile[];
}

export interface HydraShareBundle {
  schemaVersion: 1;
  shareId: string;
  createdAt: string;
  encryption: ShareEncryptionInfo;
  repo: ShareRepoInfo;
  hydraSession: ShareHydraSessionInfo;
  agents: {
    codex: CodexNativeSessionPayload;
  };
}
