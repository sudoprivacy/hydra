// Pure navigation proof for the Desktop v2 terminal-first shell.
//
// Run: node packages/desktop/scripts/terminalFirstShellSmoke.mjs

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const tabStatePath = path.join(here, '..', 'src', 'renderer', 'tabs', 'tabState.ts');
const bundled = await build({
  entryPoints: [tabStatePath],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  logLevel: 'silent',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`;
const { chooseInitialSession, INITIAL_TABS_STATE, tabsReducer } = await import(moduleUrl);

const copilot = (session, status = 'running', agentSessionId = null) => ({
  session,
  sessionKind: 'copilot',
  status,
  agentSessionId,
});
const worker = (session, workerId, status = 'running') => ({
  session,
  sessionKind: 'worker',
  status,
  workerId,
});

// A true first run stays on the quiet Copilot creation surface even when a
// standalone Worker already exists.
assert.equal(chooseInitialSession([worker('orphan', 1)], null), null);

const descriptors = [
  copilot('captain-a', 'running', 'agent-a'),
  copilot('captain-b', 'running', 'agent-b'),
  worker('repo_feat-one', 1),
];
assert.equal(chooseInitialSession(descriptors, 'captain-b').session, 'captain-b');
assert.equal(chooseInitialSession(descriptors, 'missing').session, 'captain-a');
assert.equal(
  chooseInitialSession([copilot('paused', 'stopped'), worker('live-worker', 1)], null).session,
  'live-worker',
  'when Copilots exist but are stopped, the first live session is selected',
);

let state = INITIAL_TABS_STATE;
state = tabsReducer(state, { type: 'open', descriptor: descriptors[0] });
assert.equal(state.tabs.length, 1);
assert.equal(state.tabs[0].id, 'copilot:agent-a');
assert.equal(state.activeId, 'copilot:agent-a');

state = tabsReducer(state, { type: 'open', descriptor: descriptors[2], view: 'diff' });
assert.equal(state.tabs.length, 2);
assert.equal(state.activeId, 'worker:1');
assert.equal(state.tabs[1].view, 'diff');

state = tabsReducer(state, { type: 'open', descriptor: descriptors[2] });
assert.equal(state.tabs.length, 2, 'opening the same Worker focuses its existing tab');
assert.equal(state.tabs[1].view, 'diff', 'refocusing does not reset the selected Worker view');

state = tabsReducer(state, {
  type: 'reconcile',
  sessions: [descriptors[0], worker('repo_feat-renamed', 1)],
});
assert.equal(state.tabs[1].id, 'worker:1', 'Worker tab identity survives a route rename');
assert.equal(state.tabs[1].session, 'repo_feat-renamed');
assert.equal(state.tabs[1].view, 'diff', 'rename retains the Worker surface and local pane state');

state = tabsReducer(state, { type: 'close', id: 'worker:1' });
assert.equal(state.activeId, 'copilot:agent-a', 'closing active tab focuses its neighbour');
state = tabsReducer(state, { type: 'close', id: 'copilot:agent-a' });
assert.equal(state.activeId, null, 'closing the final tab returns to the session landing state');
assert.equal(state.tabs.length, 0);

state = tabsReducer(INITIAL_TABS_STATE, { type: 'open', descriptor: descriptors[2] });
state = tabsReducer(state, { type: 'reconcile', sessions: [] });
assert.equal(state.tabs.length, 0, 'deleted sessions prune their tabs');
assert.equal(state.activeId, null);

const rendererRoot = path.join(here, '..', 'src', 'renderer');
const baseStyles = fs.readFileSync(path.join(rendererRoot, 'styles', 'base.css'), 'utf-8');
const terminalSource = fs.readFileSync(path.join(rendererRoot, 'routes', 'WorkerTerminal.tsx'), 'utf-8');
const newShellSource = fs.readFileSync(
  path.join(rendererRoot, 'routes', 'terminal', 'NewShellControl.tsx'),
  'utf-8',
);
const panePopoverSource = fs.readFileSync(
  path.join(rendererRoot, 'routes', 'terminal', 'NewShellPopover.tsx'),
  'utf-8',
);
const closePaneSource = fs.readFileSync(
  path.join(rendererRoot, 'routes', 'terminal', 'ClosePaneConfirm.tsx'),
  'utf-8',
);

assert.match(terminalSource, /<NewShellControl/);
assert.match(terminalSource, /enabled=\{active && status === 'connected'\}/);
assert.match(newShellSource, /crypto\.randomUUID\(\)/);
assert.match(newShellSource, /direction: 'down',[\s\S]*startDirectory: 'session-workdir'/);
assert.match(newShellSource, /client\.focusTerminalPane/);
assert.match(newShellSource, /client\.closeTerminalPane/);
assert.match(panePopoverSource, /pane\.canClose \? \(/);
assert.match(panePopoverSource, /agent-current-directory/);
assert.match(closePaneSource, /Running processes in this pane will stop\./);
assert.match(baseStyles, /\.hydra-shell-popover \{/);

console.log('terminalFirstShellSmoke: ok');
