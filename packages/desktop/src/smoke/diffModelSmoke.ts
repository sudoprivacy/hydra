/**
 * Smoke test: the getDiff → view mapping, on a REAL git worktree.
 *
 * The M4 Diff Review GUI can't launch headlessly, so this proves the layer that
 * matters instead: point the *real* headless `DiffService` (the same one
 * `HydraAppService.getDiff` / `getFileSnapshot` call) at a worktree with a
 * modify + add + delete + rename, wrap its result into the `DiffSummary` shape
 * the client returns, and drive it through the pure view functions the React
 * components render from (`diffModel.ts`). Asserts the changed-file list, the
 * line diff, the side-by-side pairing, and the ship handoff commands — plus the
 * pure edge cases the git repo won't exercise.
 *
 * Run: node packages/desktop/out/smoke/diffModelSmoke.js
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DiffService } from '@hydra/core/diff';
import type { DiffSummary } from '@hydra/protocol';

import {
  basePathFor,
  buildShipCommands,
  classifyStatus,
  collapseUnchangedRows,
  computeLineDiff,
  currentPathFor,
  splitLines,
  toChangedFileList,
  toSideBySide,
} from '../renderer/diff/diffModel';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A repo with a `main` base and a `feature` branch carrying M/D/R + an untracked add. */
function buildRepo(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: root, stdio: 'ignore' });
  git(['config', 'user.email', 'diff@hydra.test'], root);
  git(['config', 'user.name', 'Diff Smoke'], root);
  git(['config', 'commit.gpgsign', 'false'], root);

  fs.writeFileSync(path.join(root, 'keep.txt'), 'same\n');
  fs.writeFileSync(path.join(root, 'mod.txt'), 'line1\nline2\nline3\n');
  fs.writeFileSync(path.join(root, 'del.txt'), 'to be deleted\n');
  fs.writeFileSync(path.join(root, 'old-name.txt'), 'rename me\nsecond line\n');
  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'base'], root);

  git(['checkout', '-q', '-b', 'feature'], root);
  fs.writeFileSync(path.join(root, 'mod.txt'), 'line1\nline2-changed\nline3\nline4\n');
  fs.rmSync(path.join(root, 'del.txt'));
  git(['mv', 'old-name.txt', 'new-name.txt'], root); // pure rename → R
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'feature work'], root);

  fs.writeFileSync(path.join(root, 'added.txt'), 'brand new\n'); // untracked add
}

