/**
 * Smoke test for the typed AgentRegistry facade and behavior-preserving
 * command/prompt definitions.
 *
 * Run: node out/smoke/agentRegistrySmoke.js
 */

import assert from 'node:assert/strict';
import {
  AGENT_COMPLETION_NOTIFICATIONS,
  AGENT_DEFINITIONS,
  AGENT_LABELS,
  AGENT_READY_PATTERNS,
  AGENT_SESSION_CAPTURE,
  AGENT_YOLO_FLAGS,
  DEFAULT_AGENT_COMMANDS,
  GLOBAL_READY_PROMPT_HANDLERS,
  agentSupportsCompletionNotification,
  agentSupportsCopilotMode,
  buildAgentLaunchCommand,
  buildAgentResumePlan,
  getAgentDefaultCommand,
  getAgentDefinition,
  getAgentReadyPromptHandlers,
} from '../core/agentRegistry';

function assertCommand(plan: ReturnType<typeof buildAgentResumePlan>): string {
  assert.ok(plan && plan.strategy === 'command');
  return plan.command;
}

function handlerById(agentType: string, id: string) {
  const handler = getAgentReadyPromptHandlers(agentType).find(entry => entry.id === id);
  assert.ok(handler, `missing prompt handler ${id}`);
  return handler;
}

function testDefinitionsAndFacadeMaps(): void {
  assert.deepEqual(Object.keys(AGENT_DEFINITIONS).sort(), [
    'antigravity',
    'claude',
    'codex',
    'custom',
    'gemini',
    'sudocode',
  ]);

  assert.equal(AGENT_LABELS.claude, 'Claude');
  assert.equal(AGENT_LABELS.codex, 'Codex');
  assert.equal(AGENT_LABELS.gemini, 'Gemini');
  assert.equal(AGENT_LABELS.antigravity, 'Antigravity');
  assert.equal(AGENT_LABELS.sudocode, 'Sudo Code');
  assert.equal(AGENT_LABELS.custom, 'Custom');

  assert.deepEqual(DEFAULT_AGENT_COMMANDS, {
    claude: 'claude',
    codex: 'codex',
    gemini: 'gemini',
    antigravity: 'agy',
    sudocode: 'scode',
  });
  assert.equal((DEFAULT_AGENT_COMMANDS as Record<string, string | undefined>)['custom'], undefined);

  assert.equal(AGENT_YOLO_FLAGS.claude, '--dangerously-skip-permissions');
  assert.equal(AGENT_YOLO_FLAGS.codex, '--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust');
  assert.equal(AGENT_YOLO_FLAGS.gemini, '--yolo --skip-trust');
  assert.equal(AGENT_YOLO_FLAGS.antigravity, '--dangerously-skip-permissions');
  assert.equal(AGENT_YOLO_FLAGS.sudocode, '--dangerously-skip-permissions');
  assert.equal((AGENT_YOLO_FLAGS as Record<string, string | undefined>)['custom'], undefined);

  assert.ok(AGENT_READY_PATTERNS.claude.test('⏵'));
  assert.ok(AGENT_READY_PATTERNS.codex.test('›'));
  assert.ok(AGENT_READY_PATTERNS.gemini.test('⏵'));
  assert.ok(AGENT_READY_PATTERNS.antigravity.test('? for shortcuts'));
  assert.ok(AGENT_READY_PATTERNS.sudocode.test('\n❯ '));
  assert.equal((AGENT_READY_PATTERNS as Record<string, RegExp | undefined>)['custom'], undefined);

  assert.deepEqual(AGENT_COMPLETION_NOTIFICATIONS, {
    claude: true,
    codex: true,
    gemini: true,
    antigravity: true,
    sudocode: false,
    custom: false,
  });
}

function testCapabilityLookup(): void {
  assert.equal(getAgentDefinition('claude').id, 'claude');
  assert.equal(getAgentDefinition('unknown-agent').id, 'custom');
  assert.equal(getAgentDefaultCommand('codex'), 'codex');
  DEFAULT_AGENT_COMMANDS.codex = 'codex-smoke-override';
  assert.equal(getAgentDefaultCommand('codex'), 'codex-smoke-override');
  DEFAULT_AGENT_COMMANDS.codex = 'codex';
  assert.equal(getAgentDefaultCommand('unknown-agent'), undefined);

  assert.equal(agentSupportsCompletionNotification('claude'), true);
  assert.equal(agentSupportsCompletionNotification('codex'), true);
  assert.equal(agentSupportsCompletionNotification('gemini'), true);
  assert.equal(agentSupportsCompletionNotification('antigravity'), true);
  assert.equal(agentSupportsCompletionNotification('sudocode'), false);
  assert.equal(agentSupportsCompletionNotification('unknown-agent'), false);

  assert.equal(agentSupportsCopilotMode('claude', 'normal'), true);
  assert.equal(agentSupportsCopilotMode('claude', 'plan'), true);
  assert.equal(agentSupportsCopilotMode('codex', 'plan'), true);
  assert.equal(agentSupportsCopilotMode('gemini', 'plan'), false);
  assert.equal(agentSupportsCopilotMode('antigravity', 'normal'), true);
  assert.equal(agentSupportsCopilotMode('antigravity', 'plan'), false);
  assert.equal(agentSupportsCopilotMode('sudocode', 'plan'), false);
  assert.equal(agentSupportsCopilotMode('unknown-agent', 'plan'), false);
}

