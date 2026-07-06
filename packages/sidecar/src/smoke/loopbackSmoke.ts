/**
 * Smoke test: the M1 seam over a REAL 127.0.0.1 HTTP/WS loopback, with auth.
 *
 *   HydraControlClient → LoopbackHttpWsTransport → (fetch / WebSocket over the
 *   wire) → createLoopbackServer → HydraAppService → @hydra/core
 *
 * over a HYDRA_HOME-isolated engine and a tmux-free fake backend. It:
 *   • round-trips listSessions(), create+delete of a task worker, sendMessage,
 *     getLogs — all over the wire;
 *   • subscribes to the events stream (WebSocket) and receives ≥ 1 event;
 *   • asserts auth is ENFORCED: missing / wrong bearer token → 401, and a
 *     non-local Origin → 403.
 *
 * Run: node packages/sidecar/out/smoke/loopbackSmoke.js
 */

import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createHydraControlClient } from '@hydra/protocol';
import type { HydraControlClient, HydraEvent } from '@hydra/protocol';
import { LoopbackHttpWsTransport } from '@hydra/transport-loopback';
import { FakeBackend } from './fakeBackend';

interface RawResponse {
  status: number;
  body: string;
}

/**
 * A raw HTTP request via node:http so we can send headers that undici's `fetch`
 * refuses to forward (notably `Origin`, a forbidden header name). The auth
 * negative tests need exact control over what reaches the wire.
 */
function rawRequest(
  url: string,
  options: { method: string; headers?: Record<string, string>; body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: options.method,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Pull events off the WS stream until `predicate` matches, then stop (closing
 * the socket). Bounded by a timeout so a missing event fails loud instead of
 * hanging the suite.
 */
async function firstMatchingEvent(
  client: HydraControlClient,
  predicate: (event: HydraEvent) => boolean,
  timeoutMs = 10_000,
): Promise<HydraEvent> {
  const iterator = client.subscribeEvents({ after: 0 })[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('timed out waiting for a matching event');
      }
      const timeout = new Promise<'TIMEOUT'>((resolve) => {
        setTimeout(() => resolve('TIMEOUT'), remaining).unref();
      });
      const next = await Promise.race([iterator.next(), timeout]);
      if (next === 'TIMEOUT') {
        throw new Error('timed out waiting for a matching event');
      }
      if (next.done) {
        throw new Error('event stream ended before a matching event arrived');
      }
      if (predicate(next.value)) {
        return next.value;
      }
    }
  } finally {
    // Stop the stream: closes the client socket, which the server observes and
    // uses to tear down the underlying poll iterable.
    await iterator.return?.();
  }
}

