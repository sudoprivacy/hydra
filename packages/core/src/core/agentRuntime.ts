import { randomUUID } from 'node:crypto';
import { expandAndResolvePath } from './path';
import {
  connectScode,
  validateScodePermissionResponse as validatePermissionResponse,
  validateScodeQuestionResponse as validateQuestionResponse,
  type ContentBlock,
  type InitializeResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ScodeAcpConfig,
  type ScodeConnection,
  type ScodeQuestionRequest,
  type ScodeQuestionResponse,
  type SessionNotification,
} from './scodeAcp';

export type AgentRuntimeStatus = 'connecting' | 'ready' | 'prompting' | 'awaiting-input' | 'stopping' | 'stopped' | 'error';
export type ScodeConnector = typeof connectScode;

export interface PendingAgentPermission {
  id: string;
  createdAt: string;
  request: RequestPermissionRequest;
}

export interface PendingAgentQuestion {
  id: string;
  createdAt: string;
  request: ScodeQuestionRequest;
}

export interface AgentRuntimeSnapshot {
  id: string;
  kind: 'scode-acp';
  workspace: string;
  status: AgentRuntimeStatus;
  pid: number | null;
  sessionId: string | null;
  /** Foreground Hydra requests only; native A2A work can overlap these requests. */
  activePromptId: string | null;
  queuedPrompts: number;
  pendingPermissions: PendingAgentPermission[];
  pendingQuestions: PendingAgentQuestion[];
  lastSequence: number;
  lastError: string | null;
}

interface AgentRuntimeEventBase {
  runtimeId: string;
  sequence: number;
  at: string;
}

type AgentRuntimeEventBody =
  | { type: 'status'; snapshot: AgentRuntimeSnapshot }
  | { type: 'notification'; notification: SessionNotification }
  | { type: 'prompt'; phase: 'queued' | 'started'; promptId: string }
  | { type: 'prompt'; phase: 'completed'; promptId: string; result: PromptResponse }
  | { type: 'prompt'; phase: 'failed'; promptId: string; error: string }
  | { type: 'permission'; phase: 'requested' | 'selected' | 'cancelled'; permission: PendingAgentPermission; optionId?: string }
  | { type: 'question'; phase: 'requested' | 'answered' | 'cancelled'; question: PendingAgentQuestion; answers?: ScodeQuestionResponse['answers'] };

export type AgentRuntimeEvent = AgentRuntimeEventBase & AgentRuntimeEventBody;
export type AgentRuntimeListener = (event: AgentRuntimeEvent) => void;

export interface AgentRuntimeConnectOptions {
  /** Manual mode waits for respondToPermission; otherwise the supplied handler or cancellation is used. */
  permissionMode?: 'cancel' | 'manual';
  /** Manual mode waits for respondToQuestion; otherwise a handler is required for native questions. */
  inputMode?: 'cancel' | 'manual';
  /** Optional observer installed before initialization/session loading. */
  onEvent?: AgentRuntimeListener;
}

export interface AgentRuntime {
  readonly id: string;
  readonly kind: 'scode-acp';
  snapshot(): AgentRuntimeSnapshot;
  subscribe(listener: AgentRuntimeListener, options?: { replay?: boolean }): () => void;
  events(afterSequence?: number): AgentRuntimeEvent[];
  prompt(content: string | readonly ContentBlock[]): Promise<PromptResponse>;
  cancel(): Promise<void>;
  respondToPermission(requestId: string, optionId: string | null): boolean;
  respondToQuestion(requestId: string, answers: ScodeQuestionResponse['answers'] | null): boolean;
  stop(): Promise<void>;
}

interface PromptJob {
  id: string;
  content: ContentBlock[];
  resolve: (result: PromptResponse) => void;
  reject: (error: Error) => void;
}

interface PendingPermissionEntry {
  value: PendingAgentPermission;
  manual: boolean;
  finish: (response: RequestPermissionResponse) => void;
}

