import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from '../utils/exec';
import { getRepoRoot, getBaseBranch } from '../utils/git';
import { getRepoIdentifier } from '../core/git';
import { getActiveBackend, MultiplexerSession, HydraRole } from '../utils/multiplexer';
import { toCanonicalPath } from '../utils/path';
import { parseCpuPercentSum } from '../utils/cpuPercent';
import { isDirectoryWorker, isRepoWorker, SessionManager, WorkerInfo } from '../core/sessionManager';
import { CopilotMode, Worktree } from '../core/types';
import {
  buildSessionNotificationSummary,
  type SessionNotificationSource,
  type SessionNotificationSummary,
} from '../core/sessionNotificationSummary';
import type { HydraNotification, NotificationKind } from '../core/notifications';
import { getNotificationDecorationUri } from './notificationDecorationProvider';

export type Classification = 'attached' | 'alive' | 'idle' | 'stopped' | 'orphan';

export interface SessionStatus {
  attached: boolean;
  panes: number;
  lastActive: number;
  gitDirty: number;
  gitModified: number;
  gitAdded: number;
  gitDeleted: number;
  gitUntracked: number;
  classification: Classification;
  commitsAhead: number;
  cpuUsage: number;
  prNumber?: number;
  prState?: 'open' | 'closed' | 'merged';
}

interface SessionWithStatus extends MultiplexerSession {
  status: SessionStatus;
  worktreePath?: string;
  slug: string;
  hydraRole?: HydraRole;
  hydraAgent?: string;
  hydraCopilotMode?: CopilotMode;
}

function isCurrentWorkspacePath(targetPath: string | undefined, activeWorkspacePath: string): boolean {
  const normalizedTarget = toCanonicalPath(targetPath);
  return Boolean(normalizedTarget && normalizedTarget === activeWorkspacePath);
}

// ─── Utility ──────────────────────────────────────────────

export function formatLastActive(sessionActivity: number): string {
  if (sessionActivity === 0) return '-';
  const now = Math.floor(Date.now() / 1000);
  const diffSec = now - sessionActivity;
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);

  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  return new Date(sessionActivity * 1000).toLocaleDateString();
}

function getClassificationOrder(classification: Classification): number {
  switch (classification) {
    case 'attached': return 1;
    case 'alive': return 2;
    case 'idle': return 3;
    case 'stopped': return 4;
    case 'orphan': return 5;
    default: return 6;
  }
}

// ─── Status Gathering ─────────────────────────────────────

function parseGitPorcelainStatus(lines: string[]): Pick<
  SessionStatus,
  'gitDirty' | 'gitModified' | 'gitAdded' | 'gitDeleted' | 'gitUntracked'
> {
  let gitDirty = 0;
  let gitModified = 0;
  let gitAdded = 0;
  let gitDeleted = 0;
  let gitUntracked = 0;

  const trimmedLines = lines.map(l => l.trimEnd()).filter(l => l.trim().length > 0);
  gitDirty = trimmedLines.length;

  for (const line of trimmedLines) {
    if (line.startsWith('??')) {
      gitUntracked++;
      continue;
    }

    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';
    const code = `${x}${y}`;

    if (code.includes('D')) {
      gitDeleted++;
      continue;
    }
    if (code.includes('M') || code.includes('R')) {
      gitModified++;
      continue;
    }
    if (code.includes('A') || code.includes('C')) {
      gitAdded++;
      continue;
    }
  }

  return { gitDirty, gitModified, gitAdded, gitDeleted, gitUntracked };
}

async function getWorktreeBranchLabel(worktreePath: string, fallbackLabel: string): Promise<string> {
  try {
    const branch = (await exec('git symbolic-ref --short HEAD', { cwd: worktreePath, logFailure: false })).trim();
    if (branch) return branch;
  } catch {
    void 0;
  }

  try {
    const head = (await exec('git rev-parse --short HEAD', { cwd: worktreePath, logFailure: false })).trim();
    if (head) return head;
  } catch {
    void 0;
  }

  return fallbackLabel;
}

async function getWorktreeGitStatus(worktreePath: string): Promise<Pick<
  SessionStatus,
  'gitDirty' | 'gitModified' | 'gitAdded' | 'gitDeleted' | 'gitUntracked' | 'commitsAhead'
>> {
  let commitsAhead = 0;
  let parsed = { gitDirty: 0, gitModified: 0, gitAdded: 0, gitDeleted: 0, gitUntracked: 0 };

  if (!fs.existsSync(worktreePath) || !(await isGitInitialized(worktreePath))) {
    return { ...parsed, commitsAhead };
  }

  try {
    const gitStatusOutput = await exec('git status --porcelain', { cwd: worktreePath, logFailure: false });
    const lines = gitStatusOutput.split('\n');
    parsed = parseGitPorcelainStatus(lines);
  } catch {
    void 0;
  }

  try {
    const aheadOutput = await exec('git rev-list --count @{upstream}..HEAD', { cwd: worktreePath, logFailure: false });
    commitsAhead = parseInt(aheadOutput.trim(), 10) || 0;
  } catch {
    void 0;
  }

  return { ...parsed, commitsAhead };
}

