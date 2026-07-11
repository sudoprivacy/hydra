import { hashText, redactText, truncateText } from './logRedaction';
import type { WorkerRuntimeState } from './workerRuntimeState';
import { parseCodexTranscriptLines } from './codexTranscriptParser';

export type WorkerNeedsInputSignalSource = 'claude-hook' | 'codex-transcript' | 'manual';

export type WorkerNeedsInputReason =
  | 'permission-request'
  | 'ask-user-question'
  | 'exit-plan'
  | 'request-user-input';

export interface WorkerNeedsInputSignal {
  source: WorkerNeedsInputSignalSource;
  reason: WorkerNeedsInputReason;
  title: string;
  body: string;
  fingerprint: string;
}

export type CodexRuntimeSignalReason =
  | 'task-started'
  | 'request-user-input'
  | 'input-resolved'
  | 'turn-complete'
  | 'turn-aborted';

export interface CodexRuntimeSignal {
  state: Extract<WorkerRuntimeState, 'running' | 'idle' | 'needs-input'>;
  reason: CodexRuntimeSignalReason;
  title: string;
  body: string;
  fingerprint: string;
}

export interface WorkerNeedsInputHookEventInput {
  agent: string;
  eventName?: string;
  toolName?: string;
  permissionMode?: string;
  payload?: unknown;
}

const BODY_LIMIT = 600;
const FINGERPRINT_LIMIT = 2048;

