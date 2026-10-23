import { runScodeMcp as runSharedScodeMcp } from '@sudocode/acp/mcp';
import { registerCommandShutdown } from '../commandLifetime';
export type { ScodeMcpConfig } from '@sudocode/acp/mcp';

/** The application owns shutdown; protocol and MCP behavior are shared. */
export function runScodeMcp(file: string): Promise<void> {
  return runSharedScodeMcp(file, { registerShutdown: registerCommandShutdown });
}
