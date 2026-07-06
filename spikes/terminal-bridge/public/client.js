/* Hydra terminal-bridge spike — browser client.
 *
 * Owns an xterm.js terminal and a single WebSocket to the bridge server.
 *   term.onData   -> ws  {"t":"i","d":...}
 *   term.onResize -> ws  {"t":"r","c":cols,"r":rows}
 *   ws message    -> term.write   (raw PTY output)  or  JSON control line
 *
 * Reconnect is manual-with-auto-retry: if the socket drops we back off and retry,
 * and because we re-attach to the (persistent) tmux session, `tmux attach` repaints
 * the current screen — no client-side scrollback replay needed.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const sessionInput = $('session');
  const modeSelect = $('mode');
  const readonlyBox = $('readonly');
  const connectBtn = $('connect');
  const statusEl = $('status');
  const dimsEl = $('dims');

  // --- xterm setup ---------------------------------------------------------
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 13,
    scrollback: 5000,
    // macOS option-as-meta so alt-keybindings reach tmux/vim.
    macOptionIsMeta: true,
    theme: { background: '#1e1e1e' },
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open($('term'));
  fitAddon.fit();

  let ws = null;
  let reconnectTimer = null;
  let intentionalClose = false;
  let retryDelay = 500;

  function setStatus(state, text) {
    statusEl.className = state;
    statusEl.textContent = text || state;
  }

  function currentParams() {
    const cols = term.cols;
    const rows = term.rows;
    const session = (sessionInput.value || 'spike-target').trim();
    const mode = modeSelect.value;
    const readonly = readonlyBox.checked ? '1' : '0';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const qs = new URLSearchParams({ session, mode, readonly, cols, rows });
    return `${proto}//${location.host}/ws?${qs.toString()}`;
  }

  function connect() {
    disconnect(/* intentional */ true); // tear down any existing socket first
    intentionalClose = false;
    setStatus('connecting', 'connecting…');
    connectBtn.textContent = 'Disconnect';

    const url = currentParams();
    ws = new WebSocket(url);

    ws.onopen = () => {
      retryDelay = 500;
      setStatus('connected', readonlyBox.checked ? 'connected (read-only)' : 'connected');
      // Make sure the server-side PTY matches our exact current size.
      sendResize();
      term.focus();
    };

    ws.onmessage = (ev) => {
      const data = ev.data;
      // Control lines are JSON objects starting with '{'; PTY output is anything else.
      // (PTY output can technically start with '{', but our server only emits control
      //  JSON as standalone frames, so a leading '{' + valid parse is unambiguous enough
      //  for a spike. We guard by requiring a known "t" field.)
      if (typeof data === 'string' && data.length && data[0] === '{') {
        try {
          const msg = JSON.parse(data);
          if (msg && typeof msg.t === 'string') {
            handleControl(msg);
            return;
          }
        } catch { /* not control — fall through as terminal data */ }
      }
      term.write(data);
    };

    ws.onclose = () => {
      if (intentionalClose) {
        setStatus('disconnected', 'disconnected');
        connectBtn.textContent = 'Connect';
        return;
      }
      setStatus('disconnected', `reconnecting in ${Math.round(retryDelay / 100) / 10}s…`);
      reconnectTimer = setTimeout(() => {
        retryDelay = Math.min(retryDelay * 1.6, 5000);
        connect();
      }, retryDelay);
    };

    ws.onerror = () => {
      // onclose will follow and drive reconnect.
    };
  }

  function handleControl(msg) {
    if (msg.t === 'hello') {
      term.writeln(`\x1b[90m[bridge] attached to "${msg.target}" via ${msg.mode}` +
        `${msg.readonly ? ' (read-only)' : ''}${msg.clientSession ? ' [' + msg.clientSession + ']' : ''}\x1b[0m`);
    } else if (msg.t === 'error') {
      setStatus('disconnected', 'error');
      term.writeln(`\x1b[31m[bridge] ${msg.message}\x1b[0m`);
      intentionalClose = true; // don't auto-reconnect on a hard error
    } else if (msg.t === 'exit') {
      term.writeln(`\x1b[90m[bridge] pty exited (code=${msg.exitCode})\x1b[0m`);
    }
  }

  function disconnect(intentional) {
    intentionalClose = !!intentional;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) {
      try { ws.close(); } catch { /* noop */ }
      ws = null;
    }
    if (intentional) {
      setStatus('disconnected', 'disconnected');
      connectBtn.textContent = 'Connect';
    }
  }

  function sendResize() {
    dimsEl.textContent = `${term.cols}×${term.rows}`;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows }));
    }
  }

  // --- wiring --------------------------------------------------------------
  term.onData((d) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'i', d }));
    }
  });

  term.onResize(() => sendResize());

  // Refit on window resize (debounced via rAF).
  let raf = 0;
  window.addEventListener('resize', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      try { fitAddon.fit(); } catch { /* noop */ }
    });
  });

  connectBtn.addEventListener('click', () => {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      disconnect(true);
    } else {
      connect();
    }
  });

  // --- boot ----------------------------------------------------------------
  // Prefill from URL (?session=...&mode=...&readonly=1) for quick sharing.
  const boot = new URLSearchParams(location.search);
  sessionInput.value = boot.get('session') || 'spike-target';
  if (boot.get('mode')) modeSelect.value = boot.get('mode');
  if (boot.get('readonly') === '1') readonlyBox.checked = true;
  dimsEl.textContent = `${term.cols}×${term.rows}`;
  setStatus('disconnected', 'disconnected');

  // Auto-connect on load for a one-click demo.
  connect();
})();
