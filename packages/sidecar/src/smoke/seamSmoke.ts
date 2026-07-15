/**
 * Smoke test: the in-process seam, end to end.
 *
 *   HydraControlClient → InProcessTransport → HydraAppService → @hydra/core
 *
 * over a HYDRA_HOME-isolated engine and a tmux-free fake backend (like the
 * existing engine smokes). Proves the seam by round-tripping listSessions(), a
 * create+delete task-worker mutation, and getDiff (+ the path-constrained
 * getFileSnapshot and the subscribeEvents stream).
 *
 * Run: node packages/sidecar/out/smoke/seamSmoke.js
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createHydraControlClient, transportFactory } from '@hydra/protocol';
import type { HydraControlClient, HydraEvent } from '@hydra/protocol';
import { FakeBackend } from './fakeBackend';

function runGit(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Build a git repo with a `main` base and a `feature` branch that has changes. */
function buildGitRepo(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: root, stdio: 'ignore' });
  runGit(['config', 'user.email', 'seam@hydra.test'], root);
  runGit(['config', 'user.name', 'Seam Smoke'], root);
  runGit(['config', 'commit.gpgsign', 'false'], root);

  fs.writeFileSync(path.join(root, 'a.txt'), 'base');
  runGit(['add', '.'], root);
  runGit(['commit', '-q', '-m', 'base'], root);

  runGit(['checkout', '-q', '-b', 'feature'], root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'changed');
  fs.writeFileSync(path.join(root, 'b.txt'), 'new file'); // untracked
}

async function collectEvents(
  client: HydraControlClient,
  predicate: (event: HydraEvent) => boolean,
  limit = 200,
): Promise<HydraEvent[]> {
  const collected: HydraEvent[] = [];
  let seen = 0;
  for await (const event of client.subscribeEvents({ after: 0 })) {
    collected.push(event);
    if (predicate(event) || ++seen >= limit) {
      break; // breaking returns the generator and clears its poll timer
    }
  }
  return collected;
}

