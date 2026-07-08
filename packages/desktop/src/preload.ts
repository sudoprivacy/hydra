// Preload — the secure IPC bridge. contextIsolation is on, so the renderer never
// touches Node or ipcRenderer directly. The exposed surface stays narrow:
// bootstrap for loopback coordinates, plus validated external URL opening.

import { contextBridge, ipcRenderer } from 'electron';

import type { HydraBootstrap, HydraBridge } from './bootstrap';

// The preload runs SANDBOXED (Electron's default), so it cannot `require` local
// modules — importing a runtime value from './bootstrap' makes the compiled
// preload emit `require('./bootstrap')`, which the sandbox rejects and leaves
// `window.hydra` unset (blank window). Import only TYPES from bootstrap and inline
// the channel literal. Must stay equal to IPC_BOOTSTRAP_CHANNEL in bootstrap.ts.
const IPC_BOOTSTRAP_CHANNEL = 'hydra:bootstrap';
const IPC_OPEN_EXTERNAL_CHANNEL = 'hydra:open-external';

const bridge: HydraBridge = {
  getBootstrap: (): Promise<HydraBootstrap> => ipcRenderer.invoke(IPC_BOOTSTRAP_CHANNEL),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC_OPEN_EXTERNAL_CHANNEL, url),
};

contextBridge.exposeInMainWorld('hydra', bridge);
