/**
 * Smoke test for the generated Windows hydra.cmd wrapper.
 *
 * Run: node out/smoke/windowsCliWrapperSmoke.js
 */

import assert from 'node:assert/strict';
import { buildWrapperScriptWindows } from '../core/cliInstaller';

function main(): void {
  const script = buildWrapperScriptWindows();

  assert.match(
    script,
    /setlocal DisableDelayedExpansion/,
    'Windows wrapper must not enable delayed expansion because the inline Node script contains JS ! operators',
  );
  assert.doesNotMatch(
    script,
    /setlocal EnableDelayedExpansion/,
    'EnableDelayedExpansion corrupts inline JS such as !extPath before node sees it',
  );
  assert.match(
    script,
    /node -e ".*" -- %\*/s,
    'Windows wrapper must use -- so --version and other CLI flags pass through to Hydra, not node',
  );
  assert.match(
    script,
    /process\.argv\.slice\(1\)/,
    'node -e receives forwarded arguments from process.argv[1]',
  );
  assert.doesNotMatch(
    script,
    /process\.argv\.slice\(2\)/,
    'slice(2) drops the first Hydra subcommand when invoked through node -e',
  );

  console.log('windowsCliWrapperSmoke: ok');
}

main();
