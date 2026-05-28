import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from '../utils/exec';
import { getRepoRoot, getBaseBranch } from '../utils/git';
import { getActiveBackend, MultiplexerSession, HydraRole } from '../utils/multiplexer';
import { toCanonicalPath } from '../utils/path';
import { SessionManager, WorkerInfo } from '../core/sessionManager';
import { CopilotMode, Worktree } from '../core/types';

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
    const branch = (await exec('git symbolic-ref --short HEAD', { cwd: worktreePath })).trim();
    if (branch) return branch;
  } catch {
    void 0;
  }

  try {
    const head = (await exec('git rev-parse --short HEAD', { cwd: worktreePath })).trim();
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

  if (!fs.existsSync(worktreePath)) {
    return { ...parsed, commitsAhead };
  }

  try {
    const gitStatusOutput = await exec('git status --porcelain', { cwd: worktreePath });
    const lines = gitStatusOutput.split('\n');
    parsed = parseGitPorcelainStatus(lines);
  } catch {
    void 0;
  }

  try {
    const aheadOutput = await exec('git rev-list --count @{upstream}..HEAD', { cwd: worktreePath });
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

  try {
    const pids = await backend.getSessionPanePids(sessionName);
    const numericPids = pids.filter(pid => /^\d+$/.test(pid));
    if (numericPids.length > 0) {
      const pidList = numericPids.join(',');
      const cpuOutput = await exec(`ps -o %cpu= -p ${pidList}`);
      const cpuValues = cpuOutput.split('\n').filter(l => l.trim()).map(v => parseFloat(v.trim()) || 0);
      cpuUsage = cpuValues.reduce((a, b) => a + b, 0);
    }
  } catch {
    void 0;
  }

  if (worktreePath && fs.existsSync(worktreePath)) {
    try {
      const gitStatusOutput = await exec('git status --porcelain', { cwd: worktreePath });
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
      const aheadOutput = await exec('git rev-list --count @{upstream}..HEAD', { cwd: worktreePath });
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
    await exec('git rev-parse --git-dir', { cwd: dirPath });
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
        { cwd: repoRoot }
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


// ─── Copilot Item (Level 2) ──────────────────────────────

export class CopilotItem extends TmuxItem {
  public readonly worktreePath?: string;
  public readonly agentType: string;
  public readonly copilotMode: CopilotMode;
  public readonly classification: Classification;

  constructor(opts: {
    sessionName: string;
    displayName?: string;
    agentType: string;
    copilotMode?: CopilotMode;
    worktreePath?: string;
    classification: Classification;
  }) {
    const label = opts.displayName || opts.sessionName;
    const copilotMode = opts.copilotMode || 'normal';
    const description = copilotMode === 'plan'
      ? `[${opts.agentType}] [planner]`
      : `[${opts.agentType}]`;
    super(label, vscode.TreeItemCollapsibleState.Expanded, undefined, opts.sessionName);

    this.worktreePath = opts.worktreePath;
    this.agentType = opts.agentType;
    this.copilotMode = copilotMode;
    this.classification = opts.classification;
    this.id = opts.sessionName;
    this.description = description;
    this.contextValue = 'copilotItem';
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
    this.id = repoRoot;
    this.contextValue = 'repoGroup';
    this.iconPath = new vscode.ThemeIcon('repo');
    if (baseBranch) {
      const shortName = baseBranch.replace(/^origin\//, '');
      this.description = `[base: ${shortName}]`;
    }
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
  }) {
    const displayLabel = opts.displayName || opts.branchLabel;
    const description = opts.isCurrentWorkspace ? 'This project' : undefined;
    super(displayLabel, vscode.TreeItemCollapsibleState.Expanded, opts.repoName, opts.sessionName);

    this.isCurrentWorkspace = opts.isCurrentWorkspace;
    this.worktreePath = opts.worktreePath;
    this.repoRoot = opts.repoRoot;
    this.hasGit = opts.hasGit;
    this.hasTmux = opts.hasTmux;
    this.isMainWorktree = Boolean(opts.isMainWorktree);
    this.id = opts.sessionName;
    this.description = description;

    this.contextValue = 'workerItem';
    this.command = {
      command: 'tmux.attachCreate',
      title: 'Open Session',
      arguments: [this]
    };

    if (!opts.hasGit) {
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
    } else if (opts.hasTmux) {
      this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
    } else {
      this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('charts.green'));
    }
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
    displayName?: string
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
      isMainWorktree: isRoot
    });

    this.session = session;
    this.detailItem = new TmuxDetailItem(session, repoName, worktree, extensionUri);

    const descParts: string[] = [];
    if (this.description) descParts.push(String(this.description));
    if (workerId != null) descParts.push(`#${workerId}`);
    if (agentType) descParts.push(`[${agentType}]`);
    if (descParts.length > 0) this.description = descParts.join(' ');

    const hasGitChanges = session.status.commitsAhead > 0 || session.status.gitModified > 0 ||
      session.status.gitDeleted > 0 || session.status.gitAdded > 0 || session.status.gitUntracked > 0;
    if (hasGitChanges || session.status.prNumber) {
      this.gitStatusItem = new GitStatusItem(session.status, repoName, session.name, session.worktreePath);
    }
  }
}

export class InactiveWorktreeItem extends WorktreeItem {
  public readonly detailItem: InactiveDetailItem;
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
    displayName?: string
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
      isMainWorktree: worktree.isMain
    });

    this.contextValue = 'inactiveWorkerItem';
    this.worktree = worktree;
    this.targetSessionName = targetSessionName;
    this.detailItem = new InactiveDetailItem(worktree, repoName, targetSessionName, extensionUri);

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

