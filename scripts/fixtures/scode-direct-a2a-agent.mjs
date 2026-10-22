import * as acp from '@agentclientprotocol/sdk';
import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';

// Protocol fixture only. Real engine/policy/mailbox and zero-inference proofs
// belong to sudocode's stdio acceptance, not this Hydra transport smoke.
const scenario = process.argv[2] ?? 'normal';
const journal = process.env.HYDRA_DIRECT_FIXTURE_JOURNAL;
const log = entry => appendFileSync(journal, JSON.stringify({ pid: process.pid, ...entry })+'\n');
let sessionId;
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false });
const app = acp.agent({ name: 'hydra-direct-fixture', version: '1' })
  .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true },
    ...(scenario === 'legacy' ? {} : { _meta: { sudocode: { directA2a: { version: 1 } } } }),
  }))
  .onRequest(acp.methods.agent.session.load, ctx => { sessionId = ctx.params.sessionId; log({ method: 'session/load', sessionId }); return {}; })
  .onRequest(acp.methods.agent.session.prompt, () => { log({ method: 'session/prompt' }); throw new Error('Unexpected model path'); })
  .onRequest('_sudocode/a2a/send', value => value, ctx => {
    log({ method: '_sudocode/a2a/send', input: ctx.params });
    if (scenario === 'missing-method') throw acp.RequestError.methodNotFound('_sudocode/a2a/send');
    if (ctx.params.sessionId !== sessionId) throw new Error('Unknown native session');
    if (scenario === 'loss') process.exit(17); // Append journal exists, response is lost.
    if (scenario === 'malformed') return { queued: true };
    return result({ success: true, routing: { sender: 'bound-fixture-actor', to: ctx.params.to }, text: ctx.params.message });
  })
  .onRequest('_sudocode/a2a/agent_list', value => value, ctx => {
    log({ method: '_sudocode/a2a/agent_list', input: ctx.params });
    return result({ agents: [{ name: 'fixture-peer', send_to: 'fixture-peer' }] });
  })
  .onRequest(acp.methods.agent.session.close, () => ({}));
const connection = app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
