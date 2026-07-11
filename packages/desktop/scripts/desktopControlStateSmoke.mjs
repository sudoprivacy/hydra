// Headless proof for the Desktop v2 renderer control state. The smoke bundles
// the exact pure reducer/selectors used by React and compares the temporary
// legacy adapter with the previous Mission Control selector during migration.
//
// Run: node packages/desktop/scripts/desktopControlStateSmoke.mjs

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.join(here, '..', 'src', 'renderer');
const bundled = await build({
  stdin: {
    contents: `
      export * from './controlState/index.ts';
      export {
        createBoardModel as createLegacyBoardModel,
        applyNotificationSnapshot as applyLegacyNotificationSnapshot,
        selectBoard as selectLegacyBoard,
      } from './missionControl/boardModel.ts';
    `,
    resolveDir: renderer,
    sourcefile: 'desktop-control-state-smoke-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  external: ['@hydra/protocol', '@hydra/core', '@hydra/core/*'],
  logLevel: 'silent',
});

const code = bundled.outputFiles[0].text;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const control = await import(moduleUrl);

const {
  createDesktopControlModel,
  applyConnectionState,
  applyControlEvent,
  applyGitStatus,
  applyNotificationOccurrenceSnapshot,
  applyRuntimeSnapshot,
  applySessionsSnapshot,
  selectCopilotContext,
  selectDesktopControlView,
  selectLegacyBoardView,
  selectSessionHeader,
  selectWorkerContext,
  createLegacyBoardModel,
  applyLegacyNotificationSnapshot,
  selectLegacyBoard,
} = control;

function runtime(workerId, overrides = {}) {
  return {
    version: 2,
    workerId,
    sessionName: workerId === 1 ? 'repo-a_feat-one' : 'task_notes',
    lifecycleEpoch: `epoch-${workerId}`,
    runId: workerId === 1 ? 'run-one' : null,
    revision: workerId === 1 ? 1 : 0,
    state: workerId === 1 ? 'running' : 'idle',
    signalId: `signal-${workerId}`,
    origin: 'lifecycle',
    reason: 'seed',
    observedAt: '2026-07-11T01:00:00.000Z',
    agent: 'codex',
    workdir: workerId === 1 ? '/wt/one' : '/notes',
    ...overrides,
  };
}

function v1Runtime(state) {
  return {
    state,
    updatedAt: '2026-07-11T01:00:00.000Z',
    origin: 'session-manager',
    reason: 'legacy seed',
  };
}

function worker(overrides = {}) {
  return {
    number: 1,
    name: 'worker-one',
    type: 'code',
    session: 'repo-a_feat-one',
    repo: '/src/repo-a',
    branch: 'feat/one',
    agent: 'codex',
    status: 'running',
    runtimeState: v1Runtime('running'),
    attached: false,
    workdir: '/wt/one',
    managedWorkdir: true,
    copilotSessionName: 'copilot_captain',
    sessionId: null,
    sessionFile: null,
    agentSessionId: null,
    ...overrides,
  };
}

function copilot(overrides = {}) {
  return {
    name: 'captain',
    session: 'copilot_captain',
    agent: 'codex',
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

const sessions = {
  workers: [
    worker(),
    worker({
      number: 2,
      name: 'task-one',
      type: 'task',
      session: 'task_notes',
      repo: null,
      branch: null,
      workdir: '/notes',
      runtimeState: v1Runtime('idle'),
    }),
  ],
  copilots: [copilot()],
  count: 3,
};

const runtimeList = {
  version: 2,
  loadedAt: '2026-07-11T01:00:01.000Z',
  lastEventSeq: 10,
  runtimes: [runtime(1), runtime(2)],
  count: 2,
};

function event(seq, type, session, payload = {}) {
  return {
    version: 1,
    seq,
    bootId: 'boot',
    ts: new Date(Date.parse('2026-07-11T01:00:00.000Z') + seq * 1000).toISOString(),
    type,
    source: 'session-manager',
    session,
    role: type.startsWith('copilot.') ? 'copilot' : 'worker',
    agent: 'codex',
    workdir: '/wt/one',
    payload,
  };
}

function runtimePayload(overrides = {}) {
  return {
    workerId: 1,
    state: 'needs-input',
    origin: 'hook',
    reason: 'awaiting approval',
    lifecycleEpoch: 'epoch-1',
    runId: 'run-one',
    revision: 2,
    signalId: 'signal-live',
    occurrenceId: 'occ-live',
    sourceSequence: 11,
    observedAt: '2026-07-11T01:00:11.000Z',
    ...overrides,
  };
}

function occurrence(id, workerId, kind, overrides = {}) {
  return {
    version: 2,
    id,
    occurrenceId: `occ-${id}`,
    workerId,
    lifecycleEpoch: `epoch-${workerId}`,
    runId: workerId === 1 ? 'run-one' : 'run-two',
    signalId: `sig-${id}`,
    kind,
    status: 'active',
    title: `${kind} title`,
    body: `${kind} body`,
    createdAt: '2026-07-11T02:00:00.000Z',
    readAt: null,
    resolvedAt: null,
    dismissedAt: null,
    sourceSession: workerId === 1 ? 'repo-a_feat-one' : 'task_notes',
    targetSession: 'copilot_captain',
    action: { type: 'open-session', session: workerId === 1 ? 'repo-a_feat-one' : 'task_notes' },
    ...overrides,
  };
}

// ── 1. Initial state is keyed by workerId and ignores the v1 runtime field. ──

let model = createDesktopControlModel(sessions, runtimeList);
model = applyConnectionState(model, { sessionsConnected: true });
let view = selectDesktopControlView(model);
assert.equal(view.workers.length, 2);
assert.equal(view.copilots.length, 1);
assert.deepEqual(view.workerGroups.map(group => group.kind), ['repository', 'local-tasks']);
assert.equal(view.workerGroups[0].label, 'repo-a');
assert.equal(view.copilots[0].workerCount, 2);
assert.equal(view.copilots[0].repoCount, 1);
assert.equal(view.workers[0].runtimeState, 'running');

const divergentSessions = {
  ...sessions,
  workers: [worker({ runtimeState: v1Runtime('error') }), sessions.workers[1]],
};
const divergent = createDesktopControlModel(divergentSessions, runtimeList);
assert.equal(
  selectDesktopControlView(divergent).workers[0].runtimeState,
  'running',
  'renderer runtime comes from v2, never the legacy listSessions projection',
);

// ── 2. A complete v2 event applies live; stale revisions/runs are ignored. ──

let result = applyControlEvent(
  model,
  event(11, 'worker.runtime.changed', 'repo-a_feat-one', runtimePayload()),
);
assert.equal(result.runtimeRefreshRequired, false);
model = result.model;
assert.equal(selectDesktopControlView(model).workers[0].runtimeState, 'needs-input');

result = applyControlEvent(
  model,
  event(12, 'worker.runtime.changed', 'repo-a_feat-one', runtimePayload({ revision: 1, signalId: 'stale-rev' })),
);
assert.equal(selectDesktopControlView(result.model).workers[0].runtimeState, 'needs-input');
assert.equal(result.runtimeRefreshRequired, false, 'stale revision is ignored without a refresh storm');
model = result.model;

result = applyControlEvent(
  model,
  event(13, 'worker.runtime.changed', 'repo-a_feat-one', runtimePayload({ revision: 3, runId: 'old-run', signalId: 'stale-run' })),
);
assert.equal(selectDesktopControlView(result.model).workers[0].runtimeState, 'needs-input');
assert.equal(result.runtimeRefreshRequired, false, 'stale run is ignored');
model = result.model;

result = applyControlEvent(
  model,
  event(14, 'worker.runtime.changed', 'repo-a_feat-one', runtimePayload({ revision: 3, state: 'unknown' })),
);
assert.equal(result.runtimeRefreshRequired, true, 'illegal runtime transition fails closed');
assert.equal(selectDesktopControlView(result.model).workers[0].runtimeState, 'needs-input');
model = result.model;

result = applyControlEvent(
  model,
  event(15, 'worker.runtime.changed', 'repo-a_feat-one', runtimePayload({ revision: 3, lifecycleEpoch: 'new-epoch' })),
);
assert.equal(result.runtimeRefreshRequired, true, 'epoch mismatch requests an authoritative refresh');
assert.equal(selectDesktopControlView(result.model).workers[0].runtimeState, 'needs-input');
model = result.model;

result = applyControlEvent(
  model,
  event(16, 'worker.runtime.changed', 'repo-a_feat-one', { workerId: 1, state: 'error' }),
);
assert.equal(result.runtimeRefreshRequired, true, 'malformed v2 runtime event fails closed');
model = result.model;

// ── 3. Snapshot/event race: an older cursor cannot roll back a live event. ──

model = applyRuntimeSnapshot(model, {
  ...runtimeList,
  lastEventSeq: 10,
  runtimes: [runtime(1, { revision: 1, state: 'running' }), runtime(2)],
});
assert.equal(selectDesktopControlView(model).workers[0].runtimeState, 'needs-input');

model = applyRuntimeSnapshot(model, {
  ...runtimeList,
  lastEventSeq: 20,
  runtimes: [runtime(1, { revision: 4, state: 'idle', observedAt: '2026-07-11T01:00:20.000Z' }), runtime(2)],
});
assert.equal(selectDesktopControlView(model).workers[0].runtimeState, 'idle');
assert.equal(model.lastEventSeq, 16, 'runtime refresh cursor does not advance the applied event cursor');
model = applyRuntimeSnapshot(model, {
  ...runtimeList,
  lastEventSeq: 20,
  runtimes: [runtime(1, { revision: 1, state: 'running' }), runtime(2)],
});
assert.equal(
  selectDesktopControlView(model).workers[0].runtimeState,
  'idle',
  'same-cursor out-of-order response cannot roll back a higher revision',
);

result = applyControlEvent(model, event(21, 'worker.created', 'repo-b_new', {}));
assert.equal(result.sessionRefreshRequired, true, 'membership event requests a sessions/runtime resync');
model = result.model;

// ── 4. Active occurrence snapshots replace authoritatively and prioritize. ──

const needsInput = occurrence('needs', 1, 'needs-input', { createdAt: '2026-07-11T02:02:00.000Z' });
const error = occurrence('error', 2, 'error', { createdAt: '2026-07-11T02:01:00.000Z' });
const complete = occurrence('complete', 1, 'complete', { createdAt: '2026-07-11T02:03:00.000Z' });
model = applyNotificationOccurrenceSnapshot(model, {
  version: 2,
  loadedAt: '2026-07-11T02:04:00.000Z',
  lastEventSeq: 22,
  occurrences: [complete, needsInput, error],
  count: 3,
  totalCount: 3,
  activeCount: 3,
  unreadCount: 3,
});
assert.equal(
  model.lastEventSeq,
  21,
  'notification snapshot cursor does not skip still-buffered runtime/session events',
);
result = applyControlEvent(model, event(22, 'worker.stopped', 'repo-a_feat-one', {}));
assert.equal(result.sessionRefreshRequired, true, 'event at the notification cursor is still applied');
model = result.model;
view = selectDesktopControlView(model);
assert.deepEqual(view.attention.map(row => row.occurrence.kind), ['error', 'needs-input', 'complete']);
assert.equal(view.unreadTotal, 3);
assert.equal(view.workers[0].unreadCount, 2, 'worker counts join by stable workerId');
assert.equal(view.copilots[0].activeAttentionCount, 3, 'copilot aggregates its managed Workers');
assert.deepEqual(
  selectCopilotContext(model, 'copilot_captain').workers.map(row => row.workerId),
  [2, 1],
  'copilot context sorts Workers by attention priority',
);
assert.equal(selectWorkerContext(model, 1).occurrences.length, 2);
assert.equal(selectSessionHeader(model, 'repo-a_feat-one').activeAttentionCount, 2);

const newerEmpty = {
  version: 2,
  loadedAt: '2026-07-11T02:05:00.000Z',
  lastEventSeq: 23,
  occurrences: [],
  count: 0,
  totalCount: 0,
  activeCount: 0,
  unreadCount: 0,
};
model = applyNotificationOccurrenceSnapshot(model, newerEmpty);
assert.equal(selectDesktopControlView(model).attention.length, 0, 'new snapshot removes stale occurrences');
model = applyNotificationOccurrenceSnapshot(model, {
  ...newerEmpty,
  lastEventSeq: 22,
  occurrences: [error],
  count: 1,
  totalCount: 1,
  activeCount: 1,
  unreadCount: 1,
});
assert.equal(selectDesktopControlView(model).attention.length, 0, 'older occurrence snapshot cannot roll back state');

// ── 5. Git overlay and rename keep stable runtime identity. ──

model = applyGitStatus(model, {
  repo_a: { changed: 99 },
  'repo-a_feat-one': { changed: 3 },
  task_notes: { changed: 9 },
});
assert.equal(selectDesktopControlView(model).workers[0].changed, 3);
assert.equal(selectDesktopControlView(model).workers[1].changed, null);

const renamedSessions = {
  ...sessions,
  workers: [worker({ session: 'repo-a_feat-renamed', name: 'renamed-worker' }), sessions.workers[1]],
};
model = applySessionsSnapshot(model, renamedSessions);
const renamedWorker = selectDesktopControlView(model).workers[0];
assert.equal(renamedWorker.workerId, 1);
assert.equal(renamedWorker.session, 'repo-a_feat-renamed');
assert.equal(renamedWorker.runtimeState, 'idle', 'runtime survives route rename through workerId join');

// ── 6. Temporary adapter matches the old board for equivalent v1/v2 state. ──

const comparisonModel = createDesktopControlModel(sessions, runtimeList);
const oldBase = selectLegacyBoard(createLegacyBoardModel(sessions));
const newBase = selectLegacyBoardView(comparisonModel);
assert.deepEqual(
  newBase.groups.map(group => ({ kind: group.kind, label: group.label })),
  oldBase.groups.map(group => ({ kind: group.kind, label: group.label })),
);
assert.equal(newBase.workerCount, oldBase.workerCount);
assert.equal(newBase.copilotCount, oldBase.copilotCount);
assert.equal(newBase.groups[0].tiles[0].runtime, oldBase.groups[0].tiles[0].runtime);
assert.equal(
  newBase.groups.find(group => group.kind === 'copilots').tiles[0].workerCount,
  oldBase.groups.find(group => group.kind === 'copilots').tiles[0].workerCount,
);

const legacyNotification = {
  loadedAt: '2026-07-11T02:02:00.000Z',
  lastEventSeq: 11,
  totalCount: 1,
  unreadCount: 1,
  notifications: [{
    id: needsInput.id,
    createdAt: needsInput.createdAt,
    readAt: null,
    kind: needsInput.kind,
    title: needsInput.title,
    body: needsInput.body,
    targetSession: needsInput.targetSession,
    sourceSession: needsInput.sourceSession,
    action: needsInput.action,
  }],
};
const oldWithAttention = selectLegacyBoard(
  applyLegacyNotificationSnapshot(createLegacyBoardModel(sessions), legacyNotification),
);
const newWithAttention = selectLegacyBoardView(
  applyNotificationOccurrenceSnapshot(comparisonModel, {
    version: 2,
    loadedAt: legacyNotification.loadedAt,
    lastEventSeq: legacyNotification.lastEventSeq,
    occurrences: [needsInput],
    count: 1,
    totalCount: 1,
    activeCount: 1,
    unreadCount: 1,
  }),
);
assert.equal(newWithAttention.unreadTotal, oldWithAttention.unreadTotal);
assert.deepEqual(newWithAttention.inbox.map(item => item.kind), oldWithAttention.inbox.map(item => item.kind));

console.log('desktopControlStateSmoke: ok');
