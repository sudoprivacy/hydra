/**
 * Smoke for the Windows enhanced PATH (issue #225 §2, codex review round 1).
 *
 * execPowerShell invokes `powershell.exe` via execFile, which relies on PATH
 * to resolve. VS Code subprocesses sometimes get a stripped PATH that omits
 * the System32 directories. Hard-pin the well-known WindowsPowerShell location
 * (and PowerShell 7's default install) at the front of the enhanced PATH so
 * execPowerShell can find an interpreter even in those isolated environments.
 *
 * The smoke flips process.platform to 'win32' temporarily and inspects the
 * resulting PATH string. The dirs themselves don't need to exist on the host
 * machine — getEnhancedPath only assembles a string.
 */

import assert from 'node:assert/strict';
import { getEnhancedPath } from '../core/exec';

function withWin32<T>(fn: () => T): T {
  const originalPlatform = process.platform;
  const originalSystemRoot = process.env.SystemRoot;
  const originalPathEnv = process.env.PATH;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  process.env.SystemRoot = 'C:\\Windows';
  process.env.PATH = 'C:\\existing\\bin';
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalSystemRoot;
    if (originalPathEnv === undefined) delete process.env.PATH;
    else process.env.PATH = originalPathEnv;
  }
}

// The smoke runs on macOS/Linux CI but exercises the win32 branch via a
// mocked process.platform. node's `path` and `path.delimiter` still use host
// conventions in that mode, so the joined separators and the entry delimiter
// won't be `\` and `;` — use substring matches that are robust either way.
function main(): void {
  const pathOnWin = withWin32(() => getEnhancedPath());

  assert.ok(
    /WindowsPowerShell[\\/]v1\.0/.test(pathOnWin),
    `Windows PowerShell 5.1 dir must be on the enhanced PATH:\n${pathOnWin}`,
  );
  assert.ok(
    pathOnWin.includes('PowerShell\\7') || pathOnWin.includes('PowerShell/7'),
    `PowerShell 7 dir must be on the enhanced PATH:\n${pathOnWin}`,
  );

  // PowerShell dirs must come before the user's existing PATH so they win
  // even when System32 was stripped from the inherited env.
  const psIndex = pathOnWin.search(/WindowsPowerShell/);
  const existingIndex = pathOnWin.indexOf('C:\\existing\\bin');
  assert.ok(psIndex >= 0, 'WindowsPowerShell substring not found');
  assert.ok(existingIndex >= 0, 'caller-set PATH was not preserved');
  assert.ok(
    psIndex < existingIndex,
    `PowerShell dirs must be PREPENDED so they win over a PATH that omits System32: ${pathOnWin}`,
  );

  // Custom SystemRoot is honored (Windows installed to a non-standard drive).
  const originalPlatform = process.platform;
  const originalSystemRoot = process.env.SystemRoot;
  const originalPathEnv = process.env.PATH;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  process.env.SystemRoot = 'D:\\Windows';
  process.env.PATH = 'D:\\existing';
  try {
    const customPath = getEnhancedPath();
    assert.ok(
      /D:[\\/]Windows[\\/]System32[\\/]WindowsPowerShell/.test(customPath),
      `SystemRoot override must be reflected: ${customPath}`,
    );
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalSystemRoot;
    if (originalPathEnv === undefined) delete process.env.PATH;
    else process.env.PATH = originalPathEnv;
  }

  // POSIX behavior unchanged (no PowerShell entries on the non-mocked path).
  const pathOnPosix = getEnhancedPath();
  assert.ok(
    !pathOnPosix.includes('WindowsPowerShell'),
    `POSIX PATH must not contain WindowsPowerShell: ${pathOnPosix}`,
  );

  console.log('enhancedPathWindowsSmoke: ok');
}

main();
