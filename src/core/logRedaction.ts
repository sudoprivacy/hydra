import * as crypto from 'crypto';

export const DEFAULT_STDIO_LIMIT = 8 * 1024;
export const DEFAULT_COMMAND_LIMIT = 16 * 1024;
export const DEFAULT_STRING_LIMIT = 16 * 1024;

const REDACTED = '[REDACTED]';

const SECRET_KEY_PATTERN = /(?:^|[_-])(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|AUTH)(?:$|[_-])/i;
const KEY_VALUE_SECRET_PATTERN = /(\b[A-Z0-9_.-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_.-]*\b\s*[:=]\s*)(['"]?)([^\s'",;]+)/gi;
const BEARER_PATTERN = /(Authorization\s*:\s*Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi;
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
const GITHUB_TOKEN_PATTERN = /\bgh[opsu]_[A-Za-z0-9_]{20,}\b/g;

export type SanitizedLogValue =
  | string
  | number
  | boolean
  | null
  | SanitizedLogValue[]
  | { [key: string]: SanitizedLogValue };

export function isSecretLikeKey(key: string): boolean {
  if (SECRET_KEY_PATTERN.test(key)) {
    return true;
  }
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('passwd') ||
    normalized.includes('apikey') ||
    normalized.includes('accesskey');
}

export function redactText(value: string, limit = DEFAULT_STRING_LIMIT): string {
  const redacted = value
    .replace(KEY_VALUE_SECRET_PATTERN, `$1$2${REDACTED}`)
    .replace(BEARER_PATTERN, `$1${REDACTED}`)
    .replace(OPENAI_KEY_PATTERN, REDACTED)
    .replace(GITHUB_TOKEN_PATTERN, REDACTED);
  return truncateText(redacted, limit);
}

export function truncateText(value: string, limit = DEFAULT_STRING_LIMIT): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}...[truncated ${value.length - limit} chars]`;
}

export function hashText(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function sanitizeLogValue(key: string, value: unknown): SanitizedLogValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (isSecretLikeKey(key)) {
    return REDACTED;
  }

  const limit = getLimitForKey(key);

  if (value instanceof Error) {
    const sanitized: { [key: string]: SanitizedLogValue } = {
      name: value.name,
      message: redactText(value.message, limit),
    };
    if (value.stack) {
      sanitized.stack = redactText(value.stack, DEFAULT_STDIO_LIMIT);
    }
    const maybeError = value as Error & {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    if (maybeError.code !== undefined) {
      const code = sanitizeLogValue('code', maybeError.code);
      if (code !== undefined) sanitized.code = code;
    }
    if (maybeError.stdout !== undefined) {
      const stdout = sanitizeLogValue('stdout', maybeError.stdout);
      if (stdout !== undefined) sanitized.stdout = stdout;
    }
    if (maybeError.stderr !== undefined) {
      const stderr = sanitizeLogValue('stderr', maybeError.stderr);
      if (stderr !== undefined) sanitized.stderr = stderr;
    }
    return sanitized;
  }

  if (typeof value === 'string') {
    return redactText(value, limit);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return Number.isFinite(value as number) || typeof value !== 'number' ? value as SanitizedLogValue : String(value);
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((entry, index) => sanitizeLogValue(`${key}.${index}`, entry))
      .filter((entry): entry is SanitizedLogValue => entry !== undefined);
  }

  if (typeof value === 'object') {
    const result: { [key: string]: SanitizedLogValue } = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeLogValue(childKey, childValue);
      if (sanitized !== undefined) {
        result[childKey] = sanitized;
      }
    }
    return result;
  }

  return redactText(String(value), limit);
}

export function sanitizeLogContext(context?: Record<string, unknown>): Record<string, SanitizedLogValue> {
  const sanitized: Record<string, SanitizedLogValue> = {};
  if (!context) {
    return sanitized;
  }

  for (const [key, value] of Object.entries(context)) {
    const safeValue = sanitizeLogValue(key, value);
    if (safeValue !== undefined) {
      sanitized[key] = safeValue;
    }
  }
  return sanitized;
}

function getLimitForKey(key: string): number {
  switch (key) {
    case 'stdout':
    case 'stderr':
    case 'stack':
      return DEFAULT_STDIO_LIMIT;
    case 'command':
      return DEFAULT_COMMAND_LIMIT;
    default:
      return DEFAULT_STRING_LIMIT;
  }
}
