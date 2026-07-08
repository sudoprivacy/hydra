// Preload — the secure IPC bridge. contextIsolation is on, so the renderer never
// touches Node or ipcRenderer directly; it sees only `window.hydra.getBootstrap()`,
// which resolves the { url, token } handoff. That is the ONLY thing exposed —
// every domain call goes over the loopback transport, not IPC (FINAL §2).

import { contextBridge, ipcRenderer } from 'electron';

import type { HydraBootstrap, HydraBridge } from './bootstrap';

// The preload runs SANDBOXED (Electron's default), so it cannot `require` local
// modules — importing a runtime value from './bootstrap' makes the compiled
// preload emit `require('./bootstrap')`, which the sandbox rejects and leaves
// `window.hydra` unset (blank window). Import only TYPES from bootstrap and inline
// the channel literal. Must stay equal to IPC_BOOTSTRAP_CHANNEL in bootstrap.ts.
const IPC_BOOTSTRAP_CHANNEL = 'hydra:bootstrap';

const bridge: HydraBridge = {
  getBootstrap: (): Promise<HydraBootstrap> => ipcRenderer.invoke(IPC_BOOTSTRAP_CHANNEL),
};

contextBridge.exposeInMainWorld('hydra', bridge);
