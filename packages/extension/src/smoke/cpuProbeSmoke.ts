/**
 * Smoke for the TreeView CPU probe (issue #225 §4).
 *
 * The probe runs `ps -o %cpu= -p <pids>`, which has no Windows equivalent. On
 * Windows the call threw, the try/catch silently set cpuUsage = 0, and every
 * TreeView refresh wasted a child-process spawn. We can't change platform at
 * runtime, so this smoke verifies the parser stays correct on POSIX (no
 * regression) and that the exported function exists so callers/tests can
 * reach the parser without re-running `ps`.
 */

import assert from 'node:assert/strict';
import { parseCpuPercentSum } from '../utils/cpuPercent';

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

function main(): void {
  assert.equal(typeof parseCpuPercentSum, 'function');

  // Single line
  assert.ok(approx(parseCpuPercentSum('12.5'), 12.5));

  // Multiple lines (typical `ps -o %cpu= -p p1,p2`)
  assert.ok(approx(parseCpuPercentSum('1.0\n2.5\n0.3'), 3.8));

  // Whitespace and empty lines
  assert.ok(approx(parseCpuPercentSum('  4.0  \n\n  6.0  \n'), 10.0));

  // Garbage lines parse to 0 (parseFloat NaN → 0), don't crash
  assert.equal(parseCpuPercentSum(''), 0);
  assert.ok(approx(parseCpuPercentSum('not-a-number\n2.0'), 2.0));

  console.log('cpuProbeSmoke: ok');
}

main();
