// Headless proof that Mission Control renders from "snapshot + event delta"
// (M2 Definition of done). It exercises the SAME pure reducer the live hook
// drives (src/renderer/missionControl/boardModel.ts) — no React, no DOM, no
// sidecar. esbuild strips the type-only @hydra/protocol imports, so the reducer
// bundles to dependency-free ESM we can import and assert against.
//
// Run: node packages/desktop/scripts/missionControlBoardSmoke.mjs

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const boardModelPath = path.join(here, '..', 'src', 'renderer', 'missionControl', 'boardModel.ts');

const bundled = await build({
  entryPoints: [boardModelPath],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  // Type-only imports are erased; keep the domain packages external as a belt.
  external: ['@hydra/protocol', '@hydra/core', '@hydra/core/*'],
  logLevel: 'silent',
});

const code = bundled.outputFiles[0].text;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const {
  createBoardModel,
  applyEvent,
  applyEvents,
  applyGitStatus,
  applyNotificationSnapshot,
  applySnapshot,
  selectBoard,
  isMembershipEvent,
  deriveLifecycle,
} = await import(moduleUrl);

// ── fixtures ──

let seq = 0;
function event(type, session, payload) {
  seq += 1;
  return {
    version: 1,
    seq,
    bootId: 'boot',
    ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    type,
    source: 'session-manager',
    session,
    role: type.startsWith('copilot.') ? 'copilot' : 'worker',
    payload,
  };
}

function runtimeState(state) {
  return { state, updatedAt: '2026-01-01T00:00:00.000Z', origin: 'session-manager', reason: 'seed' };
}

function worker(overrides) {
  return {
    number: 1,
    name: 'worker-one',
    type: 'code',
    session: 'repo-a_feat-one',
    repo: '/src/repo-a',
    branch: 'feat/one',
    agent: 'claude',
    status: 'running',
    runtimeState: runtimeState('running'),
    attached: false,
    workdir: '/wt/one',
    managedWorkdir: true,
    copilotSessionName: null,
    sessionId: null,
    sessionFile: null,
    agentSessionId: null,
    ...overrides,
  };
}

function copilot(overrides) {
  return {
    name: 'captain',
    session: 'copilot_captain',
    agent: 'claude',
    mode: 'normal',
    status: 'running',
    attached: false,
    workdir: '/home/dev',
    sessionId: null,
    sessionFile: null,
    agentSessionId: null,
    ...overrides,
  };
}

const snapshot = {
  workers: [
    worker({}),
    worker({ number: 2, name: 'task-one', type: 'task', session: 'task_notes', repo: null, branch: null, workdir: '/notes', runtimeState: runtimeState('idle') }),
  ],
  copilots: [copilot({})],
  count: 3,
};

// ── 1. snapshot → grouped board ──

let model = createBoardModel(snapshot);
let view = selectBoard(model);

assert.equal(view.workerCount, 2, 'two workers');
assert.equal(view.copilotCount, 1, 'one copilot');
assert.deepEqual(
  view.groups.map((group) => group.kind),
  ['repo', 'tasks', 'copilots'],
  'grouped by repo, then Local Tasks, then Copilots',
);
assert.equal(view.groups[0].label, 'repo-a', 'repo group is labelled by basename');
assert.equal(view.groups[1].label, 'Local Tasks');
assert.equal(view.groups[2].label, 'Copilots');

const codeTile0 = view.groups[0].tiles[0];
assert.equal(codeTile0.runtime, 'running', 'runtime seeded from the snapshot');
assert.equal(codeTile0.lifecycle, 'running');
assert.equal(view.attentionTotal, 0, 'nothing needs attention yet');

// ── 2. THE PROOF: an event delta flips the tile with NO refetch ──