interface PendingQuestionEntry {
  value: PendingAgentQuestion;
  manual: boolean;
  finish: (response: ScodeQuestionResponse | Error) => void;
}

const MAX_HISTORY_EVENTS = 128;
const MAX_HISTORY_BYTES = 1024 * 1024;
const MAX_QUEUED_PROMPTS = 64;
const MAX_PENDING_INPUTS = 32;

/** Owns one ACP process. Observers own only their subscriptions, never the process. */
export class ScodeAgentRuntime implements AgentRuntime {
  readonly kind = 'scode-acp' as const;
  readonly ready: Promise<void>;
  private connection: ScodeConnection | undefined;
  private status: AgentRuntimeStatus = 'connecting';
  private lastError: string | null = null;
  private sequence = 0;
  private activePromptId: string | null = null;
  private readonly listeners = new Set<AgentRuntimeListener>();
  private readonly history: Array<{ event: AgentRuntimeEvent; bytes: number }> = [];
  private readonly deliveries: AgentRuntimeEvent[] = [];
  private delivering = false;
  private historyBytes = 0;
  private readonly prompts: PromptJob[] = [];
  private pumping = false;
  private stopRequested = false;
  private readonly lifetime = new AbortController();
  private readonly ownerAbort = () => { void this.stop().catch(() => {}); };
  private stopPromise: Promise<void> | undefined;
  private readonly permissions = new Map<string, PendingPermissionEntry>();
  private readonly questions = new Map<string, PendingQuestionEntry>();

  /** Prefer AgentRuntimeRegistry.connect so native session ownership is enforced. */
  constructor(
    readonly id: string,
    private readonly config: ScodeAcpConfig,
    private readonly options: AgentRuntimeConnectOptions = {},
    connector: ScodeConnector = connectScode,
  ) {
    if (options.onEvent) this.listeners.add(options.onEvent);
    this.ready = Promise.resolve().then(async () => {
      this.emitStatus();
      await this.open(connector);
    });
    // A registry caller can observe startup through events before awaiting ready.
    void this.ready.catch(() => {});
    config.signal?.addEventListener('abort', this.ownerAbort, { once: true });
    if (config.signal?.aborted) this.ownerAbort();
  }

  get initialized(): InitializeResponse | undefined {
    return this.connection && clone(this.connection.initialized);
  }

  snapshot(): AgentRuntimeSnapshot {
    return {
      id: this.id, kind: this.kind, workspace: this.config.workspace, status: this.status,
      pid: this.connection?.pid ?? null,
      sessionId: this.connection?.sessionId ?? this.config.acpSessionId ?? null,
      activePromptId: this.activePromptId, queuedPrompts: this.prompts.length,
      pendingPermissions: Array.from(this.permissions.values(), entry => clone(entry.value)),
      pendingQuestions: Array.from(this.questions.values(), entry => clone(entry.value)),
      lastSequence: this.sequence, lastError: this.lastError,
    };
  }

  /** Every delivery is a separate clone; a throwing observer cannot affect another observer. */
  subscribe(listener: AgentRuntimeListener, options: { replay?: boolean } = {}): () => void {
    const history = options.replay ? this.events() : [];
    let replaying = options.replay === true;
    const duringReplay: AgentRuntimeEvent[] = [];
    const subscriber: AgentRuntimeListener = event => {
      if (replaying) duringReplay.push(event);
      else this.deliver(listener, event);
    };
    this.listeners.add(subscriber);
    for (const event of history) this.deliver(listener, event);
    while (duringReplay.length) this.deliver(listener, duringReplay.shift()!);
    replaying = false;
    return () => { this.listeners.delete(subscriber); };
  }

  /** A bounded diagnostic tail, not a durable mailbox or a prompt transcript. */
  events(afterSequence = 0): AgentRuntimeEvent[] {
    return this.history.filter(entry => entry.event.sequence > afterSequence).map(entry => clone(entry.event));
  }

