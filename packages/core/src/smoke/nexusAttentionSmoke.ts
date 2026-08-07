// LIVE smoke for worker→copilot ATTENTION over nexus (gap #1, a2a-mapping doc §5).
//
// Two isolated NotificationStores over ONE live daemon simulate two machines that
// share a replicated mailbox: store A = "worker machine", store B = "copilot
// machine". A worker-attention notification (targetSession = the copilot) is
// published into A; A's NotificationMailboxMirror sends it to the copilot's
// mailbox; B's CopilotInboundBridge re-materializes it into B with
// context.viaMailbox=true — the cross-machine hop that a per-machine
// NotificationStore cannot make today. Then B's OWN mirror must NOT echo the
// re-materialized notification back to the mailbox (the loop guard): the copilot
// mailbox must still hold exactly one frame.
//
// Needs a running daemon + an sk- agent key; NOT in the CI chain. Unique NAME/run.
//   SK=sk-... NAME=ts-copilot-$RANDOM node out/smoke/nexusAttentionSmoke.js

import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { EventLog } from '../core/events';
import { CopilotInboundBridge } from '../core/copilotInboundBridge';
import { NotificationMailboxMirror } from '../core/notificationMailboxMirror';
import { NotificationStore } from '../core/notifications';
import { NotificationStoreV2 } from '../core/notificationV2';
import { NexusMessageTransport, type NexusVfsClientOptions } from '../core/transport/nexus';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Client options for one nexus connection. CERT plane when `bundle` is an agent
 * bundle dir (ca.pem + agent.pem + agent-key.pem — the mTLS agent identity the
 * daemon resolves via classify_peer_cert); otherwise the sk-/insecure token plane.
 */
function clientOptions(address: string, bundle: string | undefined): NexusVfsClientOptions {
  if (bundle) {
    return {
      address,
      tls: {
        ca: readFileSync(join(bundle, 'ca.pem')),
        cert: readFileSync(join(bundle, 'agent.pem')),
        key: readFileSync(join(bundle, 'agent-key.pem')),
      },
    };
  }
  return { address, token: process.env.SK ?? process.env.NEXUS_SK ?? '' };
}

/** A fully isolated NotificationStore (own file, event log, v2 store) = one "machine". */
function isolatedStore(tag: string): NotificationStore {
  const dir = mkdtempSync(join(tmpdir(), `hydra-attn-${tag}-`));
  const eventLog = new EventLog(join(dir, 'events.jsonl'), join(dir, 'events-state.json'));
  const v2 = new NotificationStoreV2(join(dir, 'notifications-v2.json'));
  return new NotificationStore(
    join(dir, 'notifications.json'),
    undefined,
    eventLog,
    undefined,
    Date.now,
    v2,
  );
}

async function main(): Promise<void> {
  if (!process.env.BUNDLE && !(process.env.SK ?? process.env.NEXUS_SK)) {
    throw new Error('nexusAttentionSmoke: set BUNDLE (agent cert dir) or SK (an sk- key)');
  }
  const address = process.env.ADDR ?? process.env.NEXUS_AGENT_ADDR ?? '127.0.0.1:2126';
  const copilot = process.env.NAME ?? 'ts-copilot-probe';
  // Faithful worker→copilot: the SENDER (store A's mirror) is a WORKER agent
  // writing into the COPILOT's mailbox (cross-agent A2A — the kernel stamps the
  // worker's `from`); the receiver (store B's bridge) is the COPILOT agent tailing
  // its own mailbox. SENDER_BUNDLE defaults to BUNDLE (single-agent degenerate run).
  const copilotBundle = process.env.BUNDLE;
  const senderBundle = process.env.SENDER_BUNDLE ?? copilotBundle;

  const storeA = isolatedStore('a');
  const storeB = isolatedStore('b');
  const txA = new NexusMessageTransport(clientOptions(address, senderBundle));
  const txB = new NexusMessageTransport(clientOptions(address, copilotBundle));
  const collector = new NexusMessageTransport(clientOptions(address, copilotBundle));
  const mirrorA = new NotificationMailboxMirror({ store: storeA, messageTransport: txA });
  const bridgeB = new CopilotInboundBridge({ store: storeB, messageTransport: txB });
  const mirrorB = new NotificationMailboxMirror({ store: storeB, messageTransport: txB });

  try {
    bridgeB.start(copilot); // "machine B" tails the copilot's mailbox
    await sleep(500); // let the tail arm

    // "machine A": a worker raises attention for this copilot.
    const dedupeKey = `attn-smoke:${copilot}:${process.pid}`;
    storeA.create({
      kind: 'needs-input',
      title: 'Worker #1 needs input',
      body: 'please respond',
      targetSession: copilot,
      sourceSession: 'ts-worker',
      dedupeKey,
    });
    await mirrorA.pollOnce(); // mirror it to the copilot's mailbox

    // B's bridge must re-materialize it into B's local store (cross-machine hop).
    let got = undefined as ReturnType<typeof storeB.list>['notifications'][number] | undefined;
    for (let i = 0; i < 40 && !got; i += 1) {
      got = storeB
        .list({ targetSession: copilot })
        .notifications.find((n) => n.dedupeKey === dedupeKey);
      if (!got) {
        await sleep(250);
      }
    }
    if (!got) {
      throw new Error('copilot bridge did not re-materialize the attention within 10s');
    }
    if (!got.context?.viaMailbox) {
      throw new Error('re-materialized notification is missing the viaMailbox provenance marker');
    }

    // Loop guard: B's own mirror must SKIP the viaMailbox notification. The copilot
    // mailbox must still hold exactly one frame (no echo back).
    await mirrorB.pollOnce();
    await sleep(500);
    const frames = await collector.collect(copilot);
    if (frames.length !== 1) {
      throw new Error(
        `loop guard failed: copilot mailbox should hold exactly 1 frame, holds ${frames.length}`,
      );
    }

    console.log(
      'nexusAttentionSmoke: ok — attention A→mailbox→B re-materialized (viaMailbox), loop-guarded (1 frame)',
    );
  } finally {
    mirrorA.dispose();
    mirrorB.dispose();
    bridgeB.dispose();
    txA.close();
    txB.close();
    collector.close();
  }
}

main().catch((error) => {
  console.error('nexusAttentionSmoke: FAIL', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
