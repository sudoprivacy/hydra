import { hashText } from './logRedaction';

export type CodexTranscriptEventKind =
  | 'task-started'
  | 'needs-input'
  | 'input-resolved'
  | 'turn-complete'
  | 'turn-aborted';

export interface CodexTranscriptEvent {
  kind: CodexTranscriptEventKind;
  nativeId: string;
  turnId?: string;
  callId?: string;
  question?: string;
  observedAt?: string;
  sourceSequence?: number;
}

export interface CodexTranscriptParserState {
  currentTurnId?: string;
  pendingCallId?: string;
  lastCallId?: string;
  lastNativeSequence?: number;
}

export interface CodexTranscriptParseResult {
  events: CodexTranscriptEvent[];
  state: CodexTranscriptParserState;
}

const MAX_NATIVE_ID_LENGTH = 500;

export function createCodexTranscriptParserState(): CodexTranscriptParserState {
  return {};
}

export function parseCodexTranscriptLines(
  lines: readonly string[],
  initialState: CodexTranscriptParserState = createCodexTranscriptParserState(),
): CodexTranscriptParseResult {
  const state: CodexTranscriptParserState = { ...initialState };
  const events: CodexTranscriptEvent[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = parseJsonObject(trimmed);
    if (!record) continue;

    const payload = asRecord(record.payload);
    const sourceSequence = getSequence(record, payload);
    if (sourceSequence !== undefined) {
      state.lastNativeSequence = Math.max(state.lastNativeSequence ?? 0, sourceSequence);
    }
    const observedAt = getTimestamp(record, payload);
    const recordType = getString(record, ['type']);

    if (recordType === 'turn_context') {
      const turnId = getId(payload, ['turn_id', 'turnId']);
      if (turnId && turnId !== state.currentTurnId) {
        state.currentTurnId = turnId;
        state.pendingCallId = undefined;
      }
      continue;
    }

    if (recordType === 'response_item' && payload) {
      const payloadType = getString(payload, ['type']);
      const callId = getId(payload, ['call_id', 'callId']);
      if (payloadType === 'function_call'
        && getString(payload, ['name']) === 'request_user_input') {
        const argumentsObject = parseArgumentsObject(payload.arguments);
        const question = firstQuestionText(argumentsObject ?? payload);
        const resolvedCallId = callId
          ?? `request:${hashText(`${state.currentTurnId ?? 'turn'}:${question ?? 'request_user_input'}`)}`;
        state.pendingCallId = resolvedCallId;
        state.lastCallId = resolvedCallId;
        events.push({
          kind: 'needs-input',
          nativeId: resolvedCallId,
          turnId: state.currentTurnId,
          callId: resolvedCallId,
          question,
          observedAt,
          sourceSequence,
        });
        continue;
      }

      if (payloadType === 'function_call_output'
        && callId
        && callId === state.pendingCallId) {
        events.push({
          kind: 'input-resolved',
          nativeId: callId,
          turnId: state.currentTurnId,
          callId,
          observedAt,
          sourceSequence,
        });
        state.pendingCallId = undefined;
        state.lastCallId = callId;
      }
      continue;
    }

    if (recordType !== 'event_msg' || !payload) continue;
    const eventType = getString(payload, ['type']);
    const payloadTurnId = getId(payload, ['turn_id', 'turnId']);
    const turnId = payloadTurnId ?? state.currentTurnId;

    switch (eventType) {
      case 'task_started': {
        state.currentTurnId = turnId;
        state.pendingCallId = undefined;
        events.push({
          kind: 'task-started',
          nativeId: nativeId('task-started', turnId, undefined, sourceSequence, trimmed),
          turnId,
          observedAt,
          sourceSequence,
        });
        break;
      }
      case 'request_user_input': {
        const question = firstQuestionText(payload);
        const callId = getId(payload, ['call_id', 'callId'])
          ?? `request:${hashText(`${turnId ?? 'turn'}:${question ?? 'request_user_input'}`)}`;
        state.pendingCallId = callId;
        state.lastCallId = callId;
        events.push({
          kind: 'needs-input',
          nativeId: callId,
          turnId,
          callId,
          question,
          observedAt,
          sourceSequence,
        });
        break;
      }
      case 'task_complete':
      case 'turn_complete': {
        if (matchesCurrentTurn(payloadTurnId, state.currentTurnId)) {
          events.push({
            kind: 'turn-complete',
            nativeId: nativeId('turn-complete', turnId, state.pendingCallId, sourceSequence, trimmed),
            turnId,
            callId: state.pendingCallId,
            observedAt,
            sourceSequence,
          });
          state.pendingCallId = undefined;
        }
        break;
      }
      case 'turn_aborted': {
        if (matchesCurrentTurn(payloadTurnId, state.currentTurnId)) {
          events.push({
            kind: 'turn-aborted',
            nativeId: nativeId('turn-aborted', turnId, state.pendingCallId, sourceSequence, trimmed),
            turnId,
            callId: state.pendingCallId,
            observedAt,
            sourceSequence,
          });
          state.pendingCallId = undefined;
        }
        break;
      }
      default:
        break;
    }
  }

  return { events, state };
}

function nativeId(
  kind: CodexTranscriptEventKind,
  turnId: string | undefined,
  callId: string | undefined,
  sourceSequence: number | undefined,
  line: string,
): string {
  return callId ?? turnId ?? (sourceSequence !== undefined ? String(sourceSequence) : `${kind}:${hashText(line)}`);
}

function matchesCurrentTurn(payloadTurnId: string | undefined, currentTurnId: string | undefined): boolean {
  return !payloadTurnId || !currentTurnId || payloadTurnId === currentTurnId;
}

function getSequence(
  record: Record<string, unknown>,
  payload: Record<string, unknown> | undefined,
): number | undefined {
  return getNonNegativeSafeInteger(record, ['sequence', 'seq'])
    ?? getNonNegativeSafeInteger(payload, ['sequence', 'seq']);
}

function getTimestamp(
  record: Record<string, unknown>,
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const value = getString(record, ['timestamp', 'created_at', 'createdAt'])
    ?? getString(payload, ['timestamp', 'created_at', 'createdAt']);
  return value && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function firstQuestionText(payload: Record<string, unknown> | undefined): string | undefined {
  const questions = asRecordArray(payload?.questions);
  for (const question of questions) {
    const text = getString(question, ['question', 'header', 'label', 'id']);
    if (text) return normalizeSingleLine(text);
  }
  const direct = getString(payload, ['question', 'prompt', 'message', 'header']);
  return direct ? normalizeSingleLine(direct) : undefined;
}

function parseArgumentsObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'string' ? parseJsonObject(value) : asRecord(value);
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== undefined)
    : [];
}

function getString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function getId(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  const value = getString(record, keys);
  if (!value) return undefined;
  return value.length <= MAX_NATIVE_ID_LENGTH ? value : `native:${hashText(value)}`;
}

function getNonNegativeSafeInteger(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
  }
  return undefined;
}

function normalizeSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