  prompt(content: string | readonly ContentBlock[]): Promise<PromptResponse> {
    this.assertUsable();
    if (this.prompts.length >= MAX_QUEUED_PROMPTS) throw new Error('Agent runtime prompt queue is full');
    const blocks: ContentBlock[] = typeof content === 'string' ? [{ type: 'text', text: content }] : clone([...content]);
    const id = randomUUID();
    const result = new Promise<PromptResponse>((resolve, reject) => {
      this.prompts.push({ id, content: blocks, resolve, reject });
    });
    this.emit({ type: 'prompt', phase: 'queued', promptId: id });
    void this.pumpPrompts();
    return result;
  }

  async cancel(): Promise<void> {
    this.assertUsable();
    this.cancelPendingInputs();
    await this.ready;
    this.assertUsable();
    await this.connection!.notify('session/cancel', { sessionId: this.connection!.sessionId });
  }

  respondToPermission(requestId: string, optionId: string | null): boolean {
    const pending = this.permissions.get(requestId);
    if (!pending || !pending.manual) return false;
    const response: RequestPermissionResponse = optionId === null
      ? { outcome: { outcome: 'cancelled' } }
      : { outcome: { outcome: 'selected', optionId } };
    validatePermissionResponse(pending.value.request, response);
    pending.finish(response);
    return true;
  }

  respondToQuestion(requestId: string, answers: ScodeQuestionResponse['answers'] | null): boolean {
    const pending = this.questions.get(requestId);
    if (!pending || !pending.manual) return false;
    if (answers === null) {
      pending.finish(new Error('Agent question cancelled'));
    } else {
      const response = { answers: clone(answers) };
      validateQuestionResponse(pending.value.request, response);
      pending.finish(response);
    }
    return true;
  }

