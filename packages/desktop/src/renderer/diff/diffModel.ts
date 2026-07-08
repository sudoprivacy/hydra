// Pure, DOM-free view logic for the diff review screen.
//
// It turns the shapes the headless DiffService returns — `DiffSummary` /
// `DiffChange` from `getDiff`, and file contents from `getFileSnapshot` — into
// render-ready view models. There is deliberately ZERO React, DOM, or Node
// dependency here (it imports only `type`s from `@hydra/protocol`), so the whole
// getDiff→view mapping can be unit-tested headlessly under `node`
// (see src/smoke/diffModelSmoke.ts). The React components in this directory are
// thin shells over these functions.

import type { DiffChange, DiffSummary } from '@hydra/protocol';

// ── changed-file classification ──────────────────────────────────────────────

export type ChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type-changed'
  | 'unmerged'
  | 'unknown';

export interface ChangeBadge {
  kind: ChangeKind;
  /** One-letter badge, mirroring git's `--name-status` letters (A/M/D/R/C/T/U). */
  symbol: string;
  /** Full word for tooltips / accessibility labels. */
  label: string;
}

const BADGES: Record<ChangeKind, { symbol: string; label: string }> = {
  added: { symbol: 'A', label: 'Added' },
  modified: { symbol: 'M', label: 'Modified' },
  deleted: { symbol: 'D', label: 'Deleted' },
  renamed: { symbol: 'R', label: 'Renamed' },
  copied: { symbol: 'C', label: 'Copied' },
  'type-changed': { symbol: 'T', label: 'Type changed' },
  unmerged: { symbol: 'U', label: 'Unmerged' },
  unknown: { symbol: '?', label: 'Unknown' },
};

/**
 * Map a git `--name-status` code to a change kind. Rename/copy codes carry a
 * similarity score (`R100`, `C75`) that we ignore — only the leading letter
 * matters for classification.
 */
export function classifyStatus(status: string): ChangeKind {
  const code = (status ?? '').trim().charAt(0).toUpperCase();
  switch (code) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'type-changed';
    case 'U':
      return 'unmerged';
    default:
      return 'unknown';
  }
}

export function changeBadge(kind: ChangeKind): ChangeBadge {
  const meta = BADGES[kind];
  return { kind, symbol: meta.symbol, label: meta.label };
}

export interface ChangedFileView {
  /** Post-rename path — the stable React key and the primary label. */
  path: string;
  /** Original path for renames/copies (undefined otherwise). */
  oldPath?: string;
  kind: ChangeKind;
  badge: ChangeBadge;
  /** Raw git status code, preserved for detail/debugging. */
  status: string;
  /** Whether a base-side snapshot exists (false only for pure adds). */
  hasBase: boolean;
  /** Whether a current-side snapshot exists (false only for pure deletes). */
  hasCurrent: boolean;
}

export function toChangedFileView(change: DiffChange): ChangedFileView {
  const kind = classifyStatus(change.status);
  return {
    path: change.path,
    oldPath: change.oldPath,
    kind,
    badge: changeBadge(kind),
    status: change.status,
    hasBase: kind !== 'added',
    hasCurrent: kind !== 'deleted',
  };
}

/** Map a getDiff summary's changes into the file-list view models. */
export function toChangedFileList(summary: Pick<DiffSummary, 'changes'>): ChangedFileView[] {
  return summary.changes.map(toChangedFileView);
}

/**
 * The `getFileSnapshot` path for a file's base side. For renames/copies the base
 * lives at the ORIGINAL path; everything else uses the current path. Returns
 * undefined when there is no base side (a pure add).
 */
export function basePathFor(view: ChangedFileView): string | undefined {
  if (!view.hasBase) {
    return undefined;
  }
  return view.oldPath ?? view.path;
}

/** The `getFileSnapshot` path for a file's current side (undefined for deletes). */
export function currentPathFor(view: ChangedFileView): string | undefined {
  return view.hasCurrent ? view.path : undefined;
}

// ── line-level diff (LCS) ────────────────────────────────────────────────────

export type DiffRowType = 'context' | 'add' | 'del';

export interface DiffRow {
  type: DiffRowType;
  /** 1-based base-side line number (undefined for pure adds). */
  baseLine?: number;
  /** 1-based current-side line number (undefined for pure deletes). */
  currentLine?: number;
  text: string;
}

export interface LineDiff {
  rows: DiffRow[];
  added: number;
  removed: number;
  /** True when the file pair was too large to diff inline; `rows` is empty. */
  truncated: boolean;
}

// Product of the two line counts above which we skip the O(n·m) LCS and mark the
// diff truncated, so a giant generated file can never wedge the renderer.
const MAX_LCS_CELLS = 4_000_000;

