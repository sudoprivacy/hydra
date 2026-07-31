// LIVE smoke for the nexus message plane (doc §5, increment 2 slice 2).
//
// Drives NexusMessageTransport against a real nexus daemon: send an envelope to an
// agent's chat-with-me mailbox, collect it back, and assert the kernel stamped an
// unforgeable `from` (a forged `from` is overwritten with the caller's authenticated
// agent_id). Needs a running daemon with the a2a stamp hook armed, so it is NOT in the
// CI chain. Pass a UNIQUE NAME per run so the mailbox is a fresh single-message stream.
//
//   SK=sk-... NAME=ts-msg-$RANDOM node out/smoke/nexusMessageSmoke.js

import { NexusMessageTransport } from '../core/transport/nexus';

async function main(): Promise<void> {
  const token = process.env.SK ?? process.env.NEXUS_SK ?? '';
  if (!token) {
    throw new Error('nexusMessageSmoke: set SK (an sk- agent key)');
  }
  const address = process.env.ADDR ?? process.env.NEXUS_AGENT_ADDR ?? '127.0.0.1:2129';
  const target = process.env.NAME ?? 'ts-msg-probe'; // recipient mailbox: /agents/<target>/chat-with-me
  const expectedFrom = process.env.AGENT ?? 'ts-probe'; // the sk- key's subject → stamped `from`
  const body = process.env.MSG ?? 'hello via message transport';

  const mt = new NexusMessageTransport({ address, token });
  try {
    // Forge `from` — the kernel must overwrite it with the authenticated sender.
    await mt.send(target, { from: 'impostor', to: 'peer', body });
    const msgs = await mt.collect(target);
    if (msgs.length !== 1) {
      throw new Error(`expected exactly 1 message, got ${msgs.length} (stale mailbox? pass a unique NAME)`);
    }
    const m = msgs[0];
    if (m.from !== expectedFrom) {
      throw new Error(`from ${JSON.stringify(m.from)} != ${JSON.stringify(expectedFrom)} (from-stamp)`);
    }
    if (m.body !== body) {
      throw new Error(`body ${JSON.stringify(m.body)} != ${JSON.stringify(body)}`);
    }
    console.log(
      `nexusMessageSmoke: ok — send/collect round-trip; from-stamp overwrote "impostor" -> "${m.from}" (unforgeable)`,
    );
  } finally {
    mt.close();
  }
}

main().catch((error) => {
  console.error('nexusMessageSmoke: FAIL', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
