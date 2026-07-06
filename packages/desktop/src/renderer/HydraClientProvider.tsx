// HydraClientProvider + useHydraClient — the seam boundary for the whole UI.
//
// It reads the { url, token } handoff off `window.hydra` (the preload bridge),
// builds ONE HydraControlClient over LoopbackHttpWsTransport, and provides it via
// context. Every feature screen (Mission Control now; terminal/diff later) calls
// `useHydraClient()` and never touches the transport, the token, or IPC directly.
// Swapping the transport (Fork B) changes only this file.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { createHydraControlClient, type HydraControlClient } from '@hydra/protocol';
import { LoopbackHttpWsTransport } from '@hydra/transport-loopback';

import type { HydraBridge } from '../bootstrap';

declare global {
  interface Window {
    hydra: HydraBridge;
  }
}

const HydraClientContext = createContext<HydraControlClient | null>(null);

export function HydraClientProvider({ children }: { children: ReactNode }): JSX.Element {
  const [client, setClient] = useState<HydraControlClient | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    window.hydra
      .getBootstrap()
      .then((bootstrap) => {
        if (active) {
          setClient(createHydraControlClient(new LoopbackHttpWsTransport(bootstrap)));
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return <div className="hydra-status hydra-status--error">Could not reach the sidecar: {error}</div>;
  }
  if (!client) {
    return <div className="hydra-status">Connecting to the sidecar…</div>;
  }
  return <HydraClientContext.Provider value={client}>{children}</HydraClientContext.Provider>;
}

/** Access the shared HydraControlClient. Throws if used outside the provider. */
export function useHydraClient(): HydraControlClient {
  const client = useContext(HydraClientContext);
  if (!client) {
    throw new Error('useHydraClient must be used within <HydraClientProvider>');
  }
  return client;
}