async function getSessionStatus(sessionName: string, worktreePath?: string): Promise<SessionStatus> {
  const backend = getActiveBackend();
  let attached = false;
  let lastActive = 0;
  let panes = 1;
  let gitDirty = 0;
  let gitModified = 0;
  let gitAdded = 0;
  let gitDeleted = 0;
  let gitUntracked = 0;
  let commitsAhead = 0;
  let cpuUsage = 0;

  try {
    const info = await backend.getSessionInfo(sessionName);
    attached = info.attached;
    lastActive = info.lastActive;
  } catch {
    void 0;
  }

  try {
    panes = await backend.getSessionPaneCount(sessionName);
  } catch {
    void 0;
  }

  // `ps -o %cpu=` is POSIX-only; on Windows it errors out (no `ps` binary),
  // the catch below swallowed the failure, and every TreeView session
  // rendered as 0% CPU while still spawning a doomed child process per
  // refresh. Gate the probe on platform and leave cpuUsage = 0 on Windows
  // for now; a real Windows CPU probe would need Get-Process + sampling.
  // See issue #225 §4.
  if (process.platform !== 'win32') {
    try {
      const pids = await backend.getSessionPanePids(sessionName);
      const numericPids = pids.filter(pid => /^\d+$/.test(pid));
      if (numericPids.length > 0) {
        const pidList = numericPids.join(',');
        const cpuOutput = await exec(`ps -o %cpu= -p ${pidList}`);
        cpuUsage = parseCpuPercentSum(cpuOutput);
      }
    } catch {
      void 0;
    }
  }

  const canReadGitStatus = worktreePath
    && fs.existsSync(worktreePath)
    && await isGitInitialized(worktreePath);
  if (canReadGitStatus) {
    try {
      const gitStatusOutput = await exec('git status --porcelain', { cwd: worktreePath, logFailure: false });
      const parsed = parseGitPorcelainStatus(gitStatusOutput.split('\n'));
      gitDirty = parsed.gitDirty;
      gitModified = parsed.gitModified;
      gitAdded = parsed.gitAdded;
      gitDeleted = parsed.gitDeleted;
      gitUntracked = parsed.gitUntracked;
    } catch {
      void 0;
    }

    try {
      const aheadOutput = await exec('git rev-list --count @{upstream}..HEAD', { cwd: worktreePath, logFailure: false });
      commitsAhead = parseInt(aheadOutput.trim(), 10) || 0;
    } catch {
      void 0;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  let classification: Classification;

  if (attached) {
    classification = 'attached';
  } else if (now - lastActive < 600) {
    classification = 'alive';
  } else {
    classification = 'idle';
  }

  return { attached, panes, lastActive, gitDirty, gitModified, gitAdded, gitDeleted, gitUntracked, commitsAhead, cpuUsage, classification };
}

async function isGitInitialized(dirPath: string): Promise<boolean> {
  try {
    await exec('git rev-parse --git-dir', { cwd: dirPath, logFailure: false });
    return true;
  } catch {
    return false;
  }
}

interface PrInfo {
  number: number;
  state: 'open' | 'closed' | 'merged';
}

const PR_STATUS_CACHE_TTL_MS = 30_000;
const PR_STATUS_FETCH_TIMEOUT_MS = 3_000;
const prStatusCache = new Map<string, { fetchedAt: number; value: Map<string, PrInfo> }>();

async function fetchRepoPrStatuses(repoRoot: string): Promise<Map<string, PrInfo>> {
  const cached = prStatusCache.get(repoRoot);
  if (cached && Date.now() - cached.fetchedAt < PR_STATUS_CACHE_TTL_MS) {
    return cached.value;
  }

  const map = new Map<string, PrInfo>();
  try {
    const json = await Promise.race([
      exec(
        'gh pr list --state all --json headRefName,number,state --limit 100',
        { cwd: repoRoot, logFailure: false }
      ),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('gh pr list timeout')), PR_STATUS_FETCH_TIMEOUT_MS)
      ),
    ]);
    const prs: { headRefName: string; number: number; state: string }[] = JSON.parse(json);
    // Keep the first (most recent) PR per branch
    for (const pr of prs) {
      if (!map.has(pr.headRefName)) {
        const state = pr.state === 'MERGED' ? 'merged'
          : pr.state === 'CLOSED' ? 'closed'
          : 'open';
        map.set(pr.headRefName, { number: pr.number, state });
      }
    }
  } catch {
    // Timeout, gh not installed, or non-zero exit: fall back to last good cache
    // if we have one, otherwise return an empty map. Either way, do not block
    // TreeView rendering on gh CLI latency.
    if (cached) return cached.value;
  }

  prStatusCache.set(repoRoot, { fetchedAt: Date.now(), value: map });
  return map;
}

// ─── Tree Item Classes ────────────────────────────────────

export class TmuxItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly repoName?: string,
    public readonly sessionName?: string
  ) {
    super(label, collapsibleState);
  }
}

function appendNotificationTooltip(
  existing: string | vscode.MarkdownString | undefined,
  summary: SessionNotificationSummary,
  options: { unreadLabel?: string; footer?: string } = {},
): vscode.MarkdownString {
  const md = existing instanceof vscode.MarkdownString
    ? existing
    : new vscode.MarkdownString();
  if (typeof existing === 'string' && existing.trim()) {
    md.appendText(existing);
  }

  md.appendMarkdown('\n\n---\n\n**Hydra notification**\n\n');
  md.appendMarkdown('- ');
  md.appendText(options.unreadLabel ?? 'Unread');
  md.appendMarkdown(': ');
  md.appendText(String(summary.unreadCount));
  md.appendMarkdown('\n');
  md.appendMarkdown('- Kind: ');
  md.appendText(summary.kind);
  md.appendMarkdown('\n');
  md.appendMarkdown('- Title: ');
  md.appendText(summary.attention.title);
  md.appendMarkdown('\n');
  if (summary.attention.body) {
    md.appendMarkdown('- Body: ');
    md.appendText(summary.attention.body);
    md.appendMarkdown('\n');
  }
  md.appendMarkdown('- Created: ');
  md.appendText(summary.attention.createdAt);
  md.appendMarkdown('\n');
  if (summary.attention.targetSession) {
    md.appendMarkdown('- Target: ');
    md.appendText(summary.attention.targetSession);
    md.appendMarkdown('\n');
  }
  if (summary.attention.sourceSession) {
    md.appendMarkdown('- Source: ');
    md.appendText(summary.attention.sourceSession);
    md.appendMarkdown('\n');
  }
  if (summary.attention.action) {
    md.appendMarkdown('- Action: ');
    md.appendText(`${summary.attention.action.type}:${summary.attention.action.session}`);
    md.appendMarkdown('\n');
  }
  if (options.footer) {
    md.appendMarkdown('\n');
    md.appendText(options.footer);
  } else {
    md.appendMarkdown('\nRight-click this session to open, mark read, or clear notifications.');
  }
  return md;
}

function applyNotificationSummary(
  item: vscode.TreeItem,
  sessionName: string,
  summary?: SessionNotificationSummary,
): void {
  item.resourceUri = getNotificationDecorationUri(sessionName);
  if (!summary) {
    return;
  }

  item.tooltip = appendNotificationTooltip(item.tooltip, summary);
}

function getTargetSessionNotificationSummary(
  source: SessionNotificationSource | undefined,
  sessionName: string,
): SessionNotificationSummary | undefined {
  return source
    ? buildSessionNotificationSummary(sessionName, source.getByTargetSession(sessionName))
    : undefined;
}

function getTargetUnreadNotifications(
  source: SessionNotificationSource | undefined,
  sessionName: string,
): readonly HydraNotification[] {
  return source
    ? source.getByTargetSession(sessionName).filter(notification => notification.readAt === null)
    : [];
}

function getLatestSourceCompletionNotification(
  source: SessionNotificationSource | undefined,
  sessionName: string,
): HydraNotification | undefined {
  if (!source) return undefined;
  const projected = source.getLatestSourceCompletion?.(sessionName);
  if (projected) return projected;
  return source.getBySourceSession(sessionName)
    .filter(notification =>
      notification.kind === 'complete' &&
      notification.targetSession !== sessionName,
    )
    .sort(compareNotificationsNewestFirst)[0];
}

