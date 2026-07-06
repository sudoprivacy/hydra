/**
 * Smoke test: the M3 terminal seam over a REAL 127.0.0.1 HTTP/WS loopback with a
 * REAL node-pty ⇄ tmux attach, modeled on the validated spike smoke
 * (spikes/terminal-bridge/smoke-test.js) but wired through the M1 loopback seam:
 *
 *   HydraControlClient.attachTerminal → LoopbackHttpWsTransport.openTerminal
 *     → WS /v1/terminal → TerminalBridge → node-pty `tmux attach` → tmux session
 *
 * It boots the loopback server, spins up a throwaway `tmux new-session` on an
 * ISOLATED tmux socket (never touches the user's real tmux), and checks the four
 * hard problems plus auth:
 *   1. bidirectional I/O    — a keystroke reaches the shell and its echo returns;
 *   2. resize propagation   — `pty.resize` → tmux → the shell's `stty size`;
 *   3. drop + reconnect     — the session persists and a fresh attach repaints;
 *   4. read-only mirror     — a mirror observer sees the current screen;
 *   5. auth enforcement     — a wrong bearer token on the terminal WS is rejected.
 * Then it cleans up the tmux session + server.
 *
 * Skips cleanly (exit 0) when tmux is unavailable so it is safe in the suite.
 *
 * Run: node packages/sidecar/out/smoke/terminalSmoke.js
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import WebSocket from 'ws';

import { createHydraControlClient } from '@hydra/protocol';
import type { HydraControlClient, TerminalChannel, TerminalMode } from '@hydra/protocol';
import { LoopbackHttpWsTransport } from '@hydra/transport-loopback';

import { FakeBackend } from './fakeBackend';

// Isolated tmux server (via `-L`) so the smoke never touches the user's tmux.
const SOCKET = `hydra-m3-smoke-${process.pid}`;
const TMUX_ARGS = ['-L', SOCKET];
const SESSION = 'hydra-m3-target';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Strip the ANSI/VT noise tmux emits so text assertions match the visible chars.
/* eslint-disable no-control-regex */
const stripAnsi = (s: string): string =>
  s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][AB0]/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, '');
/* eslint-enable no-control-regex */

