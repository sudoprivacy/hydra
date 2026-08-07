// SEND side of worker→copilot attention over nexus (gap #1 of the hydra A2A
// message plane, doc §5 "worker→copilot attention").
//
// The sidecar polls its NotificationStore for copilot-directed attention
// (needs-input / runtime-error, `targetSession` = the copilot's session) and
// mirrors each — exactly once — to that copilot's chat-with-me mailbox, so
// attention raised on one machine reaches a copilot on another. Cross-machine is
// the whole point: the NotificationStore is per-machine, so today a worker on Mac
// never reaches a copilot on Win.
//
// Why POLL, not an in-process event listener: a major attention source is the
// detached `hydra hooks` CLI (packages/cli hooks.ts), a SEPARATE process that
// writes the file-backed store. `EventLog.onDidAppend` only fires for same-process
// appends, so it would silently miss hook-originated attention; `list()` reads the
// store file fresh, so a poll sees every origin uniformly (hook CLI, needs-input
// monitor, WLS). Attention is not latency-critical, so a ~1.5s poll is ample.
//
// Loop guard: the RECEIVE side (copilotInboundBridge) re-materializes each mailbox
// message into the peer machine's local store with `context.viaMailbox = true`.
// This mirror skips those, so it never echoes a re-materialized notification back
// to the mailbox it just came from. `dedupeKey` is carried through so a re-
// materialized copy collides with the local original when the copilot happens to
// be on the SAME machine (NotificationStore.create dedups by dedupeKey) — no double.
//
// Wired only in nexus / dual mode (an empty/legacy transport makes send a no-op).

import { logger } from './logger';
import type { HydraNotification, NotificationStore } from './notifications';
import type { MessageTransport } from './transport/nexus/messageTransport';

/** The notification payload carried in a mailbox frame body (JSON). */
export interface MirroredNotification {
  kind: HydraNotification['kind'];
  title: string;
  body: string;
  sourceSession: string | null;
  dedupeKey?: string;
  context?: HydraNotification['context'];
}

export interface NotificationMailboxMirrorOptions {
  store: NotificationStore;
  messageTransport: MessageTransport;
  /** Poll cadence; attention is not latency-critical. Default 1500ms. */
  pollIntervalMs?: number;
}

const DEFAULT_POLL_MS = 1500;

export class NotificationMailboxMirror {
  private readonly store: NotificationStore;
  private readonly messageTransport: MessageTransport;
  private readonly pollIntervalMs: number;
  /** notification id -> already mirrored (poll idempotency), pruned to live store ids. */
  private readonly mirrored = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(options: NotificationMailboxMirrorOptions) {
    this.store = options.store;
    this.messageTransport = options.messageTransport;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    // Never hold the process open just for the mirror.
    this.timer.unref?.();
  }

  /** One poll pass. Also the deterministic entry point for the smoke. */
  async pollOnce(): Promise<void> {
    let notifications: HydraNotification[];
    try {
      notifications = this.store.list().notifications;
    } catch (error) {
      logger.warn('nexus.notification-mirror', 'notification list failed (non-fatal)', {
        error: String(error),
      });
      return;
    }

    const liveIds = new Set<string>();
    for (const n of notifications) {
      liveIds.add(n.id);
      // Only copilot-directed attention carries a targetSession.
      if (!n.targetSession) {
        continue;
      }
      // Re-materialized from a mailbox on this machine — never echo it back.
      if (n.context?.viaMailbox) {
        continue;
      }
      if (this.mirrored.has(n.id)) {
        continue;
      }
      this.mirrored.add(n.id);
      const payload: MirroredNotification = {
        kind: n.kind,
        title: n.title,
        body: n.body,
        sourceSession: n.sourceSession,
        dedupeKey: n.dedupeKey,
        context: n.context,
      };
      try {
        await this.messageTransport.send(n.targetSession, { body: JSON.stringify(payload) });
      } catch (error) {
        // Transient send failure — drop the mark so the next poll retries.
        this.mirrored.delete(n.id);
        logger.warn('nexus.notification-mirror', 'mirror to copilot mailbox failed (non-fatal)', {
          target: n.targetSession,
          error: String(error),
        });
      }
    }

    // Bound the dedupe set to notifications still retained in the store.
    for (const id of this.mirrored) {
      if (!liveIds.has(id)) {
        this.mirrored.delete(id);
      }
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