function compareNotificationsNewestFirst(a: HydraNotification, b: HydraNotification): number {
  const timeDiff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (Number.isFinite(timeDiff) && timeDiff !== 0) {
    return timeDiff;
  }
  return b.createdAt.localeCompare(a.createdAt);
}

function getNotificationThemeColor(kind: NotificationKind): vscode.ThemeColor {
  switch (kind) {
    case 'error':
      return new vscode.ThemeColor('charts.red');
    case 'blocked':
      return new vscode.ThemeColor('charts.purple');
    case 'needs-input':
      return new vscode.ThemeColor('charts.yellow');
    case 'complete':
      return new vscode.ThemeColor('charts.green');
    case 'info':
      return new vscode.ThemeColor('charts.blue');
  }
}

function getNotificationIcon(kind: NotificationKind): string {
  switch (kind) {
    case 'error':
      return 'error';
    case 'blocked':
    case 'needs-input':
      return 'warning';
    case 'complete':
      return 'pass';
    case 'info':
      return 'info';
  }
}

function formatNotificationDetailLabel(notification: HydraNotification): string {
  const title = notification.title || notification.body || 'Notification';
  return notification.kind === 'complete'
    ? title
    : `${notification.kind}: ${title}`;
}

function formatNotificationSessionLabel(sessionName: string | null): string | undefined {
  if (!sessionName) return undefined;
  return sessionName.replace(/^task_/, '');
}

function formatNotificationDescription(notification: HydraNotification): string | undefined {
  const parts = [
    formatNotificationSessionLabel(notification.sourceSession),
    formatNotificationAge(notification.createdAt),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function formatNotificationAge(createdAt: string): string | undefined {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return formatLastActive(Math.floor(timestamp / 1000));
}

function buildNotificationTooltip(
  notification: HydraNotification,
  footer: string,
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown('**Hydra notification**\n\n');
  md.appendMarkdown('- Kind: ');
  md.appendText(notification.kind);
  md.appendMarkdown('\n');
  md.appendMarkdown('- Title: ');
  md.appendText(notification.title);
  md.appendMarkdown('\n');
  if (notification.body) {
    md.appendMarkdown('- Body: ');
    md.appendText(notification.body);
    md.appendMarkdown('\n');
  }
  md.appendMarkdown('- Created: ');
  md.appendText(notification.createdAt);
  md.appendMarkdown('\n');
  if (notification.targetSession) {
    md.appendMarkdown('- Target: ');
    md.appendText(notification.targetSession);
    md.appendMarkdown('\n');
  }
  if (notification.sourceSession) {
    md.appendMarkdown('- Source: ');
    md.appendText(notification.sourceSession);
    md.appendMarkdown('\n');
  }
  if (notification.action) {
    md.appendMarkdown('- Action: ');
    md.appendText(`${notification.action.type}:${notification.action.session}`);
    md.appendMarkdown('\n');
  }
  md.appendMarkdown('\n');
  md.appendText(footer);
  return md;
}

function formatWorkerStatusLabel(kind: NotificationKind): string {
  return kind === 'complete' ? 'completed' : kind;
}


// ─── Copilot Item (Level 2) ──────────────────────────────

/**
 * Per-repo grouping of workers managed by a single Copilot.
 * `repoName` is null for task workers (directory-scoped, no repo).
 */
export interface CopilotWorkerGroup {
  repoName: string | null;
  workers: WorkerInfo[];
}

export interface CopilotWorkerSummary {
  workerCount: number;
  repoCount: number;
  groups: CopilotWorkerGroup[];
}

function buildCopilotTooltip(
  displayName: string,
  agentType: string,
  copilotMode: CopilotMode,
  summary: CopilotWorkerSummary,
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportThemeIcons = true;
  const modeSuffix = copilotMode === 'plan' ? ' · planner' : '';
  md.appendMarkdown(`**${displayName}** — ${agentType} copilot${modeSuffix}\n\n`);
  if (summary.workerCount === 0) {
    md.appendMarkdown('_No managed workers yet._');
    return md;
  }
  md.appendMarkdown(`${summary.workerCount} worker${summary.workerCount === 1 ? '' : 's'} · ${summary.repoCount} repo${summary.repoCount === 1 ? '' : 's'}\n`);
  for (const group of summary.groups) {
    const heading = group.repoName ?? 'Local tasks';
    md.appendMarkdown(`\n**${heading}**\n`);
    for (const w of group.workers) {
      let glyph: string;
      if (w.status === 'stopped') glyph = '○';
      else if (w.attached) glyph = '●';
      else glyph = '◐';
      const label = w.displayName || w.slug || w.sessionName;
      const stateBits: string[] = [];
      if (w.status === 'stopped') stateBits.push('stopped');
      else if (w.attached) stateBits.push('attached');
      else stateBits.push('idle');
      md.appendMarkdown(`- ${glyph} ${label} _(${stateBits.join(', ')})_\n`);
    }
  }
  return md;
}

export class CopilotItem extends TmuxItem {
  public readonly worktreePath?: string;
  public readonly agentType: string;
  public readonly copilotMode: CopilotMode;
  public readonly classification: Classification;
  public readonly workerSummary: CopilotWorkerSummary;
  public readonly notificationDetailItems: NotificationDetailItem[];

  constructor(opts: {
    sessionName: string;
    displayName?: string;
    agentType: string;
    copilotMode?: CopilotMode;
    worktreePath?: string;
    classification: Classification;
    workerSummary?: CopilotWorkerSummary;
    notificationSummary?: SessionNotificationSummary;
    notifications?: readonly HydraNotification[];
  }) {
    const label = opts.displayName || opts.sessionName;
    const copilotMode = opts.copilotMode || 'normal';
    const workerSummary: CopilotWorkerSummary = opts.workerSummary ?? { workerCount: 0, repoCount: 0, groups: [] };
    const parts: string[] = [`[${opts.agentType}]`];
    if (copilotMode === 'plan') parts.push('[planner]');
    if (workerSummary.workerCount > 0) {
      const w = workerSummary.workerCount;
      const r = workerSummary.repoCount;
      const wTxt = `${w} worker${w === 1 ? '' : 's'}`;
      const rTxt = `${r} repo${r === 1 ? '' : 's'}`;
      parts.push(r > 0 ? `[${wTxt} · ${rTxt}]` : `[${wTxt}]`);
    }
    const description = parts.join(' ');
    super(label, vscode.TreeItemCollapsibleState.Expanded, undefined, opts.sessionName);

    this.worktreePath = opts.worktreePath;
    this.agentType = opts.agentType;
    this.copilotMode = copilotMode;
    this.classification = opts.classification;
    this.workerSummary = workerSummary;
    this.id = opts.sessionName;
    this.description = description;
    this.tooltip = buildCopilotTooltip(label, opts.agentType, copilotMode, workerSummary);
    this.contextValue = 'copilotItem';
    applyNotificationSummary(this, opts.sessionName, opts.notificationSummary);
    this.notificationDetailItems = (opts.notifications ?? []).map(notification =>
      new NotificationDetailItem(opts.sessionName, notification),
    );
    this.command = {
      command: 'tmux.attachCreate',
      title: 'Open Session',
      arguments: [this]
    };

    // Blue circle: filled=attached, outline=idle
    if (opts.classification === 'attached') {
      this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'));
    } else if (opts.classification === 'stopped') {
      this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('foreground'));
    } else {
      this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('charts.blue'));
    }
  }
}

