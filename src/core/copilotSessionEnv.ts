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

// Probe wrapper with bounded retry + explicit fallback signal. If the psmux
// `show-options default-shell` probe failed (transient socket race right after
// createSession, server restart, etc.), the caller used to fall back silently
// to PowerShell — re-opening the original cmd.exe parse bug for users who'd
// configured cmd as default-shell. Now we retry a few times, then surface
// usedFallback so the caller can log a warning. See issue #225 §6 (codex
// review round 1).
export type PaneShellProbe = () => Promise<string>;

export interface PaneShellProbeResult {
  shell: WindowsPaneShell;
  usedFallback: boolean;
  attempts: number;
}

export interface PaneShellProbeOptions {
  maxAttempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function probePaneShellWithRetry(
  probe: PaneShellProbe,
  options: PaneShellProbeOptions = {},
): Promise<PaneShellProbeResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  const delayMs = options.delayMs ?? 50;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = await probe();
      return { shell: classifyWindowsShell(raw), usedFallback: false, attempts: attempt };
    } catch {
      if (attempt < maxAttempts) await sleep(delayMs);
    }
  }
  return { shell: 'pwsh', usedFallback: true, attempts: maxAttempts };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
