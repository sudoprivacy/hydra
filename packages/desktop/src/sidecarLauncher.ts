// launchSidecar — the plain-Node fork + handshake, shared by the Electron main
// process and the headless `bootCheck`. Kept Electron-free on purpose so the
// exact fork → ready-line → health-check path the app uses is testable without a
// display (bootCheck.ts) and is the same code a future `hydrad` supervisor runs.

import { fork, type ChildProcess } from 'node:child_process';

import {
  BEARER_PREFIX,
  LOOPBACK_ROUTES,
  SIDECAR_READY_TYPE,
  type SidecarReadyLine,
} from '@hydra/transport-loopback/wire';

export interface LaunchSidecarOptions {
  /** Per-launch bearer token; passed to the sidecar via env, kept for the client. */
  token: string;
  /**
   * Absolute path to the built sidecar entrypoint. Defaults to resolving
   * `@hydra/sidecar/main` (→ its `out/main.js`).
   */
  sidecarPath?: string;
  /** Extra env for the child (e.g. an isolated HYDRA_HOME for tests). */
  env?: Record<string, string | undefined>;
  /** Pin the sidecar port (default: OS-assigned random). */
  port?: number;
  readyTimeoutMs?: number;
  healthTimeoutMs?: number;
}

export interface SidecarHandle {
  url: string;
  port: number;
  token: string;
  child: ChildProcess;
  /** SIGTERM the sidecar (it also dies on our disconnect). */
  stop(): void;
}

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;

export async function launchSidecar(options: LaunchSidecarOptions): Promise<SidecarHandle> {
  const sidecarPath = options.sidecarPath ?? resolveSidecarEntry();
  const child = fork(sidecarPath, [], {
    env: {
      ...process.env,
      HYDRA_SIDECAR_TOKEN: options.token,
      ...(options.port ? { HYDRA_SIDECAR_PORT: String(options.port) } : {}),
      ...options.env,
    },
    // Pipe stdout (we parse the ready line) + stderr (forwarded for diagnostics);
    // 'ipc' gives the child a channel so it dies when this process disconnects.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[sidecar] ${chunk.toString()}`);
  });

  const ready = await waitForReadyLine(child, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  await waitForHealth(
    `${ready.url}${LOOPBACK_ROUTES.health}`,
    options.token,
    options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
  );

  return {
    url: ready.url,
    port: ready.port,
    token: options.token,
    child,
    stop: () => {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    },
  };
}

/** Resolve the sidecar's built entrypoint via its package export map. */
function resolveSidecarEntry(): string {
  return require.resolve('@hydra/sidecar/main');
}

function waitForReadyLine(child: ChildProcess, timeoutMs: number): Promise<SidecarReadyLine> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      fn();
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as SidecarReadyLine;
          if (parsed && parsed.type === SIDECAR_READY_TYPE && typeof parsed.url === 'string') {
            finish(() => resolve(parsed));
            return;
          }
        } catch {
          // Non-JSON diagnostic line — ignore and keep scanning.
        }
      }
    };

    const onExit = (code: number | null) =>
      finish(() => reject(new Error(`sidecar exited before it was ready (code ${code ?? 'null'})`)));

    const timer = setTimeout(
      () => finish(() => reject(new Error(`sidecar did not print a ready line within ${timeoutMs}ms`))),
      timeoutMs,
    );

    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
}

async function waitForHealth(healthUrl: string, token: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(healthUrl, {
        headers: { authorization: `${BEARER_PREFIX}${token}` },
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Server not accepting connections yet — retry until the deadline.
    }
    if (Date.now() > deadline) {
      throw new Error(`sidecar health-check did not pass within ${timeoutMs}ms`);
    }
    await delay(50);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
