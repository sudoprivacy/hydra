// LIVE smoke for the nexus orchestration-tracking backend (doc §5, increment 2 slice 1).
//
// Unlike the mock-backed smokes, this one talks to a REAL nexus daemon, so it is NOT in
// the default `npm test` chain (CI has no nexus). Run it by hand against a founder whose
// agent plane is up:
//
//   SK=sk-... HOST_PID=4242 LOCAL_ID=7 node out/smoke/nexusTrackingSmoke.js
//
// Verifies register -> list -> heartbeat -> unregister, and that the assigned pid IS the
// OS host_pid (nexus-vfs #195): host_pid=4242, local_id=7  ->  pid="4242.7".

import { NexusRunTracker } from '../core/transport/nexus';

async function main(): Promise<void> {
  const token = process.env.SK ?? process.env.NEXUS_SK ?? '';
  if (!token) {
    throw new Error('nexusTrackingSmoke: set SK (an sk- agent key) — the agent plane always authenticates');
  }
  const address = process.env.ADDR ?? process.env.NEXUS_AGENT_ADDR ?? '127.0.0.1:2129';
  const hostPid = Number(process.env.HOST_PID ?? 4242);
  const localId = process.env.LOCAL_ID ? Number(process.env.LOCAL_ID) : undefined;
  const name = process.env.NAME ?? 'pocnode-hydra-w1';
  const connectionId = process.env.CONN ?? `hydra-smoke-${hostPid}`;
  const expectedPid = localId != null ? `${hostPid}.${localId}` : String(hostPid);

  const tracker = new NexusRunTracker({ address, token });
  try {
    const handle = await tracker.registerRun({ name, hostPid, connectionId, localId });
    if (!handle) {
      throw new Error('registerRun returned null');
    }
    if (handle.pid !== expectedPid) {
      throw new Error(`pid ${handle.pid} != expected ${expectedPid} (host_pid encoding, #195)`);
    }
    if (handle.name !== name) {
      throw new Error(`name ${handle.name} != ${name}`);
    }

    const listed = await tracker.listRuns();
    if (!listed.some((r) => r.pid === handle.pid && r.name === name)) {
      throw new Error('run not in listRuns after register');
    }

    await tracker.heartbeat(handle.pid);

    await tracker.unregisterRun(handle.pid);
    const after = await tracker.listRuns();
    if (after.some((r) => r.pid === handle.pid)) {
      throw new Error('run still present after unregister');
    }

    console.log(
      `nexusTrackingSmoke: ok — pid == host_pid (${handle.pid}); register/list/heartbeat/unregister all live`,
    );
  } finally {
    tracker.close();
  }
}

main().catch((error) => {
  console.error('nexusTrackingSmoke: FAIL', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
