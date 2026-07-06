// The ONE thing that crosses Electron IPC (FINAL §"Data plane"): the loopback
// bootstrap handoff. Everything else — every domain call and stream — rides the
// loopback HTTP/WS transport, never IPC. Shared by the main process (which
// produces it), the preload (which bridges it), and the renderer (which builds
// its HydraControlClient from it).

/** IPC channel the preload invokes to fetch the bootstrap from main. */
export const IPC_BOOTSTRAP_CHANNEL = 'hydra:bootstrap';

/** Loopback coordinates handed to the renderer. */
export interface HydraBootstrap {
  url: string;
  token: string;
}

/** The surface `contextBridge` exposes on `window.hydra` in the renderer. */
export interface HydraBridge {
  getBootstrap(): Promise<HydraBootstrap>;
}
