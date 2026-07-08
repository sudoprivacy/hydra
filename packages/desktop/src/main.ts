// Electron main process (M1 — minimal). Responsibilities, per FINAL §2:
//   • mint a per-launch random bearer token
//   • child_process.fork the plain-Node sidecar, passing the token via env
//   • health-check it (via the shared launcher) before showing the window
//   • hand { url, token } to the renderer over secure IPC — bootstrap ONLY
//   • the sidecar dies with the app (IPC disconnect + explicit stop on quit)
//
// It does NOT build Mission Control — the renderer is a thin React shell (M2).

import { app, BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { normalizeExternalHttpUrl } from './externalLinks';
import { launchSidecar, type SidecarHandle } from './sidecarLauncher';
import { IPC_BOOTSTRAP_CHANNEL, IPC_OPEN_EXTERNAL_CHANNEL, type HydraBootstrap } from './bootstrap';

let sidecar: SidecarHandle | undefined;
let mainWindow: BrowserWindow | undefined;

// A GUI app launched from Finder inherits only a minimal PATH (/usr/bin:/bin:…),
// so the sidecar can't find tmux / git / the agent CLIs — they live in
// /opt/homebrew/bin, /usr/local/bin, ~/.nvm/…. Resolve the user's real login-shell
// PATH once and hand it to the sidecar so `tmux attach` etc. work in the packaged
// app exactly as they do when launched from a terminal.
function resolveUserPath(): string {
  const fallbacks = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  let shellPath = '';
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    shellPath = execFileSync(shell, ['-ilc', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: 4000,
    }).trim();
  } catch {
    // Login shell unavailable (odd env / CI) — fall back to the common dirs below.
  }
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of `${shellPath}:${process.env.PATH ?? ''}:${fallbacks.join(':')}`.split(':')) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      merged.push(dir);
    }
  }
  return merged.join(':');
}

function requireRendererSender(event: IpcMainInvokeEvent): void {
  if (event.sender !== mainWindow?.webContents) {
    throw new Error('Refused IPC request from unknown renderer');
  }
}

function registerOpenExternalIpc(): void {
  ipcMain.handle(IPC_OPEN_EXTERNAL_CHANNEL, async (event, input: unknown) => {
    requireRendererSender(event);
    const url = normalizeExternalHttpUrl(input);
    if (!url) {
      throw new Error('Refused to open unsupported external URL');
    }
    await shell.openExternal(url);
  });
}

function installNavigationGuards(window: BrowserWindow, appUrl: string): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== appUrl) {
      event.preventDefault();
    }
  });
}

async function start(): Promise<void> {
  const token = randomBytes(32).toString('hex');
  sidecar = await launchSidecar({ token, env: { PATH: resolveUserPath() } });

  const bootstrap: HydraBootstrap = { url: sidecar.url, token: sidecar.token };
  const indexPath = path.join(__dirname, '..', 'index.html');
  const appUrl = pathToFileURL(indexPath).href;
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 720,
    title: 'Hydra',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  installNavigationGuards(mainWindow, appUrl);
  ipcMain.handle(IPC_BOOTSTRAP_CHANNEL, (event) => {
    requireRendererSender(event);
    return bootstrap;
  });
  registerOpenExternalIpc();

  await mainWindow.loadFile(indexPath);
}

app.whenReady().then(start).catch((error: unknown) => {
  process.stderr.write(`hydra-desktop: failed to start — ${String(error)}\n`);
  sidecar?.stop();
  app.quit();
});

// Sidecar dies with the app.
app.on('quit', () => sidecar?.stop());
app.on('window-all-closed', () => app.quit());
