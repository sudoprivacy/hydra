/**
 * Smoke for probePaneShellWithRetry (issue #225 §6, codex review round 1).
 *
 * The original detectPaneShell did a single show-options probe and silently
 * fell back to PowerShell on any error. Codex flagged that a transient probe
 * failure right after createSession (socket race, server restart) would
 * re-introduce the cmd.exe parse bug for users who'd configured cmd as
 * default-shell. The probe now retries up to 3 times, and the result surfaces
 * `usedFallback` so the caller can log a warning instead of swallowing.
 *
 * This smoke drives the retry helper with a mocked probe function so the test
 * runs on macOS/Linux without psmux.
 */

import assert from 'node:assert/strict';
import {
  probePaneShellWithRetry,
  type PaneShellProbe,
} from '../core/copilotSessionEnv';

async function main(): Promise<void> {
  const sleepCalls: number[] = [];
  const fakeSleep = async (ms: number): Promise<void> => { sleepCalls.push(ms); };

  // ── First-try success: no retries, no fallback ──
  {
    let calls = 0;
    const probe: PaneShellProbe = async () => { calls++; return 'cmd.exe'; };
    sleepCalls.length = 0;
    const r = await probePaneShellWithRetry(probe, { sleep: fakeSleep });
    assert.equal(r.shell, 'cmd');
    assert.equal(r.attempts, 1);
    assert.equal(r.usedFallback, false);
    assert.equal(calls, 1, 'no retry on first-try success');
    assert.equal(sleepCalls.length, 0, 'no sleep on first-try success');
  }

  // ── Transient failure then success: returns cmd, not silent pwsh fallback ──
  {
    let calls = 0;
    const probe: PaneShellProbe = async () => {
      calls++;
      if (calls < 3) throw new Error('transient psmux socket race');
      return 'cmd.exe';
    };
    sleepCalls.length = 0;
    const r = await probePaneShellWithRetry(probe, { sleep: fakeSleep });
    assert.equal(r.shell, 'cmd', 'transient failure must recover and report cmd');
    assert.equal(r.attempts, 3);
    assert.equal(r.usedFallback, false);
    assert.equal(calls, 3);
    assert.equal(sleepCalls.length, 2, 'two retries → two sleeps');
  }

  // ── Persistent failure: usedFallback signal + pwsh shell ──
  {
    let calls = 0;
    const probe: PaneShellProbe = async () => { calls++; throw new Error('persistent'); };
    sleepCalls.length = 0;
    const r = await probePaneShellWithRetry(probe, { sleep: fakeSleep });
    assert.equal(r.shell, 'pwsh', 'persistent failure falls back to pwsh');
    assert.equal(r.attempts, 3, 'default 3 attempts');
    assert.equal(r.usedFallback, true, 'usedFallback flag set so caller can log warning');
    assert.equal(calls, 3);
    assert.equal(sleepCalls.length, 2, 'sleep N-1 times for N attempts');
  }

  // ── Custom maxAttempts honored ──
  {
    let calls = 0;
    const probe: PaneShellProbe = async () => { calls++; throw new Error('x'); };
    sleepCalls.length = 0;
    const r = await probePaneShellWithRetry(probe, { sleep: fakeSleep, maxAttempts: 5 });
    assert.equal(r.attempts, 5);
    assert.equal(calls, 5);
    assert.equal(r.usedFallback, true);
  }

  // ── Classification: powershell variants → pwsh ──
  {
    const probe: PaneShellProbe = async () =>
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    const r = await probePaneShellWithRetry(probe, { sleep: fakeSleep });
    assert.equal(r.shell, 'pwsh');
    assert.equal(r.usedFallback, false);
  }

  console.log('paneShellProbeSmoke: ok');
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
