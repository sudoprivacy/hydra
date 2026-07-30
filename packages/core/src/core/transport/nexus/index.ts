// The switchable transport seam (doc §5). One mode flips both planes IN SYNC — the
// tracking plane today, the message plane joins here later — so they are never split.
//
//   HYDRA_TRANSPORT=legacy   (default)  tmux/NotificationStore only; nexus untouched
//   HYDRA_TRANSPORT=nexus                nexus backends only
//   HYDRA_TRANSPORT=dual                 both; nexus is best-effort (failures swallowed)
//
// Wired at the CLI composition roots (where `new TmuxBackendCore()` lives), so the
// choice is made once per process alongside the multiplexer backend.

import {
  DualRunTracker,
  NexusRunTracker,
  NoopRunTracker,
  RunTracker,
} from './runTracker';
import { NexusVfsClientOptions } from './vfsClient';

export * from './vfsClient';
export * from './runTracker';

export type TransportMode = 'legacy' | 'nexus' | 'dual';

export function resolveTransportMode(env: NodeJS.ProcessEnv = process.env): TransportMode {
  const raw = (env.HYDRA_TRANSPORT ?? 'legacy').toLowerCase();
  return raw === 'nexus' || raw === 'dual' ? raw : 'legacy';
}

export interface TransportOptions {
  /** Overrides; address/token default from NEXUS_AGENT_ADDR / NEXUS_SK. */
  clientOptions?: NexusVfsClientOptions;
  /** Non-fatal nexus errors in Dual mode land here (default: warn to console). */
  onError?: (op: string, error: unknown) => void;
  env?: NodeJS.ProcessEnv;
}

export interface TransportBackends {
  mode: TransportMode;
  runTracker: RunTracker;
  // messageTransport: MessageTransport;  // joins here with the message plane
}

/** Construct the per-process transport backends, both planes switched by one mode. */
export function createTransport(opts: TransportOptions = {}): TransportBackends {
  const env = opts.env ?? process.env;
  const mode = resolveTransportMode(env);
  if (mode === 'legacy') {
    return { mode, runTracker: new NoopRunTracker() };
  }

  const clientOptions: NexusVfsClientOptions = {
    address: env.NEXUS_AGENT_ADDR,
    token: env.NEXUS_SK,
    ...opts.clientOptions,
  };
  const nexus = new NexusRunTracker(clientOptions);
  if (mode === 'nexus') {
    return { mode, runTracker: nexus };
  }

  const onError =
    opts.onError ??
    ((op: string, error: unknown) =>
      // eslint-disable-next-line no-console
      console.warn(`[hydra/nexus-tracking] non-fatal ${op} failure:`, error));
  return { mode, runTracker: new DualRunTracker(nexus, onError) };
}