// ─── Worker Item / Worktree Items (Level 2) ───────────────

export class RepoGroupItem extends TmuxItem {
  constructor(
    public readonly repoName: string,
    public readonly repoRoot: string,
    baseBranch?: string
  ) {
    super(repoName, vscode.TreeItemCollapsibleState.Expanded, repoName);
    this.id = `repo:${getRepoIdentifier(repoRoot)}`;
    this.contextValue = 'repoGroup';
    this.iconPath = new vscode.ThemeIcon('repo');
    if (baseBranch) {
      const shortName = baseBranch.replace(/^origin\//, '');
      this.description = `[base: ${shortName}]`;
    }
  }

  updateBaseBranch(baseBranch?: string): void {
    if (baseBranch) {
      const shortName = baseBranch.replace(/^origin\//, '');
      this.description = `[base: ${shortName}]`;
    } else {
      this.description = undefined;
    }
  }
}

export class TaskGroupItem extends TmuxItem {
  constructor() {
    super('Local Tasks', vscode.TreeItemCollapsibleState.Expanded, 'Local Tasks');
    this.id = 'hydra-local-tasks';
    this.contextValue = 'taskGroup';
    this.iconPath = new vscode.ThemeIcon('folder');
    this.description = 'folder workers';
  }
}

/**
 * Level 2 – Icon rules:
 *   ● filled green  = git ✓ + tmux active
 *   ○ outline green = git ✓ + tmux stopped
 *   ⚠️ warning      = git not initialized
 */
export class WorktreeItem extends TmuxItem {
  public readonly isCurrentWorkspace: boolean;
  public readonly worktreePath?: string;
  public readonly repoRoot?: string;
  public readonly hasGit: boolean;
  public readonly hasTmux: boolean;
  public readonly isMainWorktree: boolean;

  constructor(opts: {
    branchLabel: string;
    displayName?: string;
    repoName: string;
    sessionName: string;
    worktreePath?: string;
    repoRoot?: string;
    isCurrentWorkspace: boolean;
    hasGit: boolean;
    hasTmux: boolean;
    isMainWorktree?: boolean;
    isTaskWorker?: boolean;
    notificationSummary?: SessionNotificationSummary;
  }) {
    const displayLabel = opts.isTaskWorker
      ? (opts.displayName || opts.branchLabel)
      : opts.branchLabel;
    const description = opts.isCurrentWorkspace
      ? (opts.isTaskWorker ? 'This folder' : 'This project')
      : undefined;
    super(displayLabel, vscode.TreeItemCollapsibleState.Expanded, opts.repoName, opts.sessionName);

    this.isCurrentWorkspace = opts.isCurrentWorkspace;
    this.worktreePath = opts.worktreePath;
    this.repoRoot = opts.repoRoot;
    this.hasGit = opts.hasGit;
    this.hasTmux = opts.hasTmux;
    this.isMainWorktree = Boolean(opts.isMainWorktree);
    this.id = opts.sessionName;
    this.description = description;

    this.contextValue = opts.isTaskWorker ? 'taskWorkerItem' : 'workerItem';
    this.command = {
      command: 'tmux.attachCreate',
      title: 'Open Session',
      arguments: [this]
    };

    if (opts.isTaskWorker) {
      this.iconPath = opts.hasTmux
        ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'))
        : new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('charts.green'));
    } else if (!opts.hasGit) {
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
    } else if (opts.hasTmux) {
      this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
    } else {
      this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('charts.green'));
    }
    applyNotificationSummary(this, opts.sessionName, opts.notificationSummary);
  }
}

// ─── Detail Items (Level 3+) ──────────────────────────────

export class TmuxDetailItem extends TmuxItem {
  constructor(
    public readonly session: SessionWithStatus,
    public readonly repoName: string,
    public readonly worktree?: Worktree,
    extensionUri?: vscode.Uri
  ) {
    const parts: string[] = [];

    if (session.status.classification === 'stopped') {
      parts.push('stopped');
    } else {
      parts.push(`${session.status.panes}p`);
      parts.push(formatLastActive(session.status.lastActive));
      if (session.status.cpuUsage > 0) {
        parts.push(`CPU ${session.status.cpuUsage.toFixed(0)}%`);
      }
    }

    if (session.status.classification === 'orphan') {
      parts.push('orphan');
    }

    if (session.hydraRole === 'copilot' && session.hydraCopilotMode === 'plan') {
      parts.push(session.hydraAgent === 'claude' ? 'Native Planner' : 'Read-only Planner');
    }

    const label = parts.join(' · ');
    super(label, vscode.TreeItemCollapsibleState.None, repoName, session.name);

    this.contextValue = 'detailItem';

    if (extensionUri) {
      const iconPath = vscode.Uri.joinPath(
        extensionUri,
        'resources',
        session.status.classification === 'stopped' ? 'tmux-inactive.svg' : 'tmux.svg'
      );
      this.iconPath = { light: iconPath, dark: iconPath };
    } else {
      this.iconPath = new vscode.ThemeIcon('terminal-tmux');
    }

  }
}

export class InactiveDetailItem extends TmuxItem {
  constructor(
    public readonly worktree: Worktree,
    public readonly repoName: string,
    public readonly targetSessionName: string,
    extensionUri?: vscode.Uri
  ) {
    super('0p · stopped', vscode.TreeItemCollapsibleState.None, repoName, targetSessionName);

    this.contextValue = 'detailItem';

    if (extensionUri) {
      const iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'tmux-inactive.svg');
      this.iconPath = { light: iconPath, dark: iconPath };
    } else {
      this.iconPath = new vscode.ThemeIcon('terminal-tmux');
    }

  }
}

export class NotificationDetailItem extends TmuxItem {
  public readonly notificationId: string;

