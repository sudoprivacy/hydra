// LIVE smoke: multi-message receive. Verifies the watch/bridge receive path handles
// SEVERAL messages (a worker gets multiple copilot messages), each decoded as its own
// envelope — i.e. StreamReadAt is per-frame, not concatenated. Critical for the bridge.
// Needs a running daemon; NOT in the CI chain. Pass a UNIQUE NAME per run.
//
//   SK=sk-... NAME=ts-multi-$RANDOM node out/smoke/nexusMultiSmoke.js

import { MessageEnvelope, NexusMessageTransport } from '../core/transport/nexus';

async function main(): Promise<void> {
  const token = process.env.SK ?? process.env.NEXUS_SK ?? '';
  if (!token) {
    throw new Error('nexusMultiSmoke: set SK');
  }
  const address = process.env.ADDR ?? process.env.NEXUS_AGENT_ADDR ?? '127.0.0.1:2129';
  const target = process.env.NAME ?? 'ts-multi-probe';
  const bodies = ['m1-alpha', 'm2-beta', 'm3-gamma'];

  const watcher = new NexusMessageTransport({ address, token });
  const sender = new NexusMessageTransport({ address, token });
  const controller = new AbortController();
  const received: MessageEnvelope[] = [];
  let resolveAll: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveAll = resolve;
  });

  const watching = watcher.watch(
    target,
    (env) => {
      received.push(env);
      if (received.length >= bodies.length) {
        resolveAll();
      }
    },
    { signal: controller.signal, timeoutMs: 5000 },
  );

  try {
    await new Promise((r) => setTimeout(r, 500));
    for (const body of bodies) {
      await sender.send(target, { to: 'peer', body });
    }

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`only received ${received.length}/${bodies.length} within 10s`)), 10_000),
    );
    await Promise.race([done, timeout]);

    const gotBodies = received.map((m) => m.body);
    const ok =
      gotBodies.length === bodies.length && bodies.every((b, i) => gotBodies[i] === b);
    if (!ok) {
      throw new Error(`expected ${JSON.stringify(bodies)} in order, got ${JSON.stringify(gotBodies)}`);
    }
    // Also verify collect() decodes all N (per-frame, not concatenated).
    const collector = new NexusMessageTransport({ address, token });
    const collectedBodies = (await collector.collect(target)).map((m) => m.body);
    collector.close();
    if (
      collectedBodies.length !== bodies.length ||
      !bodies.every((b, i) => collectedBodies[i] === b)
    ) {
      throw new Error(`collect() expected ${JSON.stringify(bodies)}, got ${JSON.stringify(collectedBodies)}`);
    }
    console.log(
      `nexusMultiSmoke: ok — watch received ${bodies.length} in order + collect() decoded ${collectedBodies.length}: ${JSON.stringify(gotBodies)}`,
    );
  } finally {
    controller.abort();
    await watching.catch(() => {});
    watcher.close();
    sender.close();
  }
}

main().catch((error) => {
  console.error('nexusMultiSmoke: FAIL', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
