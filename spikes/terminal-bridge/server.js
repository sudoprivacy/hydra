'use strict';

/**
 * Hydra terminal-bridge spike — server.
 *
 * Bridges a browser xterm.js terminal to a REAL tmux session:
 *
 *     xterm.js  <--WebSocket-->  this server  <--node-pty-->  `tmux attach ...`  -->  tmux session
 *
 * One PTY is spawned per WebSocket client. The PTY runs `tmux attach-session`
 * (optionally against a per-client *grouped* session so each browser tab gets an
 * independent window size instead of tmux's "smallest attached client wins").
 *
 * Wire protocol (deliberately tiny):
 *   client -> server : text frames, JSON
 *       {"t":"i","d":"<keystrokes>"}      input -> pty.write
 *       {"t":"r","c":<cols>,"r":<rows>}   resize -> pty.resize
 *   server -> client : text frames, raw PTY output (already UTF-8 decoded by node-pty's
 *                      StringDecoder, so multibyte box-drawing chars survive chunk splits)
 *                      plus one leading JSON control line {"t":"hello",...} on connect and
 *                      {"t":"exit",...} when the PTY dies.
 *
 * No auth, no TLS — localhost spike only.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const PORT = Number(process.env.PORT || 7071);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

// tmux binary — allow override, else rely on PATH.
const TMUX = process.env.TMUX_BIN || 'tmux';

// ---------------------------------------------------------------------------
// Static file serving (index.html, client.js, and vendored xterm assets)
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

// Vendored client libraries served straight from node_modules — keeps the spike
// self-contained (no CDN, works offline) without adding a bundler.
const VENDOR = {
  '/vendor/xterm.js': require.resolve('@xterm/xterm/lib/xterm.js'),
  '/vendor/xterm.css': require.resolve('@xterm/xterm/css/xterm.css'),
  '/vendor/addon-fit.js': require.resolve('@xterm/addon-fit/lib/addon-fit.js'),
};

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': contentType });
    res.end(buf);
  });
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = url.pathname;

  if (VENDOR[pathname]) {
    const file = VENDOR[pathname];
    sendFile(res, file, MIME[path.extname(file)] || 'application/octet-stream');
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  // Prevent path traversal; only serve from PUBLIC_DIR.
  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  sendFile(res, filePath, MIME[path.extname(filePath)] || 'application/octet-stream');
});

// ---------------------------------------------------------------------------
// tmux helpers
// ---------------------------------------------------------------------------

function tmux(args) {
  return spawnSync(TMUX, args, { encoding: 'utf8' });
}

function sessionExists(name) {
  return tmux(['has-session', '-t', name]).status === 0;
}

/** A tmux-safe, unique per-client session name. */
let clientCounter = 0;
function makeClientSessionName(target) {
  clientCounter += 1;
  // tmux session names can't contain '.' or ':'; keep it simple.
  const safeTarget = String(target).replace(/[^A-Za-z0-9_-]/g, '_');
  return `bridge_${safeTarget}_${process.pid}_${clientCounter}`;
}

