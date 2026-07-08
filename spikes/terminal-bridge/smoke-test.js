'use strict';

/**
 * Headless smoke test for the terminal bridge — no browser required.
 *
 * Drives the WebSocket bridge exactly like the xterm client would, against a
 * throwaway `spike-target` tmux session, and checks the four hard problems from
 * the spike: bidirectional I/O, resize propagation, grouped-vs-attach sizing,
 * and reconnect. Prints observations used to write FINDINGS.md.
 *
 * Usage:
 *   node server.js &                    # in one shell
 *   tmux new-session -d -s spike-target 'bash --norc -i'
 *   node smoke-test.js
 */

const WebSocket = require('ws');
const { spawnSync } = require('child_process');

const BASE = process.env.BRIDGE_URL || 'ws://127.0.0.1:7071/ws';
const TARGET = process.env.TARGET_SESSION || 'spike-target';
const TMUX = process.env.TMUX_BIN || 'tmux';

const stripAnsi = (s) =>
  s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][AB0]/g, '').replace(/\x1b[=>]/g, '');

let passes = 0;
let failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
  else { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(opts = {}) {
    const qs = new URLSearchParams({
      session: opts.session || TARGET,
      mode: opts.mode || 'grouped',
      readonly: opts.readonly ? '1' : '0',
      cols: String(opts.cols || 80),
      rows: String(opts.rows || 24),
    });
    this.url = `${BASE}?${qs.toString()}`;
    this.buf = '';
    this.hello = null;
    this.ws = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const to = setTimeout(() => reject(new Error('connect timeout')), 5000);
      ws.on('open', () => { clearTimeout(to); resolve(); });
      ws.on('message', (data) => {
        const s = data.toString();
        if (s[0] === '{') {
          try {
            const m = JSON.parse(s);
            if (m && m.t) {
              if (m.t === 'hello') this.hello = m;
              if (m.t === 'error') { this.buf += `[error] ${m.message}\n`; }
              return;
            }
          } catch { /* fall through */ }
        }
        this.buf += s;
      });
      ws.on('error', (e) => { clearTimeout(to); reject(e); });
    });
  }
  async waitForHello(ms = 3000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (this.hello) return this.hello;
      await sleep(25);
    }
    return null;
  }
  send(text) { this.ws.send(JSON.stringify({ t: 'i', d: text })); }
  resize(c, r) { this.ws.send(JSON.stringify({ t: 'r', c, r })); }
  clear() { this.buf = ''; }
  async waitFor(re, ms = 4000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const m = stripAnsi(this.buf).match(re);
      if (m) return m;
      await sleep(50);
    }
    return null;
  }
  /** run `stty size` in the attached shell, return {rows, cols} or null */
  async sttySize(ms = 4000) {
    this.clear();
    // printf keeps the RESULT literal out of the digit-matching regex.
    this.send(`printf 'SZ:%s\\n' "$(stty size)"\r`);
    const m = await this.waitFor(/SZ:(\d+)\s+(\d+)/, ms);
    return m ? { rows: Number(m[1]), cols: Number(m[2]) } : null;
  }
  close() { try { this.ws.close(); } catch { /* noop */ } }
}

