import { getTmuxCommand } from './path';
import { pwshQuote, shellQuote } from './shell';

export function buildTmuxMouseScrollbackCommand(sessionName: string): string {
  const tmuxCommand = getTmuxCommand();

  if (process.platform === 'win32') {
    return `${tmuxCommand} set-option -t ${pwshQuote(sessionName)} mouse on *>$null`;
  }

  return `${tmuxCommand} set-option -t ${shellQuote(sessionName)} mouse on >/dev/null 2>&1 || true`;
}
