/**
 * Smoke test: the M3 terminal seam over a REAL 127.0.0.1 HTTP/WS loopback with a
 * REAL node-pty ⇄ tmux attach, modeled on the validated spike smoke
 * (spikes/terminal-bridge/smoke-test.js) but wired through the M1 loopback seam:
 *
 *   HydraControlClient.attachTerminal → LoopbackHttpWsTransport.openTerminal
 *     → WS /v1/terminal → TerminalBridge → node-pty `tmux attach` → tmux session
 *
 * It boots the loopback server, spins up a throwaway `tmux new-session` on an
 * ISOLATED tmux socket (never touches the user's real tmux), and checks the
 * terminal behaviors plus auth:
 *   0. rejection semantics  — unknown ownership exits non-transiently;
 *   1. bidirectional I/O    — a keystroke reaches the shell and its echo returns;
 *   2. mouse scrollback     — wheel input enters tmux copy-mode, not the pane;
 *   3. resize propagation   — `pty.resize` → tmux → the shell's `stty size`;
 *   4. drop + reconnect     — the session persists and a fresh attach repaints;
 *   5. read-only mirror     — a mirror observer sees the current screen;
 *   6. auth enforcement     — a wrong bearer token on the terminal WS is rejected.
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
  private readonly errors: string[] = [];
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
    this.channel.onError(({ message }) => {
      this.errors.push(message);
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

  async waitForError(re: RegExp, ms = 5000): Promise<string | null> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const message = this.errors.find(error => re.test(error));
      if (message) return message;
      await sleep(50);
    }
    return null;
  }

  async waitForExit(ms = 5000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.exited) {
        return true;
      }
      await sleep(25);
    }
    return this.exited;
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
  const backend = new FakeBackend();
  backend.sessions.add(SESSION);
  backend.workdirs.set(SESSION, tempHome);
  backend.roles.set(SESSION, 'worker');
  backend.workerIds.set(SESSION, 1);
  fs.mkdirSync(process.env.HYDRA_HOME!, { recursive: true });
  fs.writeFileSync(path.join(process.env.HYDRA_HOME!, 'sessions.json'), JSON.stringify({
    copilots: {},
    workers: {
      [SESSION]: {
        source: 'directory',
        sessionName: SESSION,
        displayName: SESSION,
        workerId: 1,
        repo: null,
        repoRoot: null,
        branch: null,
        slug: SESSION,
        status: 'running',
        attached: false,
        agent: 'codex',
        workdir: tempHome,
        managedWorkdir: false,
        tmuxSession: SESSION,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        sessionId: null,
        copilotSessionName: null,
      },
    },
    nextWorkerId: 2,
    updatedAt: new Date().toISOString(),
  }), 'utf8');
  const appService = new HydraAppService({ backend });
  const server = await createLoopbackServer(appService, { token });
  const client = createHydraControlClient(new LoopbackHttpWsTransport({ url: server.url, token }));

  try {
    console.log('0. Foreign session attach rejected');
    const foreign = new Term(client, 'ordinary-user-tmux');
    const foreignError = await foreign.waitFor(/Refusing to control unknown Hydra session/, 5000);
    check('foreign tmux session is rejected before attach', foreignError !== null);
    const foreignExited = await foreign.waitForExit();
    check(
      'terminal hard error is a non-transient exit',
      foreignExited && foreign.exitCode !== null,
      `exited=${foreignExited} code=${String(foreign.exitCode)}`,
    );
    foreign.close();

    backend.workerIds.set(SESSION, 2);
    const mismatched = new Term(client, SESSION);
    const mismatchError = await mismatched.waitFor(/worker identity does not match session state/, 5000);
    check('mismatched Hydra worker identity is rejected before attach', mismatchError !== null);
    const mismatchedExited = await mismatched.waitForExit();
    check(
      'identity mismatch is a non-transient exit',
      mismatchedExited && mismatched.exitCode !== null,
      `exited=${mismatchedExited} code=${String(mismatched.exitCode)}`,
    );
    mismatched.close();
    backend.workerIds.set(SESSION, 1);

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

    // ── 2. mouse scrollback (wheel → tmux copy-mode, not pane Up/Down) ──
    console.log('2. Mouse scrollback ownership');
    const mouseEnabled = tmux([
      'display-message',
      '-p',
      '-t',
      `${SESSION}:0.0`,
      '#{mouse}',
    ]).stdout?.trim();
    check('interactive attach enables tmux mouse handling', mouseEnabled === '1');

    // SGR mouse button 64 is wheel-up. Sending it through the real terminal
    // channel exercises WS → node-pty → tmux exactly like xterm.js does.
    t1.write('\x1b[<64;10;10M');
    await sleep(200);
    const paneMode = tmux([
      'display-message',
      '-p',
      '-t',
      `${SESSION}:0.0`,
      '#{pane_in_mode}|#{pane_mode}',
    ]).stdout?.trim();
    check(
      'wheel-up enters tmux copy-mode instead of reaching the pane',
      paneMode === '1|copy-mode',
      paneMode || 'no pane mode',
    );
    if (paneMode === '1|copy-mode') {
      tmux(['send-keys', '-t', `${SESSION}:0.0`, '-X', 'cancel']);
      await sleep(100);
    }

    // ── 3. resize propagation (channel.resize → pty → tmux → shell) ──
    console.log('3. Resize propagation');
    const before = await t1.sttySize();
    t1.resize(120, 50);
    await sleep(500);
    const after = await t1.sttySize();
    check(
      'shell sees the new column count after resize',
      Boolean(after && after.cols === 120),
      `before=${before?.cols}c after=${after?.cols}c (rows ${before?.rows}->${after?.rows}, status off)`,
    );

    // ── 4. drop + reconnect: session persists and a fresh attach repaints ──
    console.log('4. Drop + reconnect (repaint of current screen)');
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

    // A newer interactive owner must evict the previous one with a structured
    // reason so Desktop can stop auto-reconnect instead of stealing ownership
    // back in a loop.
    const replacement = new Term(client, SESSION, { mode: 'interactive', cols: 120, rows: 40 });
    await replacement.waitFor(/./, 5000);
    const replacementReason = await t2.waitForError(/replaced by a newer interactive client/, 5000);
    check('interactive owner replacement exposes a structured error', Boolean(replacementReason));
    t2.close();

    // ── 5. read-only mirror sees the current screen ──
    console.log('5. Read-only mirror');
    const mirror = new Term(client, SESSION, { mode: 'mirror', cols: 120, rows: 40 });
    const mirrored = await mirror.waitFor(new RegExp(persist), 5000);
    check('mirror observer receives the current screen (capture-pane)', Boolean(mirrored));
    mirror.close();
    replacement.close();
    await sleep(300);

    // ── 6. auth: a wrong token on the terminal WS is rejected ──
    console.log('6. Auth enforcement on the terminal WS');
    const wsBase = server.url.replace(/^http/, 'ws');
    const badUrl = `${wsBase}/v1/terminal?session=${encodeURIComponent(SESSION)}&mode=interactive&cols=80&rows=24&token=wrong`;
    const rejected = await connectRejected(badUrl);
    check('terminal WS with a wrong bearer token is rejected', rejected);
    const okUrl = `${wsBase}/v1/terminal?session=${encodeURIComponent(SESSION)}&mode=interactive&cols=80&rows=24&token=${encodeURIComponent(token)}`;
    const accepted = await connectRejected(okUrl);
    check('terminal WS with the valid token is accepted', !accepted);

    // ── 7. the target session survived every attach/detach ──
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