let passes = 0;
let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passes += 1;
    console.log(`  PASS ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function tmux(args: string[]): SpawnSyncReturns<string> {
  return spawnSync('tmux', [...TMUX_ARGS, ...args], { encoding: 'utf8' });
}

function tmuxHasSession(session: string): boolean {
  return tmux(['has-session', '-t', session]).status === 0;
}

/** A test harness over one TerminalChannel — buffers output, waits on patterns. */
class Term {
  private buf = '';
  private readonly channel: TerminalChannel;
  exited = false;
  exitCode: number | null = null;

  constructor(client: HydraControlClient, session: string, opts: { mode?: TerminalMode; cols?: number; rows?: number } = {}) {
    this.channel = client.attachTerminal({
      session,
      mode: opts.mode ?? 'interactive',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
    });
    this.channel.onData((chunk) => {
      this.buf += chunk;
    });
    this.channel.onExit(({ code }) => {
      this.exited = true;
      this.exitCode = code;
    });
  }

  write(text: string): void {
    this.channel.write(text);
  }

  resize(cols: number, rows: number): void {
    this.channel.resize(cols, rows);
  }

  clear(): void {
    this.buf = '';
  }

  /** Count occurrences of `re` in the (ANSI-stripped) buffer so far. */
  occurrences(re: RegExp): number {
    return (stripAnsi(this.buf).match(new RegExp(re, 'g')) || []).length;
  }

  close(): void {
    this.channel.close();
  }

  async waitFor(re: RegExp, ms = 5000): Promise<RegExpMatchArray | null> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const match = stripAnsi(this.buf).match(re);
      if (match) {
        return match;
      }
      await sleep(50);
    }
    return null;
  }

  /** Run `stty size` in the attached shell → { rows, cols } or null. */
  async sttySize(ms = 5000): Promise<{ rows: number; cols: number } | null> {
    this.clear();
    // printf keeps the literal result out of the digit-matching regex below.
    this.write(`printf 'SZ:%s\\n' "$(stty size)"\r`);
    const match = await this.waitFor(/SZ:(\d+)\s+(\d+)/, ms);
    return match ? { rows: Number(match[1]), cols: Number(match[2]) } : null;
  }
}

/** True if a raw WS handshake to `url` is REJECTED (never reaches 'open'). */
function connectRejected(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let opened = false;
    let settled = false;
    const settle = (rejected: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(rejected);
    };
    const timer = setTimeout(() => settle(false), 4000);
    ws.on('open', () => {
      opened = true;
      settle(false);
    });
    ws.on('unexpected-response', () => settle(true));
    ws.on('error', () => settle(!opened));
    ws.on('close', () => settle(!opened));
  });
}

async function main(): Promise<void> {
  // ── skip cleanly if tmux is unavailable ──
  if (spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status !== 0) {
    console.log('terminalSmoke: SKIP (tmux not available)');
    process.exit(0);
  }

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-terminal-'));
  // A SHORT tmpdir for the tmux socket (macOS caps Unix socket paths at ~104
  // chars — the /var/folders HOME above is far too deep). The bridge inherits
  // TMUX_TMPDIR, so its tmux calls resolve the SAME isolated socket; teardown
  // rms this dir, so no stray socket files accumulate across runs.
  const tmuxTmp = fs.mkdtempSync('/tmp/hydra-m3-');
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.HYDRA_HOME = path.join(tempHome, '.hydra');
  process.env.HYDRA_TELEMETRY = '0';
  // Route the bridge's tmux calls (getTmuxSocketArgs reads this) to our isolated
  // server, so it attaches to the SAME throwaway server we create below.
  process.env.HYDRA_TMUX_SOCKET = SOCKET;
  process.env.TMUX_TMPDIR = tmuxTmp;
  delete process.env.HYDRA_CONFIG_PATH;

  // Throwaway target session on the isolated socket.
  const created = tmux(['new-session', '-d', '-s', SESSION, 'bash', '--norc', '-i']);
  if (created.status !== 0) {
    console.error(`terminalSmoke: could not create tmux session: ${created.stderr?.trim()}`);
    tmux(['kill-server']);
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tmuxTmp, { recursive: true, force: true });
    process.exit(1);
  }

  // Import AFTER env is set so the engine/stores resolve the isolated home.
  const { HydraAppService } = await import('../appService');
  const { createLoopbackServer } = await import('../loopbackServer');

  const token = `tm-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  const appService = new HydraAppService({ backend: new FakeBackend() });
  const server = await createLoopbackServer(appService, { token });
  const client = createHydraControlClient(new LoopbackHttpWsTransport({ url: server.url, token }));

  try {
    // ── 1. bidirectional I/O (interactive attach) ──
    console.log('1. Bidirectional I/O');
    const t1 = new Term(client, SESSION, { mode: 'interactive', cols: 100, rows: 40 });
    // Wait for the initial repaint (tmux redraws the pane on attach).
    await t1.waitFor(/./, 5000);
    await sleep(400);
    t1.clear();
    const marker = 'BRIDGE_ECHO_7f3a';
    t1.write(`echo ${marker}\r`);
    const echoed = await t1.waitFor(new RegExp(marker), 5000);
    check(
      'keystroke reaches shell and echo returns',
      Boolean(echoed),
      `saw marker ${t1.occurrences(new RegExp(marker))}× (echo + output)`,
    );

    // ── 2. resize propagation (channel.resize → pty → tmux → shell) ──
    console.log('2. Resize propagation');
    const before = await t1.sttySize();
    t1.resize(120, 50);
    await sleep(500);
    const after = await t1.sttySize();
    check(
      'shell sees the new column count after resize',
      Boolean(after && after.cols === 120),
      `before=${before?.cols}c after=${after?.cols}c (rows ${before?.rows}->${after?.rows}, status off)`,
    );

    // ── 3. drop + reconnect: session persists and a fresh attach repaints ──
    console.log('3. Drop + reconnect (repaint of current screen)');
    t1.clear();
    const persist = 'PERSIST_af19';
    t1.write(`echo ${persist}\r`);
    await t1.waitFor(new RegExp(persist), 5000);
    t1.close();
    await sleep(600);
    const t2 = new Term(client, SESSION, { mode: 'interactive', cols: 120, rows: 40 });
    // The reattach repaints the current pane, which still shows the marker.
    const repainted = await t2.waitFor(new RegExp(persist), 5000);
    check('session persists + reattach repaints the current screen', Boolean(repainted));
    const responsive = await t2.sttySize();
    check('reattached terminal is interactive', Boolean(responsive), responsive ? `${responsive.cols}c` : 'no response');

    // ── 4. read-only mirror sees the current screen ──
    console.log('4. Read-only mirror');
    const mirror = new Term(client, SESSION, { mode: 'mirror', cols: 120, rows: 40 });
    const mirrored = await mirror.waitFor(new RegExp(persist), 5000);
    check('mirror observer receives the current screen (capture-pane)', Boolean(mirrored));
    mirror.close();
    t2.close();
    await sleep(300);

    // ── 5. auth: a wrong token on the terminal WS is rejected ──
    console.log('5. Auth enforcement on the terminal WS');
    const wsBase = server.url.replace(/^http/, 'ws');
    const badUrl = `${wsBase}/v1/terminal?session=${encodeURIComponent(SESSION)}&mode=interactive&cols=80&rows=24&token=wrong`;
    const rejected = await connectRejected(badUrl);
    check('terminal WS with a wrong bearer token is rejected', rejected);
    const okUrl = `${wsBase}/v1/terminal?session=${encodeURIComponent(SESSION)}&mode=interactive&cols=80&rows=24&token=${encodeURIComponent(token)}`;
    const accepted = await connectRejected(okUrl);
    check('terminal WS with the valid token is accepted', !accepted);

    // ── 6. the target session survived every attach/detach ──
    check('target tmux session still alive (never disrupted)', tmuxHasSession(SESSION));

    console.log(`\n${passes} passed, ${failures} failed`);
  } finally {
    await server.close();
    tmux(['kill-session', '-t', SESSION]);
    tmux(['kill-server']);
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tmuxTmp, { recursive: true, force: true });
  }

  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  // Best-effort cleanup of the isolated tmux server on a crash.
  spawnSync('tmux', [...TMUX_ARGS, 'kill-server'], { encoding: 'utf8' });
  process.exit(1);
});