/** Split file content into lines, dropping a single trailing newline's phantom row. */
export function splitLines(content: string): string[] {
  if (content === '') {
    return [];
  }
  const normalized = content.endsWith('\n') ? content.slice(0, -1) : content;
  return normalized.split('\n');
}

/**
 * A classic LCS line diff between the base and current contents of one file.
 * Produces a linear row list (context / del / add) suitable for an inline view;
 * `toSideBySide` pairs it for the two-column view.
 */
export function computeLineDiff(baseContent: string, currentContent: string): LineDiff {
  const base = splitLines(baseContent);
  const current = splitLines(currentContent);

  if (base.length * current.length > MAX_LCS_CELLS) {
    return { rows: [], added: 0, removed: 0, truncated: true };
  }

  // lcs[i][j] = length of the longest common subsequence of base[i:] & current[j:].
  const lcs: number[][] = Array.from({ length: base.length + 1 }, () =>
    new Array<number>(current.length + 1).fill(0),
  );
  for (let i = base.length - 1; i >= 0; i--) {
    for (let j = current.length - 1; j >= 0; j--) {
      lcs[i][j] =
        base[i] === current[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < base.length && j < current.length) {
    if (base[i] === current[j]) {
      rows.push({ type: 'context', baseLine: i + 1, currentLine: j + 1, text: base[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ type: 'del', baseLine: i + 1, text: base[i] });
      removed++;
      i++;
    } else {
      rows.push({ type: 'add', currentLine: j + 1, text: current[j] });
      added++;
      j++;
    }
  }
  while (i < base.length) {
    rows.push({ type: 'del', baseLine: i + 1, text: base[i] });
    removed++;
    i++;
  }
  while (j < current.length) {
    rows.push({ type: 'add', currentLine: j + 1, text: current[j] });
    added++;
    j++;
  }

  return { rows, added, removed, truncated: false };
}

// ── side-by-side pairing ─────────────────────────────────────────────────────

export interface SideCell {
  lineNumber?: number;
  text: string;
  type: 'context' | 'del' | 'add' | 'empty';
}

export interface SideBySideRow {
  left: SideCell;
  right: SideCell;
}

const EMPTY_CELL: SideCell = { text: '', type: 'empty' };

/**
 * Pair a linear diff into aligned two-column rows. Consecutive deletions and
 * additions are zipped side by side (the shorter run padded with empty cells);
 * context rows map to both columns.
 */
export function toSideBySide(rows: DiffRow[]): SideBySideRow[] {
  const paired: SideBySideRow[] = [];
  let dels: DiffRow[] = [];
  let adds: DiffRow[] = [];

  const flush = (): void => {
    const span = Math.max(dels.length, adds.length);
    for (let k = 0; k < span; k++) {
      const del = dels[k];
      const add = adds[k];
      paired.push({
        left: del ? { lineNumber: del.baseLine, text: del.text, type: 'del' } : EMPTY_CELL,
        right: add ? { lineNumber: add.currentLine, text: add.text, type: 'add' } : EMPTY_CELL,
      });
    }
    dels = [];
    adds = [];
  };

  for (const row of rows) {
    if (row.type === 'del') {
      dels.push(row);
    } else if (row.type === 'add') {
      adds.push(row);
    } else {
      flush();
      paired.push({
        left: { lineNumber: row.baseLine, text: row.text, type: 'context' },
        right: { lineNumber: row.currentLine, text: row.text, type: 'context' },
      });
    }
  }
  flush();
  return paired;
}

// ── ship handoff (push & PR) ─────────────────────────────────────────────────

export interface ShipCommand {
  title: string;
  command: string;
}

export interface ShipHandoffInput {
  /** Current branch of the worktree (empty in detached HEAD → no handoff). */
  branch: string;
  /** Absolute worktree path — the diff is anchored here. */
  workdir: string;
}

/** Single-quote a shell argument, escaping embedded single quotes. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The exact commands to ship the worker's branch: push it, then open a PR. v1 is
 * a *handoff* — there is no push/PR verb on `HydraControlClient`, so we surface
 * the copy-pasteable commands (FINAL.md risk #3: "review + ship only, do not
 * build an IDE"). Returns [] when the worktree has no branch to push.
 */
export function buildShipCommands(input: ShipHandoffInput): ShipCommand[] {
  const branch = input.branch.trim();
  if (!branch) {
    return [];
  }
  const dir = shQuote(input.workdir);
  return [
    {
      title: 'Push the branch to origin',
      command: `git -C ${dir} push -u origin ${shQuote(branch)}`,
    },
    {
      title: 'Open a pull request',
      command: `cd ${dir} && gh pr create --head ${shQuote(branch)} --fill`,
    },
  ];
}
