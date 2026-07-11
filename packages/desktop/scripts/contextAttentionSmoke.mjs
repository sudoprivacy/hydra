// Pure behavior proof for Context UI state and occurrence routing.
// Run: node packages/desktop/scripts/contextAttentionSmoke.mjs

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const contextStatePath = path.join(here, '..', 'src', 'renderer', 'context', 'contextStateModel.ts');
const attentionRoutingPath = path.join(here, '..', 'src', 'renderer', 'context', 'attentionRouting.ts');

async function load(entryPoint) {
  const bundled = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  });
  const source = Buffer.from(bundled.outputFiles[0].text).toString('base64');
  return import(`data:text/javascript;base64,${source}`);
}

const { contextUiReducer, INITIAL_CONTEXT_UI_STATE } = await load(contextStatePath);
const { resolveAttentionRoute } = await load(attentionRoutingPath);

let state = contextUiReducer(INITIAL_CONTEXT_UI_STATE, {
  type: 'open-session',
  mode: 'copilot',
  session: 'captain',
});
assert.deepEqual(state, { open: true, mode: 'copilot', subjectSession: 'captain' });

state = contextUiReducer(state, {
  type: 'sync-session',
  mode: 'worker',
  session: 'repo_feat-one',
});
assert.deepEqual(state, { open: true, mode: 'worker', subjectSession: 'repo_feat-one' });

state = contextUiReducer(state, { type: 'open-attention' });
assert.deepEqual(state, { open: true, mode: 'attention', subjectSession: null });
assert.equal(
  contextUiReducer(state, { type: 'sync-session', mode: 'worker', session: 'ignored' }),
  state,
  'global Attention does not follow tab focus',
);

state = contextUiReducer(state, {
  type: 'toggle-session',
  mode: 'worker',
  session: 'repo_feat-one',
});
assert.deepEqual(state, { open: true, mode: 'worker', subjectSession: 'repo_feat-one' });
state = contextUiReducer(state, {
  type: 'toggle-session',
  mode: 'worker',
  session: 'repo_feat-one',
});
assert.equal(state.open, false, 'toggling the current subject closes Context');

const occurrence = (kind, readAt = null) => ({
  version: 2,
  id: `${kind}-id`,
  occurrenceId: `${kind}-occurrence`,
  workerId: 7,
  lifecycleEpoch: 'epoch',
  runId: 'run',
  signalId: 'signal',
  kind,
  status: 'active',
  title: kind,
  body: '',
  createdAt: '2026-07-12T00:00:00.000Z',
  readAt,
  resolvedAt: null,
  dismissedAt: null,
  sourceSession: 'repo_feat-one',
  targetSession: 'captain',
});
const codeWorker = {
  session: 'repo_feat-one',
  workerId: 7,
  type: 'code',
  raw: { agentSessionId: 'agent-worker' },
};
const taskWorker = {
  session: 'task_notes',
  workerId: 8,
  type: 'task',
  raw: { agentSessionId: null },
};

assert.deepEqual(resolveAttentionRoute(occurrence('complete'), codeWorker), {
  session: 'repo_feat-one',
  workerId: 7,
  agentSessionId: 'agent-worker',
  view: 'diff',
  markReadId: 'complete-id',
});
assert.equal(resolveAttentionRoute(occurrence('complete'), taskWorker).view, 'terminal');
assert.equal(resolveAttentionRoute(occurrence('needs-input'), codeWorker).view, 'terminal');
assert.equal(resolveAttentionRoute(occurrence('error', '2026-07-12T00:01:00.000Z'), codeWorker).markReadId, null);
assert.equal(resolveAttentionRoute(occurrence('complete'), null).session, null);

console.log('contextAttentionSmoke: ok');
