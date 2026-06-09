/**
 * Lockdown for end-to-end shellTarget threading (issue #225 §7, codex round 1).
 *
 * Three worker launch sites in sessionManager.ts (launchPreparedWorker,
 * startWorker fresh, createCodeWorker fresh) used to call
 * buildAgentLaunchCommand without `{ shellTarget }`, so even after §7 fixed
 * the copilot paths, every WORKER launch on Windows defaulted to PowerShell
 * quoting regardless of the pane shell. Lock down that every
 * buildAgentLaunchCommand call in this file passes the 5th argument and that
 * the 5th argument carries shellTarget (either via { shellTarget } or
 * { ...agentOptions, shellTarget }).
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

function main(): void {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'core', 'sessionManager.ts'),
    'utf-8',
  );

  // Walk every multi-line buildAgentLaunchCommand(...) call body and check
  // that the call args reference `shellTarget`. Easier to drive off the
  // matched-paren region than to write a brittle regex for both single-line
  // and multi-line forms.
  const callSites: string[] = [];
  let cursor = 0;
  while (true) {
    const idx = source.indexOf('buildAgentLaunchCommand(', cursor);
    if (idx < 0) break;
    // Skip the import statement itself.
    const lineStart = source.lastIndexOf('\n', idx) + 1;
    const lineSlice = source.slice(lineStart, idx);
    if (lineSlice.includes('import') || lineSlice.startsWith('//')) {
      cursor = idx + 1;
      continue;
    }
    let depth = 0;
    let i = idx + 'buildAgentLaunchCommand'.length;
    let endIdx = -1;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) { endIdx = i; break; }
      }
    }
    if (endIdx < 0) break;
    callSites.push(source.slice(idx, endIdx + 1));
    cursor = endIdx + 1;
  }

  assert.ok(
    callSites.length >= 5,
    `Expected at least 5 buildAgentLaunchCommand call sites (got ${callSites.length})`,
  );

  for (const site of callSites) {
    assert.ok(
      site.includes('shellTarget'),
      `Every buildAgentLaunchCommand call must thread shellTarget:\n${site}`,
    );
  }

  // Same check for buildAgentResumePlan — only the explicit-build sites, not
  // the canResume probe sites whose return value is only used as a boolean.
  // We approximate "explicit build" as "assigned to a const named resumePlan".
  const resumePlanCalls = source.match(/const resumePlan = buildAgentResumePlan\([\s\S]*?\);/g) || [];
  assert.ok(
    resumePlanCalls.length >= 1,
    'Expected at least one buildAgentResumePlan launch-build call',
  );
  for (const site of resumePlanCalls) {
    assert.ok(
      site.includes('shellTarget'),
      `Every resume-plan build call must thread shellTarget:\n${site}`,
    );
  }

  console.log('shellTargetEndToEndSmoke: ok');
}

main();