  constructor(
    sessionName: string,
    public readonly notification: HydraNotification,
  ) {
    super(
      formatNotificationDetailLabel(notification),
      vscode.TreeItemCollapsibleState.None,
      undefined,
      sessionName,
    );

    this.notificationId = notification.id;
    this.id = `notification:target:${sessionName}:${notification.id}`;
    this.contextValue = 'notificationDetailItem';
    this.description = formatNotificationDescription(notification);
    this.iconPath = new vscode.ThemeIcon(
      getNotificationIcon(notification.kind),
      getNotificationThemeColor(notification.kind),
    );
    this.tooltip = buildNotificationTooltip(notification, 'Click to open this notification and mark it read.');
    this.command = {
      command: 'hydra.openSessionNotification',
      title: 'Open Notification',
      arguments: [this],
    };
  }
}

export class GitStatusItem extends TmuxItem {
  public readonly worktreePath?: string;
  public readonly prNumber?: number;

  constructor(
    status: SessionStatus,
    repoName: string,
    sessionName?: string,
    worktreePath?: string
  ) {
    const parts: string[] = [];

    const newCount = status.gitAdded + status.gitUntracked;

    if (status.commitsAhead > 0) parts.push(`↑${status.commitsAhead}`);
    if (status.gitModified > 0) parts.push(`M:${status.gitModified}`);
    if (newCount > 0) parts.push(`U:${newCount}`);
    if (status.gitDeleted > 0) parts.push(`D:${status.gitDeleted}`);
    if (status.prNumber) parts.push(`PR #${status.prNumber} ${status.prState}`);

    const label = parts.join(' · ');
    super(label, vscode.TreeItemCollapsibleState.None, repoName, sessionName);

    this.contextValue = 'gitStatusItem';

    let iconColor: vscode.ThemeColor;
    if (status.prState === 'merged') {
      iconColor = new vscode.ThemeColor('charts.purple');
    } else if (status.prState === 'closed') {
      iconColor = new vscode.ThemeColor('charts.red');
    } else {
      iconColor = new vscode.ThemeColor('charts.green');
    }
    this.iconPath = new vscode.ThemeIcon('git-commit', iconColor);
    this.worktreePath = worktreePath;
    this.prNumber = status.prNumber;

    if (status.prNumber && worktreePath) {
      this.command = {
        command: 'hydra.openPR',
        title: 'Open PR',
        arguments: [this]
      };
    }
  }
}

// ─── Composite Items (backward compat) ───────────────────

export class TmuxSessionItem extends WorktreeItem {
  public readonly session: SessionWithStatus;
  public readonly detailItem: TmuxDetailItem;
  public readonly completionNotification?: HydraNotification;
  public readonly gitStatusItem?: GitStatusItem;

  constructor(
    session: SessionWithStatus,
    repoName: string,
    worktree: Worktree | undefined,
    isCurrentWorkspace: boolean,
    hasGit: boolean,
    extensionUri?: vscode.Uri,
    branchLabelOverride?: string,
    agentType?: string,
    repoRoot?: string,
    workerId?: number,
    displayName?: string,
    isTaskWorker?: boolean,
    notificationSummary?: SessionNotificationSummary,
    completionNotification?: HydraNotification
  ) {
    const isRoot = Boolean(worktree?.isMain);
    const branchLabel = branchLabelOverride || worktree?.branch || (isRoot ? 'main' : session.slug);

    super({
      branchLabel,
      displayName,
      repoName,
      sessionName: session.name,
      worktreePath: session.worktreePath,
      repoRoot,
      isCurrentWorkspace,
      hasGit,
      hasTmux: session.status.classification !== 'stopped',
      isMainWorktree: isRoot,
      isTaskWorker
    });

    this.session = session;
    this.detailItem = new TmuxDetailItem(session, repoName, worktree, extensionUri);
    this.completionNotification = completionNotification;

    const descParts: string[] = [];
    if (this.description) descParts.push(String(this.description));
    if (workerId != null) descParts.push(`#${workerId}`);
    if (agentType) descParts.push(`[${agentType}]`);
    if (notificationSummary) {
      descParts.push(formatWorkerStatusLabel(notificationSummary.kind));
    } else if (completionNotification) {
      descParts.push('completed');
    }
    if (descParts.length > 0) this.description = descParts.join(' ');
    applyNotificationSummary(this, session.name, notificationSummary);
    if (completionNotification && !notificationSummary) {
      this.tooltip = buildNotificationTooltip(
        completionNotification,
        'This worker has produced a completion notification for its copilot.',
      );
    }

    const hasGitChanges = session.status.commitsAhead > 0 || session.status.gitModified > 0 ||
      session.status.gitDeleted > 0 || session.status.gitAdded > 0 || session.status.gitUntracked > 0;
    if (hasGitChanges || session.status.prNumber) {
      this.gitStatusItem = new GitStatusItem(session.status, repoName, session.name, session.worktreePath);
    }
  }
}

export class InactiveWorktreeItem extends WorktreeItem {
  public readonly detailItem: InactiveDetailItem;
  public readonly completionNotification?: HydraNotification;
  public readonly gitStatusItem?: GitStatusItem;
  public readonly worktree: Worktree;
  public readonly targetSessionName: string;

  constructor(
    worktree: Worktree,
    repoName: string,
    targetSessionName: string,
    isCurrentWorkspace: boolean,
    hasGit: boolean,
    extensionUri?: vscode.Uri,
    branchLabelOverride?: string,
    gitStatusOverride?: SessionStatus,
    repoRoot?: string,
    displayName?: string,
    isTaskWorker?: boolean,
    notificationSummary?: SessionNotificationSummary,
    completionNotification?: HydraNotification
  ) {
    const branchLabel = branchLabelOverride || worktree.branch || (worktree.isMain ? 'main' : path.basename(worktree.path));

    super({
      branchLabel,
      displayName,
      repoName,
      sessionName: targetSessionName,
      worktreePath: worktree.path,
      repoRoot,
      isCurrentWorkspace,
      hasGit,
      hasTmux: false,
      isMainWorktree: worktree.isMain,
      isTaskWorker
    });

    this.contextValue = isTaskWorker ? 'inactiveTaskWorkerItem' : 'inactiveWorkerItem';
    this.worktree = worktree;
    this.targetSessionName = targetSessionName;
    this.detailItem = new InactiveDetailItem(worktree, repoName, targetSessionName, extensionUri);
    this.completionNotification = completionNotification;
    if (notificationSummary || completionNotification) {
      const descParts = typeof this.description === 'string' && this.description.trim()
        ? [this.description]
        : [];
      descParts.push(notificationSummary
        ? formatWorkerStatusLabel(notificationSummary.kind)
        : 'completed');
      this.description = descParts.join(' ');
    }
    applyNotificationSummary(this, targetSessionName, notificationSummary);
    if (completionNotification && !notificationSummary) {
      this.tooltip = buildNotificationTooltip(
        completionNotification,
        'This worker has produced a completion notification for its copilot.',
      );
    }

    if (gitStatusOverride) {
      const hasGitChanges = gitStatusOverride.commitsAhead > 0 || gitStatusOverride.gitModified > 0 ||
        (gitStatusOverride.gitAdded + gitStatusOverride.gitUntracked) > 0 || gitStatusOverride.gitDeleted > 0;
      if (hasGitChanges || gitStatusOverride.prNumber) {
        this.gitStatusItem = new GitStatusItem(gitStatusOverride, repoName, targetSessionName, worktree.path);
      }
    }
  }
}

