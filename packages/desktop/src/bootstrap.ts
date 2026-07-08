// The tiny Electron IPC surface: bootstrap hands the renderer loopback
// coordinates, and openExternal lets terminal links leave the sandbox after main
// process validation. Domain calls and streams still ride the loopback transport.

/** IPC channel the preload invokes to fetch the bootstrap from main. */
export const IPC_BOOTSTRAP_CHANNEL = 'hydra:bootstrap';

/** IPC channel used by terminal links to open http(s) URLs externally. */
export const IPC_OPEN_EXTERNAL_CHANNEL = 'hydra:open-external';

/** Loopback coordinates handed to the renderer. */
export interface HydraBootstrap {
  url: string;
  token: string;
}

/** The surface `contextBridge` exposes on `window.hydra` in the renderer. */
export interface HydraBridge {
  getBootstrap(): Promise<HydraBootstrap>;
  openExternal(url: string): Promise<void>;
}
