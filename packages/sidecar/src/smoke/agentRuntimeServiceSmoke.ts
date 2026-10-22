/**
 * Optional ACP service ownership over the real registry with an injected,
 * process-free connector. No scode CLI, tmux, daemon, or peer is contacted.
 * Run: node packages/sidecar/out/smoke/agentRuntimeServiceSmoke.js
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createHydraControlClient, Op, transportFactory,
  type AgentRuntimeEvent, type AgentRuntimeConnectInput,
} from '@hydra/protocol';
import type {
  PromptResponse, RequestPermissionRequest, ScodeAcpConfig, ScodeConnection,
  ScodeQuestionRequest, SessionNotification,
} from '@hydra/core/scodeAcp';
import { FakeBackend } from './fakeBackend';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: value => resolve(value) };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

class FakeConnection implements ScodeConnection {
  readonly pid = 4242;
  readonly initialized = { protocolVersion: 1 };
  readonly exit = deferred<Awaited<ScodeConnection['exited']>>();
  readonly exited = this.exit.promise;
  closed = false;
  closeCalls = 0;
  readonly prompts: unknown[] = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  promptGate: ReturnType<typeof deferred<PromptResponse>> | undefined;

  constructor(
    readonly config: ScodeAcpConfig,
    readonly sessionId: string,
    private readonly onNotification: (notification: SessionNotification) => void,
  ) {}

  async request<T>(method: string, params: unknown): Promise<T> {
    assert.equal(method, 'session/prompt');
    this.prompts.push(params);
    return await (this.promptGate?.promise ?? Promise.resolve({ stopReason: 'end_turn' })) as T;
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.notifications.push({ method, params });
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.closed = true;
    this.exit.resolve({ code: 0, signal: null });
  }

  emit(text: string): void {
    this.onNotification({ sessionId: this.sessionId, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text },
    } });
  }
}

function isNotification(event: AgentRuntimeEvent, text: string): boolean {
  return event.type === 'notification'
    && event.notification.update.sessionUpdate === 'agent_message_chunk'
    && event.notification.update.content.type === 'text'
    && event.notification.update.content.text === text;
}

async function observe(iterator: AsyncIterator<AgentRuntimeEvent>, received: AgentRuntimeEvent[]): Promise<void> {
  for (;;) {
    const result = await iterator.next();
    if (result.done) return;
    received.push(result.value);
  }
}

async function main(): Promise<void> {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-acp-service-'));
  process.env.HOME = temporary;
  process.env.USERPROFILE = temporary;
  process.env.HYDRA_HOME = path.join(temporary, '.hydra');
  process.env.HYDRA_TRANSPORT = 'legacy';
  process.env.HYDRA_TELEMETRY = '0';
  delete process.env.HYDRA_CONFIG_PATH;

  const { AgentRuntimeRegistry } = await import('@hydra/core/agentRuntime');
  const { HydraAppService } = await import('../appService');
  const { NotificationMailboxMirror } = await import('@hydra/core/notificationMailboxMirror');
  const { CopilotInboundBridge } = await import('@hydra/core/copilotInboundBridge');
  const originalMirrorStart = NotificationMailboxMirror.prototype.start;
  const originalInboundStart = CopilotInboundBridge.prototype.start;
  let mailboxStarts = 0;
  NotificationMailboxMirror.prototype.start = function () { mailboxStarts += 1; throw new Error('Unexpected mailbox watcher'); };
  CopilotInboundBridge.prototype.start = function () { mailboxStarts += 1; throw new Error('Unexpected mailbox watcher'); };
  let service: InstanceType<typeof HydraAppService> | undefined;
  try {
    const connections: FakeConnection[] = [];
    const failingStartup = deferred<void>();
    const registry = new AgentRuntimeRegistry(async (config, onNotification = () => {}) => {
      if (config.scodeArgv[0] === 'fail-startup') {
        await failingStartup.promise;
        throw new Error('fake startup failure');
      }
      const connection = new FakeConnection(config, config.acpSessionId ?? `native-${connections.length + 1}`, onNotification);
      connections.push(connection);
      return connection;
    });
    let backendCalls = 0;
    const backend = new Proxy(new FakeBackend(), {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => { backendCalls += 1; return value.apply(target, args); };
      },
    });
    service = new HydraAppService({ backend, agentRuntimeRegistry: registry });
    const transport = transportFactory({ appService: service });
    const client = createHydraControlClient(transport);
    assert.equal((await client.listAgentRuntimes()).count, 0);
    await assert.rejects(() => client.getAgentRuntime('missing'), /Unknown agent runtime/);
    await assert.rejects(() => service!.request(Op.connectAgentRuntime, { id: 'unsupported', kind: 'tmux' }), /Unsupported agent runtime kind/);
    await assert.rejects(() => service!.request(Op.connectAgentRuntime, {
      id: 'relative', kind: 'scode-acp', workspace: 'relative', scodeArgv: ['fake-scode'],
    }), /workspace must be absolute/);
    await assert.rejects(() => service!.request(Op.connectAgentRuntime, {
      id: 'shell-string', kind: 'scode-acp', workspace: temporary, scodeArgv: 'fake-scode --acp',
    }), /literal argv/);
    assert.equal(connections.length, 0, 'invalid launch inputs never reach the connector');

    const failedConnect = assert.rejects(() => client.connectAgentRuntime({
      id: 'failing', kind: 'scode-acp', workspace: temporary, scodeArgv: ['fail-startup'],
    }), /fake startup failure/);
    const failedStream = client.subscribeAgentRuntimeEvents({ id: 'failing' })[Symbol.asyncIterator]();
    const failedObserver = observe(failedStream, []);
    failingStartup.resolve(undefined);
    await failedConnect;
    await failedObserver;
    assert.equal(registry.get('failing'), undefined, 'failed startup releases the runtime and its observers');

    const launch: AgentRuntimeConnectInput = {
      id: 'alpha', kind: 'scode-acp', workspace: temporary,
      scodeArgv: ['fake-scode', '--acp', 'literal $(not-a-shell)'],
      acpSessionId: 'native-alpha', env: { PRIVATE_TOKEN: 'do-not-expose', REMOVED: null },
      permissionMode: 'manual', inputMode: 'manual',
    };
    const snapshot = await client.connectAgentRuntime(launch);
    assert.equal(snapshot.status, 'ready');
    assert.equal(snapshot.sessionId, 'native-alpha');
    assert.equal((await client.connectAgentRuntime(launch)).id, 'alpha');
    assert.equal(connections.length, 1, 'repeated attachment reuses the service-owned connection');
    assert.deepEqual(connections[0].config.scodeArgv, launch.scodeArgv, 'argv remains literal data');
    await assert.rejects(() => client.connectAgentRuntime({ ...launch, scodeArgv: ['different'] }), /different launch configuration/);
    assert.equal(JSON.stringify(snapshot).includes('do-not-expose'), false);
    assert.equal(JSON.stringify(await client.getAgentRuntimeEvents({ id: 'alpha' })).includes('do-not-expose'), false);

    const first = client.subscribeAgentRuntimeEvents({ id: 'alpha', afterSequence: snapshot.lastSequence })[Symbol.asyncIterator]();
    const second = client.subscribeAgentRuntimeEvents({ id: 'alpha', afterSequence: snapshot.lastSequence })[Symbol.asyncIterator]();
    const firstEvents: AgentRuntimeEvent[] = [];
    const secondEvents: AgentRuntimeEvent[] = [];
    const firstObserver = observe(first, firstEvents);
    const secondObserver = observe(second, secondEvents);
    const alpha = connections[0];
    alpha.promptGate = deferred<PromptResponse>();
    const prompt = client.promptAgentRuntime({ id: 'alpha', content: [{ type: 'text', text: 'foreground request' }] });
    await waitFor(() => alpha.prompts.length === 1, 'foreground prompt start');
    assert.equal((await client.getAgentRuntime('alpha')).status, 'prompting');
    alpha.emit('during foreground');
    await waitFor(() => firstEvents.some(event => isNotification(event, 'during foreground'))
      && secondEvents.some(event => isNotification(event, 'during foreground')), 'both live observers');
    await first.return?.();
    await firstObserver;
    const detachedCount = firstEvents.length;
    assert.equal(alpha.closeCalls, 0, 'detaching an observer never closes the runtime');
    alpha.promptGate.resolve({ stopReason: 'end_turn' });
    assert.deepEqual(await prompt, { runtimeId: 'alpha', result: { stopReason: 'end_turn' } });
    await waitFor(() => registry.get('alpha')?.snapshot().status === 'ready', 'foreground completion');
    alpha.emit('native work after foreground');
    await waitFor(() => secondEvents.some(event => isNotification(event, 'native work after foreground')), 'post-prompt native notification');
    assert.equal(firstEvents.length, detachedCount);
    assert.equal((await client.getAgentRuntime('alpha')).activePromptId, null, 'raw notifications do not invent a foreground prompt');
    assert.equal(JSON.stringify(secondEvents).includes('do-not-expose'), false);

    const permissionRequest: RequestPermissionRequest = {
      sessionId: alpha.sessionId, toolCall: { toolCallId: 'tool-1', title: 'Choose explicitly' },
      options: [
        { optionId: 'allow-exact', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-exact', name: 'Reject once', kind: 'reject_once' },
      ],
    };
    const permission = alpha.config.onPermission!(permissionRequest, new AbortController().signal);
    let pending = await client.getAgentRuntime('alpha');
    assert.equal(pending.status, 'awaiting-input');
    assert.equal(pending.pendingPermissions.length, 1);
    const permissionId = pending.pendingPermissions[0].id;
    await assert.rejects(() => client.answerAgentRuntimePermission({ id: 'alpha', requestId: permissionId, optionId: 'invented' }), /offered optionId/);
    assert.equal((await client.getAgentRuntime('alpha')).pendingPermissions.length, 1, 'invalid choice leaves permission pending');
    await client.answerAgentRuntimePermission({ id: 'alpha', requestId: permissionId, optionId: 'reject-exact' });
    assert.deepEqual(await permission, { outcome: { outcome: 'selected', optionId: 'reject-exact' } });
    await assert.rejects(() => client.answerAgentRuntimePermission({ id: 'alpha', requestId: permissionId, optionId: null }), /not found/);

    const questionRequest: ScodeQuestionRequest = { sessionId: alpha.sessionId, toolCallId: 'tool-question', questions: [{
      id: 'plan', prompt: 'Choose a plan', kind: 'single_select', required: true, allowCustomInput: false,
      options: [{ label: 'Draft', value: 'draft', recommended: true }],
    }] };
    const question = alpha.config.onQuestion!(questionRequest, new AbortController().signal);
    pending = await client.getAgentRuntime('alpha');
    const questionId = pending.pendingQuestions[0].id;
    await assert.rejects(() => client.answerAgentRuntimeQuestion({ id: 'alpha', requestId: questionId, answers: [{ id: 'unknown', value: 'draft' }] }), /unknown or duplicate/);
    await assert.rejects(() => client.answerAgentRuntimeQuestion({ id: 'alpha', requestId: questionId, answers: [{ id: 'plan', value: 'invented' }] }), /offered value/);
    await client.answerAgentRuntimeQuestion({ id: 'alpha', requestId: questionId, answers: [{ id: 'plan', value: 'draft' }] });
    assert.deepEqual(await question, { answers: [{ id: 'plan', value: 'draft' }] });
    const cancelledQuestion = assert.rejects(alpha.config.onQuestion!(questionRequest, new AbortController().signal), /cancelled/);
    pending = await client.getAgentRuntime('alpha');
    await client.answerAgentRuntimeQuestion({ id: 'alpha', requestId: pending.pendingQuestions[0].id, answers: null });
    await cancelledQuestion;
    const cancelledPermission = alpha.config.onPermission!(permissionRequest, new AbortController().signal);
    await client.cancelAgentRuntime('alpha');
    assert.deepEqual(await cancelledPermission, { outcome: { outcome: 'cancelled' } });
    assert.deepEqual(alpha.notifications, [{ method: 'session/cancel', params: { sessionId: alpha.sessionId } }]);
    assert.equal(alpha.closeCalls, 0, 'cancel leaves the process alive');

    await assert.rejects(() => service!.request(Op.promptAgentRuntime, { id: 'alpha', content: [{ type: 'unknown' }] }), /Unsupported ACP content/);
    await assert.rejects(() => service!.request(Op.promptAgentRuntime, { id: 'alpha', content: [{ type: 'text', text: 3 }] }), /string text/);
    assert.throws(() => client.subscribeAgentRuntimeEvents({ id: 'alpha', afterSequence: -1 }), /non-negative/);
    const beforeBurst = (await client.getAgentRuntime('alpha')).lastSequence;
    const slow = client.subscribeAgentRuntimeEvents({ id: 'alpha', afterSequence: beforeBurst })[Symbol.asyncIterator]();
    for (let index = 0; index < 200; index += 1) {
      alpha.emit(`native burst ${index}`);
      await Promise.resolve();
    }
    await assert.rejects(() => slow.next(), /bounded buffer/);
    const tail = await client.getAgentRuntimeEvents({ id: 'alpha' });
    assert.ok(tail.count <= 128 && tail.count > 0, 'runtime history remains bounded');
    assert.equal((await client.getAgentRuntimeEvents({ id: 'alpha', afterSequence: tail.lastSequence })).count, 0);
    const replay = client.subscribeAgentRuntimeEvents({ id: 'alpha', afterSequence: tail.lastSequence - 1 })[Symbol.asyncIterator]();
    assert.equal((await replay.next()).value.sequence, tail.lastSequence, 'cursor replay comes from retained runtime events');
    await replay.return?.();

    // Detachment and overflow both release their listener slots.
    const slots = Array.from({ length: 63 }, () => client.subscribeAgentRuntimeEvents({ id: 'alpha', afterSequence: tail.lastSequence })[Symbol.asyncIterator]());
    assert.throws(() => client.subscribeAgentRuntimeEvents({ id: 'alpha' }), /Too many/);
    await Promise.all(slots.map(iterator => iterator.return?.()));
    const freed = client.subscribeAgentRuntimeEvents({ id: 'alpha', afterSequence: tail.lastSequence })[Symbol.asyncIterator]();
    await freed.return?.();

    await client.connectAgentRuntime({ id: 'beta', kind: 'scode-acp', workspace: path.join(temporary, 'beta'), scodeArgv: ['fake-scode'] });
    const beta = connections[1];
    assert.deepEqual(await beta.config.onPermission!(permissionRequest, new AbortController().signal), { outcome: { outcome: 'cancelled' } }, 'default mode never autoapproves');
    await assert.rejects(() => beta.config.onQuestion!(questionRequest, new AbortController().signal), /input handler or manual/);
    await client.stopAgentRuntime('alpha');
    await secondObserver;
    assert.equal(alpha.closeCalls, 1, 'explicit stop closes exactly the owned connection');
    assert.equal(beta.closeCalls, 0);
    await assert.rejects(() => client.getAgentRuntime('alpha'), /Unknown agent runtime/);
    await assert.rejects(() => client.stopAgentRuntime('alpha'), /Unknown agent runtime/);
    assert.equal((await client.listAgentRuntimes()).count, 1);
    assert.equal(backendCalls, 0, 'structured runtime operations never call tmux');
    assert.equal(mailboxStarts, 0, 'structured runtime operations add no Nexus mailbox watcher');

    const betaStream = client.subscribeAgentRuntimeEvents({ id: 'beta', afterSequence: (await client.getAgentRuntime('beta')).lastSequence })[Symbol.asyncIterator]();
    const waiting = betaStream.next();
    const disposal = service.dispose();
    assert.equal(service.dispose(), disposal, 'service disposal is idempotent');
    await disposal;
    assert.equal((await waiting).done, true, 'service disposal closes subscribed streams');
    assert.equal(beta.closeCalls, 1, 'service lifetime owns remaining connections');
    await assert.rejects(() => client.listAgentRuntimes(), /disposed/);

    class HangingRegistry extends AgentRuntimeRegistry {
      override stopAll(): Promise<void> { return new Promise(() => {}); }
    }
    const hanging = new HydraAppService({ backend, agentRuntimeRegistry: new HangingRegistry(), agentRuntimeShutdownTimeoutMs: 25 });
    await assert.rejects(() => hanging.dispose(), /shutdown timed out after 25ms/, 'even a faulty connector cannot block service shutdown forever');
    console.log('agentRuntimeServiceSmoke: ok (persistent ownership, ACP events, manual input, bounded streams/shutdown, no tmux or mailbox watcher)');
  } finally {
    await service?.dispose().catch(() => {});
    NotificationMailboxMirror.prototype.start = originalMirrorStart;
    CopilotInboundBridge.prototype.start = originalInboundStart;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