async function main(): Promise<void> {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-seam-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.HYDRA_HOME = path.join(tempHome, '.hydra');
  process.env.HYDRA_TELEMETRY = '0';
  delete process.env.HYDRA_CONFIG_PATH;

  try {
    // ── Build the seam: engine-free client over the in-process transport ──
    const backend = new FakeBackend();
    const { SessionManager } = await import('@hydra/core/sessionManager');
    const { HydraAppService } = await import('../appService');
    const sessionManager = new SessionManager(backend);
    const appService = new HydraAppService({ backend, sessionManager });
    const transport = transportFactory({ kind: 'in-process', appService });
    const client = createHydraControlClient(transport);

    // ── listSessions(): empty to start ──
    const empty = await client.listSessions();
    assert.deepEqual(empty.copilots, [], 'no copilots initially');
    assert.deepEqual(empty.workers, [], 'no workers initially');
    assert.equal(empty.count, 0, 'count is 0 initially');

    // Creation returns once the durable session exists. Readiness, onboarding,
    // and the optional first task continue in the background in that order.
    const copilot = await client.createCopilot({
      agent: 'claude',
      name: 'seam-copilot',
      task: 'start with this task',
    });
    assert.equal(copilot.status, 'created', 'copilot created');
    assert.equal(copilot.workdir, tempHome, 'desktop seam defaults copilot workdir to HOME');
    assert.equal(
      backend.messages.filter(message => message.sessionName === copilot.session).length,
      0,
      'create response is not blocked by agent readiness or prompt delivery',
    );
    await waitFor(
      () => backend.messages.filter(message => message.sessionName === copilot.session).length === 2,
      'copilot background initialization',
    );
    const copilotMessages = backend.messages
      .filter(message => message.sessionName === copilot.session)
      .map(message => message.message);
    assert.match(copilotMessages[0], /You are a Hydra copilot/);
    assert.equal(copilotMessages[1], 'start with this task');
    const parentedWorker = await client.createWorker({
      temp: true,
      name: 'parented-worker',
      agent: 'claude',
      copilot: copilot.session,
      task: 'report to the selected parent',
    });
    const parentedEntry = (await client.listSessions()).workers.find(worker => worker.session === parentedWorker.session);
    assert.equal(parentedEntry?.copilotSessionName, copilot.session, 'desktop-selected parent is persisted on the worker');
    await client.deleteSession(parentedWorker.session, 'worker', { deleteFiles: true });
    await client.deleteSession(copilot.session, 'copilot');

    // ── Desktop-only global Inbox: no extension and no parent copilot ──
    const completeWorkerResult = await client.createWorker({ temp: true, name: 'global-complete', agent: 'claude', task: 'complete this task' });
    const inputWorkerResult = await client.createWorker({ temp: true, name: 'global-input', agent: 'claude', task: 'ask for input' });
    const errorWorkerResult = await client.createWorker({ temp: true, name: 'global-error', agent: 'claude', task: 'fail this task' });
    const attentionWorkers = await Promise.all([
      sessionManager.getWorker(completeWorkerResult.session),
      sessionManager.getWorker(inputWorkerResult.session),
      sessionManager.getWorker(errorWorkerResult.session),
    ]);
    assert.ok(attentionWorkers.every(Boolean), 'sidecar lifecycle persisted all attention workers');
    const [completeWorker, inputWorker, errorWorker] = attentionWorkers;
    assert.ok(completeWorker && inputWorker && errorWorker);

    const { CompletionCoordinator } = await import('@hydra/core/completionCoordinator');
    const { CompletionJobStore } = await import('@hydra/core/completionJobStore');
    const { EventLog } = await import('@hydra/core/events');
    const { NotificationStore } = await import('@hydra/core/notifications');
    const { getWorkerLifecycleEpoch } = await import('@hydra/core/workerIdentity');
    const { WorkerRuntimeCoordinator } = await import('@hydra/core/workerRuntimeCoordinator');
    const { WorkerRuntimeStateStore } = await import('@hydra/core/workerRuntimeState');
    const { WorkerRuntimeStateStoreV2 } = await import('@hydra/core/workerRuntimeV2');
    const { AgentHookEventCoordinator } = await import('@hydra/core/agentHookEventCoordinator');
    const byId = new Map(attentionWorkers.map(worker => [worker!.workerId, worker!]));
    const eventLog = new EventLog();
    const runtimeStore = new WorkerRuntimeStateStoreV2();
    const compatibilityStore = new WorkerRuntimeStateStore();
    const notificationStore = new NotificationStore(
      undefined, undefined, eventLog, compatibilityStore, Date.now, undefined, runtimeStore,
    );
    const runtimeCoordinator = new WorkerRuntimeCoordinator(
      workerId => {
        const worker = byId.get(workerId);
        return worker ? {
          workerId,
          sessionName: worker.sessionName,
          lifecycleEpoch: getWorkerLifecycleEpoch(worker),
          agent: worker.agent,
          workdir: worker.workdir,
        } : undefined;
      },
      runtimeStore,
      compatibilityStore,
      eventLog,
    );
    const completion = new CompletionCoordinator({
      resolveWorker: workerId => {
        const worker = byId.get(workerId);
        return worker ? { worker, lifecycleEpoch: getWorkerLifecycleEpoch(worker) } : undefined;
      },
      jobStore: new CompletionJobStore(),
      runtimeStore,
      runtimeCoordinator,
      notificationStore,
      eventSource: 'session-manager',
    });
    const completed = await completion.complete({
      workerId: completeWorker.workerId,
      lifecycleEpoch: getWorkerLifecycleEpoch(completeWorker),
      origin: 'hook',
    });
    assert.equal(completed.outcome, 'completed', 'sidecar lifecycle completion reaches the global inbox');

    const hookCoordinator = new AgentHookEventCoordinator({
      resolveWorker: workerId => byId.get(workerId),
      runtimeStore,
      compatibilityStore,
      notificationStore,
      completionJobStore: new CompletionJobStore(),
      eventLog,
      runtimeCoordinator,
      eventSource: 'session-manager',
    });
    const needsInput = hookCoordinator.process({
      workerId: inputWorker.workerId,
      lifecycleEpoch: getWorkerLifecycleEpoch(inputWorker),
      agent: 'claude',
      eventName: 'PermissionRequest',
      payload: { tool_name: 'Bash', tool_use_id: 'sidecar-input', tool_input: { command: 'npm test' } },
    });
    assert.equal(needsInput.status, 'applied');
    const runtimeError = hookCoordinator.process({
      workerId: errorWorker.workerId,
      lifecycleEpoch: getWorkerLifecycleEpoch(errorWorker),
      agent: 'claude',
      eventName: 'StopFailure',
      payload: { error: 'server_error', error_details: 'service unavailable' },
    });
    assert.equal(runtimeError.status, 'applied');

    const globalInbox = await client.listNotifications();
    const globalAttention = globalInbox.notifications.filter(notification =>
      [completeWorker.sessionName, inputWorker.sessionName, errorWorker.sessionName].includes(notification.sourceSession ?? ''),
    );
    assert.deepEqual(
      globalAttention.map(notification => notification.kind).sort(),
      ['complete', 'error', 'needs-input'],
      'desktop-only operation produces all three attention kinds',
    );
    assert.ok(globalAttention.every(notification => notification.targetSession === null), 'all three use global fallback');
    for (const worker of attentionWorkers) {
      await client.deleteSession(worker!.sessionName, 'worker', { deleteFiles: true });
    }

    // ── Mutation: create + delete a task worker ──
    const created = await client.createWorker({ temp: true, name: 'seam-temp', agent: 'claude' });
    assert.equal(created.status, 'created', 'worker created');
    assert.equal(created.type, 'task', 'temp worker is a task worker');
    assert.equal(created.managedWorkdir, true, 'temp worker workdir is managed');
    const tempSession = created.session;

    const afterCreate = await client.listSessions();
    assert.equal(afterCreate.count, 1, 'one session after create');
    const workerEntry = afterCreate.workers[0];
    assert.equal(workerEntry.session, tempSession, 'listed worker matches created session');
    assert.equal(workerEntry.type, 'task');
    assert.equal(typeof workerEntry.number, 'number', 'worker has a numeric id');
    assert.equal(workerEntry.runtimeState.state, 'running', 'just-launched worker projects running');
    assert.equal(workerEntry.agentSessionId, workerEntry.sessionId, 'agentSessionId mirrors sessionId');
    const runtimeV2 = await client.listWorkerRuntimeV2();
    const runtimeV2Entry = runtimeV2.runtimes.find(runtime => runtime.workerId === workerEntry.number);
    assert.equal(runtimeV2.version, 2, 'Desktop runtime snapshot uses the v2 contract');
    assert.equal(runtimeV2Entry?.sessionName, tempSession, 'runtime v2 snapshot shares durable worker identity');
    assert.equal(runtimeV2Entry?.state, 'running', 'runtime v2 snapshot carries the authoritative state');
    assert.ok(Number.isSafeInteger(runtimeV2.lastEventSeq), 'runtime v2 snapshot carries an event cursor');

    const deleted = await client.deleteSession(tempSession, 'worker');
    assert.equal(deleted.status, 'deleted', 'worker deleted');
    assert.equal(deleted.session, tempSession);

    const afterDelete = await client.listSessions();
    assert.equal(afterDelete.count, 0, 'no sessions after delete');

    // ── getDiff + getFileSnapshot over a real git worktree ──
    const repoRoot = path.join(tempHome, 'repo');
    buildGitRepo(repoRoot);
    const diffWorker = await client.createWorker({ dir: repoRoot, name: 'repo', agent: 'claude' });
    const diffSession = diffWorker.session;
    const diffWorkerId = (await client.listSessions()).workers.find(worker => worker.session === diffSession)?.number;
    assert.equal(typeof diffWorkerId, 'number', 'diff worker has a stable worker id');

    const diff = await client.getDiff(diffSession);
    assert.equal(diff.session, diffSession, 'diff carries the session');
    assert.equal(diff.baseRef, 'main', 'base ref resolves to main');
    assert.equal(diff.branch, 'feature', 'current branch is feature');
    const diffPaths = diff.changes.map(c => c.path).sort();
    assert.deepEqual(
      diffPaths,
      ['.claude/settings.json', 'a.txt', 'b.txt'],
      'diff transparently includes the installed completion hook plus user changes',
    );
    assert.equal(diff.count, diff.changes.length, 'count equals changes length');

    const current = await client.getFileSnapshot({ session: diffSession, path: 'a.txt', side: 'current' });
    assert.equal(current.content, 'changed', 'current snapshot returns working-tree content');
    assert.equal(current.exists, true);

    const base = await client.getFileSnapshot({ session: diffSession, path: 'a.txt', side: 'base' });
    assert.equal(base.content, 'base', 'base snapshot returns the base-ref content');
    assert.ok(base.ref, 'base snapshot names the ref it read');

    // Path constraint: `..` escape MUST be rejected before any fs/git access.
    await assert.rejects(
      () => client.getFileSnapshot({ session: diffSession, path: '../escape.txt', side: 'current' }),
      /escapes the session workdir/,
      'getFileSnapshot rejects ../ traversal',
    );
    await assert.rejects(
      () => client.getFileSnapshot({ session: diffSession, path: '/etc/hosts', side: 'current' }),
      /must be relative/,
      'getFileSnapshot rejects absolute paths',
    );

    // ── getLogs + sendMessage + broadcast over the running worker ──
    const logs = await client.getLogs(diffSession, 'worker', 5);
    assert.equal(logs.session, diffSession);
    assert.equal(logs.lines, 5);
    assert.ok(logs.output.includes(diffSession), 'logs capture pane output');

    const sent = await client.sendMessage(diffSession, 'worker', 'hello worker');
    assert.equal(sent.status, 'sent');
    assert.ok(backend.messages.some(m => m.message === 'hello worker'), 'message reached the backend');

    const broadcast = await client.broadcastToWorkers('to everyone');
    assert.equal(broadcast.status, 'sent');
    assert.deepEqual(broadcast.sessions, [diffSession], 'broadcast hits the running worker');

    // ── Notifications round-trip: seed via core, drive via the client ──
    const seededNotification = new NotificationStore().create({
      kind: 'needs-input',
      title: 'Needs input',
      sourceSession: diffSession,
      targetSession: diffSession,
      context: { workerId: diffWorkerId },
    });
    const listed = await client.listNotifications({ session: diffSession });
    assert.equal(listed.count, 1, 'client lists the seeded notification');
    const notificationId = listed.notifications[0].id;
    const occurrences = await client.listNotificationOccurrencesV2({
      workerId: diffWorkerId,
      status: 'active',
    });
    assert.deepEqual(
      occurrences.occurrences.map(occurrence => occurrence.id),
      [seededNotification.notification.id],
      'in-process seam exposes the matching v2 occurrence',
    );
    const occurrenceIterable = client.subscribeNotificationOccurrencesV2({ workerId: diffWorkerId });
    const occurrenceStream = occurrenceIterable[Symbol.asyncIterator]();
    const initialOccurrences = await occurrenceStream.next();
    assert.equal(initialOccurrences.done, false, 'v2 occurrence stream yields an initial snapshot');
    assert.equal(initialOccurrences.value?.totalCount, 1);
    await occurrenceStream.return?.();
    const read = await client.markNotificationRead(notificationId);
    assert.equal(read.markedRead, 1, 'markNotificationRead flips unread → read');
    const dismissed = await client.dismissNotification(notificationId);
    assert.equal(dismissed.changed, true, 'dismissNotification removes one occurrence from the active inbox');
    assert.equal(dismissed.status, 'dismissed');
    new NotificationStore().create({
      kind: 'complete',
      title: 'Complete',
      sourceSession: diffSession,
      targetSession: null,
      context: { workerId: diffWorkerId },
    });
    const cleared = await client.clearNotifications({ session: diffSession });
    assert.equal(cleared.cleared, 1, 'clearNotifications dismisses the remaining active occurrence');

    // ── subscribeEvents stream: the create mutation left a worker.created ──
    const events = await collectEvents(
      client,
      e => e.type === 'worker.created' && e.session === tempSession,
    );
    assert.ok(
      events.some(e => e.type === 'worker.created' && e.session === tempSession),
      'subscribeEvents streams the worker.created event for the created worker',
    );

    // ── git status: the porcelain change count backing the sidebar `U:N` ──
    const { countChangedFiles } = await import('../gitStatus');
    assert.equal(
      await countChangedFiles(repoRoot),
      3,
      'countChangedFiles counts the hook config plus modified and untracked user files',
    );
    // The verb reports CODE workers only — the directory (task) worker is skipped.
    const gitStatuses = await client.listGitStatus();
    assert.ok(
      !(diffSession in gitStatuses),
      'listGitStatus skips task/directory workers (code workers only)',
    );

    // ── openTerminal: shape wired, bridge deferred to M3 ──
    assert.throws(
      () => client.attachTerminal({ session: diffSession, mode: 'interactive' }),
      /milestone M3/,
      'attachTerminal is shaped now, implemented in M3',
    );

    await client.deleteSession(diffSession, 'worker');

    console.log('seamSmoke: ok');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