function testLaunchCommands(): void {
  assert.equal(
    buildAgentLaunchCommand(
      'claude',
      'claude',
      "fix user's bug",
      '11111111-1111-4111-8111-111111111111',
      { shellTarget: 'posix' },
    ),
    "claude --dangerously-skip-permissions --session-id '11111111-1111-4111-8111-111111111111' -- 'fix user'\\''s bug'",
  );
  assert.equal(
    buildAgentLaunchCommand('claude', 'claude', undefined, undefined, { copilotMode: 'plan' }),
    'claude --permission-mode plan',
  );

  assert.equal(
    buildAgentLaunchCommand('codex', 'codex', 'fix the "bug"', undefined, { shellTarget: 'cmd' }),
    'codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust "fix the ""bug"""',
  );
  assert.equal(
    buildAgentLaunchCommand('codex', 'codex', undefined, undefined, { copilotMode: 'plan' }),
    'codex --sandbox read-only --ask-for-approval never',
  );
  assert.equal(
    buildAgentLaunchCommand(
      'codex',
      'codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust',
    ),
    'codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust',
  );

  assert.equal(
    buildAgentLaunchCommand('gemini', 'gemini', 'fix `$x`', undefined, { shellTarget: 'pwsh' }),
    'gemini --yolo --skip-trust "fix ```$x``"',
  );
  assert.equal(
    buildAgentLaunchCommand('sudocode', 'scode', 'ignored task'),
    'scode --dangerously-skip-permissions',
  );

  assert.equal(
    buildAgentLaunchCommand('unknown-agent', 'my-agent --flag', 'ignored task'),
    'my-agent --flag',
  );
}

function testResumeCommands(): void {
  assert.equal(
    assertCommand(buildAgentResumePlan('claude', 'claude', 'sess 7', undefined, null, { shellTarget: 'posix' })),
    "claude --resume 'sess 7'",
  );
  assert.equal(
    assertCommand(buildAgentResumePlan('claude', 'claude', 'sess 7', undefined, null, { copilotMode: 'plan' })),
    "claude --permission-mode plan --resume 'sess 7'",
  );

  assert.equal(
    assertCommand(buildAgentResumePlan(
      'codex',
      'codex',
      'sess "7"',
      '/tmp/hydra work',
      null,
      { shellTarget: 'posix' },
    )),
    'codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust resume -C \'/tmp/hydra work\' \'sess "7"\'',
  );
  assert.equal(
    assertCommand(buildAgentResumePlan(
      'codex',
      'codex',
      'sess "7"',
      'C:\\Users\\me\\repo folder',
      null,
      { shellTarget: 'cmd' },
    )),
    'codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust resume -C "C:\\Users\\me\\repo folder" "sess ""7"""',
  );
  assert.equal(
    assertCommand(buildAgentResumePlan(
      'codex',
      'codex',
      'sess $7',
      'C:\\Users\\me\\repo folder',
      null,
      { shellTarget: 'pwsh' },
    )),
    'codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust resume -C "C:\\Users\\me\\repo folder" "sess `$7"',
  );

  assert.equal(
    assertCommand(buildAgentResumePlan('gemini', 'gemini', 'sess-7', undefined, null, { shellTarget: 'cmd' })),
    'gemini --resume "sess-7"',
  );

  const sudoPlan = buildAgentResumePlan(
    'sudocode',
    'scode',
    'session-1-0',
    '/workspace',
    '/tmp/hydra sessions/session-1-0.jsonl',
  );
  assert.deepEqual(sudoPlan, {
    strategy: 'replSlashCommand',
    command: 'scode --dangerously-skip-permissions',
    slashCommand: '/resume /tmp/hydra sessions/session-1-0.jsonl',
  });

  assert.equal(buildAgentResumePlan('unknown-agent', 'my-agent', 'sess-7'), null);
}