model = applyEvent(model, event('worker.runtime.changed', 'repo-a_feat-one', { state: 'needs-input', reason: 'awaiting approval' }));
view = selectBoard(model);
const afterDelta = view.groups[0].tiles[0];
assert.equal(afterDelta.runtime, 'needs-input', 'runtime.changed event drove the tile live');
assert.equal(afterDelta.runtimeReason, 'awaiting approval');
assert.equal(view.groups[0].attentionCount, 1, 'the group now flags attention');
assert.equal(view.attentionTotal, 1, 'board attention total updated from the stream');

// ── 3. lifecycle delta: a stopped worker shows no live runtime ──

model = applyEvent(model, event('worker.stopped', 'repo-a_feat-one', {}));
view = selectBoard(model);
const stopped = view.groups[0].tiles[0];
assert.equal(stopped.lifecycle, 'stopped', 'worker.stopped drove lifecycle');
assert.equal(stopped.runtime, 'unknown', 'a stopped worker never claims a live runtime');
assert.equal(view.attentionTotal, 0, 'stopped worker no longer flags attention');

// ── 4. membership events request a resync (they carry no full tile DTO) ──

assert.equal(isMembershipEvent('worker.created'), true);
assert.equal(isMembershipEvent('worker.runtime.changed'), false);
const beforeToken = model.resyncToken;
model = applyEvents(model, [
  event('worker.created', 'repo-b_feat-two', { repo: '/src/repo-b' }),
  event('copilot.created', 'copilot_new', {}),
]);
assert.equal(model.resyncToken, beforeToken + 2, 'each membership event bumps the resync token');
// The board itself does not invent the new tiles — it still shows the snapshot.
assert.equal(selectBoard(model).workerCount, 2, 'membership events do not fabricate tiles');

// ── 5. notification snapshot → per-session unread + totals ──

const notifSnapshot = {
  loadedAt: '2026-01-01T00:00:00.000Z',
  lastEventSeq: seq,
  totalCount: 2,
  unreadCount: 2,
  notifications: [
    { id: 'n1', createdAt: '2026-01-01T00:00:00.000Z', readAt: null, kind: 'needs-input', title: 't', body: 'b', targetSession: null, sourceSession: 'repo-a_feat-one' },
    { id: 'n2', createdAt: '2026-01-01T00:00:00.000Z', readAt: null, kind: 'info', title: 't', body: 'b', targetSession: 'task_notes', sourceSession: null },
    { id: 'n3', createdAt: '2026-01-01T00:00:00.000Z', readAt: '2026-01-01T00:01:00.000Z', kind: 'info', title: 't', body: 'b', targetSession: 'repo-a_feat-one', sourceSession: null },
  ],
};
model = applyNotificationSnapshot(model, notifSnapshot);
view = selectBoard(model);
assert.equal(view.unreadTotal, 2, 'unread total taken from the notification snapshot');
assert.equal(view.groups[0].tiles[0].unread, 1, 'unread counted per source session (read one ignored)');
assert.equal(view.groups[1].tiles[0].unread, 1, 'unread counted per target session');

// ── 6. resync folds the fresh snapshot and clears stale overlays ──

const resynced = {
  workers: [worker({ session: 'repo-a_feat-one', status: 'running', runtimeState: runtimeState('running') })],
  copilots: [],
  count: 1,
};
model = applySnapshot(model, resynced);
view = selectBoard(model);
assert.equal(view.workerCount, 1, 'resync replaced the base snapshot');
assert.equal(view.copilotCount, 0);
assert.equal(view.groups[0].tiles[0].lifecycle, 'running', 'stale lifecycle override dropped after resync');
assert.equal(view.groups[0].tiles[0].runtime, 'running', 'stale runtime override dropped after resync');
assert.equal(view.groups[0].tiles[0].unread, 1, 'surviving session keeps its unread count');

// ── 7. copilot [N workers · M repos] summary derived from the worker list ──

