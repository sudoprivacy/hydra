import assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  AgentRuntimeRegistry,
  type AgentRuntimeEvent,
  type ScodeConnector,
} from '../core/agentRuntime';
import type {
  InitializeResponse,
  PromptResponse,
  RequestPermissionRequest,
  ScodeAcpConfig,
  ScodeConnection,
  ScodeQuestionRequest,
  ScodeQuestionResponse,
  SessionNotification,
} from '../core/scodeAcp';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

interface FakeLaunch {
  config: ScodeAcpConfig;
  connection: ScodeConnection;
  notify: (notification: SessionNotification) => void;
  requests: Array<{ method: string; params: unknown; result: ReturnType<typeof deferred<PromptResponse>> }>;
  notifications: Array<{ method: string; params: unknown }>;
  signal: AbortSignal;
  closeCalls: number;
  exit: () => void;
}

class FakeConnector {
  readonly launches: FakeLaunch[] = [];
  gate: Promise<void> | undefined;
  failure: Error | undefined;
  startupNotification: SessionNotification | undefined;
  returnedSessionId: string | undefined;
  respectStartupAbort = false;

  readonly connect: ScodeConnector = async (config, onNotification) => {
    const exited = deferred<Awaited<ScodeConnection['exited']>>();
    const controller = new AbortController();
    let closed = false;
    const initialized: InitializeResponse = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
    const launch: FakeLaunch = {
      config, signal: controller.signal, requests: [], notifications: [], closeCalls: 0,
      notify: notification => onNotification?.(notification),
      exit: () => {
        closed = true;
        controller.abort();
        for (const request of launch.requests) request.result.reject(new Error('Fake process exited'));
        exited.resolve({ code: 0, signal: null });
      },
      connection: {
        pid: 12000 + this.launches.length, sessionId: this.returnedSessionId ?? config.acpSessionId ?? 'new-native',
        initialized, get closed() { return closed; }, exited: exited.promise,
        request: <T>(method: string, params?: unknown): Promise<T> => {
          const result = deferred<PromptResponse>();
          launch.requests.push({ method, params, result });
          return result.promise as Promise<T>;
        },
        notify: async (method: string, params?: unknown) => { launch.notifications.push({ method, params }); },
        close: async () => { launch.closeCalls++; launch.exit(); },
      },
    };
    this.launches.push(launch);
    if (this.startupNotification) launch.notify(this.startupNotification);
    if (this.gate && this.respectStartupAbort && config.signal) {
      const signal = config.signal;
      const abort = () => { launch.exit(); };
      const cancelled = new Promise<never>((_,reject) => {
        signal.addEventListener('abort', () => { abort(); reject(new Error('Startup cancelled')); }, { once:true });
        if (signal.aborted) { abort(); reject(new Error('Startup cancelled')); }
      });
      await Promise.race([this.gate,cancelled]);
    } else {
      await this.gate;
    }
    if (this.failure) throw this.failure;
    return launch.connection;
  };
}

function config(overrides: Partial<ScodeAcpConfig> = {}): ScodeAcpConfig {
  return { workspace: process.cwd(), scodeArgv: ['fake-scode', 'acp'], acpSessionId: 'native-one', ...overrides };
}

function notification(text = 'independent A2A message'): SessionNotification {
  return { sessionId: 'native-one', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } };
}

