'use strict';

const vscode = require('vscode');
const notify = require('../notify');
const { MessageNode, FileNode, GroupNode } = require('./nodes');
const { formatDate, absoluteDate, confirm, log, escapeIcons } = require('../util');
const { openMultiDiff } = require('../diffs');
const { runConflicting } = require('../commands/branchCommands');

class StashNode {
  constructor(repo, stash) {
    this.repo = repo;
    this.repoRoot = repo.root;
    this.stash = stash;
    this.sha = stash.sha;
    this.stashRef = stash.ref;
  }

  getTreeItem() {
    const s = this.stash;
    const item = new vscode.TreeItem(s.description || s.message, vscode.TreeItemCollapsibleState.Collapsed);
    item.description = `${s.ref}${s.branch ? ` • ${s.branch}` : ''} • ${formatDate(s.date)}`;
    item.tooltip = `${s.message}\n${absoluteDate(s.date)}${s.parents[2] ? '\nIncludes untracked files' : ''}`;
    item.iconPath = new vscode.ThemeIcon('archive');
    item.contextValue = 'stash';
    return item;
  }

  async getChildren() {
    const files = await this.repo.getStashFiles(this.stash);
    return files.map((f) => new FileNode(this.repo, { ...f, status: f.untracked ? 'A' : f.status }, { leftRef: f.beforeRef, rightRef: f.afterRef, contextValue: 'stashFile', parent: this }));
  }
}

/**
 * The "Stashes" group of the Repository view (collapsed; its children load when opened).
 * @param {import('../../git/repository').Repository} repo
 */
function stashGroup(repo) {
  const count = (repo.state && repo.state.stashCount) || 0;
  return new GroupNode('Stashes', async () => {
    const stashes = await repo.getStashes();
    if (!stashes.length) return [new MessageNode('No stashes', 'info')];
    return stashes.map((s) => new StashNode(repo, s));
  }, { icon: 'archive', description: count ? String(count) : undefined, collapsed: true, contextValue: 'group:stashes', id: `${repo.root}:stashes` });
}