export class TmuxSessionDetailItem extends TmuxDetailItem {
  constructor(
    session: SessionWithStatus,
    repoName: string,
    worktree?: Worktree,
    extensionUri?: vscode.Uri
  ) {
    super(session, repoName, worktree, extensionUri);
  }
}

export class InactiveWorktreeDetailItem extends InactiveDetailItem {
  constructor(
    worktree: Worktree,
    repoName: string,
    targetSessionName: string,
    extensionUri?: vscode.Uri
  ) {
    super(worktree, repoName, targetSessionName, extensionUri);
  }
}

// ─── Shared Helpers ───────────────────────────────────────

function getActiveWorkspacePath(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  try {
    const repoRoot = getRepoRoot();
    return toCanonicalPath(repoRoot) || path.resolve(repoRoot);
  } catch {
    return toCanonicalPath(folders[0].uri.fsPath) || path.resolve(folders[0].uri.fsPath);
  }
}

function sortItems(items: TmuxItem[]): TmuxItem[] {
  items.sort((a, b) => {
    const currentA = a instanceof WorktreeItem && a.isCurrentWorkspace;
    const currentB = b instanceof WorktreeItem && b.isCurrentWorkspace;
    if (currentA !== currentB) return currentA ? -1 : 1;

    const nameCompare = a.label.localeCompare(b.label);
    if (nameCompare !== 0) return nameCompare;

    const scoreA = getItemScore(a);
    const scoreB = getItemScore(b);
    return scoreA - scoreB;
  });

  return items;
}

function getItemScore(item: TmuxItem): number {
  if (item instanceof TmuxSessionItem) return getClassificationOrder(item.session.status.classification);
  if (item instanceof InactiveWorktreeItem) return getClassificationOrder('stopped');
  return 10;
}

/**
 * Group all workers by their parent copilot session, then by repo within each
 * copilot. Workers with no copilotSessionName (manually-created workers) are
 * skipped. Task workers (no repoRoot/repo) go into a single null-repo bucket.
 *
 * Ordering: repos appear in first-seen order from the worker list; task
 * workers (null-repo bucket) are pushed last so they don't fragment the
 * repo-grouped view.
 */
export function buildCopilotWorkerSummaries(workers: WorkerInfo[]): Map<string, CopilotWorkerSummary> {
  const result = new Map<string, CopilotWorkerSummary>();
  for (const w of workers) {
    if (!w.copilotSessionName) continue;
    let summary = result.get(w.copilotSessionName);
    if (!summary) {
      summary = { workerCount: 0, repoCount: 0, groups: [] };
      result.set(w.copilotSessionName, summary);
    }
    const repoName = w.repo ?? null;
    let group = summary.groups.find(g => g.repoName === repoName);
    if (!group) {
      group = { repoName, workers: [] };
      summary.groups.push(group);
    }
    group.workers.push(w);
  }
  for (const summary of result.values()) {
    summary.workerCount = summary.groups.reduce((n, g) => n + g.workers.length, 0);
    summary.repoCount = summary.groups.filter(g => g.repoName !== null).length;
    summary.groups.sort((a, b) => {
      if (a.repoName === null) return 1;
      if (b.repoName === null) return -1;
      return 0;
    });
  }
  return result;
}

// ─── Copilot Provider ─────────────────────────────────────

export class CopilotProvider implements vscode.TreeDataProvider<TmuxItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TmuxItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _extensionUri: vscode.Uri | undefined;
  private _copilotItems: CopilotItem[] = [];

  constructor(private readonly notifications?: SessionNotificationSource) {}

  setExtensionUri(uri: vscode.Uri): void { this._extensionUri = uri; }
  refresh(): void { this._onDidChangeTreeData.fire(undefined); }
  getTreeItem(element: TmuxItem): vscode.TreeItem { return element; }
  getParent(element: TmuxItem): TmuxItem | undefined {
    if (element instanceof CopilotItem) return undefined;
    // Detail items are children of CopilotItems
    return this._copilotItems.find(c => c.sessionName === element.sessionName);
  }

  getCopilotItems(): CopilotItem[] { return this._copilotItems; }

  async refreshAndGetCopilotItems(): Promise<CopilotItem[]> {
    await this.getChildren(undefined);
    return this._copilotItems;
  }

  async getChildren(element?: TmuxItem): Promise<TmuxItem[]> {
    if (!element) return this.getRootItems();
    if (element instanceof CopilotItem) return this.getCopilotDetailItems(element);
    return [];
  }

  private async getRootItems(): Promise<TmuxItem[]> {
    try {
      const backend = getActiveBackend();
      const sm = new SessionManager(backend);
      const [copilots, workers] = await Promise.all([sm.listCopilots(), sm.listWorkers()]);

      if (copilots.length === 0) {
        this._copilotItems = [];
        return [];  // triggers viewsWelcome
      }

      const summariesByCopilot = buildCopilotWorkerSummaries(workers);

      const items: CopilotItem[] = [];
      for (const c of copilots) {
        let classification: Classification;
        if (c.status !== 'running') {
          classification = 'stopped';
        } else if (c.attached) {
          classification = 'attached';
        } else {
          classification = 'alive';
        }
        items.push(new CopilotItem({
          sessionName: c.sessionName,
          displayName: c.displayName,
          agentType: c.agent,
          copilotMode: c.copilotMode,
          worktreePath: c.workdir,
          classification,
          workerSummary: summariesByCopilot.get(c.sessionName),
          notificationSummary: getTargetSessionNotificationSummary(this.notifications, c.sessionName),
          notifications: getTargetUnreadNotifications(this.notifications, c.sessionName),
        }));
      }

      this._copilotItems = items;
      return items;
    } catch {
      this._copilotItems = [];
      return [];
    }
  }

  private async getCopilotDetailItems(copilot: CopilotItem): Promise<TmuxItem[]> {
    if (!copilot.sessionName) return [];
    const backend = getActiveBackend();
    const workdir = await backend.getSessionWorkdir(copilot.sessionName);
    const status = await getSessionStatus(copilot.sessionName, workdir);
    const session: SessionWithStatus = {
      name: copilot.sessionName,
      windows: 1,
      attached: status.attached,
      workdir,
      status,
      worktreePath: workdir,
      slug: 'copilot',
      hydraRole: 'copilot',
      hydraAgent: copilot.agentType,
      hydraCopilotMode: copilot.copilotMode,
    };
    const children: TmuxItem[] = [new TmuxDetailItem(session, '', undefined, this._extensionUri)];
    children.push(...copilot.notificationDetailItems);
    return children;
  }
}

