// LIVE smoke for the copilot->worker DELIVERY BRIDGE (doc §5, increment 2 — delivery).
//
// Drives the REAL WorkerLifecycleService in nexus mode with a mock backend + a live
// NexusMessageTransport: startWorker arms the inbound bridge (tail the worker's mailbox);
// a second client sends to that mailbox; the bridge must wake and inject the body into
// the worker's pane via backend.sendMessage. Proves the mailbox->tmux-inject last hop
// that lets a plain agent (no native mailbox read) receive nexus A2A messages.
// Needs a running daemon; NOT in the CI chain. Pass a UNIQUE NAME per run.
//
//   Single-node, token plane:
//     SK=sk-... NAME=ts-bridge-$RANDOM node out/smoke/nexusBridgeSmoke.js
//   Cross-node, cert plane (the auth-on 2-node case): the WLS bridge tails on ADDR,
//   the copilot SENDS on SENDER_ADDR (a DIFFERENT node); the mailbox write must
//   raft-replicate to the bridge's node, where the tail wakes and injects.
//     ADDR=127.0.0.1:12126 BUNDLE=<bridge agent dir> \
//     SENDER_ADDR=127.0.0.1:12127 SENDER_BUNDLE=<copilot agent dir> \
//     NAME=ts-bridge-$RANDOM node out/smoke/nexusBridgeSmoke.js

import { readFileSync } from 'fs';
import { join } from 'path';

import { WorkerLifecycleService } from '../core/workerLifecycleService';
import { NexusMessageTransport, type NexusVfsClientOptions } from '../core/transport/nexus';
import { RecordingBackend, FakeSessionManager, createWorker } from './workerLifecycleServiceSmoke';

/**
 * Client options for one nexus connection. CERT plane when `bundle` is an agent
 * bundle dir (ca.pem + agent.pem + agent-key.pem — the mTLS identity the daemon
 * resolves via classify_peer_cert); otherwise the sk-/insecure token plane.
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

async function main(): Promise<void> {
  const bundle = process.env.BUNDLE;
  if (!bundle && !(process.env.SK ?? process.env.NEXUS_SK)) {
    throw new Error('nexusBridgeSmoke: set BUNDLE (agent cert dir) or SK (an sk- agent key)');
  }
  const address = process.env.ADDR ?? process.env.NEXUS_AGENT_ADDR ?? '127.0.0.1:2129';
  // Cross-node: the copilot SENDS from a different node than the WLS bridge tails.
  // Defaults collapse to a single-node run.
  const senderAddr = process.env.SENDER_ADDR ?? address;
  const senderBundle = process.env.SENDER_BUNDLE ?? bundle;
  const sessionName = process.env.NAME ?? 'ts-bridge-probe';
  const body = process.env.MSG ?? 'delivered via bridge';

  const worker = createWorker(1, sessionName);
  const backend = new RecordingBackend();
  const manager = new FakeSessionManager(backend, [worker]);
  const messageTransport = new NexusMessageTransport(clientOptions(address, bundle));
  const service = new WorkerLifecycleService({
    backend,
    sessionManager: manager,
    messageTransport,
    mode: 'nexus',
    eventSource: 'cli',
  });
  const sender = new NexusMessageTransport(clientOptions(senderAddr, senderBundle));

  try {
    await service.startWorker(sessionName); // arms the inbound mailbox->pane bridge
    await new Promise((r) => setTimeout(r, 500)); // let the bridge tail arm
    await sender.send(sessionName, { from: 'copilot', to: sessionName, body });

    // Poll the mock backend for the injected message (bridge is async).
    let injected: { sessionName: string; message: string } | undefined;
    for (let i = 0; i < 40 && !injected; i += 1) {
      injected = backend.sent.find((s) => s.sessionName === sessionName && s.message.includes(body));
      if (!injected) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!injected) {
      throw new Error('bridge did not inject the mailbox message into the pane within 10s');
    }
    console.log(
      `nexusBridgeSmoke: ok — mailbox message delivered to pane via bridge: ${JSON.stringify(injected.message)}`,
    );
  } finally {
    service.close();
    sender.close();
  }
}

main().catch((error) => {
  console.error('nexusBridgeSmoke: FAIL', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