async function main(): Promise<void> {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-loopback-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.HYDRA_HOME = path.join(tempHome, '.hydra');
  process.env.HYDRA_TELEMETRY = '0';
  delete process.env.HYDRA_CONFIG_PATH;

  // Import AFTER HYDRA_HOME is set so the engine/stores resolve the isolated home.
  const { HydraAppService } = await import('../appService');
  const { createLoopbackServer } = await import('../loopbackServer');

  const token = `lb-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  const backend = new FakeBackend();
  const appService = new HydraAppService({ backend });
  const server = await createLoopbackServer(appService, { token });

  try {
    // Bound to loopback on a random port, as the FINAL security posture requires.
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/, 'server binds 127.0.0.1 on a random port');
    assert.ok(Number.isInteger(server.port) && server.port > 0, 'server reports a concrete port');

    const client = createHydraControlClient(new LoopbackHttpWsTransport({ url: server.url, token }));

    // ── round-trip 1: listSessions() over HTTP ──
    const empty = await client.listSessions();
    assert.deepEqual(empty.workers, [], 'no workers initially');
    assert.deepEqual(empty.copilots, [], 'no copilots initially');
    assert.equal(empty.count, 0, 'count is 0 initially');

    // ── round-trip 2: create + delete a task worker (mutation over the wire) ──
    const created = await client.createWorker({ temp: true, name: 'lb-temp', agent: 'claude' });
    assert.equal(created.status, 'created', 'worker created over the wire');
    assert.equal(created.type, 'task', 'temp worker is a task worker');
    const session = created.session;

    const afterCreate = await client.listSessions();
    assert.equal(afterCreate.count, 1, 'one session after create');
    assert.equal(afterCreate.workers[0].session, session, 'listed worker matches created session');

    // ── round-trip 3: getLogs + sendMessage over the wire ──
    const logs = await client.getLogs(session, 'worker', 5);
    assert.equal(logs.session, session, 'logs carry the session');
    assert.equal(logs.lines, 5, 'logs echo the requested line count');
    assert.ok(logs.output.includes(session), 'logs capture pane output');

    const sent = await client.sendMessage(session, 'worker', 'hello over loopback');
    assert.equal(sent.status, 'sent', 'message sent over the wire');
    assert.ok(
      backend.messages.some((m) => m.message === 'hello over loopback'),
      'message reached the backend through the server',
    );

    // ── round-trip 4: events stream over WebSocket receives ≥ 1 event ──
    // The create above appended a `worker.created` event; the stream drains the
    // backlog from seq 0 and must deliver it over the socket.
    const event = await firstMatchingEvent(
      client,
      (e) => e.type === 'worker.created' && e.session === session,
    );
    assert.equal(event.type, 'worker.created', 'stream delivered the worker.created event');
    assert.equal(event.session, session, 'streamed event carries the created session');
    assert.ok(Number.isInteger(event.seq) && event.seq > 0, 'streamed event carries a seq cursor');

    // ── openTerminal now returns a live channel (node-pty ⇄ tmux is M3) ──
    // The full node-pty bridge is exercised against a real tmux session in
    // smoke:terminal; here we just assert the transport hands back a well-formed
    // TerminalChannel (no NotImplemented throw) and can be torn down cleanly.
    const channel = client.attachTerminal({ session, mode: 'mirror' });
    assert.equal(channel.session, session, 'channel carries the session');
    assert.equal(channel.mode, 'mirror', 'channel carries the requested mode');
    assert.equal(typeof channel.write, 'function', 'channel exposes write');
    assert.equal(typeof channel.resize, 'function', 'channel exposes resize');
    channel.close();

    // ── auth is ENFORCED (FINAL security posture) ──
    const rpcUrl = `${server.url}/v1/rpc`;
    const rpcBody = JSON.stringify({ op: 'sessions.list', payload: null });

    const noToken = await rawRequest(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rpcBody,
    });
    assert.equal(noToken.status, 401, 'missing bearer token → 401');

    const wrongToken = await rawRequest(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-the-real-token' },
      body: rpcBody,
    });
    assert.equal(wrongToken.status, 401, 'wrong bearer token → 401');

    const badOrigin = await rawRequest(rpcUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        origin: 'http://evil.example.com',
      },
      body: rpcBody,
    });
    assert.equal(badOrigin.status, 403, 'valid token but non-local Origin → 403');

    // A valid token with no Origin (a native client) still works — sanity anchor.
    const ok = await rawRequest(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: rpcBody,
    });
    assert.equal(ok.status, 200, 'valid token, no Origin → 200');

    // A wrong token over the WS handshake is rejected too (stream never opens).
    await assert.rejects(
      () => firstMatchingEvent(
        createHydraControlClient(new LoopbackHttpWsTransport({ url: server.url, token: 'wrong' })),
        () => true,
        3_000,
      ),
      'WS stream with a wrong token is rejected',
    );

    // ── cleanup: delete the worker over the wire ──
    const deleted = await client.deleteSession(session, 'worker');
    assert.equal(deleted.status, 'deleted', 'worker deleted over the wire');
    const afterDelete = await client.listSessions();
    assert.equal(afterDelete.count, 0, 'no sessions after delete');

    console.log('loopbackSmoke: ok');
  } finally {
    await server.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

// Exit explicitly: this smoke opens real client sockets (the undici `fetch`
// keep-alive pool + WebSocket clients) whose idle handles would otherwise keep
// the process alive after the assertions pass. `main()` has already closed the
// server and printed the result by the time we get here.
void main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  },
);
