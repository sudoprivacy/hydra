// LIVE smoke: DT_STREAM fan-out (doc §6). Two independent watchers tail the SAME stream;
// one write reaches BOTH — the basis for broadcast (copilot -> all workers via one shared
// stream, no per-worker fan-out write). Needs a running daemon; NOT in the CI chain.
//
//   SK=sk-... NAME=bcast-$RANDOM node out/smoke/nexusFanoutSmoke.js

import { MessageEnvelope, NexusMessageTransport } from '../core/transport/nexus';

async function main(): Promise<void> {
  const token = process.env.SK ?? process.env.NEXUS_SK ?? '';
  if (!token) {
    throw new Error('nexusFanoutSmoke: set SK');
  }
  const address = process.env.ADDR ?? process.env.NEXUS_AGENT_ADDR ?? '127.0.0.1:2129';
  const stream = process.env.NAME ?? 'bcast-probe';
  const body = process.env.MSG ?? 'broadcast to all';

  const w1 = new NexusMessageTransport({ address, token });
  const w2 = new NexusMessageTransport({ address, token });
  const sender = new NexusMessageTransport({ address, token });
  const controller = new AbortController();
  const got1: MessageEnvelope[] = [];
  const got2: MessageEnvelope[] = [];
  let resolve1: () => void = () => {};
  let resolve2: () => void = () => {};
  const both = Promise.all([
    new Promise<void>((r) => (resolve1 = r)),
    new Promise<void>((r) => (resolve2 = r)),
  ]);

  const watching1 = w1.watch(stream, (e) => { got1.push(e); resolve1(); }, { signal: controller.signal, timeoutMs: 5000 });
  const watching2 = w2.watch(stream, (e) => { got2.push(e); resolve2(); }, { signal: controller.signal, timeoutMs: 5000 });

  try {
    await new Promise((r) => setTimeout(r, 500));
    await sender.send(stream, { to: 'all', body });

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`fan-out incomplete: w1=${got1.length} w2=${got2.length} within 10s`)), 10_000),
    );
    await Promise.race([both, timeout]);

    if (got1[0]?.body !== body || got2[0]?.body !== body) {
      throw new Error(`both watchers must receive ${JSON.stringify(body)} — got w1=${JSON.stringify(got1[0]?.body)} w2=${JSON.stringify(got2[0]?.body)}`);
    }
    console.log(`nexusFanoutSmoke: ok — one write reached BOTH watchers (DT_STREAM fan-out): ${JSON.stringify(body)}`);
  } finally {
    controller.abort();
    await Promise.allSettled([watching1, watching2]);
    w1.close();
    w2.close();
    sender.close();
  }
}

main().catch((error) => {
  console.error('nexusFanoutSmoke: FAIL', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
