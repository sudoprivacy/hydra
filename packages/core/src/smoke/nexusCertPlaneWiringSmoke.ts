// Guards the createTransport CERT-PLANE contract (no daemon needed — pure wiring).
//
// An auth-on nexus daemon exposes ONLY the mTLS cert plane (agents authenticate by
// cert on the main bind; the sk- --agent-bind-addr plane was removed). So the shipped
// app must be able to pick the cert plane from env: NEXUS_AGENT_CERT_DIR (a bundle dir
// with ca.pem + agent.pem + agent-key.pem). This asserts the resolution honours that
// contract — reads the bundle, prefers cert over a stray token, fails loud on a bundle
// missing its PEMs, and otherwise falls back to the sk- token plane. Runs in CI.
//
// It tests `resolveAgentCredential` directly (pure readFileSync, no cert parsing) plus
// the token/legacy `createTransport` paths; the cert-plane `createTransport` path parses
// the PEMs via grpc at construction, so exercising it end to end needs a real bundle and
// a live daemon — that is the manual `appdriver`/nexus cross-node smoke's job.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTransport, resolveAgentCredential } from '../core/transport/nexus';

/** A temp dir holding the three PEM files an agent bundle carries (dummy bytes — the
 *  credential resolver only reads them; it does not parse them). */
function fakeBundle(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-cert-plane-'));
  writeFileSync(join(dir, 'ca.pem'), 'CA-BYTES');
  writeFileSync(join(dir, 'agent.pem'), 'CERT-BYTES');
  writeFileSync(join(dir, 'agent-key.pem'), 'KEY-BYTES');
  return dir;
}

function main(): void {
  const bundle = fakeBundle();
  try {
    // 1) Cert dir -> mTLS material, read verbatim from the bundle's three PEMs.
    const cert = resolveAgentCredential({ NEXUS_AGENT_CERT_DIR: bundle });
    assert.ok(cert.tls, 'a cert dir must yield mTLS material');
    assert.equal(cert.tls?.ca.toString(), 'CA-BYTES');
    assert.equal(cert.tls?.cert.toString(), 'CERT-BYTES');
    assert.equal(cert.tls?.key.toString(), 'KEY-BYTES');
    assert.equal(cert.token, undefined, 'a cert dir must not also carry a token');

    // 2) Cert dir wins over a stray token (cert plane is the more-secure choice).
    const both = resolveAgentCredential({ NEXUS_AGENT_CERT_DIR: bundle, NEXUS_SK: 'sk-ignored' });
    assert.ok(both.tls, 'cert dir must win over NEXUS_SK');
    assert.equal(both.token, undefined, 'a cert dir must suppress the token');

    // 3) No cert dir -> the sk- token plane (loopback / auth-off).
    const token = resolveAgentCredential({ NEXUS_SK: 'sk-loopback' });
    assert.equal(token.token, 'sk-loopback');
    assert.equal(token.tls, undefined, 'no cert dir means no mTLS material');

    // 4) A cert dir missing its PEMs must fail loud — no silent token fallback that
    //    would then hit an auth-on daemon with no client cert and hang.
    const empty = mkdtempSync(join(tmpdir(), 'nexus-cert-empty-'));
    assert.throws(
      () => resolveAgentCredential({ NEXUS_AGENT_CERT_DIR: empty }),
      /ca\.pem|ENOENT|no such file/i,
      'a cert dir without its PEMs must throw, not silently fall back',
    );
    rmSync(empty, { recursive: true, force: true });

    // 5) createTransport wires the token plane end to end (insecure gRPC, no PEM parse).
    const token2 = createTransport({
      env: { HYDRA_TRANSPORT: 'nexus', NEXUS_AGENT_ADDR: '127.0.0.1:2129', NEXUS_SK: 'sk-loopback' },
    });
    assert.equal(token2.mode, 'nexus', 'token plane must select nexus mode');
    assert.ok(token2.nexusMessageTransport, 'nexus mode must expose the pure nexus message transport');

    // 6) Legacy ignores every nexus credential.
    const legacy = createTransport({ env: { HYDRA_TRANSPORT: 'legacy', NEXUS_AGENT_CERT_DIR: bundle } });
    assert.equal(legacy.mode, 'legacy', 'legacy must ignore nexus credentials');
    assert.equal(legacy.nexusMessageTransport, undefined, 'legacy must not expose a nexus transport');

    console.log('nexusCertPlaneWiringSmoke: ok — createTransport honours the NEXUS_AGENT_CERT_DIR cert plane');
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
}

main();
