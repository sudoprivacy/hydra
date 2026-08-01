// Message plane (doc §5) — the second synchronized switchable plane. Delivers + reads
// agent-to-agent messages. Legacy backend = tmux inject + NotificationStore (stays in
// hydra, wired at the callsite); nexus backend = chat-with-me mailbox write + collect
// over the VFS agent plane, with the kernel stamping an unforgeable `from`.

import { NexusVfsClient, NexusVfsClientOptions } from './vfsClient';

/** An A2A message. `from` is a placeholder — the kernel stamp hook overwrites it. */
export interface MessageEnvelope {
  from?: string;
  to?: string | null;
  body: string;
}

export interface WatchOptions {
  /** Abort to stop tailing (the returned promise then resolves). */
  signal?: AbortSignal;
  /** Start from this offset (default "0" — from the beginning). */
  fromOffset?: string;
  /** Per-read server long-poll timeout (default 30s). */
  timeoutMs?: number;
}

/** `target` is the recipient agent's persistent name (= `worker.sessionName` today). */
export interface MessageTransport {
  send(target: string, envelope: MessageEnvelope): Promise<void>;
  collect(target: string): Promise<MessageEnvelope[]>;
  /**
   * Tail a mailbox: call `onMessage` for each new envelope until `opts.signal` aborts.
   * The nexus plane uses sys_watch (blocking StreamReadAt); other planes are no-ops.
   */
  watch(
    target: string,
    onMessage: (envelope: MessageEnvelope) => void,
    opts?: WatchOptions,
  ): Promise<void>;
  close(): void;
}

const mailboxPath = (agent: string): string => `/agents/${agent}/chat-with-me`;

/** Legacy: nexus messaging off. The tmux / NotificationStore path stays in hydra. */
export class NoopMessageTransport implements MessageTransport {
  async send(): Promise<void> {}
  async collect(): Promise<MessageEnvelope[]> {
    return [];
  }
  async watch(): Promise<void> {} // no mailbox on this plane
  close(): void {}
}

/** nexus: chat-with-me mailbox write + collect; `from` is kernel-stamped (unforgeable). */
export class NexusMessageTransport implements MessageTransport {
  private readonly client: NexusVfsClient;

  constructor(options: NexusVfsClientOptions = {}) {
    this.client = new NexusVfsClient(options);
  }

  async send(target: string, envelope: MessageEnvelope): Promise<void> {
    const path = mailboxPath(target);
    await this.client.mkstream(path);
    // A forged `from` here is harmless — the kernel stamp hook overwrites it with the
    // caller's authenticated agent_id (on the cert/token plane). NoAuth (serve-local)
    // passes it through, so from-unforgeability holds only on an authenticated plane.
    const frame = JSON.stringify({
      from: envelope.from ?? '(unset)',
      to: envelope.to ?? null,
      body: envelope.body,
    });
    await this.client.streamWrite(path, Buffer.from(frame));
  }

  async collect(target: string): Promise<MessageEnvelope[]> {
    const raw = await this.client.streamCollect(mailboxPath(target));
    if (!raw.length) {
      return [];
    }
    // Single-message decode: the stamp hook re-serializes each frame (dropping any
    // delimiter), so multi-message framing is a follow-up.
    return [JSON.parse(raw.toString()) as MessageEnvelope];
  }

  async watch(
    target: string,
    onMessage: (envelope: MessageEnvelope) => void,
    opts: WatchOptions = {},
  ): Promise<void> {
    const path = mailboxPath(target);
    await this.client.mkstream(path); // idempotent — the stream must exist to tail
    let offset = opts.fromOffset ?? '0';
    const timeoutMs = opts.timeoutMs ?? 30000;
    while (!opts.signal?.aborted) {
      const { data, nextOffset, eof } = await this.client.streamReadAt(path, offset, {
        blocking: true,
        timeoutMs,
      });
      if (opts.signal?.aborted) {
        break;
      }
      if (eof || !data.length) {
        continue; // long-poll timed out with no frame — loop
      }
      offset = nextOffset;
      try {
        onMessage(JSON.parse(data.toString()) as MessageEnvelope);
      } catch {
        // skip a frame that is not a JSON envelope
      }
    }
  }

  close(): void {
    this.client.close();
  }
}

/** The tmux surface the legacy plane needs — the multiplexer backend satisfies it. */
export interface LegacyMessageBackend {
  sendMessage(sessionName: string, message: string): Promise<void>;
}

/** Legacy: deliver via the multiplexer backend (tmux keystroke inject); no mailbox collect. */
export class LegacyMessageTransport implements MessageTransport {
  constructor(private readonly backend: LegacyMessageBackend) {}
  async send(target: string, envelope: MessageEnvelope): Promise<void> {
    await this.backend.sendMessage(target, envelope.body);
  }
  async collect(): Promise<MessageEnvelope[]> {
    return []; // tmux has no durable mailbox to read back
  }
  async watch(): Promise<void> {} // legacy attention rides NotificationStore, not a mailbox
  close(): void {}
}

/**
 * Dual: legacy tmux inject (primary during migration — must succeed) AND a best-effort
 * mirror to the nexus mailbox (failures swallowed so nexus can never break delivery).
 */
export class DualMessageTransport implements MessageTransport {
  constructor(
    private readonly legacy: MessageTransport,
    private readonly nexus: MessageTransport,
    private readonly onError: (op: string, error: unknown) => void = () => {},
  ) {}

  async send(target: string, envelope: MessageEnvelope): Promise<void> {
    await this.legacy.send(target, envelope);
    try {
      await this.nexus.send(target, envelope);
    } catch (error) {
      this.onError('send', error);
    }
  }

  async collect(target: string): Promise<MessageEnvelope[]> {
    try {
      return await this.nexus.collect(target);
    } catch (error) {
      this.onError('collect', error);
      return [];
    }
  }

  async watch(
    target: string,
    onMessage: (envelope: MessageEnvelope) => void,
    opts?: WatchOptions,
  ): Promise<void> {
    // Mailbox tailing is the nexus plane's job; legacy attention runs via its own path.
    await this.nexus.watch(target, onMessage, opts);
  }

  close(): void {
    this.legacy.close();
    this.nexus.close();
  }
}