function permissionRequest(): RequestPermissionRequest {
  return {
    sessionId: 'native-one', toolCall: { toolCallId: 'tool-one' },
    options: [
      { optionId: 'allow-this-tool', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-this-tool', name: 'Reject', kind: 'reject_once' },
    ],
  };
}

function questionRequest(allowCustomInput = false): ScodeQuestionRequest {
  return {
    sessionId: 'native-one', toolCallId: 'question-one', title: 'Choose a plan',
    questions: [{
      id: 'choice', prompt: 'Which plan?', kind: 'single_select', required: true, allowCustomInput,
      options: [{ label: 'Plan A', value: 'plan-a', recommended: true }],
    }],
  };
}

async function tick(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }

async function testOwnershipAndObservers(): Promise<void> {
  const fake = new FakeConnector();
  fake.startupNotification = notification('load replay');
  const registry = new AgentRuntimeRegistry(fake.connect);
  const startup: AgentRuntimeEvent[] = [];
  const pending = registry.connect('stable-id', config(), { onEvent: event => startup.push(event) });
  assert.equal(pending, registry.connect('stable-id', config({ workspace: path.join(process.cwd(), 'child', '..') })));
  assert.throws(() => registry.connect('other-id', config()), /already owned/);
  assert.throws(() => registry.connect('stable-id', config({ scodeArgv: ['another-scode'] })), /different launch/);
  const runtime = await pending;
  assert.equal(fake.launches.length, 1);
  assert(startup.some(event => event.type === 'notification'));
  assert.equal(runtime.snapshot().sessionId, 'native-one');
  assert.equal(runtime.initialized?.agentCapabilities?.loadSession, true);

  const launch = fake.launches[0];
  const observed: AgentRuntimeEvent[] = [];
  const detach = runtime.subscribe(event => {
    if (event.type === 'notification') event.notification.sessionId = 'mutated';
    throw new Error('An observer must not break delivery');
  });
  const detachOther = runtime.subscribe(event => observed.push(event));
  const raw = notification();
  launch.notify(raw);
  const received = observed.find(event => event.type === 'notification');
  assert(received?.type === 'notification');
  assert.equal(received.notification.sessionId, 'native-one');
  received.notification.sessionId = 'changed by consumer';
  assert.equal(raw.sessionId, 'native-one');
  const retained = runtime.events().find(event => event.sequence === received.sequence);
  assert(retained?.type === 'notification');
  assert.equal(retained.notification.sessionId, 'native-one');
  detach();
  detachOther();
  const observedCount = observed.length;
  launch.notify(notification('still connected'));
  assert.equal(observed.length, observedCount);
  assert.equal(launch.closeCalls, 0);
  assert.equal(runtime.snapshot().status, 'ready');

  for (let index = 0; index < 180; index++) launch.notify(notification(`message ${index}`));
  assert(runtime.events().length <= 128);
  launch.notify(notification('x'.repeat(1024 * 1024 + 1)));
  assert(Buffer.byteLength(JSON.stringify(runtime.events())) < 1024 * 1024);
  const replay: AgentRuntimeEvent[] = [];
  runtime.subscribe(event => replay.push(event), { replay: true })();
  assert.equal(replay.length, runtime.events().length);
  assert(runtime.events(runtime.snapshot().lastSequence).length === 0);
  await registry.stopAll();
  assert.equal(launch.closeCalls, 1);
  assert.equal(registry.list().length, 0);
}

async function testNativePromptSerialization(): Promise<void> {
  const fake = new FakeConnector();
  const registry = new AgentRuntimeRegistry(fake.connect);
  const runtime = await registry.connect('prompt-worker', config());
  const launch = fake.launches[0];
  const first = runtime.prompt('first');
  const content = [{ type: 'text' as const, text: 'second' }];
  const second = runtime.prompt(content);
  content[0].text = 'mutated after queuing';
  await tick();
  assert.equal(launch.requests.length, 1);
  assert.equal(runtime.snapshot().status, 'prompting');
  launch.notify(notification('not the foreground result'));
  assert.equal(launch.requests.length, 1);
  const result: PromptResponse = { stopReason: 'end_turn', _meta: { nativeResult: true } };
  launch.requests[0].result.resolve(result);
  assert.deepEqual(await first, result);
  await tick();
  assert.equal(launch.requests.length, 2);
  assert.deepEqual(launch.requests[1].params, { sessionId: 'native-one', prompt: [{ type: 'text', text: 'second' }] });
  const secondRejected = assert.rejects(second, /native prompt failure/);
  launch.requests[1].result.reject(new Error('native prompt failure'));
  await secondRejected;
  assert.equal(runtime.snapshot().status, 'ready');
  assert.equal(runtime.snapshot().activePromptId, null);
  assert(runtime.events().some(event => event.type === 'prompt' && event.phase === 'completed'));
  assert(runtime.events().some(event => event.type === 'notification'));

  const active = assert.rejects(runtime.prompt('active during stop'), /exited/);
  const queued = assert.rejects(runtime.prompt('queued during stop'), /stopped/);
  await tick();
  await registry.stop('prompt-worker');
  await Promise.all([active, queued]);
  await runtime.stop();
  assert.equal(launch.closeCalls, 1);
  assert.equal(runtime.snapshot().status, 'stopped');
  assert.throws(() => runtime.prompt('too late'), /unavailable/);
}

async function testManualInputs(): Promise<void> {
  const fake = new FakeConnector();
  const registry = new AgentRuntimeRegistry(fake.connect);
  const runtime = await registry.connect('interactive', config(), { permissionMode: 'manual', inputMode: 'manual' });
  const launch = fake.launches[0];
  const permission = launch.config.onPermission!(permissionRequest(), launch.signal);
  const permissionId = runtime.snapshot().pendingPermissions[0].id;
  assert.equal(runtime.snapshot().status, 'awaiting-input');
  assert.throws(() => runtime.respondToPermission(permissionId, 'invented-grant'), /offered optionId/);
  assert.equal(runtime.snapshot().pendingPermissions.length, 1);
  assert(runtime.respondToPermission(permissionId, 'allow-this-tool'));
  assert.deepEqual(await permission, { outcome: { outcome: 'selected', optionId: 'allow-this-tool' } });
  assert.equal(runtime.respondToPermission(permissionId, 'allow-this-tool'), false);

  const question = launch.config.onQuestion!(questionRequest(), launch.signal);
  const questionId = runtime.snapshot().pendingQuestions[0].id;
  assert.throws(() => runtime.respondToQuestion(questionId, []), /required answer/);
  assert.throws(() => runtime.respondToQuestion(questionId, [{ id: 'unknown', value: 'plan-a' }]), /unknown or duplicate/);
  assert.throws(() => runtime.respondToQuestion(questionId, [{ id: 'choice', value: 'plan-a' }, { id: 'choice', value: 'plan-a' }]), /duplicate/);
  assert.throws(() => runtime.respondToQuestion(questionId, [{ id: 'choice', value: '' }]), /must not be empty/);
  assert.throws(() => runtime.respondToQuestion(questionId, [{ id: 'choice', value: 'invented-plan' }]), /offered value/);
  assert(runtime.respondToQuestion(questionId, [{ id: 'choice', value: 'plan-a' }]));
  assert.deepEqual(await question, { answers: [{ id: 'choice', value: 'plan-a' }] });
  assert.equal(runtime.respondToQuestion(questionId, []), false);

  const customQuestion = launch.config.onQuestion!(questionRequest(true), launch.signal);
  runtime.respondToQuestion(runtime.snapshot().pendingQuestions[0].id, [{ id: 'choice', value: 'custom plan' }]);
  assert.deepEqual(await customQuestion, { answers: [{ id: 'choice', value: 'custom plan' }] });

  const cancelledPermission = launch.config.onPermission!(permissionRequest(), launch.signal);
  const cancelledQuestion = assert.rejects(launch.config.onQuestion!(questionRequest(), launch.signal), /cancelled/);
  await runtime.cancel();
  assert.deepEqual(await cancelledPermission, { outcome: { outcome: 'cancelled' } });
  await cancelledQuestion;
  assert.equal(runtime.snapshot().pendingQuestions.length + runtime.snapshot().pendingPermissions.length, 0);
  assert.deepEqual(launch.notifications, [{ method: 'session/cancel', params: { sessionId: 'native-one' } }]);
  assert.equal(launch.closeCalls, 0);

  // A subscriber can answer synchronously without delivering later sequence numbers first.
  const sequences: number[] = [];
  runtime.subscribe(event => {
    if (event.type === 'permission' && event.phase === 'requested') runtime.respondToPermission(event.permission.id, 'reject-this-tool');
  });
  runtime.subscribe(event => sequences.push(event.sequence));
  assert.deepEqual(await launch.config.onPermission!(permissionRequest(), launch.signal), { outcome: { outcome: 'selected', optionId: 'reject-this-tool' } });
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  await registry.stopAll();
}

async function testDefaultAndExternalInputs(): Promise<void> {
  const fake = new FakeConnector();
  const registry = new AgentRuntimeRegistry(fake.connect);
  await registry.connect('default', config());
  let launch = fake.launches[0];
  assert.deepEqual(await launch.config.onPermission!(permissionRequest(), launch.signal), { outcome: { outcome: 'cancelled' } });
  await assert.rejects(launch.config.onQuestion!(questionRequest(), launch.signal), /requires an input handler/);
  await registry.stopAll();

  const pendingAnswer = deferred<ScodeQuestionResponse>();
  let handlerSignal: AbortSignal | undefined;
  const externalConfig = config({
    onPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'arbitrary-grant' } }),
    onQuestion: async (_request, signal) => { handlerSignal = signal; return pendingAnswer.promise; },
  });
  assert.throws(() => registry.connect('ambiguous', externalConfig, { permissionMode: 'manual' }), /cannot be combined/);
  assert.throws(() => registry.connect('ambiguous', externalConfig, { inputMode: 'manual' }), /cannot be combined/);
  const runtime = await registry.connect('external', externalConfig);
  launch = fake.launches[1];
  assert.deepEqual(await launch.config.onPermission!(permissionRequest(), launch.signal), { outcome: { outcome: 'cancelled' } });
  const answer = assert.rejects(launch.config.onQuestion!(questionRequest(), launch.signal), /cancelled/);
  await tick();
  assert(handlerSignal);
  await runtime.cancel();
  await answer;
  assert(handlerSignal.aborted);
  pendingAnswer.resolve({ answers: [{ id: 'choice', value: 'plan-a' }] });
  await tick();
  assert.equal(runtime.snapshot().pendingQuestions.length, 0);
  await registry.stopAll();
}

