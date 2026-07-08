// Sum the % CPU values that `ps -o %cpu= -p <pids>` prints on POSIX systems.
// Lives outside src/providers so smoke tests can import it without pulling in
// the vscode module. See issue #225 §4 — the surrounding `ps` probe is gated
// to non-Windows platforms; this parser stays generic.
export function parseCpuPercentSum(psOutput: string): number {
  return psOutput
    .split('\n')
    .filter(l => l.trim())
    .map(v => parseFloat(v.trim()) || 0)
    .reduce((a, b) => a + b, 0);
}