function testPlanSafety(): void {
  assert.throws(
    () => buildAgentLaunchCommand('claude', 'claude --dangerously-skip-permissions', undefined, undefined, { copilotMode: 'plan' }),
    /Planner mode cannot use unsafe agent flag "--dangerously-skip-permissions"/,
  );
  assert.throws(
    () => buildAgentLaunchCommand('codex', 'codex --dangerously-bypass-approvals-and-sandbox', undefined, undefined, { copilotMode: 'plan' }),
    /Planner mode cannot use unsafe agent flag "--dangerously-bypass-approvals-and-sandbox"/,
  );
  assert.throws(
    () => buildAgentLaunchCommand('gemini', 'gemini', undefined, undefined, { copilotMode: 'plan' }),
    /Planner mode is currently supported for Claude and Codex only/,
  );
  assert.throws(
    () => buildAgentLaunchCommand('sudocode', 'scode --dangerously-skip-permissions', undefined, undefined, { copilotMode: 'plan' }),
    /Planner mode cannot use unsafe agent flag "--dangerously-skip-permissions"/,
  );
  assert.throws(
    () => buildAgentLaunchCommand('unknown-agent', 'my-agent', undefined, undefined, { copilotMode: 'plan' }),
    /Agent "unknown-agent" is not supported/,
  );
  assert.throws(
    () => buildAgentLaunchCommand('unknown-agent', 'my-agent --yolo', undefined, undefined, { copilotMode: 'plan' }),
    /Planner mode cannot use unsafe agent flag "--yolo"/,
  );
  assert.throws(
    () => buildAgentResumePlan('gemini', 'gemini', 'sess-7', undefined, null, { copilotMode: 'plan' }),
    /Planner mode is currently supported for Claude and Codex only/,
  );
}

function testPromptHandlers(): void {
  const globalTrust = GLOBAL_READY_PROMPT_HANDLERS.find(handler => handler.id === 'claude-trust-folder');
  assert.ok(globalTrust);
  assert.equal(globalTrust.blocksReadiness, undefined);
  assert.deepEqual(globalTrust.handle('Do you trust this folder?'), { kind: 'sendKeys', keys: '' });

  assert.equal(getAgentReadyPromptHandlers('claude')[0].id, 'claude-trust-folder');
  assert.equal(getAgentReadyPromptHandlers('unknown-agent').length, 0);

  const codexTrust = handlerById('codex', 'codex-trust-directory');
  assert.equal(codexTrust.blocksReadiness, true);
  assert.deepEqual(codexTrust.handle('Do you trust the contents of this directory?'), { kind: 'sendKeys', keys: '' });

  const codexUpdate = handlerById('codex', 'codex-update-picker');
  assert.equal(codexUpdate.blocksReadiness, true);
  assert.deepEqual(
    codexUpdate.handle('Update available!\n1. Update now\n2. Skip\nPress enter to continue'),
    { kind: 'sendKeys', keys: 'Down' },
  );

  const codexHookReview = handlerById('codex', 'codex-hook-review');
  assert.equal(codexHookReview.blocksReadiness, true);
  assert.deepEqual(codexHookReview.handle('Hooks need review'), { kind: 'sendKeys', keys: 'Down' });

  const codexCwd = handlerById('codex', 'codex-resume-cwd-picker');
  assert.equal(codexCwd.blocksReadiness, true);
  assert.deepEqual(codexCwd.handle('Choose working directory to resume this session'), { kind: 'sendKeys', keys: '' });

  const geminiTrust = handlerById('gemini', 'gemini-trust-folder');
  assert.equal(geminiTrust.blocksReadiness, true);
  assert.deepEqual(geminiTrust.handle('Do you trust the files in this folder?'), { kind: 'sendKeys', keys: '' });

  const sudoBroadDirectory = handlerById('sudocode', 'sudocode-broad-directory');
  assert.equal(sudoBroadDirectory.blocksReadiness, false);
  assert.deepEqual(sudoBroadDirectory.handle('Continue anyway? [y/N]:'), { kind: 'sendKeys', keys: 'y' });
}

function testSessionCapture(): void {
  assert.equal(AGENT_SESSION_CAPTURE.codex?.statusCommand, '/status');
  assert.equal(
    AGENT_SESSION_CAPTURE.codex?.sessionIdPattern.exec('Session: 11111111-1111-4111-8111-111111111111')?.[1],
    '11111111-1111-4111-8111-111111111111',
  );
  assert.equal(AGENT_SESSION_CAPTURE.gemini?.statusCommand, '/stats');
  assert.equal(
    AGENT_SESSION_CAPTURE.gemini?.sessionIdPattern.exec('Session ID: 22222222-2222-4222-8222-222222222222')?.[1],
    '22222222-2222-4222-8222-222222222222',
  );
  assert.equal(AGENT_SESSION_CAPTURE.sudocode?.statusCommand, '/status');
  assert.equal(
    AGENT_SESSION_CAPTURE.sudocode?.sessionIdPattern.exec('Session session-1778831515919-0')?.[1],
    'session-1778831515919-0',
  );
  assert.equal(
    AGENT_SESSION_CAPTURE.sudocode?.sessionFilePattern?.exec('Auto-save .scode/sessions/a/session-1778831515919-0.jsonl')?.[1],
    '.scode/sessions/a/session-1778831515919-0.jsonl',
  );
  assert.equal(AGENT_SESSION_CAPTURE.custom, undefined);
}

function main(): void {
  testDefinitionsAndFacadeMaps();
  testCapabilityLookup();
  testLaunchCommands();
  testResumeCommands();
  testPlanSafety();
  testPromptHandlers();
  testSessionCapture();
  console.log('agentRegistrySmoke: ok');
}

main();