async function testPendingStartupAndFailure(): Promise<void> {
  const fake = new FakeConnector();
  const gate = deferred<void>();
  fake.gate = gate.promise;
  const registry = new AgentRuntimeRegistry(fake.connect);
  const pending = registry.connect('pending', config());
  await tick();
  const stopping = registry.stopAll();
  assert.throws(() => registry.connect('late', config({ acpSessionId: 'different' })), /registry is stopping/);
  gate.resolve();
  await pending;
  await stopping;
  assert.equal(fake.launches[0].closeCalls, 1);
  assert.equal(registry.list().length, 0);

  fake.gate = undefined;
  fake.failure = new Error('startup failed');
  await assert.rejects(registry.connect('retry', config()), /startup failed/);
  assert.equal(registry.list().length, 0);
  fake.failure = undefined;
  await registry.connect('retry', config());
  await registry.stopAll();

  const fresh = config({ acpSessionId: undefined });
  await registry.connect('first-owner', fresh);
  const starts = fake.launches.length;
  assert.throws(() => registry.connect('second-owner', fresh), /already owned/);
  assert.equal(registry.list().length, 1);
  assert.equal(fake.launches.length, starts, 'duplicate workspace must be refused before another CLI is spawned');
  await registry.stopAll();

  const cancellable = new FakeConnector();
  cancellable.gate = new Promise(() => {});
  cancellable.respectStartupAbort = true;
  const owner = new AgentRuntimeRegistry(cancellable.connect);
  const failed = assert.rejects(owner.connect('pending-abort', config()), /cancelled/);
  await tick();
  await owner.stopAll();
  await failed;
  assert(cancellable.launches[0].connection.closed);
  assert.equal(owner.list().length, 0);
}

