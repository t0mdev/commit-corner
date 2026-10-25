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
  // Space in a list you check off: on a file other than the one open, it opens that one (the
  // keyboard stays in the list); pressed again — on the file that is open — it ticks it off.
  // VS Code tells an extension the selected row, not the focused one: selecting the focused row
  // (list.select, what Enter does) and seeing whether the selection moved tells them apart.
  ctx.command('commitCorner.view.toggleViewedKey', async (viewName) => {
    const provider = views[viewName];
    if (!provider) return;
    const view = provider.view;
    // Working in another part of the view (a pull request row, a group): Space as always.
    if (view.selection[0] && !view.selection[0].viewed) {
      await vscode.commands.executeCommand('list.toggleExpand');
      return;
    }
    const id = (n) => n && n.viewed ? `${n.viewed.scope}\0${n.path}` : n && n.path;
    const before = id(view.selection[0]);
    // Whether you are looking at that file's diff right now (only then may Space tick it).
    const shown = (n) => {
      const groups = vscode.window.tabGroups;
      const input = groups && groups.activeTabGroup && groups.activeTabGroup.activeTab && groups.activeTabGroup.activeTab.input;
      if (!n || !n.openUris || !input) return false;
      const open = [input.modified, input.original, input.uri].filter(Boolean).map(String);
      return n.openUris().some((u) => open.includes(u));
    };
    const wasShown = shown(view.selection[0]);
    const moved = new Promise((resolve) => {
      const d = view.onDidChangeSelection(() => {
        d.dispose();
        resolve(true);
      });
      setTimeout(() => {
        d.dispose();
        resolve(false);
      }, 150);
    });
    await vscode.commands.executeCommand('list.select');
    const changed = (await moved) && id(view.selection[0]) !== before;
    const node = view.selection[0];
    // Opened another file, a row that is not a file, or the file was not on screen (Space opened
    // it): no tick — you tick what you have seen.
    if (changed || !node || !node.viewed || !wasShown) return;
    await vscode.commands.executeCommand('commitCorner.toggleViewed', node);
    const now = require('../viewed').get().isViewed(node.viewed.scope, node.path, node.viewed.fingerprint);
    vscode.window.setStatusBarMessage(`${now ? '✓ Viewed' : 'Not viewed'}: ${node.path}`, 3000);
  });
}

module.exports = { register, DELETE, RENAME, contextOf };
