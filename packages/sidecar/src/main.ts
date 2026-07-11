// The standalone sidecar entrypoint — `node packages/sidecar/out/main.js`.
//
// This is tomorrow's `hydrad`: a plain-Node, Electron-free program that hosts
// the engine (`HydraAppService` → @hydra/core) behind the loopback HTTP/WS
// server. The Electron main process `child_process.fork()`s this file today; a
// launchd/systemd unit will run the same file (renamed) in Fork B.
//
// Contract with the parent:
//   • token in     — read from `HYDRA_SIDECAR_TOKEN` (required). Optional
//                    `HYDRA_SIDECAR_PORT` pins the port (default: random).
//   • ready out    — one JSON line on stdout: `{ type, url, port }`, so the
//                    parent can capture the chosen URL without guessing.
//   • dies with app — exits on SIGTERM/SIGINT and, when forked with an IPC
//                    channel, on parent `disconnect`.

import { HydraAppService } from './appService';
import { createLoopbackServer, type LoopbackServer } from './loopbackServer';
import { SIDECAR_READY_TYPE, type SidecarReadyLine } from '@hydra/transport-loopback/wire';
import { WorkerAttentionSupervisor } from '@hydra/core/workerAttentionSupervisor';

async function main(): Promise<void> {
  const token = process.env.HYDRA_SIDECAR_TOKEN;
  if (!token) {
    process.stderr.write('hydra-sidecar: HYDRA_SIDECAR_TOKEN is required\n');
    process.exit(1);
  }

  const portEnv = process.env.HYDRA_SIDECAR_PORT;
  const port = portEnv ? Number.parseInt(portEnv, 10) : 0;
  if (portEnv && !Number.isInteger(port)) {
    process.stderr.write(`hydra-sidecar: invalid HYDRA_SIDECAR_PORT "${portEnv}"\n`);
    process.exit(1);
  }

  const appService = new HydraAppService();
  const server = await createLoopbackServer(appService, { token, port });
  const attentionSupervisor = new WorkerAttentionSupervisor({ producerKind: 'sidecar' });
  attentionSupervisor.initialize();

  // The single machine-readable ready line. Newline-terminated so a parent can
  // read line-by-line off stdout.
  const ready: SidecarReadyLine = { type: SIDECAR_READY_TYPE, url: server.url, port: server.port };
  process.stdout.write(`${JSON.stringify(ready)}\n`);

  installShutdownHandlers(server, attentionSupervisor);
}

function installShutdownHandlers(
  server: LoopbackServer,
  attentionSupervisor: WorkerAttentionSupervisor,
): void {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    attentionSupervisor.dispose();
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // When forked with an IPC channel, the channel closing means the parent
  // (Electron main) is gone — the sidecar must not outlive it.
  process.on('disconnect', shutdown);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `hydra-sidecar: fatal ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
