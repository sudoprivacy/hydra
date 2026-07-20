import type { SessionManager } from './sessionManager';
import type {
  MultiplexerBackendCore,
  TerminalPaneDirection,
  TerminalPaneSnapshot,
} from './types';

export type TerminalPaneStartDirectory =
  | 'session-workdir'
  | 'agent-current-directory';

export interface SessionTerminalPaneList {
  session: string;
  agentPaneId: string;
  panes: TerminalPaneSnapshot[];
  maxPanes: number;
}
export interface CreateSessionTerminalPaneInput {
  session: string;
  requestId: string;
  direction: TerminalPaneDirection;
  startDirectory: TerminalPaneStartDirectory;
  command?: string;
}

export interface CloseSessionTerminalPaneResult extends SessionTerminalPaneList {
  outcome: 'closed' | 'already-closed';
}

const MAX_PANES = 4;
const MAX_COMMAND_LENGTH = 4096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SessionTerminalService {
  private readonly mutations = new Map<string, Promise<void>>();

  constructor(
    private readonly backend: MultiplexerBackendCore,
    private readonly sessionManager: SessionManager,
  ) {}

  async list(session: string): Promise<SessionTerminalPaneList> {
    await this.assertOwnedLive(session);
    return this.snapshot(session);
  }

  async create(input: CreateSessionTerminalPaneInput): Promise<SessionTerminalPaneList> {
    this.validateCreate(input);
    return this.serialize(input.session, async () => {
      const ownership = await this.assertOwnedLive(input.session);
      const controller = this.getController();
      const panes = await controller.list(input.session);
      const agentPaneId = await controller.resolveAgentPane(input.session);
      const activeTarget = panes.find(pane => pane.active)?.paneId ?? agentPaneId;

      let cwd: string | null | undefined;
      if (input.startDirectory === 'agent-current-directory') {
        cwd = panes.find(pane => pane.paneId === agentPaneId)?.currentPath;
      } else {
        const entity = ownership.kind === 'worker'
          ? this.sessionManager.getPersistedWorker(input.session)
          : this.sessionManager.getPersistedCopilot(input.session);
        cwd = entity?.workdir;
      }
      if (!cwd) {
        throw new Error(`Unable to resolve a start directory for tmux session "${input.session}"`);
      }

      const command = input.command?.trim() ? input.command : undefined;
      const updated = await controller.create(input.session, {
        requestId: input.requestId,
        direction: input.direction,
        cwd,
        targetPaneId: activeTarget,
        command,
      });
      return {
        session: input.session,
        agentPaneId,
        panes: updated,
        maxPanes: MAX_PANES,
      };
    });
  }

  async focus(session: string, paneId: string): Promise<SessionTerminalPaneList> {
    this.validateTarget(session, paneId);
    return this.serialize(session, async () => {
      await this.assertOwnedLive(session);
      const controller = this.getController();
      const panes = await controller.focus(session, paneId);
      return {
        session,
        agentPaneId: await controller.resolveAgentPane(session),
        panes,
        maxPanes: MAX_PANES,
      };
    });
  }

  async close(session: string, paneId: string): Promise<CloseSessionTerminalPaneResult> {
    this.validateTarget(session, paneId);
    return this.serialize(session, async () => {
      await this.assertOwnedLive(session);
      const controller = this.getController();
      const result = await controller.close(session, paneId);
      return {
        session,
        agentPaneId: await controller.resolveAgentPane(session),
        panes: result.panes,
        maxPanes: MAX_PANES,
        outcome: result.outcome,
      };
    });
  }

  private async snapshot(session: string): Promise<SessionTerminalPaneList> {
    const controller = this.getController();
    const agentPaneId = await controller.resolveAgentPane(session);
    return {
      session,
      agentPaneId,
      panes: await controller.list(session),
      maxPanes: MAX_PANES,
    };
  }

  private getController() {
    const controller = this.backend.terminalPanes;
    if (!controller) {
      throw new Error('Terminal pane control is unavailable for this multiplexer');
    }
    return controller;
  }

  private async assertOwnedLive(session: string): Promise<{ kind: 'worker' | 'copilot' }> {
    if (!session?.trim()) throw new Error('session is required');
    const ownership = await this.sessionManager.assertHydraSessionOwnership(session);
    if (!ownership.live) {
      throw new Error(`Hydra session "${session}" is stopped`);
    }
    return { kind: ownership.kind };
  }

  private validateCreate(input: CreateSessionTerminalPaneInput): void {
    if (!input || !input.session?.trim()) throw new Error('session is required');
    if (!UUID_PATTERN.test(input.requestId ?? '')) {
      throw new Error('requestId must be a valid UUID');
    }
    if (input.direction !== 'down' && input.direction !== 'right') {
      throw new Error('direction must be "down" or "right"');
    }
    if (
      input.startDirectory !== 'session-workdir'
      && input.startDirectory !== 'agent-current-directory'
    ) {
      throw new Error(
        'startDirectory must be "session-workdir" or "agent-current-directory"',
      );
    }
    if (input.command !== undefined) {
      if (typeof input.command !== 'string') throw new Error('command must be a string');
      if (input.command.length > MAX_COMMAND_LENGTH) {
        throw new Error(`command must be at most ${MAX_COMMAND_LENGTH} characters`);
      }
      if (/[\0\r\n]/.test(input.command)) {
        throw new Error('command must be a single line without control characters');
      }
    }
  }

  private validateTarget(session: string, paneId: string): void {
    if (!session?.trim()) throw new Error('session is required');
    if (!/^%\d+$/.test(paneId ?? '')) throw new Error('paneId must be a tmux pane ID');
  }

  private async serialize<T>(session: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(session) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.mutations.set(session, current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.mutations.get(session) === current) this.mutations.delete(session);
    }
  }
}
