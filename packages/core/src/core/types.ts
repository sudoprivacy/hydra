export type MultiplexerType = 'tmux';
export type HydraRole = 'copilot' | 'worker';
export type AgentType = 'claude' | 'codex' | 'gemini' | 'antigravity' | 'sudocode' | 'custom';
export type CopilotMode = 'normal' | 'plan';

export interface MultiplexerSession {
  name: string;
  windows: number;
  attached: boolean;
  /** Number of clients currently attached to the session, when reported by the backend. */
  attachedClients?: number;
  workdir?: string;
  role?: HydraRole;
  agent?: string;
  /** Stable tmux pane ID recorded when Hydra creates the Agent pane. */
  agentPaneId?: string;
  /** False only when recorded metadata points to a pane that no longer exists. */
  agentPaneAlive?: boolean;
}

export type TerminalPaneRole = 'agent' | 'shell' | 'external';
export type TerminalPaneDirection = 'down' | 'right';

export interface TerminalPaneSnapshot {
  paneId: string;
  windowId: string;
  paneIndex: number;
  title: string;
  label: string;
  role: TerminalPaneRole;
  active: boolean;
  currentCommand: string | null;
  currentPath: string | null;
  canClose: boolean;
}

export interface CreateTerminalPaneOptions {
  requestId: string;
  direction: TerminalPaneDirection;
  cwd: string;
  targetPaneId: string;
  command?: string;
}

export interface TerminalPaneController {
  resolveAgentPane(sessionName: string): Promise<string>;
  list(sessionName: string): Promise<TerminalPaneSnapshot[]>;
  create(
    sessionName: string,
    options: CreateTerminalPaneOptions,
  ): Promise<TerminalPaneSnapshot[]>;
  focus(sessionName: string, paneId: string): Promise<TerminalPaneSnapshot[]>;
  close(sessionName: string, paneId: string): Promise<{
    outcome: 'closed' | 'already-closed';
    panes: TerminalPaneSnapshot[];
  }>;
}

export interface SessionStatusInfo {
  attached: boolean;
  /** Number of clients currently attached to the session, when reported by the backend. */
  attachedClients?: number;
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
  readonly terminalPanes?: TerminalPaneController;
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
  getSessionWorkerId?(sessionName: string): Promise<number | undefined>;
  setSessionWorkerId?(sessionName: string, workerId: number): Promise<void>;
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
