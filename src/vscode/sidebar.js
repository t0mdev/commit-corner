'use strict';

const vscode = require('vscode');
const { config } = require('./util');

/**
 * One Commit Corner view at a time in the sidebar (commitCorner.sidebar.oneViewAtATime, on by
 * default): the view you switch to fills the sidebar, the others are hidden (VS Code has no way
 * for an extension to collapse a view, only to hide and show it). Switch with the icons in each
 * view's title bar, the Actions hub or the chords; the Graph is the default. Off: the six views
 * stack as usual.
 */
const VIEWS = [
  ['graphView', 'Graph', 'git-merge'],
  ['branches', 'Repository', 'repo'],
  ['pullRequests', 'Pull Requests', 'git-pull-request'],
  ['compare', 'Compare', 'git-compare'],
  ['fileHistory', 'File History', 'history'],
  ['worktrees', 'Worktrees', 'list-tree'],
];
const IDS = VIEWS.map(([id]) => id);

const oneAtATime = () => config().get('sidebar.oneViewAtATime', true);
const run = (cmd) => vscode.commands.executeCommand(cmd).then(undefined, () => {});

/**
 * Show a sidebar view; one at a time, hide the others.
 * @param {string} id one of IDS
 * @param {{focus?: boolean}} [o] focus: give it the keyboard (default true)
 */
async function showView(id, o = {}) {
  if (!IDS.includes(id)) return;
  // You chose a view: that is the layout now (the pending first-run one would hide it again).
  if (firstLayout) {
    firstLayout = undefined;
    if (markLayoutApplied) await markLayoutApplied();
  }
  // Show the target first, so the container never goes empty in between.
  await run(`commitCorner.${id}.open`);
  if (oneAtATime()) for (const other of IDS) if (other !== id) await run(`commitCorner.${other}.removeView`);
  if (o.focus !== false) {
    if (id === 'graphView') await run('commitCorner.graphView.focusList');
    else await run(`commitCorner.${id}.focus`);
  }
}

/** All six views stacked again (the setting turned off). */
async function showAll() {
  for (const id of IDS) await run(`commitCorner.${id}.open`);
}

/** @param {import('./context').Context} ctx */
function register(ctx) {
  for (const [id] of VIEWS) {
    ctx.command(`commitCorner.sidebar.${id}`, () => showView(id));
    // The same, titled for the Switch View menu ("Graph", not "Sidebar: Show Graph").
    ctx.command(`commitCorner.sidebar.to.${id}`, () => showView(id));
  }
  ctx.command('commitCorner.sidebar.showAllViews', () => config().update('sidebar.oneViewAtATime', false, vscode.ConfigurationTarget.Global));
  ctx.command('commitCorner.sidebar.oneViewAtATime', () => config().update('sidebar.oneViewAtATime', true, vscode.ConfigurationTarget.Global));
  ctx.extContext.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('commitCorner.sidebar.oneViewAtATime')) return;
    if (oneAtATime()) showView('graphView', { focus: false });
    else showAll();
  }));
  // First time in a workspace: start with the Graph alone (later, VS Code keeps what you chose).
  // Done when the sidebar is first shown (VS Code ignores hiding views of a container that was
  // never opened); the sidebar is never switched to Commit Corner for it.
  const key = 'sidebar.oneViewApplied';
  markLayoutApplied = () => ctx.extContext.workspaceState.update(key, true);
  if (ctx.extContext.workspaceState.get(key)) return;
  firstLayout = async () => {
    if (!oneAtATime() || ctx.extContext.workspaceState.get(key)) return;
    await markLayoutApplied();
    for (const other of IDS) if (other !== 'graphView') await run(`commitCorner.${other}.removeView`);
  };
}

/** @type {(() => Promise<void>)|undefined} the first-run layout, until the sidebar is shown */
let firstLayout;
/** @type {(() => Thenable<void>)|undefined} remembers that the layout was set (no first-run one any more) */
let markLayoutApplied;

/** The Commit Corner sidebar is showing (its Graph view loaded): apply the first-run layout once. */
function sidebarShown() {
  const f = firstLayout;
  firstLayout = undefined;
  if (f) f().catch(() => {});
}

module.exports = { register, showView, sidebarShown, VIEWS, IDS };
