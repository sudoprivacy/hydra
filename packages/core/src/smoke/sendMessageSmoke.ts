/**
 * Smoke test: sendMessage old method (send-keys -l) vs new method (load-buffer + paste-buffer).
 *
 * Two groups of tests:
 *
 * 1. **Enter-delivery tests** — messages up to ~4 KB (within the pty canonical-
 *    mode line buffer).  We run a `while read` loop in the tmux pane and verify
 *    that Enter actually arrives after the text.
 *
 * 2. **Large-message tests** — 100 KB / 500 KB payloads that exceed the shell
 *    ARG_MAX when passed via `send-keys -l`.  We only verify that the *send*
 *    does not throw; we skip the Enter-delivery check because the pty line
 *    buffer cannot hold that much un-newlined text in canonical mode (the
 *    production target — an AI agent TUI in raw mode — does not have that
 *    limitation).
 *
 * Run:  node out/smoke/sendMessageSmoke.js
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec } from '../core/exec';
import { shellQuote } from '../core/shell';

// ── helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function killSession(name: string): Promise<void> {
  try { await exec(`tmux kill-session -t ${shellQuote(name)}`); } catch { /* ignore */ }
}

// ── OLD method (send-keys -l + separate Enter) ──

async function sendMessageOld(session: string, message: string): Promise<void> {
  await exec(`tmux send-keys -l -t ${shellQuote(session)} ${shellQuote(message)}`);
  await sleep(100);
  await exec(`tmux send-keys -t ${shellQuote(session)} Enter`);
}

// ── NEW method (load-buffer + paste-buffer + separate Enter) ──

async function sendMessageNew(session: string, message: string): Promise<void> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const bufferName = `hydra-smoke-${suffix}`;
  const tmpFile = path.join(os.tmpdir(), `hydra-smoke-${suffix}`);
  try {
    fs.writeFileSync(tmpFile, message);
    await exec(`tmux load-buffer -b ${bufferName} ${shellQuote(tmpFile)}`);
    await exec(`tmux paste-buffer -b ${bufferName} -t ${shellQuote(session)} -d`);
    await sleep(100);
    await exec(`tmux send-keys -t ${shellQuote(session)} Enter`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* best-effort */ }
  }
}

// ── test infrastructure ──

interface TestCase {
  name: string;
  message: string;
}

type Method = 'old' | 'new';
type Outcome = { pass: boolean; error?: string };

// ── Group 1: Enter-delivery tests (message fits in pty line buffer) ──

const ENTER_TESTS: TestCase[] = [
  {
    name: 'simple message',
    message: 'hello world',
  },
  {
    name: 'single quotes',
    message: "It's a test with 'single' and 'nested' quotes",
  },
  {
    name: 'double quotes, backticks, dollar signs',
    message: 'A "quoted" `backtick` test with $PATH and ${HOME}',
  },
  {
    name: 'backslashes',
    message: 'C:\\Users\\test\\path and \\n \\t escaped chars',
  },
  {
    name: 'mixed special chars',
    message: `"hello" 'world' \`cmd\` $HOME \\path (parens) {braces} [brackets] | & ; # ~ !`,
  },
  {
    name: 'long message (1000 chars)',
    message: 'x'.repeat(1_000),
  },
  {
    name: 'embedded newlines',
    message: 'line1\nline2\nline3',
  },
];

async function runEnterTest(method: Method, tc: TestCase, index: number): Promise<Outcome> {
  const ts = Date.now();
  const session = `hydra-smoke-${method}-${index}-${ts}`;
  const recvFile = path.join(os.tmpdir(), `hydra-smoke-recv-${ts}-${Math.random().toString(36).slice(2)}`);

  try {
    try { fs.unlinkSync(recvFile); } catch { /* no-op */ }

    await exec(`tmux new-session -d -s ${shellQuote(session)} -x 200 -y 50`);
    await sleep(200);

    // Start a read-loop that writes a marker when a complete line is received
    const loop = `while IFS= read -r line; do echo GOT >> ${shellQuote(recvFile)}; done`;
    await exec(`tmux send-keys -t ${shellQuote(session)} ${shellQuote(loop)} Enter`);
    await sleep(400);

    // Send the test message
    const send = method === 'old' ? sendMessageOld : sendMessageNew;
    try {
      await send(session, tc.message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { pass: false, error: `send threw: ${msg.slice(0, 160)}` };
    }

    await sleep(600);

    // Check if Enter was received
    try {
      const content = fs.readFileSync(recvFile, 'utf-8');
      if (content.includes('GOT')) {
        return { pass: true };
      }
      return { pass: false, error: 'signal file exists but no GOT marker' };
    } catch {
      return { pass: false, error: 'Enter not received (signal file missing)' };
    }
  } finally {
    await killSession(session);
    try { fs.unlinkSync(recvFile); } catch { /* no-op */ }
  }
}

// ── Group 2: Large-message tests (send must not throw) ──

const LARGE_TESTS: TestCase[] = [
  { name: 'large message (100 KB)', message: 'x'.repeat(100_000) },
  { name: 'large message (500 KB)', message: 'x'.repeat(500_000) },
];

async function runLargeTest(method: Method, tc: TestCase, index: number): Promise<Outcome> {
  const ts = Date.now();
  const session = `hydra-smoke-lg-${method}-${index}-${ts}`;

  try {
    await exec(`tmux new-session -d -s ${shellQuote(session)} -x 200 -y 50`);
    await sleep(200);

    const send = method === 'old' ? sendMessageOld : sendMessageNew;
    try {
      await send(session, tc.message);
      return { pass: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { pass: false, error: `send threw: ${msg.slice(0, 160)}` };
    }
  } finally {
    await killSession(session);
  }
}

// ── main ──

async function main(): Promise<void> {
  try {
    await exec('which tmux');
  } catch {
    console.error('tmux is not installed — skipping smoke test');
    process.exit(0);
  }

  console.log('=== sendMessage smoke test ===\n');

  let anyNewFail = false;

  // ── Group 1: Enter-delivery ──
  console.log('--- Group 1: Enter delivery (text + Enter must both arrive) ---\n');

  for (const method of ['old', 'new'] as Method[]) {
    console.log(`  Method: ${method.toUpperCase()}`);
    for (let i = 0; i < ENTER_TESTS.length; i++) {
      const tc = ENTER_TESTS[i];
      const r = await runEnterTest(method, tc, i);
      const icon = r.pass ? 'PASS' : 'FAIL';
      console.log(`    [${icon}] ${tc.name}`);
      if (r.error) console.log(`           ${r.error}`);
      if (method === 'new' && !r.pass) anyNewFail = true;
    }
    console.log();
  }

  // ── Group 2: Large messages ──
  console.log('--- Group 2: Large messages (send must not throw) ---\n');

  for (const method of ['old', 'new'] as Method[]) {
    console.log(`  Method: ${method.toUpperCase()}`);
    for (let i = 0; i < LARGE_TESTS.length; i++) {
      const tc = LARGE_TESTS[i];
      const r = await runLargeTest(method, tc, i);
      const icon = r.pass ? 'PASS' : 'FAIL';
      console.log(`    [${icon}] ${tc.name}`);
      if (r.error) console.log(`           ${r.error}`);
      if (method === 'new' && !r.pass) anyNewFail = true;
    }
    console.log();
  }

  // ── Summary ──
  console.log('=== Summary ===');
  if (anyNewFail) {
    console.log('NEW method has failures — investigate.\n');
    process.exit(1);
  } else {
    console.log('NEW method passed all tests.');
    console.log('(OLD method may show expected failures for large messages due to ARG_MAX.)\n');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(2);
});