  /** Explicitly stop the owned process. To detach a client, call its unsubscribe function. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopRequested = true;
    this.lifetime.abort();
    this.stopPromise = Promise.resolve().then(async () => {
      try {
        await this.ready.catch(() => {});
        await this.connection?.close();
        this.config.signal?.removeEventListener('abort', this.ownerAbort);
        this.status = 'stopped';
        this.emitStatus();
      } catch (error) {
        this.lastError = errorMessage(error);
        this.status = 'error';
        this.emitStatus();
        throw error;
      }
    });
    this.status = 'stopping';
    this.cancelPendingInputs();
    this.rejectQueuedPrompts(new Error('Agent runtime stopped'));
    this.emitStatus();
    return this.stopPromise;
  }

  private async open(connector: ScodeConnector): Promise<void> {
    try {
      this.connection = await connector({
        ...this.config,
        signal: this.lifetime.signal,
        onPermission: (request, signal) => this.requestPermission(request, signal),
        onQuestion: (request, signal) => this.requestQuestion(request, signal),
      }, notification => this.emit({ type: 'notification', notification }));
      void this.connection.exited.then(exit => {
        this.config.signal?.removeEventListener('abort', this.ownerAbort);
        this.cancelPendingInputs();
        this.rejectQueuedPrompts(new Error('Agent runtime process exited'));
        if (this.stopRequested) return;
        this.lastError = `Agent runtime process exited (${exit.code}/${exit.signal})`;
        this.status = 'error';
        this.emitStatus();
      });
      if (!this.stopRequested) {
        this.updateReadyStatus();
      }
    } catch (error) {
      this.config.signal?.removeEventListener('abort', this.ownerAbort);
      this.lastError = errorMessage(error);
      this.status = this.stopRequested ? 'stopped' : 'error';
      this.cancelPendingInputs();
      this.rejectQueuedPrompts(asError(error));
      this.emitStatus();
      throw error;
    }
  }

  private async pumpPrompts(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      await this.ready;
      while (this.prompts.length && !this.stopRequested) {
        const job = this.prompts.shift()!;
        this.activePromptId = job.id;
        this.updateReadyStatus();
        this.emit({ type: 'prompt', phase: 'started', promptId: job.id });
        try {
          this.assertUsable();
          const result = await this.connection!.request<PromptResponse>('session/prompt', {
            sessionId: this.connection!.sessionId, prompt: job.content,
          });
          this.emit({ type: 'prompt', phase: 'completed', promptId: job.id, result });
          job.resolve(clone(result));
        } catch (error) {
          this.lastError = errorMessage(error);
          this.emit({ type: 'prompt', phase: 'failed', promptId: job.id, error: this.lastError });
          job.reject(asError(error));
        } finally {
          this.activePromptId = null;
          this.updateReadyStatus();
        }
      }
    } catch (error) {
      this.rejectQueuedPrompts(asError(error));
    } finally {
      this.pumping = false;
    }
  }

  private requestPermission(request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    if (this.stopRequested || signal.aborted || this.pendingInputCount() >= MAX_PENDING_INPUTS) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const value: PendingAgentPermission = { id: randomUUID(), createdAt: new Date().toISOString(), request: clone(request) };
    const controller = new AbortController();
    return new Promise(resolve => {
      const abort = () => finish({ outcome: { outcome: 'cancelled' } });
      const finish = (response: RequestPermissionResponse) => {
        if (!this.permissions.delete(value.id)) return;
        signal.removeEventListener('abort', abort);
        controller.abort();
        const outcome = response.outcome;
        const selected = outcome.outcome === 'selected';
        this.emit({
          type: 'permission', phase: selected ? 'selected' : 'cancelled', permission: value,
          optionId: outcome.outcome === 'selected' ? outcome.optionId : undefined,
        });
        this.updateReadyStatus();
        resolve(clone(response));
      };
      const manual = this.options.permissionMode === 'manual';
      this.permissions.set(value.id, { value, manual, finish });
      signal.addEventListener('abort', abort, { once: true });
      this.emit({ type: 'permission', phase: 'requested', permission: value });
      this.updateReadyStatus();
      if (manual) return;
      const handler = this.config.onPermission;
      if (!handler) { abort(); return; }
      void Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error('Agent permission cancelled');
        return handler(clone(request), controller.signal);
      }).then(response => {
        validatePermissionResponse(request, response);
        finish(response);
      }).catch(() => abort());
    });
  }

  private requestQuestion(request: ScodeQuestionRequest, signal: AbortSignal): Promise<ScodeQuestionResponse> {
    if (this.stopRequested || signal.aborted) return Promise.reject(new Error('Agent question cancelled'));
    if (this.pendingInputCount() >= MAX_PENDING_INPUTS) return Promise.reject(new Error('Too many pending agent inputs'));
    const value: PendingAgentQuestion = { id: randomUUID(), createdAt: new Date().toISOString(), request: clone(request) };
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      const abort = () => finish(new Error('Agent question cancelled'));
      const finish = (response: ScodeQuestionResponse | Error) => {
        if (!this.questions.delete(value.id)) return;
        signal.removeEventListener('abort', abort);
        controller.abort();
        const cancelled = response instanceof Error;
        this.emit({ type: 'question', phase: cancelled ? 'cancelled' : 'answered', question: value,
          answers: cancelled ? undefined : response.answers });
        this.updateReadyStatus();
        if (cancelled) reject(response); else resolve(clone(response));
      };
      const manual = this.options.inputMode === 'manual';
      this.questions.set(value.id, { value, manual, finish });
      signal.addEventListener('abort', abort, { once: true });
      this.emit({ type: 'question', phase: 'requested', question: value });
      this.updateReadyStatus();
      if (manual) return;
      const handler = this.config.onQuestion;
      if (!handler) { finish(new Error('Native question requires an input handler or manual input mode')); return; }
      void Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error('Agent question cancelled');
        return handler(clone(request), controller.signal);
      }).then(response => {
        validateQuestionResponse(request, response);
        finish(response);
      }).catch(error => finish(asError(error)));
    });
  }

  private cancelPendingInputs(): void {
    for (const entry of [...this.permissions.values()]) entry.finish({ outcome: { outcome: 'cancelled' } });
    for (const entry of [...this.questions.values()]) entry.finish(new Error('Agent question cancelled'));
  }

  private pendingInputCount(): number { return this.permissions.size + this.questions.size; }

  private updateReadyStatus(): void {
    if (this.stopRequested || this.status === 'error' || this.status === 'stopped') return;
    this.status = this.pendingInputCount() ? 'awaiting-input' : this.activePromptId ? 'prompting' : this.connection ? 'ready' : 'connecting';
    this.emitStatus();
  }

  private rejectQueuedPrompts(error: Error): void {
    for (const job of this.prompts.splice(0)) {
      this.emit({ type: 'prompt', phase: 'failed', promptId: job.id, error: error.message });
      job.reject(error);
    }
  }

  private assertUsable(): void {
    if (this.stopRequested || this.status === 'stopped' || this.status === 'error' || this.connection?.closed) {
      throw new Error(`Agent runtime "${this.id}" is unavailable (${this.status})`);
    }
  }

  private emitStatus(): void { this.emit({ type: 'status', snapshot: this.snapshot() }); }

  private emit(body: AgentRuntimeEventBody): void {
    const event: AgentRuntimeEvent = clone({ ...body, runtimeId: this.id, sequence: ++this.sequence, at: new Date().toISOString() });
    if (event.type === 'status') event.snapshot.lastSequence = event.sequence;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes <= MAX_HISTORY_BYTES) {
      this.history.push({ event, bytes });
      this.historyBytes += bytes;
      while (this.history.length > MAX_HISTORY_EVENTS || this.historyBytes > MAX_HISTORY_BYTES) {
        this.historyBytes -= this.history.shift()!.bytes;
      }
    }
    this.deliveries.push(event);
    if (this.delivering) return;
    this.delivering = true;
    try {
      while (this.deliveries.length) {
        const next = this.deliveries.shift()!;
        for (const listener of [...this.listeners]) this.deliver(listener, next);
      }
    } finally {
      this.delivering = false;
    }
  }

  private deliver(listener: AgentRuntimeListener, event: AgentRuntimeEvent): void {
    try { listener(clone(event)); } catch { /* An observer cannot fail the shared runtime. */ }
  }
}

