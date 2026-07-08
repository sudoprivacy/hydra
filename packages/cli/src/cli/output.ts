import { logger } from '@hydra/core/logger';

// Exit codes following agent-friendly CLI conventions
export const EXIT_OK = 0;
export const EXIT_INTERNAL = 1;
export const EXIT_VALIDATION = 2;
export const EXIT_NOT_FOUND = 4;
export const EXIT_CONFLICT = 5;

export interface OutputOpts {
  json?: boolean;
  quiet?: boolean;
}

/**
 * Output a successful result.
 * - --quiet: nothing (takes precedence)
 * - --json: JSON.stringify to stdout
 * - else: call prettyPrint callback
 */
export function outputResult(
  data: Record<string, unknown>,
  opts: OutputOpts,
  prettyPrint: () => void,
): void {
  if (opts.quiet) {
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(data));
    return;
  }
  prettyPrint();
}

/**
 * Output an error and exit with the appropriate code.
 * - --json: structured JSON error to stderr
 * - else: plain text error to stderr
 */
export function outputError(error: unknown, opts: OutputOpts): never {
  const message = error instanceof Error ? error.message : String(error);
  const code = classifyError(message);
  const retryable = code === EXIT_INTERNAL;
  logger.error('cli.error', 'Hydra CLI command failed', {
    exitCode: code,
    retryable,
    error,
  });

  if (opts.json) {
    const errorObj: Record<string, unknown> = { error: { code, message, retryable } };
    const hint = getHint(message, code);
    if (hint) {
      (errorObj.error as Record<string, unknown>).hint = hint;
    }
    console.error(JSON.stringify(errorObj));
  } else {
    console.error(`Error: ${message}`);
  }

  logger.flushSync();
  process.exit(code);
}

/**
 * Classify an error message into an exit code by pattern-matching known messages.
 */
export function classifyError(message: string): number {
  const lower = message.toLowerCase();

  // Validation errors
  if (
    lower.includes('invalid branch name') ||
    lower.includes('invalid default agent') ||
    lower.includes('required option') ||
    lower.includes('missing required') ||
    lower.includes('unknown config key') ||
    lower.includes('workers cannot create other workers') ||
    lower.includes('cannot be used with') ||
    lower.includes('mutually exclusive') ||
    lower.includes('only valid') ||
    lower.includes('only supported') ||
    lower.includes('requires --') ||
    lower.includes('is required') ||
    lower.includes('validation')
  ) {
    return EXIT_VALIDATION;
  }

  // Not found
  if (lower.includes('not found') || lower.includes('does not exist')) {
    return EXIT_NOT_FOUND;
  }

  // Conflict / already exists
  if (lower.includes('already exists') || lower.includes('has no managed worktree')) {
    return EXIT_CONFLICT;
  }

  return EXIT_INTERNAL;
}

function getHint(message: string, code: number): string | undefined {
  if (code === EXIT_NOT_FOUND) {
    return 'Use "hydra list --json" to see available sessions.';
  }
  if (message.includes('has no managed worktree')) {
    return 'Delete the branch first or use a different name.';
  }
  return undefined;
}
