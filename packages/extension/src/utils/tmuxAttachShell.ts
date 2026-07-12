const HYDRA_TMUX_CAPABILITY_INDEX = 1000;
const TERMINAL_FEATURES_OPTION = `terminal-features[${HYDRA_TMUX_CAPABILITY_INDEX}]`;
const TERMINAL_OVERRIDES_OPTION = `terminal-overrides[${HYDRA_TMUX_CAPABILITY_INDEX}]`;

const STARTUP_SIZE_SAMPLE_ATTEMPTS = 5;
const STARTUP_SIZE_SAMPLE_INTERVAL_SECONDS = '0.04';

export interface TmuxAttachShellOptions {
  tmuxCommand: string;
  sessionName: string;
  storedEnvironmentScrubCommand: string;
  mouseScrollbackCommand: string;
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build the PowerShell attach body used by the Windows psmux terminal.
 *
 * The capability options are arrays. Assigning Hydra's reserved high index is
 * idempotent, while `set-option -a` appended a duplicate on every attach.
 */
export function buildPowerShellTmuxAttachCommand(options: TmuxAttachShellOptions): string {
  const { tmuxCommand } = options;
  const target = powerShellQuote(options.sessionName);

  return [
    options.storedEnvironmentScrubCommand,
    `${tmuxCommand} set-option -gq set-clipboard on *>$null`,
    `${tmuxCommand} set-option -gq ${powerShellQuote(TERMINAL_FEATURES_OPTION)} ${powerShellQuote('xterm-256color:clipboard')} *>$null`,
    `${tmuxCommand} set-option -gq ${powerShellQuote(TERMINAL_OVERRIDES_OPTION)} ${powerShellQuote('*:clipboard')} *>$null`,
    options.mouseScrollbackCommand,
    `${tmuxCommand} set-window-option -gwq allow-passthrough on *>$null`,
    `${tmuxCommand} set-window-option -t ${target}:. window-size latest *>$null`,
    `${tmuxCommand} attach -t ${target}`,
  ].join('\n');
}

/**
 * Build the POSIX attach body used by the VS Code terminal.
 *
 * A detached tmux session starts at 80x24. VS Code may resize its PTY shortly
 * after terminal creation, so require two confirmations after the initial
 * positive sample before forcing the detached session to that size. Unlike the
 * old 100x30 threshold, this also settles a legitimately narrow terminal after
 * about 80 ms. If another client is already attached, skip all pre-attach
 * sizing so the shared tmux grid is not bounced between clients.
 */
export function buildPosixTmuxAttachCommand(options: TmuxAttachShellOptions): string {
  const { tmuxCommand } = options;
  const target = posixQuote(options.sessionName);
  const readAttachedClients = `${tmuxCommand} display-message -p -t ${target} '#{session_attached}' 2>/dev/null || true`;

  return [
    options.storedEnvironmentScrubCommand,
    `${tmuxCommand} set-option -gq set-clipboard on >/dev/null 2>&1 || true`,
    `${tmuxCommand} set-option -gq ${posixQuote(TERMINAL_FEATURES_OPTION)} ${posixQuote('xterm-256color:clipboard')} >/dev/null 2>&1 || true`,
    `${tmuxCommand} set-option -gq ${posixQuote(TERMINAL_OVERRIDES_OPTION)} ${posixQuote('*:clipboard')} >/dev/null 2>&1 || true`,
    options.mouseScrollbackCommand,
    `${tmuxCommand} set-window-option -gwq allow-passthrough on >/dev/null 2>&1 || true`,
    `attached_clients=$(${readAttachedClients})`,
    'case "$attached_clients" in',
    "''|*[!0-9]*) attached_clients=0 ;;",
    'esac',
    'if [ "$attached_clients" -eq 0 ]; then',
    "rows=''; cols=''; last_rows=''; last_cols=''; stable_samples=0; attempt=1",
    `while [ "$attempt" -le ${STARTUP_SIZE_SAMPLE_ATTEMPTS} ]; do`,
    'size=$(stty size 2>/dev/null || true)',
    'candidate_rows=${size%% *}',
    'candidate_cols=${size##* }',
    'if [ -n "$candidate_rows" ] && [ -n "$candidate_cols" ] && [ "$candidate_rows" -gt 0 ] && [ "$candidate_cols" -gt 0 ]; then',
    'rows="$candidate_rows"; cols="$candidate_cols"',
    'if [ "$candidate_rows" = "$last_rows" ] && [ "$candidate_cols" = "$last_cols" ]; then',
    'stable_samples=$((stable_samples + 1))',
    'if [ "$stable_samples" -ge 2 ]; then break; fi',
    'else',
    'stable_samples=0',
    'fi',
    'last_rows="$candidate_rows"; last_cols="$candidate_cols"',
    'fi',
    `[ "$attempt" -ge ${STARTUP_SIZE_SAMPLE_ATTEMPTS} ] && break`,
    `sleep ${STARTUP_SIZE_SAMPLE_INTERVAL_SECONDS}`,
    'attempt=$((attempt + 1))',
    'done',
    // Recheck after sampling: another VS Code window may have attached while
    // this terminal was waiting for its dimensions to settle.
    `attached_clients=$(${readAttachedClients})`,
    'case "$attached_clients" in',
    "''|*[!0-9]*) attached_clients=0 ;;",
    'esac',
    'if [ "$attached_clients" -eq 0 ]; then',
    `if [ -n "$rows" ] && [ "$rows" -ge 1 ] && [ "$cols" -ge 1 ]; then ${tmuxCommand} set-option -t ${target} default-size "\${cols}x\${rows}" >/dev/null 2>&1 || true; fi`,
    `if [ -n "$rows" ] && [ "$rows" -ge 1 ] && [ "$cols" -ge 1 ]; then ${tmuxCommand} resize-window -t ${target}:. -x "$cols" -y "$rows" >/dev/null 2>&1 || true; fi`,
    `${tmuxCommand} set-window-option -t ${target}:. window-size latest >/dev/null 2>&1 || true`,
    'fi',
    'fi',
    `exec ${tmuxCommand} attach -t ${target}`,
  ].join('\n');
}
