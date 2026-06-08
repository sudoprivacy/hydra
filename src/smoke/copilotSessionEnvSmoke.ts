/**
 * Smoke for the Windows copilot-session env prefix (issue #225 §6).
 *
 * `withCopilotSessionEnv` used to hard-code PowerShell's `$env:VAR=value;`
 * syntax on Windows. If the psmux default-shell was cmd.exe, the worker pane
 * showed a parse error and the agent never started. Verify the helpers we
 * use to detect the shell + build the prefix produce the right syntax for
 * each branch, and that POSIX is unchanged.
 */

import assert from 'node:assert/strict';
import {
  buildWindowsCopilotSessionEnvPrefix,
  classifyWindowsShell,
} from '../core/copilotSessionEnv';
import { HYDRA_COPILOT_SESSION_ENV } from '../core/env';

function main(): void {
  // ── classifyWindowsShell ──
  assert.equal(classifyWindowsShell('C:\\Windows\\System32\\cmd.exe'), 'cmd');
  assert.equal(classifyWindowsShell('cmd.exe'), 'cmd');
  assert.equal(classifyWindowsShell('cmd'), 'cmd');
  assert.equal(classifyWindowsShell('CMD.EXE'), 'cmd', 'case-insensitive');
  assert.equal(
    classifyWindowsShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe'),
    'pwsh',
  );
  assert.equal(
    classifyWindowsShell('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
    'pwsh',
  );
  assert.equal(classifyWindowsShell(''), 'pwsh', 'empty defaults to pwsh');
  assert.equal(classifyWindowsShell('"cmd.exe"'), 'cmd', 'strip surrounding quotes');
  assert.equal(classifyWindowsShell('/bin/bash'), 'pwsh', 'unknown defaults to pwsh');

  // ── buildWindowsCopilotSessionEnvPrefix (cmd) ──
  const cmdPrefix = buildWindowsCopilotSessionEnvPrefix('cmd', 'repo_main', 'claude');
  assert.equal(
    cmdPrefix,
    `set "${HYDRA_COPILOT_SESSION_ENV}=repo_main"&& claude`,
    'cmd branch must use `set "VAR=val"&& cmd`',
  );
  assert.doesNotMatch(cmdPrefix, /\$env:/, 'cmd branch must not emit PowerShell syntax');

  // Embedded double-quotes (defensive — sanitizer keeps them out, but the
  // helper still has to be safe).
  const cmdPrefixDq = buildWindowsCopilotSessionEnvPrefix('cmd', 'a"b', 'agent');
  assert.equal(
    cmdPrefixDq,
    `set "${HYDRA_COPILOT_SESSION_ENV}=a""b"&& agent`,
    'cmd branch must double embedded double quotes',
  );

  // ── buildWindowsCopilotSessionEnvPrefix (pwsh) ──
  const pwshPrefix = buildWindowsCopilotSessionEnvPrefix('pwsh', 'repo_main', 'claude');
  assert.equal(
    pwshPrefix,
    `$env:${HYDRA_COPILOT_SESSION_ENV}='repo_main'; claude`,
    'pwsh branch must use `$env:VAR=\'val\'; cmd`',
  );
  assert.doesNotMatch(pwshPrefix, /^set "/, 'pwsh branch must not emit cmd syntax');

  // Single-quote in session name must be doubled (PowerShell single-quote literal).
  const pwshPrefixSq = buildWindowsCopilotSessionEnvPrefix('pwsh', "o'brien", 'agent');
  assert.equal(
    pwshPrefixSq,
    `$env:${HYDRA_COPILOT_SESSION_ENV}='o''brien'; agent`,
    'pwsh branch must double embedded single quotes',
  );

  console.log('copilotSessionEnvSmoke: ok');
}

main();
