import assert from 'node:assert/strict';
import { exec, execPowerShell } from '../core/exec';

// Regression test for issue #225 §2: on Windows, command bodies that contain
// PowerShell-only syntax (used by buildStoredTmuxEnvScrubCommand and
// buildTmuxMouseScrollbackCommand) must be dispatched via powershell.exe,
// not via the default `exec()` which uses cmd.exe.
//
// We can't run powershell.exe on macOS/Linux CI, so this smoke verifies the
// API contract instead:
//   1. `execPowerShell` is exported as a function with the right signature.
//   2. On non-Windows platforms it refuses to run (callers must select the
//      executor based on process.platform).
//   3. `exec` and `execPowerShell` are distinct functions.
async function main(): Promise<void> {
  assert.equal(typeof execPowerShell, 'function', 'execPowerShell must be exported');
  assert.equal(execPowerShell.length, 2, 'execPowerShell(command, options?) — 2-arg signature');
  assert.notEqual(exec, execPowerShell, 'exec and execPowerShell must be distinct');

  if (process.platform !== 'win32') {
    await assert.rejects(
      execPowerShell('Write-Output ok'),
      /only supported on win32/i,
      'On non-Windows platforms, execPowerShell must reject so callers route through exec() instead',
    );
  }

  console.log('execPowerShellSmoke: ok');
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
