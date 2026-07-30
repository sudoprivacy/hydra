// Orchestration-tracking plane (doc §5) — one of the two synchronized switchable
// planes. It reports a run's *identity and lifecycle* to a backend; process OWNERSHIP
// (spawn / kill / git / worktree) is NOT here — that stays hydra either way (§8.1).
//
// Legacy backend  = tmux-session tracking only (no-op here).
// nexus backend   = register_external / heartbeat into the kernel AgentRegistry.
// Dual backend    = report to nexus alongside legacy, swallowing nexus failures so a
//                   nexus outage can never take down hydra's worker lifecycle.

import { NexusVfsClient, NexusVfsClientOptions } from './vfsClient';

/** What nexus assigned for a reported run. */
export interface RunHandle {
  /** The agent pid == the OS host_pid (nexus-vfs #195), e.g. "4242" or "4242.7". */
  pid: string;
  /** The persistent, cluster-unique agent name. */
  name: string;
}

export interface RegisterRunInput {
  /** Persistent cluster-unique name, e.g. `<node_id>-hydra-w<workerId>`. */
  name: string;
  /** OS pid hosting the run — for hydra, the tmux pane pid. */
  hostPid: number;
  /** Unique id for this registration; presence selects the external (unmanaged) path. */
  connectionId: string;
  /** Disambiguates micro-agents sharing one OS process (coroutines/threads). */
  localId?: number;
  ownerId?: string;
  zoneId?: string;
  labels?: Record<string, string>;
}

export interface RunSummary {
  pid: string;
  name: string;
  state: string;
}

/** The tracking plane a hydra run's lifecycle drives. */
export interface RunTracker {
  /** Report a run in. Returns null when the backend does not track (legacy) or a Dual write failed. */
  registerRun(input: RegisterRunInput): Promise<RunHandle | null>;
  heartbeat(pid: string): Promise<void>;
  unregisterRun(pid: string): Promise<void>;
  listRuns(filter?: { zoneId?: string; ownerId?: string }): Promise<RunSummary[]>;
  close(): void;
}

/** Legacy: tmux-session tracking is implicit, so nexus tracking is a no-op. */
export class NoopRunTracker implements RunTracker {
  async registerRun(): Promise<RunHandle | null> {
    return null;
  }
  async heartbeat(): Promise<void> {}
  async unregisterRun(): Promise<void> {}
  async listRuns(): Promise<RunSummary[]> {
    return [];
  }
  close(): void {}
}

/** nexus: register_external / heartbeat into the kernel AgentRegistry via the Call RPC. */
export class NexusRunTracker implements RunTracker {
  private readonly client: NexusVfsClient;

  constructor(options: NexusVfsClientOptions = {}) {
    this.client = new NexusVfsClient(options);
  }

  async registerRun(input: RegisterRunInput): Promise<RunHandle> {
    const desc = await this.client.call<RunHandle>('agent_register_external', {
      name: input.name,
      owner_id: input.ownerId ?? 'hydra',
      zone_id: input.zoneId ?? '',
      connection_id: input.connectionId,
      host_pid: input.hostPid,
      local_id: input.localId,
      protocol: 'hydra',
      labels: input.labels ?? {},
    });
    return { pid: desc.pid, name: desc.name };
  }

  async heartbeat(pid: string): Promise<void> {
    await this.client.call('agent_heartbeat', { pid });
  }

  async unregisterRun(pid: string): Promise<void> {
    await this.client.call('agent_unregister_external', { pid });
  }

  async listRuns(filter: { zoneId?: string; ownerId?: string } = {}): Promise<RunSummary[]> {
    return this.client.call<RunSummary[]>('agent_list', {
      zone_id: filter.zoneId,
      owner_id: filter.ownerId,
    });
  }

  close(): void {
    this.client.close();
  }
}

/**
 * Dual: report to nexus alongside legacy tracking (legacy is a no-op, so this is nexus
 * with a safety net). nexus tracking is pure-additive — it does not own the process — so
 * failures are swallowed via `onError`; a nexus outage must never break worker lifecycle.
 */
export class DualRunTracker implements RunTracker {
  constructor(
    private readonly nexus: RunTracker,
    private readonly onError: (op: string, error: unknown) => void = () => {},
  ) {}

  async registerRun(input: RegisterRunInput): Promise<RunHandle | null> {
    try {
      return await this.nexus.registerRun(input);
    } catch (error) {
      this.onError('registerRun', error);
      return null;
    }
  }

  async heartbeat(pid: string): Promise<void> {
    try {
      await this.nexus.heartbeat(pid);
    } catch (error) {
      this.onError('heartbeat', error);
    }
  }

  async unregisterRun(pid: string): Promise<void> {
    try {
      await this.nexus.unregisterRun(pid);
    } catch (error) {
      this.onError('unregisterRun', error);
    }
  }

  async listRuns(filter?: { zoneId?: string; ownerId?: string }): Promise<RunSummary[]> {
    try {
      return await this.nexus.listRuns(filter);
    } catch (error) {
      this.onError('listRuns', error);
      return [];
    }
  }

  close(): void {
    this.nexus.close();
  }
}