export function classifyWorkerNeedsInputEvent(
  input: WorkerNeedsInputHookEventInput,
): WorkerNeedsInputSignal | undefined {
  const agent = input.agent.trim().toLowerCase();
  if (agent !== 'claude') {
    return undefined;
  }

  const payload = asRecord(input.payload);
  const eventName = input.eventName
    || getString(payload, ['hook_event_name', 'hookEventName', 'event_name', 'eventName', 'event']);
  const toolName = input.toolName
    || getString(payload, ['tool_name', 'toolName', 'tool']);
  const permissionMode = input.permissionMode
    || getString(payload, ['permission_mode', 'permissionMode']);

  if (eventName === 'PermissionRequest') {
    return buildClaudeSignal('PermissionRequest', toolName, permissionMode, payload);
  }

  if (
    eventName === 'PreToolUse'
    && permissionMode === 'bypassPermissions'
    && (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode')
  ) {
    return buildClaudeSignal('PreToolUse', toolName, permissionMode, payload);
  }

  return undefined;
}

export function classifyCodexNeedsInputTranscriptText(text: string): WorkerNeedsInputSignal | undefined {
  let candidate: { callId: string; question?: string } | undefined;
  const parsed = parseCodexTranscriptLines(text.split(/\r?\n/));
  for (const event of parsed.events) {
    if (event.kind === 'needs-input') {
      candidate = {
        callId: event.callId ?? event.nativeId,
        question: event.question,
      };
    } else if (event.kind === 'input-resolved'
      || event.kind === 'turn-complete'
      || event.kind === 'turn-aborted') {
      if (!event.callId || !candidate || event.callId === candidate.callId) candidate = undefined;
    }
  }
  if (!candidate || parsed.state.pendingCallId !== candidate.callId) return undefined;
  const question = candidate.question ?? 'Codex is waiting for input.';
  return {
    source: 'codex-transcript',
    reason: 'request-user-input',
    title: 'Codex needs input',
    body: truncateBody(question),
    fingerprint: `codex:${hashText(candidate.callId)}`,
  };
}

export function classifyCodexRuntimeTranscriptText(text: string): CodexRuntimeSignal | undefined {
  let latest: CodexRuntimeSignal | undefined;
  const parsed = parseCodexTranscriptLines(text.split(/\r?\n/));
  for (const event of parsed.events) {
    switch (event.kind) {
      case 'task-started':
        latest = {
          state: 'running',
          reason: 'task-started',
          title: 'Codex task started',
          body: 'Codex started processing a task.',
          fingerprint: `codex-runtime:${hashText(event.nativeId)}`,
        };
        break;
      case 'needs-input':
        latest = {
          state: 'needs-input',
          reason: 'request-user-input',
          title: 'Codex needs input',
          body: truncateBody(event.question ?? 'Codex is waiting for input.'),
          fingerprint: `codex-runtime:${hashText(event.callId ?? event.nativeId)}`,
        };
        break;
      case 'input-resolved':
        latest = {
          state: 'running',
          reason: 'input-resolved',
          title: 'Codex input resolved',
          body: 'Codex received the requested input and resumed the turn.',
          fingerprint: `codex-runtime:${hashText(event.callId ?? event.nativeId)}`,
        };
        break;
      case 'turn-complete':
        latest = {
          state: 'idle',
          reason: 'turn-complete',
          title: 'Codex turn completed',
          body: 'Codex completed the current turn.',
          fingerprint: `codex-runtime:${hashText(event.nativeId)}`,
        };
        break;
      case 'turn-aborted':
        latest = {
          state: 'idle',
          reason: 'turn-aborted',
          title: 'Codex turn aborted',
          body: 'Codex aborted the current turn.',
          fingerprint: `codex-runtime:${hashText(event.nativeId)}`,
        };
        break;
    }
  }

  return latest;
}

function buildClaudeSignal(
  eventName: string,
  toolName: string | undefined,
  permissionMode: string | undefined,
  payload: Record<string, unknown> | undefined,
): WorkerNeedsInputSignal | undefined {
  const toolInput = asRecord(payload?.tool_input) || asRecord(payload?.toolInput) || payload;
  if (toolName === 'AskUserQuestion') {
    const body = describeAskUserQuestion(toolInput) || 'Claude is waiting for an answer.';
    return {
      source: 'claude-hook',
      reason: 'ask-user-question',
      title: 'Claude asks a question',
      body: truncateBody(body),
      fingerprint: fingerprint('claude', eventName, toolName, permissionMode, body),
    };
  }

  if (toolName === 'ExitPlanMode') {
    const body = describeExitPlanMode(toolInput) || 'Claude is waiting for plan approval.';
    return {
      source: 'claude-hook',
      reason: 'exit-plan',
      title: 'Claude awaits plan approval',
      body: truncateBody(body),
      fingerprint: fingerprint('claude', eventName, toolName, permissionMode, body),
    };
  }

  if (eventName === 'PermissionRequest') {
    const body = describePermissionRequest(toolName, toolInput);
    return {
      source: 'claude-hook',
      reason: 'permission-request',
      title: 'Claude needs permission',
      body: truncateBody(body),
      fingerprint: fingerprint('claude', eventName, toolName || 'unknown-tool', permissionMode, body),
    };
  }

  return undefined;
}

function describePermissionRequest(toolName: string | undefined, toolInput: Record<string, unknown> | undefined): string {
  const tool = toolName || 'a tool';
  const command = getString(toolInput, ['command', 'cmd']);
  const filePath = getString(toolInput, ['file_path', 'filePath', 'path']);
  if (command) {
    return `Claude is waiting for permission to run ${tool}: ${command}`;
  }
  if (filePath) {
    return `Claude is waiting for permission to use ${tool} on ${filePath}`;
  }
  return `Claude is waiting for permission to use ${tool}.`;
}

function describeAskUserQuestion(toolInput: Record<string, unknown> | undefined): string | undefined {
  const question = firstQuestionText(toolInput);
  const options = firstQuestionOptions(toolInput);
  if (!question && options.length === 0) {
    return undefined;
  }
  return [
    question ? `Question: ${question}` : undefined,
    options.length > 0 ? `Options: ${options.join(', ')}` : undefined,
  ].filter(Boolean).join('\n');
}

function describeExitPlanMode(toolInput: Record<string, unknown> | undefined): string | undefined {
  const plan = getString(toolInput, ['plan', 'content', 'message']);
  if (!plan) {
    return undefined;
  }
  return `Plan approval requested:\n${plan}`;
}

function firstQuestionText(payload: Record<string, unknown> | undefined): string | undefined {
  const questions = asRecordArray(payload?.questions);
  if (questions.length > 0) {
    for (const question of questions) {
      const text = getString(question, ['question', 'header', 'label', 'id']);
      if (text) {
        return normalizeSingleLine(text);
      }
    }
  }
  const direct = getString(payload, ['question', 'prompt', 'message', 'header']);
  return direct ? normalizeSingleLine(direct) : undefined;
}

function firstQuestionOptions(payload: Record<string, unknown> | undefined): string[] {
  const question = asRecordArray(payload?.questions)[0];
  const options = asRecordArray(question?.options || payload?.options);
  return options
    .map(option => getString(option, ['label', 'value', 'id']))
    .filter((option): option is string => Boolean(option))
    .slice(0, 5)
    .map(normalizeSingleLine);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.map(asRecord).filter((entry): entry is Record<string, unknown> => entry != null)
    : [];
}

function getString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (normalized) {
        return normalized;
      }
    }
  }
  return undefined;
}

function normalizeSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateBody(value: string): string {
  return truncateText(redactText(value, BODY_LIMIT), BODY_LIMIT);
}

function fingerprint(...parts: Array<string | undefined>): string {
  return hashText(parts.filter(Boolean).join('\n').slice(0, FINGERPRINT_LIMIT));
}
