// Guards the blocking-read long-poll timeout classification (no daemon — pure logic).
//
// A blocking `StreamReadAt` that reaches its timeout with no frame surfaces as a
// `WouldBlock` error, not an `eof` response. `watch` (the A2A mailbox tail) must treat
// that as a normal long-poll expiry and re-poll — otherwise a tail idle longer than one
// timeout window dies and misses every later message. `isStreamLongPollTimeout` is the
// classifier; this asserts it catches the timeout AND does NOT swallow real errors (a
// too-broad match would silently drop permission/not-found/transport failures). Runs in CI.

import assert from 'node:assert/strict';

import { isStreamLongPollTimeout } from '../core/transport/nexus/vfsClient';

function main(): void {
  // The real daemon shape (as seen live) + its bare forms → treated as a retry.
  assert.equal(
    isStreamLongPollTimeout(
      new Error('StreamReadAt: {"code":-32603,"message":"WouldBlock(\\"stream read timeout\\")"}'),
    ),
    true,
    'the live WouldBlock stream-read-timeout error must classify as a long-poll expiry',
  );
  assert.equal(isStreamLongPollTimeout(new Error('WouldBlock("stream read timeout")')), true);
  assert.equal(isStreamLongPollTimeout('stream read timeout'), true);

  // Genuine failures must STILL throw — never masked as "no frame yet".
  assert.equal(isStreamLongPollTimeout(new Error('permission denied')), false);
  assert.equal(isStreamLongPollTimeout(new Error('NotFound: stream does not exist')), false);
  assert.equal(isStreamLongPollTimeout(new Error('connection refused')), false);
  assert.equal(isStreamLongPollTimeout(undefined), false);

  console.log('nexusWatchTimeoutSmoke: ok — long-poll timeout retried; real errors still surface');
}

main();
