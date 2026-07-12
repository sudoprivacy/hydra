// Headless boot check — the desktop proof-of-life that runs WITHOUT a display.
//
// It exercises the exact main-process path minus Electron: fork the sidecar via
// the shared launcher (mint token → ready line → health-check), build a
// HydraControlClient over the loopback transport with the handed-over
// { url, token }, call listSessions() once, and exit 0. If Electron can't run a
// window in this environment, this is the runnable evidence the M1 handoff works
// (alongside `smoke:loopback`).
//
// Run: node packages/desktop/out/bootCheck.js   (npm run desktop:boot-check)

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createHydraControlClient } from '@hydra/protocol';
import { LoopbackHttpWsTransport } from '@hydra/transport-loopback';

import { launchSidecar } from './sidecarLauncher';

async function main(): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-desktop-bootcheck-'));
  const token = randomBytes(32).toString('hex');
  const hydraHome = path.join(home, '.hydra');
  const tmuxSocket = path.join(hydraHome, 'tmux', 'hydra.sock');
  fs.mkdirSync(path.dirname(tmuxSocket), { recursive: true });

  const sidecar = await launchSidecar({
    token,
    env: {
      HOME: home,
      USERPROFILE: home,
      HYDRA_HOME: hydraHome,
      HYDRA_TMUX_SOCKET: tmuxSocket,
      HYDRA_TELEMETRY: '0',
    },
  });

  try {
    const client = createHydraControlClient(
      new LoopbackHttpWsTransport({ url: sidecar.url, token: sidecar.token }),
    );
    const list = await client.listSessions();
    console.log(
      `hydra-desktop boot-check: sidecar up at ${sidecar.url} — ` +
        `listSessions() → ${list.count} session(s) (${list.workers.length} workers, ${list.copilots.length} copilots)`,
    );
    console.log('bootCheck: ok');
  } finally {
    await stopSidecar(sidecar);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function stopSidecar(sidecar: Awaited<ReturnType<typeof launchSidecar>>): Promise<void> {
  if (sidecar.child.exitCode !== null || sidecar.child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => sidecar.child.once('exit', () => resolve()));
  sidecar.stop();
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (sidecar.child.exitCode === null && sidecar.child.signalCode === null) {
    sidecar.child.kill('SIGKILL');
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }
}

// Explicit exit: the transport's client sockets would otherwise keep the process
// alive after the check passes.
main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  },
);