/** @param {import('../context').Context} ctx */
function register(ctx) {
  const { manager } = ctx;
  const cmd = ctx.command;

  const stashCmd = (id, opts) => cmd(id, async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo) return;
    // Say what goes into the stash and what stays: untracked files only with "Include Untracked".
    // Looked at now (a file saved a second ago is in it).
    const st = await repo.refreshState();
    const changed = opts.staged ? st.staged.length : new Set([...st.staged, ...st.unstaged].map((e) => e.path)).size;
    const untracked = st.untracked.length;
    const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
    if (!changed && !(opts.includeUntracked && untracked)) {
      // Nothing that this stash takes: say so, and offer what would work.
      if (untracked && !opts.staged) {
        // A choice on the keyboard's way (a notification button needs the mouse or a detour).
        const pick = await vscode.window.showQuickPick([
          { label: '$(archive) Stash Including Untracked', description: n(untracked, 'untracked file'), go: true },
          { label: '$(close) Cancel' },
        ], { title: `Only ${n(untracked, 'untracked file')}: a plain stash leaves them where they are` });
        if (pick && pick.go) await vscode.commands.executeCommand('commitCorner.stashIncludeUntracked', repo);
      } else notify.info(opts.staged ? 'Nothing is staged to stash.' : 'There are no changes to stash.');
      return;
    }
    const title = `Stash ${n(changed + (opts.includeUntracked ? untracked : 0), opts.staged ? 'staged file' : 'changed file')}${opts.keepIndex ? ' (staged changes stay staged)' : ''}${untracked && !opts.includeUntracked ? ` — ${n(untracked, 'untracked file')} stay${untracked === 1 ? 's' : ''} (use Stash (Include Untracked) for them)` : ''}`;
    const message = await vscode.window.showInputBox({ title, prompt: 'Stash message (optional)', placeHolder: 'What were you working on?' });
    if (message === undefined) return;
    await repo.stashPush({ ...opts, message: message || undefined });
  });
  stashCmd('commitCorner.stash', {});
  stashCmd('commitCorner.stashIncludeUntracked', { includeUntracked: true });
  stashCmd('commitCorner.stashKeepIndex', { keepIndex: true });
  stashCmd('commitCorner.stashStaged', { staged: true });

  cmd('commitCorner.stashFiles', async (...args) => {
    const { resolveResources } = require('../commands/scmCommands');
    const resources = resolveResources(manager, args);
    if (!resources.length) return;
    const repo = resources[0].repo;
    const message = await vscode.window.showInputBox({ prompt: `Stash ${resources.length} file(s) — message (optional)` });
    if (message === undefined) return;
    const paths = resources.filter((r) => r.repo === repo).flatMap((r) => (r.origPath ? [r.path, r.origPath] : [r.path]));
    await repo.stashPush({ message: message || undefined, includeUntracked: true, paths });
  });

  async function pickStash(node, verb) {
    if (node && node.stashRef) {
      const repo = manager.getRepository(node.repoRoot);
      // stash@{n} is positional: a stash pushed or dropped elsewhere since the view was drawn
      // shifts the numbers. Act on the stash the user saw, found by its SHA.
      const current = (await repo.getStashes()).find((s) => s.sha === node.sha);
      if (!current) {
        notify.warn('That stash no longer exists (it was dropped or popped elsewhere).');
        return undefined;
      }
      return { repo, ref: current.ref, stash: current };
    }
    const repo = await manager.pick(node);
    if (!repo) return undefined;
    const stashes = await repo.getStashes();
    if (!stashes.length) {
      notify.info('There are no stashes.');
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(stashes.map((s) => ({ label: escapeIcons(s.description || s.message), description: `${s.ref} • ${formatDate(s.date)}`, s })), { placeHolder: `${verb} which stash?` });
    return pick && { repo, ref: pick.s.ref, stash: pick.s };
  }

  cmd('commitCorner.stashApply', async (node) => {
    const t = await pickStash(node, 'Apply');
    if (t) await runConflicting(t.repo, 'Applying stash…', () => t.repo.stashApply(t.ref, false), 'stash');
  });
  cmd('commitCorner.stashPop', async (node) => {
    const t = await pickStash(node, 'Pop');
    if (t) await runConflicting(t.repo, 'Popping stash…', () => t.repo.stashApply(t.ref, true), 'stash');
  });
  cmd('commitCorner.stashDrop', async (node) => {
    const t = await pickStash(node, 'Drop');
    if (!t) return;
    if (!(await confirm(`Drop ${t.ref}?`, 'Drop', 'A dropped stash can only be recovered by its SHA, which is printed in the log.'))) return;
    // stash@{n} may have shifted while the dialog was open (a stash pushed elsewhere).
    const now = (await t.repo.getStashes()).find((s) => s.sha === t.stash.sha);
    if (!now) return;
    const { stdout } = await t.repo.run(['stash', 'drop', now.ref]);
    // git prints the dropped stash's SHA, the only way to recover it later.
    if (stdout) log().info(stdout.trim());
  });
  cmd('commitCorner.stashBranch', async (node) => {
    const t = await pickStash(node, 'Create a branch from');
    if (!t) return;
    const name = await vscode.window.showInputBox({ prompt: `New branch for ${t.ref}` });
    if (name) await t.repo.stashBranch(name, t.ref);
  });
  cmd('commitCorner.stashShow', async (node) => {
    const t = await pickStash(node, 'Show');
    if (!t) return;
    const files = await t.repo.getStashFiles(t.stash);
    await openMultiDiff(t.repo, `${t.ref}: ${t.stash.description || t.stash.message}`, files.map((f) => ({
      path: f.path,
      leftRef: f.untracked || f.status === 'A' ? null : f.beforeRef,
      leftPath: f.origPath || f.path,
      rightRef: f.status === 'D' ? null : f.afterRef,
    })));
  });
}

module.exports = { stashGroup, StashNode, register };
