// LIVE smoke for the tracking-plane WIRING (doc §5, increment 2 slice 1).
//
// Where nexusTrackingSmoke exercises the RunTracker in isolation, this drives the REAL
// WorkerLifecycleService.startWorker / stopWorker (with the mock backend + session
// manager from workerLifecycleServiceSmoke) through a live NexusRunTracker, proving the
// wiring fires at the right lifecycle edges and reaches nexus. Needs a running nexus, so
// it is NOT in the default `npm test` chain.
//
//   Token plane:  SK=sk-... node out/smoke/nexusTrackingWiringSmoke.js
//   Cert plane (auth-on):  ADDR=127.0.0.1:12126 BUNDLE=<agent dir> node out/smoke/nexusTrackingWiringSmoke.js
//
// The tmux pane pid is faked here (no real tmux on CI/Windows); getSessionPanePids is
// hydra's own tested tmux method, so this covers the NEW logic (wiring + nexus round
// trip). The real-worker path is a manual E2E on a box with tmux.

import { readFileSync } from 'fs';
import { join } from 'path';

import { WorkerLifecycleService } from '../core/workerLifecycleService';
import { NexusRunTracker, type NexusVfsClientOptions } from '../core/transport/nexus';
import { RecordingBackend, FakeSessionManager, createWorker } from './workerLifecycleServiceSmoke';

/**
 * Client options for one nexus connection. CERT plane when `bundle` is an agent
 * bundle dir (ca.pem + agent.pem + agent-key.pem); otherwise the sk-/insecure token plane.
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

/** Backend that reports a fixed agent-pane pid (stands in for a real tmux pane). */
class PanePidBackend extends RecordingBackend {
  constructor(private readonly panePid: string) {
    super();
  }
  override async getSessionPanePids(): Promise<string[]> {
    return [this.panePid];
  }
}

async function main(): Promise<void> {
  const bundle = process.env.BUNDLE;
  if (!bundle && !(process.env.SK ?? process.env.NEXUS_SK)) {
    throw new Error('set BUNDLE (agent cert dir) or SK (an sk- agent key) — the agent plane always authenticates');
  }
  const address = process.env.ADDR ?? process.env.NEXUS_AGENT_ADDR ?? '127.0.0.1:2129';
  const hostPid = process.env.HOST_PID ?? '6001';
  const sessionName = process.env.NAME ?? 'hydra_poc_wiretest';

  const worker = createWorker(1, sessionName);
  const backend = new PanePidBackend(hostPid);
  const manager = new FakeSessionManager(backend, [worker]);
  const tracker = new NexusRunTracker(clientOptions(address, bundle));
  const service = new WorkerLifecycleService({
    backend,
    sessionManager: manager,
    runTracker: tracker,
    eventSource: 'cli',
  });

  try {
    await service.startWorker(sessionName);
    const listedAfterStart = await tracker.listRuns();
    const found = listedAfterStart.find((r) => r.name === sessionName);
    if (!found) {
      throw new Error('worker not registered in nexus after startWorker (see nexus-tracking.register warning)');
    }
    if (found.pid !== hostPid) {
      throw new Error(`registered pid ${found.pid} != agent-pane host_pid ${hostPid}`);
    }
    console.log(`startWorker -> nexus register: name=${found.name} pid=${found.pid}`);

    await service.stopWorker(sessionName);
    const listedAfterStop = await tracker.listRuns();
    if (listedAfterStop.some((r) => r.name === sessionName)) {
      throw new Error('worker still registered in nexus after stopWorker');
    }
    console.log('stopWorker -> nexus unregister: gone');

    console.log('nexusTrackingWiringSmoke: ok — startWorker/stopWorker drive nexus register/unregister');
  } finally {
    service.close(); // closes the injected tracker's channel
  }
}

main().catch((error) => {
  console.error('nexusTrackingWiringSmoke: FAIL', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
