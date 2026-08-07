// Per-key registration into the switchable orchestration-tracking plane (doc §5).
//
// register(key, input) reports a run in via the RunTracker and remembers the pid
// nexus assigned, so unregister(key) reports the SAME run out. Best-effort —
// tracking is pure-additive and must NEVER gate a lifecycle (a nexus outage can't
// break spawn/stop). The RunTracker itself is the switch (NoopRunTracker in legacy
// / NexusRunTracker / DualRunTracker), so this is switchable BY CONSTRUCTION — in
// legacy every call is a no-op, no `if nexus` guard needed.
//
// The one place the "register a run, remember its pid, unregister it, swallow
// failures" machinery lives — shared by WorkerLifecycleService (key = workerId,
// rename-stable) and the copilot lifecycle (key = copilotSessionName). Mirrors
// MailboxTailRegistry for the message plane.

import { logger } from './logger';
import type { RegisterRunInput, RunTracker } from './transport/nexus/runTracker';

export class RunTrackingRegistry<K> {
  /** key -> the agent pid nexus assigned (so unregister reports the same run out). */
  private readonly registered = new Map<K, string>();

  constructor(
    private readonly tracker: RunTracker,
    /** logger namespace prefix, e.g. `nexus-tracking` / `nexus-tracking.copilot`. */
    private readonly logScope: string = 'nexus-tracking',
  ) {}

  /** Already tracking `key`? Callers skip re-resolving inputs when so. */
  has(key: K): boolean {
    return this.registered.has(key);
  }

  /** Report a run in under `key` (idempotent per key). Best-effort. */
  async register(key: K, input: RegisterRunInput): Promise<void> {
    if (this.registered.has(key)) {
      return;
    }
    try {
      const handle = await this.tracker.registerRun(input);
      if (handle) {
        this.registered.set(key, handle.pid);
      }
    } catch (error) {
      logger.warn(`${this.logScope}.register`, 'registerRun failed (non-fatal)', {
        key: String(key),
        error: String(error),
      });
    }
  }

  /** Report the run for `key` out (best-effort). No-op if not registered. */
  async unregister(key: K): Promise<void> {
    const pid = this.registered.get(key);
    if (pid === undefined) {
      return;
    }
    this.registered.delete(key);
    try {
      await this.tracker.unregisterRun(pid);
    } catch (error) {
      logger.warn(`${this.logScope}.unregister`, 'unregisterRun failed (non-fatal)', {
        key: String(key),
        error: String(error),
      });
    }
  }
}
