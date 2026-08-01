// LIVE smoke for the message-plane RECEIVE side (doc §5, increment 2 — receive).
//
// Arms a tailing watcher on a mailbox (NexusMessageTransport.watch → blocking
// StreamReadAt / sys_watch), sends an envelope to that mailbox from a second client, and
// asserts the watcher wakes and receives it (with the kernel-stamped `from`). This is the
// primitive the copilot→worker delivery bridge + worker→copilot attention build on.
// Needs a running daemon; NOT in the CI chain. Pass a UNIQUE NAME per run.
//
//   SK=sk-... NAME=ts-watch-$RANDOM node out/smoke/nexusWatchSmoke.js

import { MessageEnvelope, NexusMessageTransport } from '../core/transport/nexus';

async function main(): Promise<void> {
  const token = process.env.SK ?? process.env.NEXUS_SK ?? '';
  if (!token) {
    throw new Error('nexusWatchSmoke: set SK (an sk- agent key)');
  }
  const address = process.env.ADDR ?? process.env.NEXUS_AGENT_ADDR ?? '127.0.0.1:2129';
  const target = process.env.NAME ?? 'ts-watch-probe';
  const expectedFrom = process.env.AGENT ?? 'ts-probe';
  const body = process.env.MSG ?? 'hello via watch';

  const watcher = new NexusMessageTransport({ address, token });
  const sender = new NexusMessageTransport({ address, token });
  const controller = new AbortController();
  const received: MessageEnvelope[] = [];
  let resolveFirst: () => void = () => {};
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });

  // Arm the tail (from offset 0), running in the background.
  const watching = watcher.watch(
    target,
    (env) => {
      received.push(env);
      resolveFirst();
    },
    { signal: controller.signal, timeoutMs: 5000 },
  );

  try {
    // Let the watcher arm, then send from the other client.
    await new Promise((r) => setTimeout(r, 500));
    await sender.send(target, { from: 'impostor', to: 'peer', body });

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('watcher did not receive within 10s')), 10_000),
    );
    await Promise.race([first, timeout]);

    const m = received[0];
    if (!m) {
      throw new Error('no message received');
    }
    if (m.from !== expectedFrom) {
      throw new Error(`from ${JSON.stringify(m.from)} != ${JSON.stringify(expectedFrom)}`);
    }
    if (m.body !== body) {
      throw new Error(`body ${JSON.stringify(m.body)} != ${JSON.stringify(body)}`);
    }
    console.log(
      `nexusWatchSmoke: ok — sys_watch tail woke + received {from:"${m.from}", body:${JSON.stringify(m.body)}}`,
    );
  } finally {
    controller.abort();
    await watching.catch(() => {});
    watcher.close();
    sender.close();
  }
}

main().catch((error) => {
  console.error('nexusWatchSmoke: FAIL', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