{
  const summarySnapshot = {
    workers: [
      worker({ session: 'w1', number: 1, repo: '/src/repo-a', copilotSessionName: 'copilot_captain' }),
      worker({ session: 'w2', number: 2, repo: '/src/repo-b', copilotSessionName: 'copilot_captain' }),
      worker({ session: 'w3', number: 3, type: 'task', repo: null, branch: null, workdir: '/n', copilotSessionName: 'copilot_captain' }),
      worker({ session: 'w4', number: 4, repo: '/src/repo-a', copilotSessionName: null }), // unmanaged: ignored
    ],
    copilots: [copilot({})],
    count: 5,
  };
  const summaryView = selectBoard(createBoardModel(summarySnapshot));
  const copilotTile = summaryView.groups.find((group) => group.kind === 'copilots').tiles[0];
  assert.equal(copilotTile.workerCount, 3, 'the copilot counts only its three managed workers');
  assert.equal(copilotTile.repoCount, 2, 'two distinct repos (the task worker contributes none)');
}

// ── 8. completed chip folds from the notification stream; clears on running ──

{
  const completeNotif = {
    loadedAt: '2026-01-01T00:00:00.000Z',
    lastEventSeq: seq,
    totalCount: 1,
    unreadCount: 1,
    notifications: [
      { id: 'done1', createdAt: '2026-01-01T00:05:00.000Z', readAt: null, kind: 'complete', title: 'done', body: '', targetSession: 'repo-a_feat-one', sourceSession: null },
    ],
  };
  let m = createBoardModel(snapshot);
  // Worker went idle (agent finished) before the complete notification lands.
  m = applyEvent(m, event('worker.runtime.changed', 'repo-a_feat-one', { state: 'idle' }));
  m = applyNotificationSnapshot(m, completeNotif);
  let v = selectBoard(m);
  assert.equal(v.groups[0].tiles[0].completed, true, 'an idle worker with a complete notification is completed');

  m = applyEvent(m, event('worker.runtime.changed', 'repo-a_feat-one', { state: 'running' }));
  v = selectBoard(m);
  assert.equal(v.groups[0].tiles[0].completed, false, 'the chip clears the moment the worker runs again');
}

{
  const copilotCompleteNotif = {
    loadedAt: '2026-01-01T00:00:00.000Z',
    lastEventSeq: seq,
    totalCount: 1,
    unreadCount: 1,
    notifications: [
      {
        id: 'done-copilot',
        createdAt: '2026-01-01T00:05:00.000Z',
        readAt: null,
        kind: 'complete',
        title: 'worker done',
        body: '',
        targetSession: 'copilot_captain',
        sourceSession: 'repo-a_feat-one',
        action: { type: 'open-session', session: 'repo-a_feat-one' },
      },
    ],
  };
  const m = applyNotificationSnapshot(createBoardModel(snapshot), copilotCompleteNotif);
  const v = selectBoard(m);
  const copilotTile = v.groups.find((group) => group.kind === 'copilots').tiles[0];
  assert.equal(copilotTile.completionNotifications.length, 1, 'copilot exposes completion child rows');
  assert.equal(copilotTile.completionNotifications[0].actionSession, 'repo-a_feat-one');
}

// ── 9. git-status counts fold into CODE-worker tiles only ──

{
  let m = createBoardModel(snapshot);
  m = applyGitStatus(m, { 'repo-a_feat-one': { changed: 3 }, task_notes: { changed: 9 } });
  const v = selectBoard(m);
  assert.equal(v.groups[0].tiles[0].changed, 3, 'the code worker shows its changed-file count');
  assert.equal(v.groups[1].tiles[0].changed, null, 'a task worker never surfaces U:N, even if a count leaks in');
}

// ── misc invariants ──

assert.equal(deriveLifecycle('stopped'), 'stopped');
assert.equal(deriveLifecycle('running'), 'running');
assert.equal(deriveLifecycle('whatever'), 'running', 'only "stopped" is stopped');

console.log('mission-control board smoke: PASS');
