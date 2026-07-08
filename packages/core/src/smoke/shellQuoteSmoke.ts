/**
 * Smoke for shellQuote / pwshQuote (issue #225 §5).
 *
 * shellQuote() is the universal cmd-bound quote helper. On Windows it must
 * produce strings that survive cmd.exe (which is what exec() dispatches to)
 * and ALSO parse correctly inside a PowerShell-as-shell context, since some
 * call sites (getTmuxCommand socket args) flow into the powershell.exe attach
 * body. The previous Windows branch used PowerShell backtick escapes, which
 * cmd.exe passes through literally — a value containing `"` corrupted the
 * command. cmd's `""` doubling is also a valid PowerShell escape (both
 * accepted inside `"…"`), so the same output works in both shells.
 *
 * pwshQuote stays single-quote-with-doubled-singles (PowerShell-only literal).
 */

import assert from 'node:assert/strict';
import { shellQuote, pwshQuote } from '../core/shell';

function withPlatform<T>(plat: 'linux' | 'darwin' | 'win32', fn: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: plat, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

function main(): void {
  // ── POSIX behavior (unchanged) ──
  withPlatform('linux', () => {
    assert.equal(shellQuote('foo'), `'foo'`);
    assert.equal(shellQuote("o'brien"), `'o'\\''brien'`);
    assert.equal(shellQuote('a"b'), `'a"b'`);
  });

  // ── Windows shellQuote: cmd-style `""` doubling ──
  withPlatform('win32', () => {
    assert.equal(shellQuote('foo'), '"foo"');
    assert.equal(shellQuote('a"b'), '"a""b"', 'embedded double quote must be doubled, not backtick-escaped');
    assert.equal(shellQuote("o'brien"), `"o'brien"`, 'single quotes are literal inside cmd "…"');

    // No backtick-escaped sequences must leak into shellQuote output, since
    // cmd.exe would pass the literal backtick through to the command.
    for (const value of ['plain', 'has "quote"', "has 'apos'", 'C:\\Users\\me', 'spaces are ok']) {
      const out = shellQuote(value);
      assert.ok(!out.includes('`"'), `shellQuote("${value}") must not contain backtick-escaped quote: ${out}`);
    }
  });

  // ── pwshQuote stays PS single-quote literal regardless of platform ──
  assert.equal(pwshQuote('foo'), `'foo'`);
  assert.equal(pwshQuote("o'brien"), `'o''brien'`);

  console.log('shellQuoteSmoke: ok');
}

main();
