// A tmux-free MultiplexerBackendCore for the seam smokes, mirroring the fake in
// core/src/smoke/taskWorkerSmoke.ts. It lets HydraAppService drive real
// SessionManager / stores against an isolated HYDRA_HOME with no tmux server.

import type {
  HydraRole,
  MultiplexerBackendCore,
  MultiplexerSession,
  SessionStatusInfo,
} from '@hydra/core/types';

export class FakeBackend implements MultiplexerBackendCore {
  readonly type = 'tmux' as const;
  readonly displayName = 'fake-tmux';
  readonly installHint = 'not needed';

  readonly sessions = new Set<string>();
  readonly workdirs = new Map<string, string>();
  readonly roles = new Map<string, HydraRole>();
  readonly agents = new Map<string, string>();
  readonly messages: Array<{ sessionName: string; message: string }> = [];
  readonly killed: string[] = [];

  async isInstalled(): Promise<boolean> {
    return true;
  }

  async listSessions(): Promise<MultiplexerSession[]> {
    return [...this.sessions].map(name => ({
      name,
      windows: 1,
      attached: false,
      workdir: this.workdirs.get(name),
    }));
  }

  async createSession(sessionName: string, cwd: string): Promise<void> {
    this.sessions.add(sessionName);
    this.workdirs.set(sessionName, cwd);
  }

  async killSession(sessionName: string): Promise<void> {
    this.sessions.delete(sessionName);
    this.killed.push(sessionName);
  }

  async renameSession(oldName: string, newName: string): Promise<void> {
    if (!this.sessions.delete(oldName)) return;
    this.sessions.add(newName);
    const workdir = this.workdirs.get(oldName);
    if (workdir) this.workdirs.set(newName, workdir);
    const role = this.roles.get(oldName);
    if (role) this.roles.set(newName, role);
    const agent = this.agents.get(oldName);
    if (agent) this.agents.set(newName, agent);
  }

  async hasSession(sessionName: string): Promise<boolean> {
    return this.sessions.has(sessionName);
  }

  async getSessionWorkdir(sessionName: string): Promise<string | undefined> {
    return this.workdirs.get(sessionName);
  }

  async setSessionWorkdir(sessionName: string, workdir: string): Promise<void> {
    this.workdirs.set(sessionName, workdir);
  }

  async getSessionRole(sessionName: string): Promise<HydraRole | undefined> {
    return this.roles.get(sessionName);
  }

  async setSessionRole(sessionName: string, role: HydraRole): Promise<void> {
    this.roles.set(sessionName, role);
  }

  async getSessionAgent(sessionName: string): Promise<string | undefined> {
    return this.agents.get(sessionName);
  }

  async setSessionAgent(sessionName: string, agent: string): Promise<void> {
    this.agents.set(sessionName, agent);
  }

  async sendKeys(): Promise<void> {
    return;
  }

  async capturePane(sessionName: string): Promise<string> {
    // A prompt glyph so SessionManager readiness probes settle immediately.
    return `⏵ ${sessionName}`;
  }

  async sendMessage(sessionName: string, message: string): Promise<void> {
    this.messages.push({ sessionName, message });
  }

  async getSessionInfo(): Promise<SessionStatusInfo> {
    return { attached: false, lastActive: Math.floor(Date.now() / 1000) };
  }

  async getSessionPaneCount(): Promise<number> {
    return 1;
  }

  async getSessionPanePids(): Promise<string[]> {
    return [];
  }

  async splitPane(): Promise<void> {
    return;
  }

  async newWindow(): Promise<void> {
    return;
  }

  buildSessionName(namespace: string, slug: string): string {
    return `${namespace}_${slug}`;
  }

  sanitizeSessionName(name: string): string {
    return name.trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  }
}
