import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { execFile, type ExecOptions } from './exec';
import { getTmuxSocketArgs } from './path';
import type {
  CreateTerminalPaneOptions,
  TerminalPaneController,
  TerminalPaneSnapshot,
} from './types';

const FIELD_SEPARATOR = '\u001f';
const MAX_PANES = 4;

/**
 * psmux on Windows does not support custom pane-scoped options (set-option -p
 * @hydra-*). When this returns true, pane metadata is stored in a
 * session-scoped JSON map instead.
 */
function isPsmux(): boolean {
  return process.platform === 'win32';
}

interface PaneMeta {
  role?: string;
  label?: string;
  requestId?: string;
}

interface RawPane {
  sessionName: string;
  windowId: string;
  paneId: string;
  paneIndex: number;
  active: boolean;
  title: string;
  currentCommand: string;
  currentPath: string;
  role: string;
  label: string;
  requestId: string;
}

function parsePaneIndex(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseRawPane(line: string): RawPane | undefined {
  const fields = line.split(FIELD_SEPARATOR);
  if (fields.length < 11) return undefined;
  const [
    sessionName,
    windowId,
    paneId,
    paneIndex,
    active,
    title,
    currentCommand,
    currentPath,
    role,
    label,
    ...requestIdParts
  ] = fields;
  if (!sessionName || !windowId || !paneId) return undefined;
  return {
    sessionName,
    windowId,
    paneId,
    paneIndex: parsePaneIndex(paneIndex),
    active: active === '1',
    title,
    currentCommand,
    currentPath,
    role,
    label,
    requestId: requestIdParts.join(FIELD_SEPARATOR),
  };
}

function tmuxBinary(): string {
  return process.platform === 'win32' ? 'psmux' : 'tmux';
}

function humanizeAgent(agent: string): string {
  return agent
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

async function runTmux(args: readonly string[], options?: ExecOptions): Promise<string> {
  return execFile(tmuxBinary(), [...getTmuxSocketArgs(), ...args], options);
}

async function bestEffortTmux(args: readonly string[]): Promise<void> {
  try {
    await runTmux(args, { logFailure: false });
  } catch {
    // Cleanup and presentation settings must not mask the primary outcome.
  }
}

export class TmuxTerminalPaneController implements TerminalPaneController {
  async initializeAgentPane(sessionName: string): Promise<string> {
    const paneId = await runTmux([
      'display-message', '-p', '-t', sessionName, '#{pane_id}',
    ]);
    if (!paneId.startsWith('%')) {
      throw new Error(`Unable to resolve the initial Agent pane for tmux session "${sessionName}"`);
    }
    await this.markAgentPane(sessionName, paneId, 'Agent');
    return paneId;
  }

  async setAgentTitle(sessionName: string, agent: string): Promise<void> {
    const paneId = await this.resolveAgentPane(sessionName);
    const normalizedAgent = agent.trim();
    const title = normalizedAgent ? `Agent · ${humanizeAgent(normalizedAgent)}` : 'Agent';
    await runTmux(['select-pane', '-t', paneId, '-T', title]);
  }

  async resolveAgentPane(sessionName: string): Promise<string> {
    const [storedPaneId, panes] = await Promise.all([
      runTmux(['show-options', '-qv', '-t', sessionName, '@hydra-agent-pane'], {
        logFailure: false,
      }).catch(() => ''),
      this.listRawPanes(),
    ]);

    if (storedPaneId) {
      const storedPane = panes.find(pane => pane.paneId === storedPaneId);
      if (!storedPane) {
        throw new Error(`Agent pane ${storedPaneId} is no longer running in tmux session "${sessionName}"`);
      }
      if (storedPane.sessionName !== sessionName) {
        throw new Error(`Refusing tmux session "${sessionName}": Agent pane metadata belongs to another session`);
      }
      if (storedPane.role !== 'agent' || storedPane.label !== 'Agent') {
        await this.markAgentPane(sessionName, storedPaneId, 'Agent');
      }
      return storedPaneId;
    }

    const sessionPanes = panes.filter(pane => pane.sessionName === sessionName);
    if (sessionPanes.length === 1) {
      await this.markAgentPane(sessionName, sessionPanes[0].paneId, 'Agent');
      return sessionPanes[0].paneId;
    }
    if (sessionPanes.length === 0) {
      throw new Error(`tmux session "${sessionName}" has no panes`);
    }
    throw new Error(
      `tmux session "${sessionName}" has multiple panes but no Agent pane metadata; restart it before managing panes`,
    );
  }

  async list(sessionName: string): Promise<TerminalPaneSnapshot[]> {
    const agentPaneId = await this.resolveAgentPane(sessionName);
    const panes = await this.listRawPanes();
    const agentPane = panes.find(pane => pane.paneId === agentPaneId);
    if (!agentPane || agentPane.sessionName !== sessionName) {
      throw new Error(`Agent pane ${agentPaneId} is no longer running in tmux session "${sessionName}"`);
    }
    return panes
      .filter(pane => pane.sessionName === sessionName && pane.windowId === agentPane.windowId)
      .sort((left, right) => left.paneIndex - right.paneIndex)
      .map(pane => this.toSnapshot(pane, agentPaneId));
  }

  async create(
    sessionName: string,
    options: CreateTerminalPaneOptions,
  ): Promise<TerminalPaneSnapshot[]> {
    const agentPaneId = await this.resolveAgentPane(sessionName);
    const before = await this.listRawPanes();
    const agentPane = before.find(pane => pane.paneId === agentPaneId);
    if (!agentPane || agentPane.sessionName !== sessionName) {
      throw new Error(`Agent pane ${agentPaneId} is no longer running in tmux session "${sessionName}"`);
    }

    const existing = before.find(pane => (
      pane.sessionName === sessionName
      && pane.windowId === agentPane.windowId
      && pane.role === 'shell'
      && pane.requestId === options.requestId
    ));
    if (existing) return this.list(sessionName);

    const managedWindow = before.filter(pane => (
      pane.sessionName === sessionName && pane.windowId === agentPane.windowId
    ));
    if (managedWindow.length >= MAX_PANES) {
      throw new Error(`This terminal already has ${MAX_PANES} panes. Close a shell pane before creating another.`);
    }

    const target = managedWindow.find(pane => pane.paneId === options.targetPaneId);
    if (!target) {
      throw new Error(`Pane ${options.targetPaneId} does not belong to the Agent window in session "${sessionName}"`);
    }

    const splitFlag = options.direction === 'right' ? '-h' : '-v';
    const percentage = options.direction === 'right' ? '40' : '35';
    const shellNumber = this.nextShellNumber(managedWindow);
    const label = `Shell ${shellNumber}`;
    const paneTitle = `${label} · ${path.basename(options.cwd) || options.cwd}`;
    let paneId: string | undefined;
    let committed = false;

    try {
      paneId = await runTmux([
        'split-window', splitFlag, '-p', percentage,
        '-P', '-F', '#{pane_id}',
        '-t', target.paneId,
        '-c', options.cwd,
      ]);
      if (!paneId.startsWith('%')) {
        throw new Error(`tmux did not return a pane ID while creating ${label}`);
      }

      await this.setPaneMeta(sessionName, paneId, {
        role: 'shell',
        label,
        requestId: options.requestId,
      });
      await runTmux(['select-pane', '-t', paneId, '-T', paneTitle]);
      await this.updatePaneBorders(agentPane.windowId, managedWindow.length + 1);

      if (options.command !== undefined) {
        await this.pasteCommand(paneId, options.command);
      }
      committed = true;
      return await this.list(sessionName);
    } catch (error) {
      if (paneId && !committed) {
        await bestEffortTmux(['kill-pane', '-t', paneId]);
        try {
          await this.updatePaneBorders(agentPane.windowId, managedWindow.length);
        } catch {
          // Preserve the original create failure after best-effort rollback.
        }
      }
      throw error;
    }
  }

  async focus(sessionName: string, paneId: string): Promise<TerminalPaneSnapshot[]> {
    const { agentPane, target } = await this.resolveTargetInAgentWindow(sessionName, paneId);
    await runTmux(['select-window', '-t', agentPane.windowId]);
    await runTmux(['select-pane', '-t', target.paneId]);
    return this.list(sessionName);
  }

  async close(sessionName: string, paneId: string): Promise<{
    outcome: 'closed' | 'already-closed';
    panes: TerminalPaneSnapshot[];
  }> {
    const agentPaneId = await this.resolveAgentPane(sessionName);
    if (paneId === agentPaneId) {
      throw new Error('The Agent pane is protected and cannot be closed');
    }

    const panes = await this.listRawPanes();
    const agentPane = panes.find(pane => pane.paneId === agentPaneId);
    if (!agentPane || agentPane.sessionName !== sessionName) {
      throw new Error(`Agent pane ${agentPaneId} is no longer running in tmux session "${sessionName}"`);
    }

    const target = panes.find(pane => pane.paneId === paneId);
    if (!target) {
      return { outcome: 'already-closed', panes: await this.list(sessionName) };
    }
    if (target.sessionName !== sessionName) {
      throw new Error(`Refusing to close pane ${paneId}: it belongs to another tmux session`);
    }
    if (target.windowId !== agentPane.windowId) {
      throw new Error(`Refusing to close pane ${paneId}: it is outside the Agent window`);
    }
    if (target.role !== 'shell') {
      throw new Error(`Pane ${paneId} is external to Hydra and cannot be closed here`);
    }

    // Repeat the ownership/role guard immediately before the destructive call.
    const current = (await this.listRawPanes()).find(pane => pane.paneId === paneId);
    if (!current) {
      return { outcome: 'already-closed', panes: await this.list(sessionName) };
    }
    if (
      current.sessionName !== sessionName
      || current.windowId !== agentPane.windowId
      || current.role !== 'shell'
    ) {
      throw new Error(`Refusing to close pane ${paneId}: tmux pane ownership changed`);
    }

    await runTmux(['kill-pane', '-t', paneId]);
    await this.removePaneMeta(sessionName, paneId);
    if (current.active) {
      await runTmux(['select-window', '-t', agentPane.windowId]);
      await runTmux(['select-pane', '-t', agentPaneId]);
    }
    const remaining = await this.list(sessionName);
    try {
      await this.updatePaneBorders(agentPane.windowId, remaining.length);
    } catch {
      // The requested pane is already closed; border titles are presentation-only.
    }
    return { outcome: 'closed', panes: remaining };
  }

  private async markAgentPane(sessionName: string, paneId: string, label: string): Promise<void> {
    await runTmux(['set-option', '-t', sessionName, '@hydra-agent-pane', paneId]);
    await this.setPaneMeta(sessionName, paneId, { role: 'agent', label });
    await runTmux(['select-pane', '-t', paneId, '-T', label]);
  }

  /**
   * Persist per-pane metadata.  On real tmux, each field is stored as a custom
   * pane option (`set-option -p`).  On psmux (Windows) custom pane options are
   * not supported, so all fields are packed into a session-scoped JSON map
   * (`@hydra-pane-meta`) keyed by pane id.
   */
  private async setPaneMeta(sessionName: string, paneId: string, meta: PaneMeta): Promise<void> {
    if (isPsmux()) {
      const map = await this.readSessionPaneMeta(sessionName);
      map[paneId] = { ...map[paneId], ...meta };
      await runTmux([
        'set-option', '-t', sessionName,
        '@hydra-pane-meta', JSON.stringify(map),
      ]);
    } else {
      if (meta.role !== undefined) {
        await runTmux(['set-option', '-p', '-t', paneId, '@hydra-pane-role', meta.role]);
      }
      if (meta.label !== undefined) {
        await runTmux(['set-option', '-p', '-t', paneId, '@hydra-pane-label', meta.label]);
      }
      if (meta.requestId !== undefined) {
        await runTmux([
          'set-option', '-p', '-t', paneId,
          '@hydra-pane-request-id', meta.requestId,
        ]);
      }
    }
  }

  /** Remove a pane's entry from the session-scoped metadata map (psmux only). */
  private async removePaneMeta(sessionName: string, paneId: string): Promise<void> {
    if (!isPsmux()) return;
    try {
      const map = await this.readSessionPaneMeta(sessionName);
      if (!(paneId in map)) return;
      delete map[paneId];
      if (Object.keys(map).length === 0) {
        await runTmux([
          'set-option', '-u', '-t', sessionName, '@hydra-pane-meta',
        ]);
      } else {
        await runTmux([
          'set-option', '-t', sessionName,
          '@hydra-pane-meta', JSON.stringify(map),
        ]);
      }
    } catch {
      // Best-effort cleanup; the pane is already gone.
    }
  }

  /** Read the session-scoped `@hydra-pane-meta` JSON map, returning {} on missing/corrupt data. */
  private async readSessionPaneMeta(sessionName: string): Promise<Record<string, PaneMeta>> {
    try {
      const raw = await runTmux(
        ['show-options', '-qv', '-t', sessionName, '@hydra-pane-meta'],
        { logFailure: false },
      );
      if (raw) return JSON.parse(raw) as Record<string, PaneMeta>;
    } catch {
      // Missing or corrupt — start fresh.
    }
    return {};
  }

  /**
   * On psmux, per-pane format variables (`#{@hydra-pane-role}` etc.) resolve to
   * empty strings.  Fill in role/label/requestId from the session-scoped JSON
   * map so that pane classification works identically to real tmux.
   */
  private async enrichFromSessionMeta(panes: RawPane[]): Promise<void> {
    const sessionNames = [...new Set(panes.map(p => p.sessionName))];
    const metaBySession = new Map<string, Record<string, PaneMeta>>();
    await Promise.all(sessionNames.map(async (name) => {
      const map = await this.readSessionPaneMeta(name);
      if (Object.keys(map).length > 0) metaBySession.set(name, map);
    }));
    for (const pane of panes) {
      const sessionMeta = metaBySession.get(pane.sessionName);
      if (!sessionMeta) continue;
      const meta = sessionMeta[pane.paneId];
      if (!meta) continue;
      if (!pane.role && meta.role) pane.role = meta.role;
      if (!pane.label && meta.label) pane.label = meta.label;
      if (!pane.requestId && meta.requestId) pane.requestId = meta.requestId;
    }
  }

  private async listRawPanes(): Promise<RawPane[]> {
    const format = [
      '#{session_name}',
      '#{window_id}',
      '#{pane_id}',
      '#{pane_index}',
      '#{pane_active}',
      '#{pane_title}',
      '#{pane_current_command}',
      '#{pane_current_path}',
      '#{@hydra-pane-role}',
      '#{@hydra-pane-label}',
      '#{@hydra-pane-request-id}',
    ].join(FIELD_SEPARATOR);
    const output = await runTmux(['list-panes', '-a', '-F', format]);
    const panes = output.split('\n')
      .filter(Boolean)
      .map(parseRawPane)
      .filter((pane): pane is RawPane => pane !== undefined);

    // On psmux (Windows) the per-pane format variables above resolve to empty
    // strings because psmux does not support custom pane-scoped options.
    // Hydrate role/label/requestId from the session-scoped JSON map instead.
    if (isPsmux()) {
      await this.enrichFromSessionMeta(panes);
    }

    return panes;
  }

  private async resolveTargetInAgentWindow(
    sessionName: string,
    paneId: string,
  ): Promise<{ agentPane: RawPane; target: RawPane }> {
    const agentPaneId = await this.resolveAgentPane(sessionName);
    const panes = await this.listRawPanes();
    const agentPane = panes.find(pane => pane.paneId === agentPaneId);
    const target = panes.find(pane => pane.paneId === paneId);
    if (!agentPane || agentPane.sessionName !== sessionName) {
      throw new Error(`Agent pane ${agentPaneId} is no longer running in tmux session "${sessionName}"`);
    }
    if (!target || target.sessionName !== sessionName || target.windowId !== agentPane.windowId) {
      throw new Error(`Pane ${paneId} does not belong to the Agent window in session "${sessionName}"`);
    }
    return { agentPane, target };
  }

  private toSnapshot(pane: RawPane, agentPaneId: string): TerminalPaneSnapshot {
    const role = pane.paneId === agentPaneId
      ? 'agent'
      : pane.role === 'shell'
        ? 'shell'
        : 'external';
    const label = role === 'agent'
      ? 'Agent'
      : role === 'shell'
        ? pane.label || 'Shell'
        : pane.label || `Pane ${pane.paneIndex}`;
    return {
      paneId: pane.paneId,
      windowId: pane.windowId,
      paneIndex: pane.paneIndex,
      title: pane.title || label,
      label,
      role,
      active: pane.active,
      currentCommand: pane.currentCommand || null,
      currentPath: pane.currentPath || null,
      canClose: role === 'shell',
    };
  }

  private nextShellNumber(panes: RawPane[]): number {
    const used = new Set(panes.flatMap(pane => {
      const match = /^Shell (\d+)$/.exec(pane.label);
      return match ? [Number.parseInt(match[1], 10)] : [];
    }));
    let candidate = 1;
    while (used.has(candidate)) candidate += 1;
    return candidate;
  }

  private async updatePaneBorders(windowId: string, paneCount: number): Promise<void> {
    if (paneCount <= 1) {
      await bestEffortTmux(['set-option', '-w', '-t', windowId, 'pane-border-status', 'off']);
      return;
    }
    await runTmux(['set-option', '-w', '-t', windowId, 'pane-border-status', 'top']);
    await runTmux([
      'set-option', '-w', '-t', windowId,
      'pane-border-format', ' #{?pane_active,#[bold],}#{pane_title}#[default] ',
    ]);
  }

  private async pasteCommand(paneId: string, command: string): Promise<void> {
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const bufferName = `hydra-pane-${suffix}`;
    const tempFile = path.join(os.tmpdir(), `hydra-pane-command-${suffix}`);
    let bufferLoaded = false;
    try {
      fs.writeFileSync(tempFile, command, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await runTmux(['load-buffer', '-b', bufferName, tempFile]);
      bufferLoaded = true;
      await runTmux(['paste-buffer', '-b', bufferName, '-t', paneId, '-d']);
      bufferLoaded = false;
      await runTmux(['send-keys', '-t', paneId, 'Enter']);
    } finally {
      if (bufferLoaded) await bestEffortTmux(['delete-buffer', '-b', bufferName]);
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // Best-effort removal if a preceding write or tmux operation failed.
      }
    }
  }
}
