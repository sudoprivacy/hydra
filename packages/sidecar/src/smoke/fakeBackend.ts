// A tmux-free MultiplexerBackendCore for the seam smokes, mirroring the fake in
// core/src/smoke/taskWorkerSmoke.ts. It lets HydraAppService drive real
// SessionManager / stores against an isolated HYDRA_HOME with no tmux server.

import type {
  HydraRole,
  MultiplexerBackendCore,
  MultiplexerSession,
  SessionStatusInfo,
  TerminalPaneController,
  TerminalPaneSnapshot,
} from '@hydra/core/types';

class FakeTerminalPanes implements TerminalPaneController {
  private readonly panes = new Map<string, TerminalPaneSnapshot[]>();
  private readonly requestIds = new Map<string, Map<string, string>>();
  private nextPaneId = 1;

  constructor(private readonly backend: FakeBackend) {}

  async resolveAgentPane(sessionName: string): Promise<string> {
    return this.ensure(sessionName)[0].paneId;
  }

  async list(sessionName: string): Promise<TerminalPaneSnapshot[]> {
    return this.ensure(sessionName).map(pane => ({ ...pane }));
  }

  async create(sessionName: string, options: {
    requestId: string;
    direction: 'down' | 'right';
    cwd: string;
    targetPaneId: string;
    command?: string;
  }): Promise<TerminalPaneSnapshot[]> {
    const panes = this.ensure(sessionName);
    const requests = this.requestIds.get(sessionName) ?? new Map<string, string>();
    this.requestIds.set(sessionName, requests);
    if (requests.has(options.requestId)) return this.list(sessionName);
    if (panes.length >= 4) throw new Error('This terminal already has 4 panes.');
    for (const pane of panes) pane.active = false;
    const shellNumber = panes.filter(pane => pane.role === 'shell').length + 1;
    const paneId = `%${this.nextPaneId++}`;
    panes.push({
      paneId,
      windowId: '@1',
      paneIndex: panes.length,
      title: `Shell ${shellNumber}`,
      label: `Shell ${shellNumber}`,
      role: 'shell',
      active: true,
      currentCommand: options.command ? 'shell' : null,
      currentPath: options.cwd,
      canClose: true,
    });
    requests.set(options.requestId, paneId);
    return this.list(sessionName);
  }

  async focus(sessionName: string, paneId: string): Promise<TerminalPaneSnapshot[]> {
    const panes = this.ensure(sessionName);
    if (!panes.some(pane => pane.paneId === paneId)) throw new Error('Pane not found');
    for (const pane of panes) pane.active = pane.paneId === paneId;
    return this.list(sessionName);
  }

  async close(sessionName: string, paneId: string): Promise<{
    outcome: 'closed' | 'already-closed';
    panes: TerminalPaneSnapshot[];
  }> {
    const panes = this.ensure(sessionName);
    if (panes[0].paneId === paneId) throw new Error('The Agent pane is protected');
    const index = panes.findIndex(pane => pane.paneId === paneId);
    if (index < 0) return { outcome: 'already-closed', panes: await this.list(sessionName) };
    if (!panes[index].canClose) throw new Error('Pane is external');
    const [removed] = panes.splice(index, 1);
    if (removed.active) panes[0].active = true;
    return { outcome: 'closed', panes: await this.list(sessionName) };
  }

  remove(sessionName: string): void {
    this.panes.delete(sessionName);
    this.requestIds.delete(sessionName);
  }

  rename(oldName: string, newName: string): void {
    const panes = this.panes.get(oldName);
    if (panes) this.panes.set(newName, panes);
    this.panes.delete(oldName);
    const requests = this.requestIds.get(oldName);
    if (requests) this.requestIds.set(newName, requests);
    this.requestIds.delete(oldName);
  }

  private ensure(sessionName: string): TerminalPaneSnapshot[] {
    if (!this.backend.sessions.has(sessionName)) throw new Error(`Session ${sessionName} is stopped`);
    let panes = this.panes.get(sessionName);
    if (!panes) {
      panes = [{
        paneId: `%${this.nextPaneId++}`,
        windowId: '@1',
        paneIndex: 0,
        title: 'Agent',
        label: 'Agent',
        role: 'agent',
        active: true,
        currentCommand: 'agent',
        currentPath: this.backend.workdirs.get(sessionName) ?? null,
        canClose: false,
      }];
      this.panes.set(sessionName, panes);
    }
    return panes;
  }
}

export class FakeBackend implements MultiplexerBackendCore {
  readonly type = 'tmux' as const;
  readonly displayName = 'fake-tmux';
  readonly installHint = 'not needed';
  readonly terminalPanes = new FakeTerminalPanes(this);

  readonly sessions = new Set<string>();
  readonly workdirs = new Map<string, string>();
  readonly roles = new Map<string, HydraRole>();
  readonly workerIds = new Map<string, number>();
  readonly agents = new Map<string, string>();
  readonly messages: Array<{ sessionName: string; message: string }> = [];
  readonly killed: string[] = [];

  async isInstalled(): Promise<boolean> {
    return true;
  }

  async listSessions(): Promise<MultiplexerSession[]> {
    return Promise.all([...this.sessions].map(async name => ({
      name,
      windows: 1,
      attached: false,
      workdir: this.workdirs.get(name),
      agentPaneId: await this.terminalPanes.resolveAgentPane(name),
      agentPaneAlive: true,
    })));
  }

  async createSession(sessionName: string, cwd: string): Promise<void> {
    this.sessions.add(sessionName);
    this.workdirs.set(sessionName, cwd);
  }

  async killSession(sessionName: string): Promise<void> {
    this.sessions.delete(sessionName);
    this.terminalPanes.remove(sessionName);
    this.killed.push(sessionName);
  }

  async renameSession(oldName: string, newName: string): Promise<void> {
    if (!this.sessions.delete(oldName)) return;
    this.sessions.add(newName);
    const workdir = this.workdirs.get(oldName);
    if (workdir) this.workdirs.set(newName, workdir);
    const role = this.roles.get(oldName);
    if (role) this.roles.set(newName, role);
    const workerId = this.workerIds.get(oldName);
    if (workerId) this.workerIds.set(newName, workerId);
    const agent = this.agents.get(oldName);
    if (agent) this.agents.set(newName, agent);
    this.terminalPanes.rename(oldName, newName);
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

  async getSessionWorkerId(sessionName: string): Promise<number | undefined> {
    return this.workerIds.get(sessionName);
  }

  async setSessionWorkerId(sessionName: string, workerId: number): Promise<void> {
    this.workerIds.set(sessionName, workerId);
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
