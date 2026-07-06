// Electron main process (M1 — minimal). Responsibilities, per FINAL §2:
//   • mint a per-launch random bearer token
//   • child_process.fork the plain-Node sidecar, passing the token via env
//   • health-check it (via the shared launcher) before showing the window
//   • hand { url, token } to the renderer over secure IPC — bootstrap ONLY
//   • the sidecar dies with the app (IPC disconnect + explicit stop on quit)
//
// It does NOT build Mission Control — the renderer is a thin React shell (M2).

import { app, BrowserWindow, ipcMain } from 'electron';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';

import { launchSidecar, type SidecarHandle } from './sidecarLauncher';
import { IPC_BOOTSTRAP_CHANNEL, type HydraBootstrap } from './bootstrap';

let sidecar: SidecarHandle | undefined;
let mainWindow: BrowserWindow | undefined;

async function start(): Promise<void> {
  const token = randomBytes(32).toString('hex');
  sidecar = await launchSidecar({ token });

  const bootstrap: HydraBootstrap = { url: sidecar.url, token: sidecar.token };
  // The single IPC surface: hand over the loopback coordinates, nothing else.
  ipcMain.handle(IPC_BOOTSTRAP_CHANNEL, () => bootstrap);

  mainWindow = new BrowserWindow({
    width: 1024,
    height: 720,
    title: 'Hydra',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
}

app.whenReady().then(start).catch((error: unknown) => {
  process.stderr.write(`hydra-desktop: failed to start — ${String(error)}\n`);
  sidecar?.stop();
  app.quit();
});

// Sidecar dies with the app.
app.on('quit', () => sidecar?.stop());
app.on('window-all-closed', () => app.quit());
