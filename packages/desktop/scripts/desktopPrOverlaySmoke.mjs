// Real data-path proof for the Desktop v2 PR overlay. Bundles the exact renderer
// reducer + selectors React uses, feeds the GitStatusMap the sidecar emits
// (changed + prNumber/prState/prUrl), and asserts the PR fields reach both the
// control row and the Worker context drawer — and never leak onto task workers.
//
// Run: node packages/desktop/scripts/desktopPrOverlaySmoke.mjs

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.join(here, '..', 'src', 'renderer');
const bundled = await build({
  stdin: {
    contents: `export * from './controlState/index.ts';`,
    resolveDir: renderer,
    sourcefile: 'desktop-pr-overlay-smoke-entry.ts',
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
  applyGitStatus,
  selectDesktopControlView,
  selectWorkerContext,
} = control;

function v1Runtime(state) {
  return { state, updatedAt: '2026-08-29T01:00:00.000Z', origin: 'session-manager', reason: 'seed' };
}

function worker(overrides = {}) {
  return {
    number: 1,
    name: 'worker-one',
    type: 'code',
    session: 'repo-a_feat-one',
    repo: '/src/repo-a',
    branch: 'feat/nexus-app-cert-plane',
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
    observedAt: '2026-08-29T01:00:00.000Z',
    agent: 'codex',
    workdir: workerId === 1 ? '/wt/one' : '/notes',
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
  copilots: [],
  count: 2,
};

const runtimeList = {
  version: 2,
  loadedAt: '2026-08-29T01:00:01.000Z',
  lastEventSeq: 5,
  runtimes: [runtime(1), runtime(2)],
  count: 2,
};

let model = createDesktopControlModel(sessions, runtimeList);
model = applyConnectionState(model, { sessionsConnected: true });

// Before any overlay: no PR data, changed unknown.
let row = selectDesktopControlView(model).workers[0];
assert.equal(row.prNumber, null, 'no PR before the overlay arrives');
assert.equal(row.prState, null);
assert.equal(row.prUrl, null);
assert.equal(row.changed, null);

// Exactly the map shape collectCodeWorkerGitStatus produced against live `gh`.
model = applyGitStatus(model, {
  'repo-a_feat-one': {
    changed: 8,
    prNumber: 335,
    prState: 'merged',
    prUrl: 'https://github.com/sudoprivacy/hydra/pull/335',
  },
  // A PR keyed to a TASK worker's session must be ignored (code-only overlay).
  task_notes: {
    changed: 3,
    prNumber: 999,
    prState: 'open',
    prUrl: 'https://example.com/pr/999',
  },
});

// Control row (feeds the sidebar + selection) carries the PR trio.
row = selectDesktopControlView(model).workers[0];
assert.equal(row.changed, 8, 'change count still surfaces');
assert.equal(row.prNumber, 335, 'PR number reaches the control row');
assert.equal(row.prState, 'merged', 'PR state reaches the control row');
assert.equal(row.prUrl, 'https://github.com/sudoprivacy/hydra/pull/335', 'PR url reaches the control row');

// Task worker never gets a PR overlay even when a status map tries to set one.
const taskRow = selectDesktopControlView(model).workers[1];
assert.equal(taskRow.prNumber, null, 'task workers are never PR-annotated');
assert.equal(taskRow.prState, null);
assert.equal(taskRow.prUrl, null);
assert.equal(taskRow.changed, null, 'task workers get no change overlay');

// Worker context drawer (where Branch + the new Pull Request fact/Open PR action render).
const ctx = selectWorkerContext(model, 1);
assert.equal(ctx.worker.branch, 'feat/nexus-app-cert-plane', 'branch still reaches the drawer');
assert.equal(ctx.worker.prNumber, 335, 'PR number reaches the drawer');
assert.equal(ctx.worker.prState, 'merged');
assert.equal(ctx.worker.prUrl, 'https://github.com/sudoprivacy/hydra/pull/335');

// A later overlay with no PR clears the fields (drops back to change-count only).
model = applyGitStatus(model, { 'repo-a_feat-one': { changed: 2 } });
row = selectDesktopControlView(model).workers[0];
assert.equal(row.changed, 2);
assert.equal(row.prNumber, null, 'PR clears when a later overlay omits it');
assert.equal(row.prState, null);
assert.equal(row.prUrl, null);

console.log('desktopPrOverlaySmoke: ok — PR overlay reaches the row and the drawer, code-only');
