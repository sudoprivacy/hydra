// RECEIVE side of worker→copilot attention over nexus (gap #1 of the hydra A2A
// message plane).
//
// Symmetric to WorkerLifecycleService.startInboundBridge (which tails a WORKER's
// mailbox and injects each message into its pane): this tails a COPILOT's
// chat-with-me mailbox and re-materializes each mirrored attention notification
// into THIS machine's local NotificationStore, so the copilot's existing
// notification UI surfaces attention that a worker raised on another machine.
//
// Each re-materialized notification is stamped context.viaMailbox=true so the
// send-side NotificationMailboxMirror skips it — it never echoes a re-materialized
// notification back to the mailbox it came from (the copilot-machine loop guard).
// dedupeKey is preserved, so if the copilot happens to be on the SAME machine as
// the worker, this collides with the local original (NotificationStore.create
// dedups by dedupeKey) rather than double-notifying.
//
// Started per copilot at appService.createCopilot, stopped on delete; nexus/dual
// only (the transport's watch is a no-op on the legacy plane).

import { logger } from './logger';
import { MailboxTailRegistry } from './mailboxTailRegistry';
import type { MirroredNotification } from './notificationMailboxMirror';
import { NotificationStore } from './notifications';
import type { MessageTransport } from './transport/nexus/messageTransport';

export interface CopilotInboundBridgeOptions {
  store: NotificationStore;
  messageTransport: MessageTransport;
}

export class CopilotInboundBridge {
  private readonly store: NotificationStore;
  /** Shared mailbox-tail machinery, keyed by copilotSessionName. */
  private readonly tails: MailboxTailRegistry<string>;

  constructor(options: CopilotInboundBridgeOptions) {
    this.store = options.store;
    this.tails = new MailboxTailRegistry<string>(
      options.messageTransport,
      (mailbox, envelope) => this.materialize(mailbox, envelope.body),
    );
  }

  /** Begin tailing a copilot's mailbox (idempotent per session). Best-effort. */
  start(copilotSessionName: string): void {
    if (!copilotSessionName) {
      return;
    }
    this.tails.start(copilotSessionName, copilotSessionName);
  }

  stop(copilotSessionName: string): void {
    this.tails.stop(copilotSessionName);
  }

  dispose(): void {
    this.tails.dispose();
  }

  /** Test seam: re-materialize one mailbox frame body synchronously. */
  materializeForTest(copilotSessionName: string, body: string): void {
    this.materialize(copilotSessionName, body);
  }

  private materialize(copilotSessionName: string, body: string): void {
    let payload: MirroredNotification;
    try {
      payload = JSON.parse(body) as MirroredNotification;
    } catch {
      return; // not a mirrored-notification frame — ignore
    }
    if (!payload || typeof payload.title !== 'string') {
      return;
    }
    try {
      this.store.create({
        kind: payload.kind,
        title: payload.title,
        body: payload.body,
        targetSession: copilotSessionName,
        sourceSession: payload.sourceSession,
        dedupeKey: payload.dedupeKey,
        context: { ...payload.context, viaMailbox: true },
        eventSource: 'session-manager',
      });
    } catch (error) {
      logger.warn('nexus.copilot-bridge', 'failed to re-materialize mirrored notification', {
        copilotSessionName,
        error: String(error),
      });
    }
  }
}
