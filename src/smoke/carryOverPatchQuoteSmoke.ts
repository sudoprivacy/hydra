/**
 * Lockdown smoke for the carry-over `git apply` quoting (issue #225 §10).
 *
 * The two carry-over branches in createWorktreeFromBranch (staged / unstaged)
 * used naked `"${tmpFile}"` interpolation. cmd.exe survived because the
 * default os.tmpdir() never contains `"`, but a TMP/TEMP env override that
 * does would break the command, and the surrounding code already uses
 * shellQuote() everywhere. Lock in that both call sites use shellQuote().
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

function main(): void {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'commands', 'createWorktreeFromBranch.ts'),
    'utf-8',
  );

  // Must not contain naked-quoted git apply.
  assert.doesNotMatch(
    source,
    /git apply "\$\{tmpFile\}"/,
    'createWorktreeFromBranch must not use naked "${tmpFile}" — wrap with shellQuote()',
  );

  // Must contain the shellQuote variant twice (staged + unstaged carry-overs).
  const shellQuoted = source.match(/git apply \$\{shellQuote\(tmpFile\)\}/g) || [];
  assert.equal(
    shellQuoted.length,
    2,
    `Expected exactly 2 shellQuote(tmpFile) call sites for staged+unstaged, found ${shellQuoted.length}`,
  );

  console.log('carryOverPatchQuoteSmoke: ok');
}

main();