async function testReentrantReplayAndFailedReconnect(): Promise<void> {
  const fake = new FakeConnector();
  const registry = new AgentRuntimeRegistry(fake.connect);
  const runtime = await registry.connect('reentrant', config(), { permissionMode:'manual', inputMode:'manual' });
  const launch = fake.launches[0];
  const replayed: AgentRuntimeEvent[] = [];
  let injected = false;
  runtime.subscribe(event => {
    replayed.push(event);
    if (!injected) { injected=true; launch.notify(notification('live during replay')); }
  }, { replay:true })();
  assert(replayed.some(event => event.type === 'notification'));
  assert.deepEqual(replayed.map(event => event.sequence), replayed.map(event => event.sequence).sort((a,b) => a-b));

  const phases: string[] = [];
  runtime.subscribe(event => {
    if (event.type === 'permission') phases.push(event.phase);
    if (event.type === 'status' && event.snapshot.pendingPermissions.length) {
      runtime.respondToPermission(event.snapshot.pendingPermissions[0].id, 'reject-this-tool');
    }
  });
  await launch.config.onPermission!(permissionRequest(),launch.signal);
  assert.deepEqual(phases,['requested','selected']);
  assert.throws(() => registry.connect('another-sid',config({acpSessionId:'different-native'})),/already owned/);
  launch.exit();
  await tick();
  assert.throws(() => registry.connect('reentrant',config(),{permissionMode:'manual',inputMode:'manual'}),/failed/);
  await registry.stopAll();
}

async function main(): Promise<void> {
  await testOwnershipAndObservers();
  await testNativePromptSerialization();
  await testManualInputs();
  await testDefaultAndExternalInputs();
  await testPendingStartupAndFailure();
  await testReentrantReplayAndFailedReconnect();
  console.log('agent runtime smoke: passed');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
