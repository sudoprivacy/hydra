// Phase 5 proof for v2-only navigation, Sidebar filtering, CSS ownership, and icons.

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const renderer = path.join(desktop, 'src', 'renderer');
const { filterSidebarView } = await loadRendererModule(path.join(renderer, 'sidebar', 'sidebarFilter.ts'));
const { discloseRows } = await loadRendererModule(path.join(renderer, 'sidebar', 'disclosure.ts'));
const { treeRowIconName } = await loadRendererModule(path.join(renderer, 'sidebar', 'rowIcon.ts'));
const {
  chooseInitialRepository,
  MANUAL_REPOSITORY,
  suggestBranchFromTask,
} = await loadRendererModule(path.join(renderer, 'missionControl', 'creationFormModel.ts'));

const copilot = {
  kind: 'copilot',
  session: 'captain',
  name: 'Release Captain',
  agent: 'codex',
  workdir: '/Users/test',
};
const codeWorker = {
  kind: 'worker',
  type: 'code',
  workerId: 7,
  session: 'hydra_feat-search',
  name: 'desktop-search',
  agent: 'claude',
  repo: '/src/hydra',
  branch: 'feat/search',
  workdir: '/wt/search',
  parentCopilotSession: 'captain',
};
const taskWorker = {
  ...codeWorker,
  type: 'task',
  workerId: 8,
  session: 'task_docs',
  name: 'docs-cleanup',
  repo: null,
  branch: null,
  workdir: '/notes',
  parentCopilotSession: null,
};
const view = {
  copilots: [copilot],
  workers: [codeWorker, taskWorker],
  workerGroups: [
    { key: 'repo:hydra', label: 'hydra', kind: 'repository', workers: [codeWorker] },
    { key: 'tasks', label: 'Local Tasks', kind: 'local-tasks', workers: [taskWorker] },
  ],
  attention: [],
  unreadTotal: 0,
  activeAttentionTotal: 0,
};

const byAgent = filterSidebarView(view, 'CODEX');
assert.deepEqual(byAgent.copilots.map(item => item.session), ['captain']);
assert.equal(byAgent.workerGroups.length, 0);

const byRepo = filterSidebarView(view, 'hydra');
assert.equal(byRepo.workerGroups.length, 1);
assert.equal(byRepo.workerGroups[0].kind, 'repository', 'search preserves repository grouping');
assert.equal(byRepo.workerGroups[0].workers[0].workerId, 7);

const byFolder = filterSidebarView(view, '/notes');
assert.equal(byFolder.workerGroups[0].kind, 'local-tasks', 'folder search preserves Local Tasks');
assert.equal(filterSidebarView(view, 'missing').noMatches, true);
assert.equal(treeRowIconName(codeWorker), 'git-branch', 'code workers keep the branch icon');
assert.equal(treeRowIconName(taskWorker), null, 'task workers omit the row icon');
assert.equal(treeRowIconName(copilot), 'git-branch', 'copilots keep their existing icon');

const repositoryOptions = [
  {
    value: '/repos/registered',
    label: 'acme/registered',
    path: '/repos/registered',
    aliases: [],
    sources: ['registered'],
    defaultBranch: 'main',
  },
  {
    value: '/repos/recent',
    label: 'recent',
    path: '/repos/recent',
    aliases: ['/worktrees/recent-task'],
    sources: ['recent'],
    defaultBranch: 'main',
  },
];
assert.equal(
  chooseInitialRepository(repositoryOptions, '/worktrees/recent-task/'),
  '/repos/recent',
  'active linked-worktree context resolves to its primary repository option',
);
assert.equal(
  chooseInitialRepository(repositoryOptions),
  '/repos/recent',
  'recent repository wins when no sidebar context is available',
);
assert.equal(
  chooseInitialRepository(repositoryOptions, '/repos/another'),
  MANUAL_REPOSITORY,
  'unknown explicit context stays available as manual repository input',
);
assert.equal(suggestBranchFromTask('Fix create dialog defaults'), 'feat/fix-create-dialog-defaults');
assert.equal(suggestBranchFromTask('优化 创建弹窗'), 'feat/优化-创建弹窗');
assert.equal(suggestBranchFromTask(''), 'feat/new-worker');

const sessions = ['a', 'b', 'c', 'd', 'e', 'f'];
assert.deepEqual(discloseRows(sessions, 4, false, false), {
  visible: ['a', 'b', 'c', 'd'],
  hiddenCount: 2,
  canToggle: true,
});
assert.deepEqual(discloseRows(sessions, 4, true, false), {
  visible: sessions,
  hiddenCount: 0,
  canToggle: true,
});
assert.deepEqual(discloseRows(sessions, 4, false, true), {
  visible: sessions,
  hiddenCount: 0,
  canToggle: false,
}, 'search reveals every matching session without a redundant disclosure control');

const indexHtml = fs.readFileSync(path.join(desktop, 'index.html'), 'utf8');
assert.equal(indexHtml.includes('<style>'), false, 'index.html has no renderer CSS block');
assert.equal(fs.existsSync(path.join(renderer, 'missionControl', 'boardModel.ts')), false, 'legacy board model removed');

for (const name of ['tokens', 'base', 'shell', 'sidebar', 'workspace', 'context', 'diff', 'states']) {
  assert.equal(fs.existsSync(path.join(renderer, 'styles', `${name}.css`)), true, `${name}.css exists`);
}

const sidebarCss = fs.readFileSync(path.join(renderer, 'styles', 'sidebar.css'), 'utf8');
assert.match(
  sidebarCss,
  /\.hydra-row__menu\.hydra-menu--open\s*\{[^}]*z-index:\s*[1-9]\d*;/s,
  'an open row menu raises its transformed stacking context above following tree rows',
);

const sessionHeaderSource = fs.readFileSync(path.join(renderer, 'shell', 'SessionHeader.tsx'), 'utf8');
assert.match(sessionHeaderSource, /<ListTree\b/, 'context toggle uses the list-tree icon');
assert.equal(sessionHeaderSource.includes('SquarePen'), false, 'context toggle does not use the edit icon');

const desktopPackage = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
assert.equal(typeof desktopPackage.dependencies['lucide-react'], 'string', 'coherent icon dependency declared');

const forbiddenGlyphs = /[▸×✕⋮↻✓]/u;
for (const file of collectSourceFiles(renderer)) {
  const source = fs.readFileSync(file, 'utf8');
  assert.equal(forbiddenGlyphs.test(source), false, `text icon removed from ${path.relative(renderer, file)}`);
}

console.log('supportingFlowsSmoke: ok');

async function loadRendererModule(entryPoint) {
  const bundled = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  });
  const source = Buffer.from(bundled.outputFiles[0].text).toString('base64');
  return import(`data:text/javascript;base64,${source}`);
}

function collectSourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(absolute));
    else if (/\.tsx?$/.test(entry.name)) files.push(absolute);
  }
  return files;
}
