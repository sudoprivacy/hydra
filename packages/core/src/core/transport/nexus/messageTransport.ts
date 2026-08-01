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

/** `target` is the recipient agent's persistent name (= `worker.sessionName` today). */
export interface MessageTransport {
  send(target: string, envelope: MessageEnvelope): Promise<void>;
  collect(target: string): Promise<MessageEnvelope[]>;
  close(): void;
}

const mailboxPath = (agent: string): string => `/agents/${agent}/chat-with-me`;

/** Legacy: nexus messaging off. The tmux / NotificationStore path stays in hydra. */
export class NoopMessageTransport implements MessageTransport {
  async send(): Promise<void> {}
  async collect(): Promise<MessageEnvelope[]> {
    return [];
  }
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

  close(): void {
    this.legacy.close();
    this.nexus.close();
  }
}