async function main(): Promise<void> {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-diffview-'));
  try {
    const repoRoot = path.join(tempHome, 'repo');
    buildRepo(repoRoot);

    // ── real getDiff, wrapped exactly like HydraAppService.getDiff ──
    const service = new DiffService();
    const result = await service.getDiff(repoRoot);
    const summary: DiffSummary = {
      session: 'diff-smoke',
      workdir: repoRoot,
      baseRef: result.baseRef,
      baseCommit: result.baseCommit,
      branch: result.branch,
      changes: result.changes,
      count: result.changes.length,
    };
    assert.equal(summary.baseRef, 'main', 'base ref resolves to main');
    assert.equal(summary.branch, 'feature', 'current branch is feature');

    // ── changed-file list mapping ──
    const files = toChangedFileList(summary);
    assert.deepEqual(
      files.map((f) => f.path),
      ['added.txt', 'del.txt', 'mod.txt', 'new-name.txt'],
      'files sorted by path',
    );
    assert.deepEqual(
      files.map((f) => f.kind),
      ['added', 'deleted', 'modified', 'renamed'],
      'kinds classified from git status codes',
    );
    assert.deepEqual(
      files.map((f) => f.badge.symbol),
      ['A', 'D', 'M', 'R'],
      'badges mirror git letters',
    );

    const [added, deleted, modified, renamed] = files;
    assert.equal(added.hasBase, false, 'an add has no base side');
    assert.equal(basePathFor(added), undefined, 'no base snapshot path for an add');
    assert.equal(currentPathFor(added), 'added.txt');

    assert.equal(deleted.hasCurrent, false, 'a delete has no current side');
    assert.equal(basePathFor(deleted), 'del.txt');
    assert.equal(currentPathFor(deleted), undefined, 'no current snapshot path for a delete');

    assert.equal(renamed.oldPath, 'old-name.txt', 'rename carries the original path');
    assert.equal(basePathFor(renamed), 'old-name.txt', 'rename base reads the ORIGINAL path');
    assert.equal(currentPathFor(renamed), 'new-name.txt', 'rename current reads the new path');

    // ── real getFileSnapshot → computeLineDiff for the modified file ──
    const base = await service.getFileSnapshot(repoRoot, basePathFor(modified)!, 'base');
    const current = await service.getFileSnapshot(repoRoot, currentPathFor(modified)!, 'current');
    assert.equal(base.content, 'line1\nline2\nline3\n', 'base snapshot is the pre-change content');
    assert.equal(current.content, 'line1\nline2-changed\nline3\nline4\n', 'current snapshot is working-tree content');

    const lineDiff = computeLineDiff(base.content, current.content);
    assert.equal(lineDiff.truncated, false);
    assert.equal(lineDiff.added, 2, 'two lines added (line2-changed + line4)');
    assert.equal(lineDiff.removed, 1, 'one line removed (line2)');
    assert.deepEqual(
      lineDiff.rows.map((r) => [r.type, r.text]),
      [
        ['context', 'line1'],
        ['del', 'line2'],
        ['add', 'line2-changed'],
        ['context', 'line3'],
        ['add', 'line4'],
      ],
      'inline rows in order',
    );

    // ── side-by-side pairing ──
    const split = toSideBySide(lineDiff.rows);
    assert.equal(split.length, 4, 'del/add zipped into one row, adds without a del pad the left');
    assert.equal(split[1].left.type, 'del');
    assert.equal(split[1].right.type, 'add');
    assert.equal(split[3].left.type, 'empty', 'the extra trailing add pads the base column');
    assert.equal(split[3].right.text, 'line4');

    // ── unchanged-context compaction ──
    const longContext = computeLineDiff(
      `${Array.from({ length: 10 }, (_, index) => `before-${index + 1}`).join('\n')}\nold\n${Array.from({ length: 10 }, (_, index) => `after-${index + 1}`).join('\n')}\n`,
      `${Array.from({ length: 10 }, (_, index) => `before-${index + 1}`).join('\n')}\nnew\n${Array.from({ length: 10 }, (_, index) => `after-${index + 1}`).join('\n')}\n`,
    );
    const compact = collapseUnchangedRows(
      longContext.rows,
      (row) => row.type === 'context',
      2,
      3,
    );
    assert.equal(compact[0].kind, 'gap', 'leading context is collapsed');
    assert.equal(compact[0].kind === 'gap' ? compact[0].count : 0, 8);
    const lastCompactItem = compact.at(-1);
    assert.equal(lastCompactItem?.kind, 'gap', 'trailing context is collapsed');
    assert.equal(lastCompactItem?.kind === 'gap' ? lastCompactItem.count : 0, 8);
    assert.equal(
      compact.filter((item) => item.kind === 'row').length,
      6,
      'two context lines remain on either side of the paired change',
    );

    // ── ship handoff commands ──
    const commands = buildShipCommands({ branch: summary.branch, workdir: summary.workdir });
    assert.equal(commands.length, 2, 'push + PR');
    assert.equal(commands[0].command, `git -C '${repoRoot}' push -u origin 'feature'`);
    assert.equal(commands[1].command, `cd '${repoRoot}' && gh pr create --head 'feature' --fill`);
    assert.deepEqual(buildShipCommands({ branch: '', workdir: repoRoot }), [], 'no branch → no handoff');

    // ── pure edge cases the repo doesn't cover ──
    assert.equal(classifyStatus('R100'), 'renamed', 'similarity score ignored');
    assert.equal(classifyStatus('C75'), 'copied');
    assert.equal(classifyStatus('T'), 'type-changed');
    assert.equal(classifyStatus('U'), 'unmerged');
    assert.equal(classifyStatus('X'), 'unknown');
    assert.equal(classifyStatus(''), 'unknown');

    assert.deepEqual(splitLines(''), [], 'empty content is zero lines');
    assert.deepEqual(splitLines('a\n'), ['a'], 'trailing newline drops the phantom row');
    assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
    assert.deepEqual(splitLines('a\n\n'), ['a', ''], 'a genuine blank line is kept');

    // Identical content diffs to nothing (a pure rename shows no line changes).
    const noChange = computeLineDiff('x\ny\n', 'x\ny\n');
    assert.equal(noChange.rows.length, 2);
    assert.equal(noChange.added, 0);
    assert.equal(noChange.removed, 0);

    console.log('diffModelSmoke: ok');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