// ---------------------------------------------------------------------------
// WebSocket <-> PTY bridge
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const target = url.searchParams.get('session') || process.env.TARGET_SESSION || 'spike-target';
  const mode = url.searchParams.get('mode') || 'grouped'; // 'grouped' | 'attach'
  const readonly = url.searchParams.get('readonly') === '1';
  const cols = clampInt(url.searchParams.get('cols'), 80, 20, 500);
  const rows = clampInt(url.searchParams.get('rows'), 24, 5, 300);

  const log = (...a) => console.log(`[ws ${target}/${mode}${readonly ? '/ro' : ''}]`, ...a);

  if (!sessionExists(target)) {
    log('target session does not exist');
    ws.send(JSON.stringify({ t: 'error', message: `tmux session "${target}" not found. Create it, e.g.  tmux new-session -d -s ${target} 'bash --norc -i'` }));
    ws.close();
    return;
  }

  // Build the argv for `tmux attach`.
  // - grouped mode: make a throwaway session grouped with the target (`new-session -t`),
  //   then attach to THAT, so this client gets its own status line / current-window and
  //   disconnecting only tears down the throwaway (never the target). NOTE: grouped
  //   sessions still SHARE the target's window grid — this does NOT give an independent
  //   per-client size (see FINDINGS.md §3); with one interactive viewer per worker that
  //   doesn't matter, since this client simply owns the size.
  // - attach mode:  attach straight to the target (classic tmux size-coupling applies).
  let clientSession = null;
  let attachArgs;

  if (mode === 'grouped') {
    clientSession = makeClientSessionName(target);
    // -d: don't attach here (the PTY will); -x/-y: initial size; -t: group with target.
    const created = tmux([
      'new-session', '-d',
      '-s', clientSession,
      '-t', target,
      '-x', String(cols), '-y', String(rows),
    ]);
    if (created.status !== 0) {
      log('failed to create grouped session:', created.stderr?.trim());
      ws.send(JSON.stringify({ t: 'error', message: `failed to create grouped session: ${created.stderr?.trim()}` }));
      ws.close();
      return;
    }
    attachArgs = ['attach-session', '-t', clientSession];
  } else {
    attachArgs = ['attach-session', '-t', target];
  }
  if (readonly) attachArgs.push('-r'); // -r: client is read-only (keystrokes ignored by tmux)

  log('spawning pty:', TMUX, attachArgs.join(' '), `(${cols}x${rows})`);

  let term;
  try {
    term = pty.spawn(TMUX, attachArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.env.HOME,
      env: process.env,
    });
  } catch (e) {
    // Most common cause on macOS: node-pty's spawn-helper lost its execute bit
    // (see scripts/ensure-pty-helper.js). Report instead of crashing the server.
    log('pty spawn failed:', e.message);
    ws.send(JSON.stringify({ t: 'error', message: `failed to spawn tmux PTY: ${e.message}. If this says posix_spawnp, run: npm run postinstall` }));
    if (clientSession) tmux(['kill-session', '-t', clientSession]);
    ws.close();
    return;
  }

  ws.send(JSON.stringify({ t: 'hello', target, mode, readonly, clientSession, cols, rows }));

  // PTY output -> browser. node-pty emits already-UTF8-decoded strings; forward as-is.
  const onData = (data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  };
  term.onData(onData);

  term.onExit(({ exitCode, signal }) => {
    log('pty exit', exitCode, signal);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ t: 'exit', exitCode, signal }));
      ws.close();
    }
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed frames
    }
    if (msg.t === 'i') {
      if (!readonly && typeof msg.d === 'string') term.write(msg.d);
    } else if (msg.t === 'r') {
      const c = clampInt(msg.c, cols, 20, 500);
      const r = clampInt(msg.r, rows, 5, 300);
      try {
        term.resize(c, r);
      } catch (e) {
        log('resize failed', e.message);
      }
    }
  });

  const cleanup = () => {
    try { term.kill(); } catch { /* already dead */ }
    // Tear down the throwaway grouped session; the real target is untouched.
    if (clientSession) {
      const killed = tmux(['kill-session', '-t', clientSession]);
      log('cleaned up grouped session', clientSession, killed.status === 0 ? 'ok' : killed.stderr?.trim());
    }
  };

  ws.on('close', () => {
    log('ws closed');
    cleanup();
  });
  ws.on('error', (e) => {
    log('ws error', e.message);
    cleanup();
  });
});

function clampInt(v, dflt, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------

httpServer.listen(PORT, HOST, () => {
  console.log(`\n  Hydra terminal-bridge spike`);
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  default target session: ${process.env.TARGET_SESSION || 'spike-target'}`);
  console.log(`  tmux: ${TMUX}\n`);
  // Friendly nudge if the default target isn't there yet.
  const dflt = process.env.TARGET_SESSION || 'spike-target';
  if (!sessionExists(dflt)) {
    console.log(`  (no "${dflt}" session yet — create one with:`);
    console.log(`     tmux new-session -d -s ${dflt} 'htop'   )\n`);
  }
});
