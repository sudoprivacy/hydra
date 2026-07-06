import * as fs from 'fs';
import {
  CopilotItem,
  GitStatusItem,
  InactiveDetailItem,
  InactiveWorktreeItem,
  TmuxDetailItem,
  TmuxItem,
  TmuxSessionItem,
  WorktreeItem,
} from '../providers/tmuxSessionProvider';
import { getHydraSessionsFile } from '../core/path';
import { getActiveBackend } from '../utils/multiplexer';

interface SessionStateEntry {
  sessionName?: string;
  displayName?: string;
  workerId?: number;
  branch?: string;
  slug?: string;
  workdir?: string;
  agent?: string;
}

interface SessionStateFile {
  copilots?: Record<string, SessionStateEntry>;
  workers?: Record<string, SessionStateEntry>;
}

export type HydraSessionKind = 'worker' | 'copilot';

export interface HydraSessionChoice {
  kind: HydraSessionKind;
  sessionName: string;
  label: string;
  worktreePath?: string;
  workerId?: number;
  agent?: string;
}

function getStringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' && candidate ? candidate : undefined;
}

function getNestedStringField(value: unknown, objectField: string, stringField: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return getStringField((value as Record<string, unknown>)[objectField], stringField);
}

function getLabelText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return getStringField(value, 'label');
}

function getTooltipText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return getStringField(value, 'value');
}

function unique(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function getItemTextFields(item?: unknown): string[] {
  if (typeof item === 'string') return [item];
  if (!item || typeof item !== 'object') return [];
  const record = item as unknown as Record<string, unknown>;
  return unique([
    getLabelText(record.label),
    getStringField(item, 'description'),
    getTooltipText(record.tooltip),
    getNestedStringField(item, 'accessibilityInformation', 'label'),
    getStringField(item, 'id'),
    getStringField(item, 'contextValue'),
  ]);
}

function getItemSessionName(item?: unknown): string | undefined {
  return getStringField(item, 'sessionName') ||
    getStringField(item, 'targetSessionName') ||
    getNestedStringField(item, 'session', 'name');
}

function normalizeDisplayLabel(label: string): string {
  return label
    .replace(/^Review:\s*/, '')
    .replace(/:\s+\d+\s+changes\b.*$/, '')
    .replace(/\s+#\d+.*$/, '')
    .replace(/\s+\[[^\]]+\]$/, '')
    .trim();
}

function readSessionState(): SessionStateFile {
  try {
    const sessionsFile = getHydraSessionsFile();
    if (!fs.existsSync(sessionsFile)) return {};
    return JSON.parse(fs.readFileSync(sessionsFile, 'utf-8')) as SessionStateFile;
  } catch {
    return {};
  }
}

function getEntries(state: SessionStateFile): [HydraSessionKind, string, SessionStateEntry][] {
  return [
    ...Object.entries(state.workers || {}).map(([key, entry]): [HydraSessionKind, string, SessionStateEntry] => ['worker', key, entry]),
    ...Object.entries(state.copilots || {}).map(([key, entry]): [HydraSessionKind, string, SessionStateEntry] => ['copilot', key, entry]),
  ];
}

function findEntryByText(state: SessionStateFile, texts: string[]): [HydraSessionKind, SessionStateEntry] | undefined {
  const workerId = texts
    .map(text => text.match(/\B#(\d+)\b/)?.[1] || text.match(/\bWorker:\s*#(\d+)\b/)?.[1])
    .find(Boolean);
  if (workerId) {
    const targetId = Number(workerId);
    const worker = Object.values(state.workers || {}).find(entry => entry.workerId === targetId);
    if (worker) return ['worker', worker];
  }

  const normalizedTexts = texts.map(normalizeDisplayLabel).filter(Boolean);
  for (const [kind, key, entry] of getEntries(state)) {
    if (normalizedTexts.some(text =>
      key === text ||
      entry.sessionName === text ||
      entry.displayName === text ||
      entry.branch === text ||
      entry.slug === text
    )) {
      return [kind, entry];
    }
  }

  return undefined;
}

function findEntryForItem(item?: unknown): [HydraSessionKind, SessionStateEntry] | undefined {
  const state = readSessionState();
  const sessionName = getItemSessionName(item);
  if (sessionName) {
    const worker = state.workers?.[sessionName];
    if (worker) return ['worker', worker];
    const copilot = state.copilots?.[sessionName];
    if (copilot) return ['copilot', copilot];
  }
  return findEntryByText(state, getItemTextFields(item));
}

export function resolveSessionKind(item?: TmuxItem): HydraSessionKind | undefined {
  if (item instanceof CopilotItem) return 'copilot';
  if (item instanceof TmuxSessionItem) return item.session.hydraRole;
  return findEntryForItem(item)?.[0];
}

export function resolveSessionName(item?: TmuxItem): string | undefined {
  return getItemSessionName(item) ||
    findEntryForItem(item)?.[1].sessionName;
}

export function hasHydraItemIdentity(item?: TmuxItem): boolean {
  return Boolean(getWorktreePath(item) || findEntryForItem(item));
}

export function listHydraSessionChoices(kinds: HydraSessionKind[] = ['worker', 'copilot']): HydraSessionChoice[] {
  const allowed = new Set(kinds);
  return getEntries(readSessionState())
    .filter(([kind, , entry]) => allowed.has(kind) && Boolean(entry.sessionName))
    .map(([kind, , entry]) => {
      const suffixes = [
        entry.workerId != null ? `#${entry.workerId}` : undefined,
        entry.agent ? `[${entry.agent}]` : undefined,
      ].filter(Boolean);
      const displayName = entry.displayName || entry.branch || entry.slug || entry.sessionName || '';
      return {
        kind,
        sessionName: entry.sessionName || '',
        label: suffixes.length > 0 ? `${displayName} ${suffixes.join(' ')}` : displayName,
        worktreePath: entry.workdir,
        workerId: entry.workerId,
        agent: entry.agent,
      };
    });
}

export function getWorktreePath(item?: TmuxItem): string | undefined {
  const structuralPath = getStringField(item, 'worktreePath') ||
    getNestedStringField(item, 'session', 'worktreePath') ||
    getNestedStringField(item, 'worktree', 'path');
  if (structuralPath) return structuralPath;

  if (item instanceof CopilotItem) return item.worktreePath;
  if (item instanceof TmuxSessionItem) return item.session.worktreePath;
  if (item instanceof InactiveWorktreeItem) return item.worktree.path;
  if (item instanceof TmuxDetailItem) return item.session?.worktreePath;
  if (item instanceof InactiveDetailItem) return item.worktree?.path;
  if (item instanceof WorktreeItem) return item.worktreePath;
  if (item instanceof GitStatusItem) return item.worktreePath;
  return undefined;
}

export async function resolveWorktreePath(item?: TmuxItem): Promise<string | undefined> {
  const direct = getWorktreePath(item);
  if (direct) return direct;

  const itemEntry = findEntryForItem(item);
  if (itemEntry?.[1].workdir) return itemEntry[1].workdir;

  const sessionName = resolveSessionName(item);
  if (sessionName) {
    try {
      const workdir = await getActiveBackend().getSessionWorkdir(sessionName);
      if (workdir) return workdir;
    } catch {
      // Fall through to undefined.
    }
  }

  return undefined;
}
