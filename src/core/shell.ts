export function shellQuote(value: string): string {
  if (process.platform === 'win32') {
    // cmd.exe quoting: wrap in `"…"` and double any embedded double quote.
    // exec() dispatches via cmd.exe on Windows, where backtick is a literal
    // character — the previous PowerShell-style `` `" `` escape would have
    // been passed through verbatim once a value actually contained a `"`.
    // Doubled `""` is also a valid double-quote escape inside PowerShell's
    // `"…"` strings, so values that flow into a PowerShell-as-shell path
    // (e.g. the attach command body) parse correctly too. See issue #225 §5.
    return `"${value.replace(/"/g, '""')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function pwshQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