// ─── Copilot Provider ─────────────────────────────────────

export class CopilotProvider implements vscode.TreeDataProvider<TmuxItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TmuxItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _extensionUri: vscode.Uri | undefined;
  private _copilotItems: CopilotItem[] = [];

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
    this._onDidChangeTreeData.fire(undefined);
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
      const copilots = await sm.listCopilots();

      if (copilots.length === 0) {
        this._copilotItems = [];
        return [];  // triggers viewsWelcome
      }

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
    return [new TmuxDetailItem(session, '', undefined, this._extensionUri)];
  }
}

// ─── Worker Provider ──────────────────────────────────────

export class WorkerProvider implements vscode.TreeDataProvider<TmuxItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TmuxItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private _extensionUri: vscode.Uri | undefined;
  private _repoGroups: RepoGroupItem[] = [];
  private _workerItemsByRepo = new Map<string, TmuxItem[]>();

  setExtensionUri(uri: vscode.Uri): void { this._extensionUri = uri; }
  refresh(): void {
    this._workerItemsByRepo.clear();
    this._onDidChangeTreeData.fire(undefined);
  }
  getTreeItem(element: TmuxItem): vscode.TreeItem { return element; }
  getParent(element: TmuxItem): TmuxItem | undefined {
    if (element instanceof RepoGroupItem) return undefined;
    // WorktreeItem/TmuxSessionItem/InactiveWorktreeItem are children of a RepoGroupItem
    if (element instanceof WorktreeItem || element instanceof InactiveWorktreeItem) {
      return this._repoGroups.find(g => g.repoName === element.repoName);
    }
    // Detail items (TmuxDetailItem, GitStatusItem) are children of a WorktreeItem
    for (const items of this._workerItemsByRepo.values()) {
      for (const item of items) {
        if (item instanceof TmuxSessionItem) {
          if (item.detailItem === element || item.gitStatusItem === element) return item;
        }
        if (item instanceof InactiveWorktreeItem) {
          if (item.detailItem === element || item.gitStatusItem === element) return item;
        }
      }
    }
    return undefined;
  }

  async refreshAndGetWorkerItems(): Promise<TmuxItem[]> {
    const groups = await this.getChildren(undefined);
    await Promise.all(groups.map(g => this.getChildren(g)));
    this._onDidChangeTreeData.fire(undefined);
    const all: TmuxItem[] = [];
    for (const items of this._workerItemsByRepo.values()) all.push(...items);
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
    const all: TmuxItem[] = [];
    for (const items of this._workerItemsByRepo.values()) {
      all.push(...items);
    }
    return all;
  }

  async getChildren(element?: TmuxItem): Promise<TmuxItem[]> {
    if (!element) return this.getRootItems();
    if (element instanceof RepoGroupItem) return this.getRepoGroupChildren(element);
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
        this._workerItemsByRepo.clear();
        const hint = new TmuxItem('No workers', vscode.TreeItemCollapsibleState.None);
        hint.iconPath = new vscode.ThemeIcon('info');
        hint.description = 'Ask your copilot to create a worker';
        return [hint];
      }

      // Group by repo
      const byRepo = new Map<string, { repoRoot: string; repoName: string; workers: WorkerInfo[] }>();
      for (const w of workers) {
        const key = w.repoRoot || 'unknown';
        let group = byRepo.get(key);
        if (!group) {
          group = { repoRoot: w.repoRoot, repoName: w.repo || 'unknown', workers: [] };
          byRepo.set(key, group);
        }
        group.workers.push(w);
      }

      // Always show RepoGroupItem per repo
      const items: RepoGroupItem[] = [];
      for (const group of byRepo.values()) {
        let baseBranch: string | undefined;
        try { baseBranch = await getBaseBranch(group.repoRoot); } catch { /* */ }
        items.push(new RepoGroupItem(group.repoName, group.repoRoot, baseBranch));
      }
      this._repoGroups = items;
      return items;
    } catch {
      this._repoGroups = [];
      this._workerItemsByRepo.clear();
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
        const worktree: Worktree = { path: w.workdir, branch: w.branch, isMain: false };
        items.push(new TmuxSessionItem(
          session, repoName, worktree, isCurrentWs, hasGit,
          this._extensionUri, branchLabel, w.agent, repoRoot, w.workerId, w.displayName
        ));
      } else {
        const worktree: Worktree = { path: w.workdir, branch: w.branch, isMain: false };
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
          this._extensionUri, branchLabel, stoppedStatus, repoRoot, w.displayName
        ));
      }
    }

    return sortItems(items);
  }
}