// ─── Worker Provider ──────────────────────────────────────

export class WorkerProvider implements vscode.TreeDataProvider<TmuxItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TmuxItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _extensionUri: vscode.Uri | undefined;
  private _repoGroups: RepoGroupItem[] = [];
  private _repoGroupByRoot = new Map<string, RepoGroupItem>();
  private _taskGroup: TaskGroupItem | undefined;
  private _workerItemsByRepo = new Map<string, TmuxItem[]>();
  private _taskWorkerItems: TmuxItem[] = [];

  constructor(private readonly notifications?: SessionNotificationSource) {}

  setExtensionUri(uri: vscode.Uri): void { this._extensionUri = uri; }
  refresh(): void {
    this._workerItemsByRepo.clear();
    this._taskWorkerItems = [];
    this._onDidChangeTreeData.fire(undefined);
  }
  getTreeItem(element: TmuxItem): vscode.TreeItem { return element; }
  getParent(element: TmuxItem): TmuxItem | undefined {
    if (element instanceof RepoGroupItem) return undefined;
    if (element instanceof TaskGroupItem) return undefined;
    // WorktreeItem/TmuxSessionItem/InactiveWorktreeItem are children of a RepoGroupItem
    if (element instanceof WorktreeItem || element instanceof InactiveWorktreeItem) {
      if (element.contextValue === 'taskWorkerItem' || element.contextValue === 'inactiveTaskWorkerItem') {
        return this._taskGroup;
      }
      if (element.repoRoot) {
        return this._repoGroupByRoot.get(element.repoRoot);
      }
      return this._repoGroups.find(g => g.repoName === element.repoName);
    }
    // Detail items are children of a WorktreeItem.
    for (const items of this._workerItemsByRepo.values()) {
      for (const item of items) {
        if (item instanceof TmuxSessionItem) {
          if (
            item.detailItem === element ||
            item.gitStatusItem === element
          ) return item;
        }
        if (item instanceof InactiveWorktreeItem) {
          if (
            item.detailItem === element ||
            item.gitStatusItem === element
          ) return item;
        }
      }
    }
    for (const item of this._taskWorkerItems) {
      if (item instanceof TmuxSessionItem) {
        if (
          item.detailItem === element ||
          item.gitStatusItem === element
        ) return item;
      }
      if (item instanceof InactiveWorktreeItem) {
        if (
          item.detailItem === element ||
          item.gitStatusItem === element
        ) return item;
      }
    }
    return undefined;
  }

  async refreshAndGetWorkerItems(): Promise<TmuxItem[]> {
    const groups = await this.getChildren(undefined);
    await Promise.all(groups.map(g => this.getChildren(g)));
    const all: TmuxItem[] = [];
    for (const items of this._workerItemsByRepo.values()) all.push(...items);
    all.push(...this._taskWorkerItems);
    return all;
  }

  async getWorkerItems(): Promise<TmuxItem[]> {
    if (this._repoGroups.length === 0) {
      await this.getChildren(undefined);
    }
    const missingGroups = this._repoGroups.filter(g => !this._workerItemsByRepo.has(g.repoRoot));
    if (missingGroups.length > 0) {
      await Promise.all(missingGroups.map(g => this.getRepoGroupChildren(g)));
    }
    if (this._taskGroup && this._taskWorkerItems.length === 0) {
      await this.getTaskGroupChildren();
    }
    const all: TmuxItem[] = [];
    for (const items of this._workerItemsByRepo.values()) {
      all.push(...items);
    }
    all.push(...this._taskWorkerItems);
    return all;
  }

  async getChildren(element?: TmuxItem): Promise<TmuxItem[]> {
    if (!element) return this.getRootItems();
    if (element instanceof RepoGroupItem) return this.getRepoGroupChildren(element);
    if (element instanceof TaskGroupItem) return this.getTaskGroupChildren();
    if (element instanceof TmuxSessionItem) {
      const children: TmuxItem[] = [element.detailItem];
      if (element.gitStatusItem) children.push(element.gitStatusItem);
      return children;
    }
    if (element instanceof InactiveWorktreeItem) {
      const children: TmuxItem[] = [element.detailItem];
      if (element.gitStatusItem) children.push(element.gitStatusItem);
      return children;
    }
    return [];
  }

  private async getRootItems(): Promise<TmuxItem[]> {
    try {
      const backend = getActiveBackend();
      const sm = new SessionManager(backend);
      const workers = await sm.listWorkers();

      if (workers.length === 0) {
        this._repoGroups = [];
        this._repoGroupByRoot.clear();
        this._taskGroup = undefined;
        this._workerItemsByRepo.clear();
        this._taskWorkerItems = [];
        const hint = new TmuxItem('No workers', vscode.TreeItemCollapsibleState.None);
        hint.iconPath = new vscode.ThemeIcon('info');
        hint.description = 'Ask your copilot to create a worker';
        return [hint];
      }

      const repoWorkers = workers.filter(isRepoWorker);
      const taskWorkers = workers.filter(isDirectoryWorker);

      // Group by repo
      const byRepo = new Map<string, { repoRoot: string; repoName: string; workers: WorkerInfo[] }>();
      for (const w of repoWorkers) {
        if (!w.repoRoot) continue;
        const key = w.repoRoot;
        let group = byRepo.get(key);
        if (!group) {
          group = { repoRoot: w.repoRoot, repoName: w.repo || 'unknown', workers: [] };
          byRepo.set(key, group);
        }
        group.workers.push(w);
      }

      // Always show RepoGroupItem per repo
      const items: TmuxItem[] = [];
      const repoGroupItems: RepoGroupItem[] = [];
      for (const group of byRepo.values()) {
        let baseBranch: string | undefined;
        try { baseBranch = await getBaseBranch(group.repoRoot); } catch { /* */ }
        const item = this._repoGroupByRoot.get(group.repoRoot) ||
          new RepoGroupItem(group.repoName, group.repoRoot, baseBranch);
        item.updateBaseBranch(baseBranch);
        this._repoGroupByRoot.set(group.repoRoot, item);
        repoGroupItems.push(item);
        items.push(item);
      }
      for (const key of this._repoGroupByRoot.keys()) {
        if (!byRepo.has(key)) {
          this._repoGroupByRoot.delete(key);
        }
      }
      this._repoGroups = repoGroupItems;
      this._taskGroup = taskWorkers.length > 0
        ? (this._taskGroup || new TaskGroupItem())
        : undefined;
      this._taskWorkerItems = [];
      if (this._taskGroup) {
        items.push(this._taskGroup);
      }
      return items;
    } catch {
      this._repoGroups = [];
      this._repoGroupByRoot.clear();
      this._taskGroup = undefined;
      this._workerItemsByRepo.clear();
      this._taskWorkerItems = [];
      return [];
    }
  }

  private async getRepoGroupChildren(group: RepoGroupItem): Promise<TmuxItem[]> {
    try {
      const backend = getActiveBackend();
      const sm = new SessionManager(backend);
      const workers = await sm.listWorkers(group.repoRoot);
      const items = await this.buildWorkerItems(workers, group.repoName, group.repoRoot);
      this._workerItemsByRepo.set(group.repoRoot, items);
      return items;
    } catch {
      return [];
    }
  }

  private async getTaskGroupChildren(): Promise<TmuxItem[]> {
    try {
      const backend = getActiveBackend();
      const sm = new SessionManager(backend);
      const workers = (await sm.listWorkers()).filter(isDirectoryWorker);
      const items = await this.buildTaskWorkerItems(workers);
      this._taskWorkerItems = items;
      return items;
    } catch {
      return [];
    }
  }

  private async buildWorkerItems(workers: WorkerInfo[], repoName: string, repoRoot: string): Promise<TmuxItem[]> {
    const activePath = getActiveWorkspacePath();
    const prMap = await fetchRepoPrStatuses(repoRoot);
    const items: TmuxItem[] = [];

    for (const w of workers) {
      const isCurrentWs = activePath
        ? isCurrentWorkspacePath(w.workdir, activePath)
        : false;
      const hasGit = w.workdir ? await isGitInitialized(w.workdir) : false;
      const branchLabel = hasGit && w.workdir
        ? await getWorktreeBranchLabel(w.workdir, w.branch || w.slug)
        : (w.branch || w.slug);
      const worktreeBranch = branchLabel;

      const pr = prMap.get(branchLabel);

      if (w.status === 'running') {
        const status = await getSessionStatus(w.sessionName, w.workdir);
        if (pr) {
          status.prNumber = pr.number;
          status.prState = pr.state;
        }
        const session: SessionWithStatus = {
          name: w.sessionName,
          windows: 1,
          attached: w.attached,
          status,
          worktreePath: w.workdir,
          slug: w.slug,
          hydraRole: 'worker',
          hydraAgent: w.agent,
        };
        const worktree: Worktree = { path: w.workdir, branch: worktreeBranch, isMain: false };
        items.push(new TmuxSessionItem(
          session, repoName, worktree, isCurrentWs, hasGit,
          this._extensionUri, branchLabel, w.agent, repoRoot, w.workerId, w.displayName, false,
          getTargetSessionNotificationSummary(this.notifications, w.sessionName),
          getLatestSourceCompletionNotification(this.notifications, w.sessionName)
        ));
      } else {
        const worktree: Worktree = { path: w.workdir, branch: worktreeBranch, isMain: false };
        const gitStatus = hasGit && w.workdir ? await getWorktreeGitStatus(w.workdir) : undefined;
        let stoppedStatus: SessionStatus | undefined = gitStatus ? {
          attached: false, panes: 0, lastActive: 0, classification: 'stopped', cpuUsage: 0,
          ...gitStatus
        } : undefined;
        if (pr) {
          if (!stoppedStatus) {
            stoppedStatus = {
              attached: false, panes: 0, lastActive: 0, classification: 'stopped', cpuUsage: 0,
              gitDirty: 0, gitModified: 0, gitAdded: 0, gitDeleted: 0, gitUntracked: 0, commitsAhead: 0,
            };
          }
          stoppedStatus.prNumber = pr.number;
          stoppedStatus.prState = pr.state;
        }
        items.push(new InactiveWorktreeItem(
          worktree, repoName, w.sessionName, isCurrentWs, hasGit,
          this._extensionUri, branchLabel, stoppedStatus, repoRoot, w.displayName, false,
          getTargetSessionNotificationSummary(this.notifications, w.sessionName),
          getLatestSourceCompletionNotification(this.notifications, w.sessionName)
        ));
      }
    }

    return sortItems(items);
  }

  private async buildTaskWorkerItems(workers: WorkerInfo[]): Promise<TmuxItem[]> {
    const activePath = getActiveWorkspacePath();
    const repoName = 'Local Tasks';
    const items: TmuxItem[] = [];

    for (const w of workers) {
      const isCurrentWs = activePath
        ? isCurrentWorkspacePath(w.workdir, activePath)
        : false;
      const label = w.displayName || w.slug || path.basename(w.workdir);
      const worktree: Worktree = { path: w.workdir, branch: label, isMain: false };

      if (w.status === 'running') {
        const status = await getSessionStatus(w.sessionName);
        const session: SessionWithStatus = {
          name: w.sessionName,
          windows: 1,
          attached: w.attached,
          status,
          worktreePath: w.workdir,
          slug: w.slug,
          hydraRole: 'worker',
          hydraAgent: w.agent,
        };
        items.push(new TmuxSessionItem(
          session, repoName, worktree, isCurrentWs, false,
          this._extensionUri, label, w.agent, undefined, w.workerId, w.displayName, true,
          getTargetSessionNotificationSummary(this.notifications, w.sessionName),
          getLatestSourceCompletionNotification(this.notifications, w.sessionName)
        ));
      } else {
        const stoppedStatus: SessionStatus = {
          attached: false,
          panes: 0,
          lastActive: 0,
          classification: 'stopped',
          cpuUsage: 0,
          gitDirty: 0,
          gitModified: 0,
          gitAdded: 0,
          gitDeleted: 0,
          gitUntracked: 0,
          commitsAhead: 0,
        };
        items.push(new InactiveWorktreeItem(
          worktree, repoName, w.sessionName, isCurrentWs, false,
          this._extensionUri, label, stoppedStatus, undefined, w.displayName, true,
          getTargetSessionNotificationSummary(this.notifications, w.sessionName),
          getLatestSourceCompletionNotification(this.notifications, w.sessionName)
        ));
      }
    }

    return sortItems(items);
  }
}
