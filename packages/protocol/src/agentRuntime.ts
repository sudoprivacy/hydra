// Optional structured runtimes are owned by the app service, independently of
// terminal workers. These type-only imports keep the protocol engine-free.
import type { AgentRuntimeEvent, AgentRuntimeSnapshot } from '@hydra/core/agentRuntime';
import type { ContentBlock, PromptResponse, ScodeQuestionResponse } from '@hydra/core/scodeAcp';

export type { AgentRuntimeEvent, AgentRuntimeSnapshot, ContentBlock, PromptResponse };

export interface AgentRuntimeConnectInput {
  id: string;
  kind: 'scode-acp';
  workspace: string;
  /** Executable followed by literal argv entries; never a shell command. */
  scodeArgv: string[];
  acpSessionId?: string;
  /** Private launch configuration; never included in snapshots or events. */
  env?: Record<string, string | null>;
  startupTimeoutMs?: number;
  closeTimeoutMs?: number;
  /** Defaults to cancellation. Manual mode exposes pending requests for an explicit answer. */
  permissionMode?: 'cancel' | 'manual';
  inputMode?: 'cancel' | 'manual';
}

export interface AgentRuntimeTargetInput { id: string }

export interface AgentRuntimeListResult {
  runtimes: AgentRuntimeSnapshot[];
  count: number;
}

export interface AgentRuntimePromptInput extends AgentRuntimeTargetInput {
  content: string | ContentBlock[];
}

export interface AgentRuntimePromptResult {
  runtimeId: string;
  /** Foreground prompt response; raw session/update messages arrive as notification events. */
  result: PromptResponse;
}

export interface AgentRuntimeActionResult {
  runtimeId: string;
  status: 'cancel-requested' | 'stopped' | 'answered';
}

export interface AgentRuntimePermissionInput extends AgentRuntimeTargetInput {
  requestId: string;
  /** An optionId from the pending request, or null to cancel. */
  optionId: string | null;
}

export interface AgentRuntimeQuestionInput extends AgentRuntimeTargetInput {
  requestId: string;
  /** Actual question IDs and offered values are validated by the runtime. Null cancels. */
  answers: ScodeQuestionResponse['answers'] | null;
}

export interface AgentRuntimeEventInput extends AgentRuntimeTargetInput {
  /** Replay the bounded diagnostic tail after this sequence, then follow live events. */
  afterSequence?: number;
}

export interface AgentRuntimeEventListResult {
  runtimeId: string;
  events: AgentRuntimeEvent[];
  count: number;
  lastSequence: number;
}
