'use strict';

const vscode = require('vscode');

/**
 * Explorer-style keys in the tree views: Delete removes the focused item,
 * F2 renames it. Keybindings pass the view name as their argument; the item
 * is the view's current selection, so the keys act on what is highlighted.
 */

/** contextValue of a tree node, e.g. "branch:tracking". */
async function contextOf(node) {
  if (!node || typeof node.getTreeItem !== 'function') return '';
  const item = await node.getTreeItem();
  return (item && item.contextValue) || '';
}

const DELETE = [
  [/^branch(:tracking)?$/, 'commitCorner.deleteBranch'],
  [/^remoteBranch$/, 'commitCorner.deleteRemoteBranch'],
  [/^tag$/, 'commitCorner.deleteTag'],
  [/^remote$/, 'commitCorner.removeRemote'],
  [/^stash$/, 'commitCorner.stashDrop'],
  [/^worktree(?!:main)(?!.*:current)/, 'commitCorner.worktreeRemove'],
];

const RENAME = [
  [/^branch/, 'commitCorner.renameBranch'],
  [/^remote$/, 'commitCorner.renameRemote'],
];

/**
 * @param {import('../context').Context} ctx
 * @param {Record<string, {view: vscode.TreeView<any>}>} views by name ("branches", "stashes", …)
 */
function register(ctx, views) {
  const dispatch = (table, verb) => async (viewName) => {
    const provider = views[viewName];
    const node = provider && provider.view.selection[0];
    if (!node) return;
    const cv = await contextOf(node);
    const hit = table.find(([re]) => re.test(cv));
    if (hit) await vscode.commands.executeCommand(hit[1], node);
    else vscode.window.setStatusBarMessage(`Commit Corner: nothing to ${verb} here${cv === 'branch:current' ? ' (the current branch cannot be deleted)' : ''}`, 3000);
  };
  ctx.command('commitCorner.view.deleteItem', dispatch(DELETE, 'delete'));
  ctx.command('commitCorner.view.renameItem', dispatch(RENAME, 'rename'));
}

module.exports = { register, DELETE, RENAME, contextOf };
