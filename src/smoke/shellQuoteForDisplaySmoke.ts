/**
 * Smoke for shellQuoteForDisplay + AgentCommandOptions.shellTarget (issue #225 §7).
 *
 * The exported quoting helper now takes a target ('posix' | 'cmd' | 'pwsh');
 * callers in sessionManager detect once and thread the same target through
 * buildAgentLaunchCommand / buildAgentResumePlan / withCopilotSessionEnv. This
 * smoke locks down each branch (so a future refactor that drops a parameter
 * trips here) and verifies the launch/resume builders honor the option.
 */

import assert from 'node:assert/strict';
import {
  buildAgentLaunchCommand,
  buildAgentResumePlan,
  defaultShellTarget,
  shellQuoteForDisplay,
} from '../core/agentConfig';

function main(): void {
  // ── shellQuoteForDisplay branches ──
  assert.equal(shellQuoteForDisplay('foo', 'posix'), `'foo'`);
  assert.equal(shellQuoteForDisplay("o'brien", 'posix'), `'o'\\''brien'`);
  assert.equal(shellQuoteForDisplay('a"b', 'posix'), `'a"b'`);

  assert.equal(shellQuoteForDisplay('foo', 'cmd'), '"foo"');
  assert.equal(shellQuoteForDisplay('a"b', 'cmd'), '"a""b"', 'cmd embedded quote → doubled');
  assert.equal(shellQuoteForDisplay('$x', 'cmd'), '"$x"', '`$` is literal to cmd');
  assert.equal(shellQuoteForDisplay('a`b', 'cmd'), '"a`b"', 'backtick is literal to cmd');

  assert.equal(shellQuoteForDisplay('foo', 'pwsh'), '"foo"');
  assert.equal(shellQuoteForDisplay('a"b', 'pwsh'), '"a`"b"', 'pwsh embedded quote → backtick-escaped');
  assert.equal(shellQuoteForDisplay('$x', 'pwsh'), '"`$x"', 'pwsh `$` → backtick-escaped');
  assert.equal(shellQuoteForDisplay('a`b', 'pwsh'), '"a``b"', 'pwsh backtick → doubled');

  // ── defaultShellTarget tracks process.platform ──
  const expectedDefault = process.platform === 'win32' ? 'pwsh' : 'posix';
  assert.equal(defaultShellTarget(), expectedDefault);

  // ── buildAgentLaunchCommand honors options.shellTarget ──
  // Claude with sessionId + task: both should be wrapped in cmd-style "…"
  const cmdLaunch = buildAgentLaunchCommand(
    'claude', 'claude',
    'fix the "bug"', 'sess-7',
    { shellTarget: 'cmd' },
  );
  assert.ok(cmdLaunch.includes('--session-id "sess-7"'), `cmd launch missing session-id quoting: ${cmdLaunch}`);
  assert.ok(cmdLaunch.includes('-- "fix the ""bug"""'), `cmd launch missing cmd-quoted task: ${cmdLaunch}`);
  assert.ok(!cmdLaunch.includes('`'), `cmd launch must not contain backticks: ${cmdLaunch}`);

  const pwshLaunch = buildAgentLaunchCommand(
    'claude', 'claude',
    'fix the "bug"', 'sess-7',
    { shellTarget: 'pwsh' },
  );
  assert.ok(pwshLaunch.includes('--session-id "sess-7"'), `pwsh launch missing session-id quoting: ${pwshLaunch}`);
  assert.ok(pwshLaunch.includes('-- "fix the `"bug`""'), `pwsh launch must backtick-escape internal "?: ${pwshLaunch}`);

  const posixLaunch = buildAgentLaunchCommand(
    'claude', 'claude',
    "it's broken", 'sess-7',
    { shellTarget: 'posix' },
  );
  assert.ok(posixLaunch.includes(`--session-id 'sess-7'`), `posix launch missing session-id quoting: ${posixLaunch}`);
  assert.ok(posixLaunch.includes(`-- 'it'\\''s broken'`), `posix launch must use POSIX single-quote escape: ${posixLaunch}`);

  // ── Codex / Gemini also honor shellTarget on launch ──
  const codexLaunch = buildAgentLaunchCommand('codex', 'codex', 'fix it', undefined, { shellTarget: 'cmd' });
  assert.ok(codexLaunch.endsWith('"fix it"'), `codex cmd launch: ${codexLaunch}`);

  const geminiLaunch = buildAgentLaunchCommand('gemini', 'gemini', 'fix it', undefined, { shellTarget: 'pwsh' });
  assert.ok(geminiLaunch.endsWith('"fix it"'), `gemini pwsh launch: ${geminiLaunch}`);

  // ── buildAgentResumePlan honors options.shellTarget for sessionId + workdir ──
  const codexResumeCmd = buildAgentResumePlan(
    'codex', 'codex', 'sess-7', 'C:\\Users\\me\\work',
    null, { shellTarget: 'cmd' },
  );
  assert.ok(codexResumeCmd && codexResumeCmd.strategy === 'command');
  if (codexResumeCmd?.strategy === 'command') {
    assert.ok(codexResumeCmd.command.includes('"C:\\Users\\me\\work"'), `codex cmd resume workdir: ${codexResumeCmd.command}`);
    assert.ok(codexResumeCmd.command.endsWith('"sess-7"'), `codex cmd resume sessionId: ${codexResumeCmd.command}`);
  }

  const codexResumePwsh = buildAgentResumePlan(
    'codex', 'codex', 'sess-7', '/home/me/work',
    null, { shellTarget: 'pwsh' },
  );
  if (codexResumePwsh?.strategy === 'command') {
    assert.ok(codexResumePwsh.command.includes('"/home/me/work"'), `codex pwsh resume workdir: ${codexResumePwsh.command}`);
  }

  const claudeResumePosix = buildAgentResumePlan(
    'claude', 'claude', 'sess-7', undefined,
    null, { shellTarget: 'posix' },
  );
  if (claudeResumePosix?.strategy === 'command') {
    assert.ok(
      claudeResumePosix.command.includes(`--resume 'sess-7'`),
      `claude posix resume: ${claudeResumePosix.command}`,
    );
  }

  console.log('shellQuoteForDisplaySmoke: ok');
}

main();
