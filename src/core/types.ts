export type MultiplexerType = 'tmux';
export type HydraRole = 'copilot' | 'worker';
export type AgentType = 'claude' | 'codex' | 'gemini' | 'sudocode' | 'custom';

export interface MultiplexerSession {
  name: string;
  windows: number;
  attached: boolean;
  workdir?: string;
}

export interface SessionStatusInfo {
  attached: boolean;
  lastActive: number;
}

export interface Worktree {
  path: string;
  branch: string;
  isMain: boolean;
}

export interface MultiplexerBackendCore {
  readonly type: MultiplexerType;
  readonly displayName: string;
  readonly installHint: string;
  isInstalled(): Promise<boolean>;
  listSessions(): Promise<MultiplexerSession[]>;
  createSession(sessionName: string, cwd: string): Promise<void>;
  killSession(sessionName: string): Promise<void>;
  renameSession(oldName: string, newName: string): Promise<void>;
  hasSession(sessionName: string): Promise<boolean>;
  getSessionWorkdir(sessionName: string): Promise<string | undefined>;
  setSessionWorkdir(sessionName: string, workdir: string): Promise<void>;
  getSessionRole(sessionName: string): Promise<HydraRole | undefined>;
  setSessionRole(sessionName: string, role: HydraRole): Promise<void>;
  getSessionAgent(sessionName: string): Promise<string | undefined>;
  setSessionAgent(sessionName: string, agent: string): Promise<void>;
  sendKeys(sessionName: string, keys: string): Promise<void>;
  capturePane(sessionName: string, lines?: number): Promise<string>;
  sendMessage(sessionName: string, message: string): Promise<void>;
  getSessionInfo(sessionName: string): Promise<SessionStatusInfo>;
  getSessionPaneCount(sessionName: string): Promise<number>;
  getSessionPanePids(sessionName: string): Promise<string[]>;
  splitPane(sessionName: string, cwd?: string): Promise<void>;
  newWindow(sessionName: string, cwd?: string): Promise<void>;
  buildSessionName(repoName: string, slug: string): string;
  sanitizeSessionName(name: string): string;
}