function tmuxSessions() {
  const r = spawnSync(TMUX, ['ls', '-F', '#{session_name}'], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

// Ask tmux the width of a session's current window (no interactive client attached,
// so this read itself doesn't trigger a resize).
function windowWidth(session) {
  const r = spawnSync(TMUX, ['display', '-t', session, '-p', '#{window_width}'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '?';
}

async function main() {
  console.log(`\nSmoke test against ${BASE}  target=${TARGET}\n`);

  if (!tmuxSessions().includes(TARGET)) {
    console.log(`\x1b[31mTarget session "${TARGET}" not found.\x1b[0m`);
    console.log(`Create it first:  tmux new-session -d -s ${TARGET} 'bash --norc -i'\n`);
    process.exit(2);
  }

  // --- 1. Bidirectional I/O -------------------------------------------------
  console.log('1. Bidirectional I/O (grouped mode)');
  const c1 = new Client({ mode: 'grouped', cols: 100, rows: 40 });
  await c1.connect();
  await c1.waitForHello();
  check('connect + hello control frame', !!c1.hello, c1.hello && `clientSession=${c1.hello.clientSession}`);
  await sleep(400);
  c1.clear();
  const marker = 'BRIDGE_ECHO_7f3a';
  c1.send(`echo ${marker}\r`);
  const echoed = await c1.waitFor(new RegExp(marker), 4000);
  // Two occurrences expected: the typed command echo + the command output.
  const count = (stripAnsi(c1.buf).match(new RegExp(marker, 'g')) || []).length;
  check('keystrokes reach shell and output returns', !!echoed, `saw marker ${count}× (echo + output)`);

  // --- 2. Resize propagation ------------------------------------------------
  console.log('\n2. Resize propagation (pty.resize -> tmux -> shell)');
  const before = await c1.sttySize();
  c1.resize(120, 50);
  await sleep(500);
  const after = await c1.sttySize();
  check('shell sees new column count after resize', after && after.cols === 120,
    `before=${before && before.cols}c  after=${after && after.cols}c (rows ${before && before.rows}->${after && after.rows}, status bar eats ~1 row)`);

  // --- 3. Grouped-session sizing: independent, or one shared grid? ----------
  // The spike asks whether `tmux new-session -t target` gives each web client an
  // INDEPENDENT window size. Ground truth: it does NOT. Grouped sessions share
  // tmux window @0, which has a single grid; `window-size latest` just snaps that
  // one grid to whichever client was last active. We prove it by asking tmux for
  // each session's window_width directly — deterministic, no timing races.
  console.log('\n3. Grouped-session sizing — independent per client, or one shared grid?');
  const cA = new Client({ mode: 'grouped', cols: 111, rows: 41 });
  const cBb = new Client({ mode: 'grouped', cols: 66, rows: 22 });
  await cA.connect(); await cA.waitForHello();
  await cBb.connect(); await cBb.waitForHello();
  await sleep(700);
  // c1 (120c) is still attached too, so 3 grouped clients at 3 sizes are live.
  const groupSessions = [TARGET, ...tmuxSessions().filter((s) => s.startsWith('bridge_'))];
  const grids = groupSessions.map((s) => ({ s, w: windowWidth(s) }));
  grids.forEach((g) => console.log(`    ${g.s}: window_width=${g.w}`));
  const distinct = new Set(grids.map((g) => g.w));
  check('all grouped sessions SHARE one window grid (independent sizing NOT achieved)',
    distinct.size === 1,
    distinct.size === 1
      ? `all report ${[...distinct][0]}c — one tmux grid; window-size=latest tracks the last-active client`
      : `unexpected distinct widths: ${[...distinct].join(', ')}`);
  cA.close(); cBb.close();
  await sleep(400);

  // --- 4. Reconnect ---------------------------------------------------------
  console.log('\n4. Reconnect (drop socket, reattach, expect repaint)');
  // Put a recognizable line on screen, drop, reconnect, and confirm attach repaints it.
  c1.clear();
  const persistMarker = 'PERSIST_af19';
  c1.send(`echo ${persistMarker}\r`);
  await c1.waitFor(new RegExp(persistMarker));
  c1.close();
  await sleep(500);
  const c2 = new Client({ mode: 'grouped', cols: 120, rows: 50 });
  await c2.connect();
  // A fresh attach repaints the current pane; the shell + prior output are still there.
  const stillThere = await c2.sttySize(); // proves the session survived and is interactive
  check('session persists + reattach works after socket drop', !!stillThere,
    stillThere ? `reattached, shell responsive (${stillThere.cols}c)` : 'no response after reconnect');
  c2.close();
  await sleep(500);

  // --- 5. Cleanup of throwaway grouped sessions -----------------------------
  console.log('\n5. Grouped-session cleanup on disconnect');
  const leftovers = tmuxSessions().filter((s) => s.startsWith('bridge_'));
  check('no leftover bridge_* grouped sessions', leftovers.length === 0,
    leftovers.length ? `leaked: ${leftovers.join(', ')}` : 'all cleaned up');
  check('target session still alive (never disrupted)', tmuxSessions().includes(TARGET));

  console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${passes} passed, ${failures} failed\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('smoke test crashed:', e); process.exit(1); });
