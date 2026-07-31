// LIVE smoke for the nexus CERT plane (agent identity cert + mTLS).
//
// Unlike the sk--token tracking smoke, this connects with an AGENT CERT minted
// by `nexusd-cluster auth mint --subject-type agent` — the client cert IS the
// identity (no token). It is NOT in the default `npm test` chain (CI has no
// nexus daemon). Run it by hand against a TLS-on founder:
//
//   BUNDLE=<data>/agents/<name>  ADDR=127.0.0.1:2126  HOST_PID=4242 \
//     node out/smoke/nexusCertAgentSmoke.js
//
// Verifies register -> list -> unregister live over mTLS. With REVOKED=1 (run
// AFTER `auth revoke --agent <name>` + a CRL refresh) it also asserts the next
// call is REJECTED — the chain is still valid, so the CRL is what rejects it.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { NexusRunTracker } from '../core/transport/nexus';

async function main(): Promise<void> {
  const bundle = process.env.BUNDLE;
  if (!bundle) {
    throw new Error(
      'nexusCertAgentSmoke: set BUNDLE=<data>/agents/<name> — the cert bundle dir ' +
        '(agent.pem / agent-key.pem / ca.pem) that `auth mint --subject-type agent` wrote',
    );
  }
  const tls = {
    ca: fs.readFileSync(path.join(bundle, 'ca.pem')),
    cert: fs.readFileSync(path.join(bundle, 'agent.pem')),
    key: fs.readFileSync(path.join(bundle, 'agent-key.pem')),
  };
  const address = process.env.ADDR ?? '127.0.0.1:2126';
  const hostPid = Number(process.env.HOST_PID ?? 4242);
  const name = process.env.NAME ?? path.basename(bundle);
  const connectionId = process.env.CONN ?? `hydra-cert-smoke-${hostPid}`;

  const tracker = new NexusRunTracker({ address, tls });
  try {
    if (process.env.REVOKED === '1') {
      // Run AFTER `auth revoke --agent <name>` + a CRL refresh. The mTLS
      // handshake still completes (the chain is valid), so the rejection
      // surfaces at the application resolve — the CRL is the gate.
      let rejected = false;
      try {
        await tracker.registerRun({ name, hostPid, connectionId });
      } catch {
        rejected = true;
      }
      if (!rejected) {
        throw new Error('REVOKED=1 but the revoked cert still authenticated — CRL not enforced');
      }
      console.log('nexusCertAgentSmoke: ok — the revoked cert is REJECTED (CRL enforced)');
      return;
    }

    const handle = await tracker.registerRun({ name, hostPid, connectionId });
    console.log(
      `nexusCertAgentSmoke: register ok over mTLS — pid=${handle.pid} name=${handle.name} (cert identity, no token)`,
    );

    const listed = await tracker.listRuns();
    if (!listed.some((r) => r.pid === handle.pid && r.name === name)) {
      throw new Error('run not in listRuns after register');
    }
    await tracker.unregisterRun(handle.pid);
    console.log('nexusCertAgentSmoke: ok — register/list/unregister all live over the cert plane');
  } finally {
    tracker.close();
  }
}

main().catch((error) => {
  console.error('nexusCertAgentSmoke: FAIL', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