interface RegistryEntry {
  runtime: ScodeAgentRuntime;
  promise: Promise<ScodeAgentRuntime>;
  fingerprint: string;
  config: ScodeAcpConfig;
  options: AgentRuntimeConnectOptions;
  ownershipKey?: string;
}

/** Process-lifetime owner for ACP connections; clients attach and detach observers. */
export class AgentRuntimeRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly ownership = new Map<string, string>();
  private stoppingAll = false;

  constructor(private readonly connector: ScodeConnector = connectScode) {}

  connect(id: string, config: ScodeAcpConfig, options: AgentRuntimeConnectOptions = {}): Promise<ScodeAgentRuntime> {
    if (!id.trim()) throw new Error('Agent runtime id must not be empty');
    if (this.stoppingAll) throw new Error('Agent runtime registry is stopping');
    if (options.permissionMode === 'manual' && config.onPermission) throw new Error('Manual permission mode cannot be combined with onPermission');
    if (options.inputMode === 'manual' && config.onQuestion) throw new Error('Manual input mode cannot be combined with onQuestion');
    if (typeof config.workspace !== 'string' || !config.workspace.trim()
        || !Array.isArray(config.scodeArgv) || !config.scodeArgv.length
        || config.scodeArgv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !config.scodeArgv[0]) {
      throw new Error('Agent runtime requires a workspace and scodeArgv argument array');
    }
    const normalized = { ...config, workspace: expandAndResolvePath(config.workspace), scodeArgv: [...config.scodeArgv], env: config.env && { ...config.env } };
    const fingerprint = launchFingerprint(normalized, options);
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.config.onPermission !== config.onPermission || existing.config.onQuestion !== config.onQuestion
          || existing.config.onProtocol !== config.onProtocol || existing.config.onError !== config.onError || existing.config.signal !== config.signal) {
        throw new Error(`Agent runtime "${id}" already has a different launch configuration`);
      }
      if (['stopped','stopping','error'].includes(existing.runtime.snapshot().status)) {
        throw new Error(`Agent runtime "${id}" has stopped or failed; stop/remove it before reconnecting`);
      }
      if (options.onEvent) existing.runtime.subscribe(options.onEvent);
      return existing.promise;
    }
    // scode resolves one stable agent identity per workspace, including session/new.
    const ownershipKey = workspaceKey(normalized.workspace);
    if (ownershipKey) this.assertUnclaimed(ownershipKey, id);
    const runtime = new ScodeAgentRuntime(id, normalized, { ...options }, this.connector);
    const entry: RegistryEntry = { runtime, promise: Promise.resolve(runtime), fingerprint, config: normalized, options: { ...options }, ownershipKey };
    this.entries.set(id, entry);
    if (ownershipKey) this.ownership.set(ownershipKey, id);
    entry.promise = runtime.ready.then(async () => {
      const actualSessionId = runtime.snapshot().sessionId!;
      const actualKey = workspaceKey(normalized.workspace);
      try {
        if (normalized.acpSessionId && actualSessionId !== normalized.acpSessionId) {
          throw new Error('ACP connector returned a different native session than requested');
        }
        this.assertUnclaimed(actualKey, id);
      } catch (error) {
        await runtime.stop();
        throw error;
      }
      if (entry.ownershipKey && entry.ownershipKey !== actualKey) this.ownership.delete(entry.ownershipKey);
      entry.ownershipKey = actualKey;
      this.ownership.set(actualKey, id);
      return runtime;
    }).catch(error => {
      this.remove(id, entry);
      throw error;
    });
    return entry.promise;
  }

  get(id: string): ScodeAgentRuntime | undefined { return this.entries.get(id)?.runtime; }
  list(): AgentRuntimeSnapshot[] { return Array.from(this.entries.values(), entry => entry.runtime.snapshot()); }

  async stop(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    await entry.runtime.stop();
    // Let a pending connect finish claiming its returned native session before removal.
    await entry.promise.catch(() => {});
    this.remove(id, entry);
    return true;
  }

  async stopAll(): Promise<void> {
    this.stoppingAll = true;
    try {
      const results = await Promise.allSettled([...this.entries.keys()].map(id => this.stop(id)));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Failed to stop agent runtimes');
    } finally {
      this.stoppingAll = false;
    }
  }

  private assertUnclaimed(key: string, id: string): void {
    const owner = this.ownership.get(key);
    if (owner && owner !== id) throw new Error(`Native ACP session is already owned by agent runtime "${owner}"`);
  }

  private remove(id: string, entry: RegistryEntry): void {
    if (this.entries.get(id) !== entry) return;
    this.entries.delete(id);
    if (entry.ownershipKey && this.ownership.get(entry.ownershipKey) === id) this.ownership.delete(entry.ownershipKey);
  }
}

function launchFingerprint(config: ScodeAcpConfig, options: AgentRuntimeConnectOptions): string {
  return JSON.stringify({
    workspace: workspaceKey(config.workspace), argv: config.scodeArgv, sessionId: config.acpSessionId ?? null,
    env: Object.entries(config.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    startupTimeoutMs: config.startupTimeoutMs, closeTimeoutMs: config.closeTimeoutMs,
    protocolLog: config.protocolLog, stderrLog: config.stderrLog,
    permissionMode: options.permissionMode ?? 'cancel', inputMode: options.inputMode ?? 'cancel',
  });
}

function workspaceKey(workspace: string): string {
  const canonical = expandAndResolvePath(workspace);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function clone<T>(value: T): T { return structuredClone(value); }
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
function errorMessage(error: unknown): string { return asError(error).message; }
