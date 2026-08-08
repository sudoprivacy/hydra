// The switchable transport seam (doc §5). One mode flips both planes IN SYNC — the
// tracking plane today, the message plane joins here later — so they are never split.
//
//   HYDRA_TRANSPORT=legacy   (default)  tmux/NotificationStore only; nexus untouched
//   HYDRA_TRANSPORT=nexus                nexus backends only
//   HYDRA_TRANSPORT=dual                 both; nexus is best-effort (failures swallowed)
//
// The nexus plane authenticates from env:
//   NEXUS_AGENT_ADDR       host:port of the daemon's agent plane
//   NEXUS_AGENT_CERT_DIR   an agent bundle dir (ca.pem + agent.pem + agent-key.pem)
//                          -> mTLS cert plane (the ONLY plane an auth-on daemon exposes)
//   NEXUS_SK               sk- token -> token/insecure plane (loopback / auth-off)
//
// Wired at the CLI composition roots (where `new TmuxBackendCore()` lives), so the
// choice is made once per process alongside the multiplexer backend.

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  DualRunTracker,
  NexusRunTracker,
  NoopRunTracker,
  RunTracker,
} from './runTracker';
import {
  DualMessageTransport,
  LegacyMessageBackend,
  LegacyMessageTransport,
  MessageTransport,
  NexusMessageTransport,
  NoopMessageTransport,
} from './messageTransport';
import { NexusVfsClientOptions } from './vfsClient';

export * from './vfsClient';
export * from './runTracker';
export * from './messageTransport';

export type TransportMode = 'legacy' | 'nexus' | 'dual';

/** The shape of `process.env` we read — avoids the `NodeJS` global (no-undef under the flat eslint config). */
type ProcessEnv = Record<string, string | undefined>;

export function resolveTransportMode(env: ProcessEnv = process.env): TransportMode {
  const raw = (env.HYDRA_TRANSPORT ?? 'legacy').toLowerCase();
  return raw === 'nexus' || raw === 'dual' ? raw : 'legacy';
}

/**
 * How the app authenticates to the nexus agent plane, resolved from env.
 *
 * `NEXUS_AGENT_CERT_DIR` (an agent bundle dir: `ca.pem` + `agent.pem` +
 * `agent-key.pem`) selects the mTLS cert plane — the ONLY plane an auth-on
 * daemon exposes (agents authenticate by cert on the main bind; the separate
 * `--agent-bind-addr` sk- plane was removed). Point `NEXUS_AGENT_ADDR` at that
 * bind. Without a cert dir, fall back to the `NEXUS_SK` token / insecure plane
 * (loopback / auth-off daemons). A cert dir wins over a stray token.
 */
export function resolveAgentCredential(env: ProcessEnv): Pick<NexusVfsClientOptions, 'tls' | 'token'> {
  const certDir = env.NEXUS_AGENT_CERT_DIR;
  if (certDir) {
    return {
      tls: {
        ca: readFileSync(join(certDir, 'ca.pem')),
        cert: readFileSync(join(certDir, 'agent.pem')),
        key: readFileSync(join(certDir, 'agent-key.pem')),
      },
    };
  }
  return { token: env.NEXUS_SK };
}

export interface TransportOptions {
  /** Overrides; address + credential (tls/token) default from NEXUS_AGENT_ADDR / NEXUS_AGENT_CERT_DIR / NEXUS_SK. */
  clientOptions?: NexusVfsClientOptions;
  /** Non-fatal nexus errors in Dual mode land here (default: warn to console). */
  onError?: (op: string, error: unknown) => void;
  env?: ProcessEnv;
  /** The multiplexer backend — powers the legacy (tmux) message plane in legacy/dual. */
  backend?: LegacyMessageBackend;
}

export interface TransportBackends {
  mode: TransportMode;
  runTracker: RunTracker;
  messageTransport: MessageTransport;
  /**
   * The PURE-nexus message transport (mailbox send/watch only), when the plane is
   * nexus or dual; `undefined` in legacy. Distinct from `messageTransport`, which in
   * dual mode is the composed Dual (tmux inject + nexus mirror). The worker→copilot
   * attention mirror + copilot inbound bridge use THIS so they never tmux-inject a
   * serialized notification into a pane (dual's `send` would).
   */
  nexusMessageTransport?: MessageTransport;
}

/** Construct the per-process transport backends, both planes switched by one mode. */
export function createTransport(opts: TransportOptions = {}): TransportBackends {
  const env = opts.env ?? process.env;
  const mode = resolveTransportMode(env);
  const legacyMessages: MessageTransport = opts.backend
    ? new LegacyMessageTransport(opts.backend)
    : new NoopMessageTransport();
  if (mode === 'legacy') {
    return { mode, runTracker: new NoopRunTracker(), messageTransport: legacyMessages };
  }

  const clientOptions: NexusVfsClientOptions = {
    address: env.NEXUS_AGENT_ADDR,
    ...resolveAgentCredential(env),
    ...opts.clientOptions,
  };
  const onError =
    opts.onError ??
    ((op: string, error: unknown) =>
      // eslint-disable-next-line no-console
      console.warn(`[hydra/nexus-transport] non-fatal ${op} failure:`, error));
  const nexusTracker = new NexusRunTracker(clientOptions);
  const nexusMessages = new NexusMessageTransport(clientOptions);
  if (mode === 'nexus') {
    return {
      mode,
      runTracker: nexusTracker,
      messageTransport: nexusMessages,
      nexusMessageTransport: nexusMessages,
    };
  }

  // Dual: legacy tmux inject is the primary path; nexus tracking + mailbox mirror are
  // best-effort (failures swallowed via onError) so nexus can never break delivery.
  return {
    mode,
    runTracker: new DualRunTracker(nexusTracker, onError),
    messageTransport: new DualMessageTransport(legacyMessages, nexusMessages, onError),
    nexusMessageTransport: nexusMessages,
  };
}
