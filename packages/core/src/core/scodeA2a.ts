import type { ScodeConnection } from './scodeAcp';

export const SCODE_A2A_METHODS = {
  send: '_sudocode/a2a/send',
  agentList: '_sudocode/a2a/agent_list',
} as const;

export interface ScodeMessage {
  to: string;
  message: string;
  summary?: string;
}

/** The real tool output, not a queued-command acknowledgement or delivery claim. */
export interface ScodeA2aResult {
  content: string;
  isError: boolean;
}

export class ScodeA2aError extends Error {
  constructor(
    message: string,
    readonly outcome: 'not_submitted' | 'unknown',
    readonly rpcError?: { code?: number; data?: unknown },
  ) {
    super(message);
    this.name = 'ScodeA2aError';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function supportsScodeDirectA2a(connection: ScodeConnection): boolean {
  const sudocode = record(connection.initialized._meta?.sudocode);
  return record(sudocode?.directA2a)?.version === 1;
}

function validateKeys(value: unknown, keys: string[]): Record<string, unknown> {
  const input = record(value);
  if (!input || Object.keys(input).some(key => !keys.includes(key))) {
    throw new ScodeA2aError('Unknown direct A2A input field', 'not_submitted');
  }
  return input;
}

async function directRequest(
  connection: ScodeConnection, method: string, params: Record<string, unknown>, timeoutMs: number,
): Promise<ScodeA2aResult> {
  if (!supportsScodeDirectA2a(connection)) {
    throw new ScodeA2aError('This scode does not advertise directA2a version 1; install a compatible scode. No prompt fallback was attempted.', 'not_submitted');
  }
  if (connection.closed) throw new ScodeA2aError('The owned scode connection is closed', 'not_submitted');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ScodeA2aError('Direct A2A timeout must be a finite positive number', 'not_submitted');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      connection.request(method, { sessionId: connection.sessionId, ...params }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      }),
    ]);
    const result = record(response);
    if (!result || typeof result.isError !== 'boolean' || typeof result.content !== 'string') {
      throw new Error('Invalid direct A2A result; execution may already have completed');
    }
    // Do not reinterpret isError or a tool's text as proof that no append occurred.
    return response as ScodeA2aResult;
  } catch (error) {
    const remote = record(error);
    const code = typeof remote?.code === 'number' ? remote.code : undefined;
    // A generic JSON-RPC code does not attest to execution/admission phase.
    // Keep every remote error Unknown until there is a verified typed refusal
    // contract. Only local preflight above can assert not_submitted.
    throw new ScodeA2aError(
      `${error instanceof Error ? error.message : String(error)}; outcome unknown, do not automatically resend`,
      'unknown', code === undefined ? undefined : { code, data: remote?.data },
    );
  } finally { clearTimeout(timer); }
}

/** No model call, sender override, alternate mailbox, retry, or second connection. */
export async function sendScodeMessage(
  connection: ScodeConnection, message: ScodeMessage, timeoutMs = 60000,
): Promise<ScodeA2aResult> {
  const input = validateKeys(message, ['to', 'message', 'summary']);
  if (typeof input.to !== 'string' || !input.to.trim() || typeof input.message !== 'string'
      || (input.summary !== undefined && typeof input.summary !== 'string')) {
    throw new ScodeA2aError('send requires a target and a plain text message', 'not_submitted');
  }
  return directRequest(connection, SCODE_A2A_METHODS.send, {
    to: input.to, message: input.message, ...(input.summary === undefined ? {} : { summary: input.summary }),
  }, timeoutMs);
}

/** Directory visibility is addressability, not evidence that a peer is online. */
export async function listScodeAgents(
  connection: ScodeConnection, options: { activeOnly?: boolean } = {}, timeoutMs = 60000,
): Promise<ScodeA2aResult> {
  const input = validateKeys(options, ['activeOnly']);
  if (input.activeOnly !== undefined && typeof input.activeOnly !== 'boolean') {
    throw new ScodeA2aError('activeOnly must be a boolean', 'not_submitted');
  }
  return directRequest(connection, SCODE_A2A_METHODS.agentList,
    input.activeOnly === undefined ? {} : { activeOnly: input.activeOnly }, timeoutMs);
}
