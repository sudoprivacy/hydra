// A per-key registry of nexus mailbox tails: `start(key, mailbox)` opens a
// `messageTransport.watch` on `mailbox` and calls `deliver(mailbox, envelope)`
// for each message until `stop(key)` / `dispose()` aborts it.
//
// The one place the "tail a mailbox, deliver each message, per-key lifecycle"
// machinery lives — shared by both message-plane inbound directions:
//   * WorkerLifecycleService — key = workerId (rename-stable), deliver = inject
//     the body into the worker's pane (`backend.sendMessage`).
//   * CopilotInboundBridge — key = copilotSessionName, deliver = re-materialize
//     the mirrored attention notification into the local NotificationStore.
// Best-effort: a watch failure is reported via `onError`, never thrown.

import { logger } from './logger';
import type { MessageEnvelope, MessageTransport } from './transport/nexus/messageTransport';

export class MailboxTailRegistry<K> {
  private readonly tails = new Map<K, AbortController>();

  constructor(
    private readonly messageTransport: MessageTransport,
    /** Called for each message on a tailed mailbox. `mailbox` = the tailed name. */
    private readonly deliver: (mailbox: string, envelope: MessageEnvelope) => void,
    /** Non-fatal watch failure hook (logs by default). */
    private readonly onError: (key: K, mailbox: string, error: unknown) => void = (key, mailbox, error) =>
      logger.warn('nexus.mailbox-tail', 'mailbox tail failed (non-fatal)', {
        key: String(key),
        mailbox,
        error: String(error),
      }),
  ) {}

  /** Begin tailing `mailbox` under `key` (idempotent per key). */
  start(key: K, mailbox: string): void {
    if (this.tails.has(key)) {
      return;
    }
    const controller = new AbortController();
    this.tails.set(key, controller);
    void this.messageTransport
      .watch(mailbox, (envelope) => this.deliver(mailbox, envelope), { signal: controller.signal })
      .catch((error) => this.onError(key, mailbox, error));
  }

  stop(key: K): void {
    const controller = this.tails.get(key);
    if (controller) {
      controller.abort();
      this.tails.delete(key);
    }
  }

  dispose(): void {
    for (const controller of this.tails.values()) {
      controller.abort();
    }
    this.tails.clear();
  }
}
