import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildPosixTmuxAttachCommand,
  buildPowerShellTmuxAttachCommand,
  type TmuxAttachShellOptions,
} from '../utils/tmuxAttachShell';

const options: TmuxAttachShellOptions = {
  tmuxCommand: 'tmux',
  sessionName: "repo_worker'branch",
  storedEnvironmentScrubCommand: 'SCRUB_ENV',
  mouseScrollbackCommand: 'MOUSE_ON',
};

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function assertIdempotentCapabilities(command: string): void {
  assert.doesNotMatch(command, /set-option -a(?:g|q|gq|qg)* .*terminal-(?:features|overrides)/);
  assert.equal(count(command, "terminal-features[1000]"), 1);
  assert.equal(count(command, "terminal-overrides[1000]"), 1);
  assert.equal(count(command, 'xterm-256color:clipboard'), 1);
  assert.equal(count(command, '*:clipboard'), 1);
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
}

function assertPosixRuntimeSizing(): void {
  if (process.platform === 'win32') return;

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-tmux-attach-'));
  const fakeTmux = path.join(fixture, 'tmux');
  const fakeStty = path.join(fixture, 'stty');
  const tmuxLog = path.join(fixture, 'tmux.log');
  const sttyLog = path.join(fixture, 'stty.log');

  try {
    fs.writeFileSync(fakeTmux, [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$FAKE_TMUX_LOG"',
      'case " $* " in',
      '*" display-message "*) printf \'%s\\n\' "$FAKE_ATTACHED" ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(fakeStty, [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$FAKE_STTY_LOG"',
      'printf \'%s\\n\' "$FAKE_STTY_SIZE"',
    ].join('\n'), { mode: 0o755 });

    const command = buildPosixTmuxAttachCommand({
      ...options,
      tmuxCommand: posixQuote(fakeTmux),
      sessionName: 'worker',
      storedEnvironmentScrubCommand: ':',
      mouseScrollbackCommand: ':',
    });
    const baseEnv = {
      ...process.env,
      PATH: `${fixture}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_TMUX_LOG: tmuxLog,
      FAKE_STTY_LOG: sttyLog,
      FAKE_STTY_SIZE: '24 80',
    };

    const attached = spawnSync('/bin/sh', ['-c', command], {
      encoding: 'utf8',
      env: { ...baseEnv, FAKE_ATTACHED: '2' },
    });
    assert.equal(attached.status, 0, attached.stderr);
    assert.equal(readLines(sttyLog).length, 0, 'attached sessions must skip startup size sampling');
    const attachedTmuxCalls = readLines(tmuxLog).join('\n');
    assert.doesNotMatch(attachedTmuxCalls, /default-size|resize-window|window-size latest/);

    fs.writeFileSync(tmuxLog, '');
    fs.writeFileSync(sttyLog, '');
    const startedAt = Date.now();
    const detached = spawnSync('/bin/sh', ['-c', command], {
      encoding: 'utf8',
      env: { ...baseEnv, FAKE_ATTACHED: '0' },
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(detached.status, 0, detached.stderr);
    assert.equal(readLines(sttyLog).length, 3, 'initial sample plus two stable confirmations');
    assert.ok(elapsedMs >= 70, `detached startup guard returned too early: ${elapsedMs} ms`);
    const detachedTmuxCalls = readLines(tmuxLog).join('\n');
    assert.match(detachedTmuxCalls, /default-size 80x24/);
    assert.match(detachedTmuxCalls, /resize-window .* -x 80 -y 24/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

function main(): void {
  const posix = buildPosixTmuxAttachCommand(options);
  const powerShell = buildPowerShellTmuxAttachCommand(options);

  assertIdempotentCapabilities(posix);
  assertIdempotentCapabilities(powerShell);

  assert.match(posix, /display-message -p .*#\{session_attached\}/);
  assert.match(posix, /last_rows=.*last_cols=/);
  assert.match(posix, /stable_samples=.*stable_samples.*-ge 2/s);
  assert.match(posix, /sleep 0\.04/);
  assert.doesNotMatch(posix, /-ge 30|-ge 100|sleep 0\.08/);

  const firstAttachedGuard = posix.indexOf('if [ "$attached_clients" -eq 0 ]; then');
  const defaultSize = posix.indexOf('default-size');
  const resizeWindow = posix.indexOf('resize-window');
  const attach = posix.indexOf('exec tmux attach');
  assert.ok(firstAttachedGuard >= 0);
  assert.ok(defaultSize > firstAttachedGuard);
  assert.ok(resizeWindow > defaultSize);
  assert.ok(attach > resizeWindow);

  // The session name remains a single shell argument on both platforms.
  assert.match(posix, /-t 'repo_worker'\\''branch'/);
  assert.match(powerShell, /-t 'repo_worker''branch'/);

  assertPosixRuntimeSizing();

  console.log('tmuxAttachShellSmoke: ok');
}

main();
