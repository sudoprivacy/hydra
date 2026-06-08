// Helpers for building the inline env-prefix that carries HYDRA_COPILOT_SESSION
// into the agent process spawned by the pane shell. Lives outside
// sessionManager.ts so smoke tests can exercise the shell-detection branches
// directly. See issue #225 §6.

import { HYDRA_COPILOT_SESSION_ENV } from './env';
import { pwshQuote } from './shell';

export type WindowsPaneShell = 'cmd' | 'pwsh';

// Classify a psmux default-shell value as either cmd.exe or PowerShell. Unknown
// values fall back to 'pwsh' — that matches Hydra's documented default and
// preserves the pre-fix behavior for users who never touched default-shell.
export function classifyWindowsShell(rawShell: string): WindowsPaneShell {
  const lower = rawShell.toLowerCase().replace(/['"]/g, '');
  if (!lower) return 'pwsh';
  if (lower.endsWith('cmd.exe') || lower === 'cmd') return 'cmd';
  return 'pwsh';
}

// Build the env-prefix that wraps the agent launch command on Windows. The
// caller has already detected the pane shell. Session names are sanitized to
// alphanumerics+hyphens, but the cmd branch also doubles any embedded `"` so
// a future relaxation of the sanitizer doesn't silently break the command.
export function buildWindowsCopilotSessionEnvPrefix(
  shell: WindowsPaneShell,
  sessionName: string,
  command: string,
): string {
  if (shell === 'cmd') {
    const cmdSafeName = sessionName.replace(/"/g, '""');
    // `set "VAR=value"&& cmd` — quoted form so `&` inside value would not break
    // parsing, and `&&` so we don't run the agent if the assignment itself
    // fails (it never should, but it's the conservative choice).
    return `set "${HYDRA_COPILOT_SESSION_ENV}=${cmdSafeName}"&& ${command}`;
  }
  return `$env:${HYDRA_COPILOT_SESSION_ENV}=${pwshQuote(sessionName)}; ${command}`;
}
