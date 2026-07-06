// Preload — the secure IPC bridge. contextIsolation is on, so the renderer never
// touches Node or ipcRenderer directly; it sees only `window.hydra.getBootstrap()`,
// which resolves the { url, token } handoff. That is the ONLY thing exposed —
// every domain call goes over the loopback transport, not IPC (FINAL §2).

import { contextBridge, ipcRenderer } from 'electron';

import { IPC_BOOTSTRAP_CHANNEL, type HydraBootstrap, type HydraBridge } from './bootstrap';

const bridge: HydraBridge = {
  getBootstrap: (): Promise<HydraBootstrap> => ipcRenderer.invoke(IPC_BOOTSTRAP_CHANNEL),
};

contextBridge.exposeInMainWorld('hydra', bridge);
