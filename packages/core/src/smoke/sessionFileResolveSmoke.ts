/**
 * Smoke test: resolveAgentSessionFile resolves transcript paths for claude,
 * codex, gemini, and sudocode against fixture homes laid out under a temp
 * directory.
 *
 * Run:  node out/smoke/sessionFileResolveSmoke.js
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { encodeClaudeWorkdir, resolveAgentSessionFile } from '../core/path';

function withFakeHome<T>(fn: (home: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-session-resolve-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  try {
    return fn(dir);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFile(p: string, contents = ''): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
}

function testClaude(): void {
  withFakeHome((home) => {
    const workdir = '/Users/dev/code/myproj/.hydra/worktrees/feat-x';
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const encoded = encodeClaudeWorkdir(workdir);
    const expected = path.join(home, '.claude', 'projects', encoded, `${sessionId}.jsonl`);
    writeFile(expected, '{}\n');

    assert.equal(resolveAgentSessionFile('claude', workdir, sessionId), expected);
    assert.equal(resolveAgentSessionFile('claude', workdir, 'missing-id'), null);
    assert.equal(resolveAgentSessionFile('claude', workdir, null), null);
    assert.equal(resolveAgentSessionFile('claude', '', sessionId), null);
  });
}

function testClaudeWindowsEncoding(): void {
  // The encoder must work for Windows-style paths (drive-letter colon,
  // backslashes) and squash whitespace too, mirroring Claude Code's slugify.
  assert.equal(encodeClaudeWorkdir('C:\\Users\\dev\\proj'), 'C--Users-dev-proj');
  assert.equal(encodeClaudeWorkdir('C:\\Users\\dev\\My Project'), 'C--Users-dev-My-Project');
  assert.equal(encodeClaudeWorkdir('/Users/dev/.config'), '-Users-dev--config');

  withFakeHome((home) => {
    const workdir = 'C:\\Users\\dev\\proj';
    const sessionId = 'aaaa1111-bbbb-2222-cccc-333333333333';
    const expected = path.join(home, '.claude', 'projects', 'C--Users-dev-proj', `${sessionId}.jsonl`);
    writeFile(expected);
    assert.equal(resolveAgentSessionFile('claude', workdir, sessionId), expected);
  });
}

function testCodex(): void {
  withFakeHome((home) => {
    const sessionId = '019deccc-251c-7192-bf0d-e8ff36a0bb5e';
    const expected = path.join(
      home, '.codex', 'sessions', '2026', '05', '03',
      `rollout-2026-05-03T00-44-55-${sessionId}.jsonl`,
    );
    writeFile(expected, '');
    // Decoy from a different day with a different sessionId.
    writeFile(path.join(
      home, '.codex', 'sessions', '2026', '05', '02',
      'rollout-2026-05-02T10-00-00-deadbeef-dead-beef-dead-beefdeadbeef.jsonl',
    ));

    assert.equal(resolveAgentSessionFile('codex', '/any/workdir', sessionId), expected);
    assert.equal(resolveAgentSessionFile('codex', '/any/workdir', 'no-such-id'), null);
    assert.equal(resolveAgentSessionFile('codex', '/any/workdir', null), null);
  });
}

function testGemini(): void {
  withFakeHome((home) => {
    const workdir = '/Users/dev/code/myproj';
    const projectName = 'myproj';
    writeFile(
      path.join(home, '.gemini', 'projects.json'),
      JSON.stringify({ projects: { [workdir]: projectName, '/other/path': 'other' } }),
    );
    const expected = path.join(home, '.gemini', 'tmp', projectName, 'logs.json');
    writeFile(expected, '[]');

    assert.equal(resolveAgentSessionFile('gemini', workdir, 'unused-session-id'), expected);
    assert.equal(resolveAgentSessionFile('gemini', workdir, null), expected);
    assert.equal(resolveAgentSessionFile('gemini', '/not/in/projects', 'x'), null);
    assert.equal(resolveAgentSessionFile('gemini', '', 'x'), null);
  });
}

function testGeminiPathNormalization(): void {
  withFakeHome((home) => {
    const projectName = 'myproj';
    // Map key has trailing slash and an unnormalized `..` segment; the input
    // workdir is the canonical form. Lookup must succeed via canonicalization.
    const mapKey = '/Users/dev/code/sub/../myproj/';
    const inputWorkdir = '/Users/dev/code/myproj';
    writeFile(
      path.join(home, '.gemini', 'projects.json'),
      JSON.stringify({ projects: { [mapKey]: projectName } }),
    );
    const expected = path.join(home, '.gemini', 'tmp', projectName, 'logs.json');
    writeFile(expected, '[]');

    assert.equal(resolveAgentSessionFile('gemini', inputWorkdir, null), expected);
  });
}

function testGeminiMissingLogs(): void {
  withFakeHome((home) => {
    const workdir = '/Users/dev/code/myproj';
    writeFile(
      path.join(home, '.gemini', 'projects.json'),
      JSON.stringify({ projects: { [workdir]: 'myproj' } }),
    );
    // No logs.json on disk.
    assert.equal(resolveAgentSessionFile('gemini', workdir, null), null);
  });
}

function testSudoCode(): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-sudocode-resolve-'));
  try {
    const workdir = path.join(tmp, 'worktree');
    const sessionId = 'session-1778831515919-0';
    const expected = path.join(workdir, '.scode', 'sessions', 'ea44ee3d072f6b6a', `${sessionId}.jsonl`);
    writeFile(expected, '{}\n');

    assert.equal(resolveAgentSessionFile('sudocode', workdir, sessionId), expected);
    assert.equal(resolveAgentSessionFile('sudocode', workdir, 'session-000-0'), null);
    assert.equal(resolveAgentSessionFile('sudocode', workdir, null), null);
    assert.equal(resolveAgentSessionFile('sudocode', '', sessionId), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testSudoCodeWorkspaceMismatch(): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-sudocode-mismatch-'));
  try {
    const oldWorkdir = path.join(tmp, 'old-worktree');
    const newWorkdir = path.join(tmp, 'new-worktree');
    const sessionId = 'session-1778843662908-0';
    const movedSessionFile = path.join(newWorkdir, '.scode', 'sessions', 'hash', `${sessionId}.jsonl`);
    writeFile(
      movedSessionFile,
      `${JSON.stringify({ type: 'session_meta', session_id: sessionId, workspace_root: oldWorkdir })}\n`,
    );

    assert.equal(resolveAgentSessionFile('sudocode', newWorkdir, sessionId), null);
    assert.equal(resolveAgentSessionFile('sudocode', newWorkdir, sessionId, movedSessionFile), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testPersistedSessionFileFallback(): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-persisted-session-'));
  try {
    const persisted = path.join(tmp, 'archived.jsonl');
    writeFile(persisted, '{}\n');
    assert.equal(resolveAgentSessionFile('sudocode', '/missing/workdir', 'session-1-0', persisted), persisted);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testUnknownAgent(): void {
  withFakeHome(() => {
    assert.equal(resolveAgentSessionFile('unknown', '/x', 'y'), null);
  });
}

function testCodexUuidV7FastPath(): void {
  withFakeHome((home) => {
    // UUIDv7 with first 48 bits = 0x019deccc251c (~ 2026-05-03 UTC).
    const sessionId = '019deccc-251c-7192-bf0d-e8ff36a0bb5e';
    const expected = path.join(
      home, '.codex', 'sessions', '2026', '05', '03',
      `rollout-2026-05-03T00-44-55-${sessionId}.jsonl`,
    );
    writeFile(expected);
    // Decoy on a different (closer in date) day with a different sessionId; the
    // fast path should never even visit this directory.
    writeFile(path.join(
      home, '.codex', 'sessions', '2026', '05', '04',
      'rollout-2026-05-04T00-00-00-019decff-ffff-7000-8000-000000000000.jsonl',
    ));

    assert.equal(resolveAgentSessionFile('codex', '/any', sessionId), expected);
  });
}

function testCodexNonV7FallsBackToScan(): void {
  withFakeHome((home) => {
    // Non-v7 sessionId → fast path returns null, scan must still find it.
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const expected = path.join(
      home, '.codex', 'sessions', '2025', '12', '01',
      `rollout-2025-12-01T10-00-00-${sessionId}.jsonl`,
    );
    writeFile(expected);
    assert.equal(resolveAgentSessionFile('codex', '/any', sessionId), expected);
  });
}

function main(): void {
  testClaude();
  testClaudeWindowsEncoding();
  testCodex();
  testCodexUuidV7FastPath();
  testCodexNonV7FallsBackToScan();
  testGemini();
  testGeminiPathNormalization();
  testGeminiMissingLogs();
  testSudoCode();
  testSudoCodeWorkspaceMismatch();
  testPersistedSessionFileFallback();
  testUnknownAgent();
  console.log('sessionFileResolveSmoke: ok');
}

main();
