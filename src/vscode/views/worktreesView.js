'use strict';

const vscode = require('vscode');
const notify = require('../notify');
const path = require('path');
const { TreeProvider, MessageNode, CommitNode, fingerprintOf } = require('./nodes');
const viewed = require('../viewed');
const { git } = require('../../git/exec');
const { parseStatus } = require('../../git/parse');
const { toGitUri } = require('../uri');
const { shortSha, confirm, formatDate, escapeMarkdown, debounce, inThisWindow, escapeIcons, statusIcon, STATUS_LABELS, log } = require('../util');
const { pickRef, inputBranchName } = require('../pickers');
const { GitError } = require('../../git/exec');

/** Fired after worktree commands change the list (add, remove, lock, prune). */
const changed = new vscode.EventEmitter();

/** "2 staged, 3 changed, 1 untracked", "clean", or undefined when unknown. */
function changesText(c) {
  if (!c) return undefined;
  const parts = [];
  if (c.conflicts) parts.push(`${c.conflicts} conflicted`);
  if (c.staged) parts.push(`${c.staged} staged`);
  if (c.unstaged) parts.push(`${c.unstaged} changed`);
  if (c.untracked) parts.push(`${c.untracked} untracked`);
  return parts.length ? parts.join(', ') : 'clean';
}

/**
 * Where a worktree's own work starts: the branch it was created from (often your local main,
 * with your unpushed work in it), else your local default branch rather than origin's.
 */
async function baseOf(repo, wt) {
  let fallback = wt.base || (await repo.defaultBaseRef());
  if (fallback && /^origin\//.test(fallback) && (await repo.revParse(`refs/heads/${fallback.slice(7)}`))) fallback = fallback.slice(7);
  const base = (wt.branch && (await repo.createdFrom(wt.branch).catch(() => undefined))) || fallback;
  return { base, fallback };
}

/**
 * "Changes vs main" under an agent's worktree: what its branch did since it left the base,
 * committed and uncommitted (like Changes vs Base), file by file, each with a "Viewed"
 * checkbox. A file the agent changes again is unviewed again (its content fingerprint differs).
 */
class WorktreeChangesNode {
  constructor(parent, base, { mergeBase, changes, ids }) {
    this.provider = parent.provider;
    this.repo = parent.repo;
    this.repoRoot = parent.repoRoot;
    this.worktree = parent.worktree;
    this.worktreePath = parent.worktreePath;
    this.base = base;
    this.mergeBase = mergeBase;
    this.changes = changes;
    this.ids = ids;
    // For the Mark All as Viewed / Clear Viewed / Summarize commands.
    this.viewedScope = `worktree:${this.repoRoot}:${this.worktreePath}:${base}`;
    this.viewedFiles = changes.map((c) => ({ path: c.path, fingerprint: fingerprintOf(ids, c) }));
    this.viewedOwner = this;
    this.viewedProvider = parent.provider;
  }

  getTreeItem() {
    const n = this.changes.length;
    const seen = viewed.get().count(this.viewedScope, this.viewedFiles);
    // Redrawn when marks change (its count): it stays open if you opened it.
    const open = this.provider && this.provider.openChanges && this.provider.openChanges.has(this.worktreePath);
    const item = new vscode.TreeItem(`Changes vs ${this.base}`, open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    // Short (a narrow sidebar cuts the end): "3 files", then "1/3 viewed", "all 3 viewed".
    item.description = !seen ? `${n} file${n === 1 ? '' : 's'}` : seen === n ? (n === 1 ? 'viewed' : `all ${n} viewed`) : `${seen}/${n} viewed`;
    item.tooltip = `What ${this.worktree.branch || path.basename(this.worktreePath)} changed since it left ${this.base} (${shortSha(this.mergeBase)}), committed and uncommitted. Check files off as you review them; a file that changes again unchecks itself.`;
    item.iconPath = new vscode.ThemeIcon(seen === n ? 'pass' : 'git-compare');
    item.contextValue = 'viewedGroup:worktree';
    item.id = `worktreeChanges:${this.worktreePath}`;
    return item;
  }

  getChildren() {
    return [...this.changes].sort((a, b) => a.path.localeCompare(b.path)).map((c) => new WorktreeFileNode(this, c));
  }
}

/** A file of "Changes vs main": opens base ↔ the file in the worktree; Viewed checkbox. */
class WorktreeFileNode {
  /** The URIs its diff shows (set when its row is drawn). */
  openUris() {
    return this.uris || [];
  }

  constructor(owner, change) {
    this.owner = owner;
    this.change = change;
    this.path = change.path;
    this.viewed = { scope: owner.viewedScope, fingerprint: fingerprintOf(owner.ids, change), owner, provider: owner.provider };
  }

  getTreeItem() {
    const { owner, change } = this;
    const name = path.posix.basename(change.path);
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    const dir = path.posix.dirname(change.path);
    item.description = dir === '.' ? '' : dir;
    const file = vscode.Uri.file(path.join(owner.worktreePath, ...change.path.split('/')));
    // The fragment keeps the file icon but not the Explorer's decorations of the main worktree.
    item.resourceUri = file.with({ fragment: 'commit-corner-history' });
    item.iconPath = statusIcon(change.status);
    item.tooltip = `${STATUS_LABELS[change.status] || change.status}: ${change.origPath ? `${change.origPath} → ` : ''}${change.path}`;
    item.contextValue = 'changedFile:worktree'; // not /^worktree/: those are the worktree row's menus
    item.checkboxState = viewed.checkbox(viewed.get(), this.viewed.scope, change.path, this.viewed.fingerprint);
    const left = toGitUri(owner.repoRoot, change.origPath || change.path, owner.mergeBase, { root: owner.worktreePath });
    const title = `${name} (${owner.worktree.branch || path.basename(owner.worktreePath)} vs ${owner.base})`;
    // The keyboard stays in the list: Enter shows the file, Space ticks it off.
    const keep = { preserveFocus: true, preview: true };
    this.uris = [String(file), String(left)];
    if (change.status === 'A') item.command = { command: 'vscode.open', title: 'Open', arguments: [file, keep] };
    else if (change.status === 'D') item.command = { command: 'vscode.open', title: 'Open', arguments: [left, keep] };
    else item.command = { command: 'vscode.diff', title: 'Open Changes', arguments: [left, file, title, keep] };
    return item;
  }
}

class WorktreeNode {
  constructor(repo, wt, provider) {
    this.provider = provider;
    this.repo = repo;
    this.repoRoot = repo.root;
    this.worktree = wt;
    this.worktreePath = wt.path;
  }

  getTreeItem() {
    const wt = this.worktree;
    const item = new vscode.TreeItem(wt.branch || (wt.bare ? '(bare)' : `detached at ${shortSha(wt.head)}`), vscode.TreeItemCollapsibleState.Collapsed);
    const dirty = wt.changes && wt.changes.staged + wt.changes.unstaged + wt.changes.untracked + wt.changes.conflicts;
    // What is going on first (uncommitted work), then where it stands: a narrow sidebar cuts the end.
    const parts = [];
    if (wt.changes) parts.push(dirty ? `● ${dirty} change${dirty === 1 ? '' : 's'}` : '✓ clean');
    if (wt.ahead || wt.behind) parts.push(`${wt.ahead ? `↑${wt.ahead}` : ''}${wt.behind ? `↓${wt.behind}` : ''}`);
    else if (wt.base && (wt.baseAhead || wt.baseBehind)) parts.push(`${wt.baseAhead ? `↑${wt.baseAhead}` : ''}${wt.baseBehind ? `↓${wt.baseBehind}` : ''} vs ${wt.base}`);
    parts.push(path.basename(wt.path));
    if (wt.commit) parts.push(formatDate(wt.commit.authorDate));
    const flags = [wt.isCurrent ? 'this window' : '', wt.isMain ? 'main' : '', wt.locked ? 'locked' : '', wt.prunable ? 'prunable' : ''].filter(Boolean);
    if (flags.length) parts.push(flags.join(', '));
    item.description = parts.join(' • ');
    const md = new vscode.MarkdownString(undefined, true);
    md.supportThemeIcons = true;
    md.appendMarkdown(`$(folder) \`${wt.path.replace(/`/g, "'").replace(/[\r\n]+/g, ' ')}\`  \n`); // a code span shows its text as is
    md.appendMarkdown(`$(git-branch) ${escapeMarkdown(wt.branch || 'detached HEAD')}${wt.upstream ? ` → ${escapeMarkdown(wt.upstream)} (${wt.ahead || 0} ahead, ${wt.behind || 0} behind)` : ''}  \n`);
    if (wt.changes) md.appendMarkdown(`$(${dirty ? 'diff' : 'check'}) ${escapeMarkdown(changesText(wt.changes))}  \n`);
    if (wt.commit) {
      md.appendMarkdown(`$(git-commit) \`${shortSha(wt.commit.sha)}\` ${escapeMarkdown(wt.commit.subject)}  \n$(person) ${escapeMarkdown(wt.commit.authorName)}, ${escapeMarkdown(formatDate(wt.commit.authorDate))}`);
    }
    if (wt.lockReason) md.appendMarkdown(`\n\n$(lock) Locked: ${escapeMarkdown(wt.lockReason)}`);
    if (wt.prunableReason) md.appendMarkdown(`\n\n$(warning) Prunable: ${escapeMarkdown(wt.prunableReason)}`);
    if (wt.error) md.appendMarkdown(`\n\n$(error) ${escapeMarkdown(wt.error)}`);
    item.tooltip = md;
    const color = wt.changes && wt.changes.conflicts ? 'gitDecoration.conflictingResourceForeground' : dirty ? 'gitDecoration.modifiedResourceForeground' : undefined;
    const icon = wt.isCurrent ? 'check' : wt.locked ? 'lock' : wt.prunable ? 'warning' : wt.isMain ? 'repo' : 'folder';
    item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
    item.contextValue = `worktree${wt.isMain ? ':main' : ''}${wt.isCurrent ? ':current' : ''}${wt.locked ? ':locked' : ''}`;
    item.id = `worktree:${wt.path}`;
    return item;
  }

  /** The checked-out commit (expands to its files) and the working state. */
  async getChildren() {
    const wt = this.worktree;
    const out = [];
    // An agent's worktree: its work since it left the base, to review file by file.
    if (!wt.isMain && wt.branch && !wt.bare && !wt.prunable && !wt.error) {
      try {
        const { base } = await baseOf(this.repo, wt);
        if (base) {
          const { mergeBase, changes } = await this.repo.worktreeChangesSince(wt.path, base);
          const files = changes.filter((c) => !c.path.endsWith('/')); // not a repository nested there
          if (files.length) {
            const ids = await this.repo.worktreeFileIds(wt.path, files.map((c) => c.path));
            out.push(new WorktreeChangesNode(this, base, { mergeBase, changes: files, ids }));
          } else out.push(new MessageNode(`No changes since it left ${base}`, 'check'));
        }
      } catch (e) {
        log().info(`Worktree changes of ${wt.path}: ${e.message}`);
      }
    }
    if (wt.changes) out.push(new MessageNode(`Working tree: ${changesText(wt.changes)}`, wt.changes.conflicts ? 'warning' : changesText(wt.changes) === 'clean' ? 'check' : 'diff'));
    if (wt.upstream) out.push(new MessageNode(`${wt.upstream}: ${wt.ahead || 0} ahead, ${wt.behind || 0} behind`, 'cloud'));
    else if (wt.branch && wt.base) out.push(new MessageNode(`No upstream · ${wt.baseAhead || 0} ahead of ${wt.base}, ${wt.baseBehind || 0} behind`, 'git-compare'));
    else if (wt.branch) out.push(new MessageNode('No upstream branch', 'cloud'));
    if (wt.commit) out.push(new CommitNode(this.repo, wt.commit, { parent: this }));
    out.push(new MessageNode(wt.path, 'folder'));
    return out;
  }
}

/**
 * Worktrees view (the owner's sixth view): every worktree with its changes, ahead/behind and
 * age. Details cost a `git status` per worktree, so they refresh only while the view is visible.
 */
class WorktreesView extends TreeProvider {
  constructor(manager) {
    super();
    this.manager = manager;
    /** worktree paths whose "Changes vs …" row is expanded */
    this.openChanges = new Set();
    this.view = require('../util').registerTreeView('commitCorner.worktrees', vscode.window.createTreeView('commitCorner.worktrees', { treeDataProvider: this, manageCheckboxStateManually: true }));
    const refresh = debounce(() => this.refresh(), 1500);
    this.disposables = [
      this.view,
      manager.onDidChangeActive(() => this.refresh()),
      manager.onDidChangeState((repo) => {
        if (repo !== manager.active || !this.view.visible) return;
        // Only what this view shows of the repository itself (its row, the worktree list): an
        // agent's saves in the main tree do not need every worktree looked at again.
        const s = repo.state;
        const sig = s && JSON.stringify([s.head, s.staged.length, s.unstaged.length, s.untracked.length, s.conflicts.length, s.operation && s.operation.kind]);
        if (sig && sig === this.lastStateSig) return;
        this.lastStateSig = sig;
        refresh();
      }),
      // Shown again: at once (a Viewed mark that the agent's edit undid must not show for 1.5 s).
      this.view.onDidChangeVisibility((e) => {
        if (e.visible) this.refresh();
      }),
      changed.event(() => this.refresh()),
      viewed.watchCheckboxes(this.view, this),
      // Which "Changes vs …" rows are open (a redraw must not close the one you are reviewing).
      this.view.onDidExpandElement((e) => {
        if (e.element instanceof WorktreeChangesNode) this.openChanges.add(e.element.worktreePath);
      }),
      this.view.onDidCollapseElement((e) => {
        if (e.element instanceof WorktreeChangesNode) this.openChanges.delete(e.element.worktreePath);
      }),
    ];
    // Other worktrees (an agent's, typically) change without events here: while the view is
    // visible, look again every 10 seconds.
    const timer = setInterval(() => {
      if (this.view.visible) this.refresh();
    }, 10000);
    this.disposables.push({ dispose: () => clearInterval(timer) });
  }

  async getRoots() {
    const repo = this.manager.active;
    if (!repo) return [];
    // "This window" is the worktree open in this window, whichever repository is active.
    const list = (await repo.getWorktreeDetails()).map((w) => ({ ...w, isCurrent: inThisWindow(w.path) }));
    this.view.description = list.length > 1 ? String(list.length) : undefined;
    return list.map((w) => new WorktreeNode(repo, w, this));
  }

  dispose() {
    super.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

/** A worktree other than the main one, picked (or the only one); undefined when there is none. */
async function pickWorktree(repo, placeHolder) {
  // The first entry is always the main worktree.
  const others = (await repo.getWorktrees()).slice(1).filter((w) => !w.bare && !w.prunable);
  if (!others.length) {
    notify.info('This repository has no other worktrees.');
    return undefined;
  }
  const pick = others.length === 1 ? { w: others[0] } : await vscode.window.showQuickPick(others.map((w) => ({ label: `$(list-tree) ${escapeIcons(w.branch || path.basename(w.path))}`, description: w.path, w })), { placeHolder });
  return pick && { repoRoot: repo.root, worktreePath: pick.w.path, worktree: pick.w };
}

/** @param {import('../context').Context} ctx */
function register(ctx) {
  const { manager } = ctx;
  const cmd = ctx.command;

  cmd('commitCorner.worktreeAdd', async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo) return;
    const mode = await vscode.window.showQuickPick([
      { label: '$(plus) New branch…', id: 'new' },
      { label: '$(git-branch) Existing branch…', id: 'existing' },
      { label: '$(git-commit) Detached at a commit/tag…', id: 'detached' },
    ], { placeHolder: 'Create a worktree for…' });
    if (!mode) return;
    let ref;
    let newBranch;
    if (mode.id === 'new') {
      newBranch = await inputBranchName('Name of the new branch', undefined, { repo });
      if (!newBranch) return;
      ref = await pickRef(repo, { placeHolder: `Start "${newBranch}" from…`, head: true });
      if (!ref) return;
    } else {
      ref = await pickRef(repo, { placeHolder: 'Branch or commit', remotes: mode.id !== 'existing', tags: mode.id !== 'existing' });
      if (!ref) return;
    }
    const suggested = path.join(path.dirname(repo.root), `${path.basename(repo.root)}.${(newBranch || ref).replace(/[^\w.-]+/g, '-')}`);
    const folder = await vscode.window.showInputBox({ prompt: 'Folder for the new worktree', value: suggested });
    if (!folder) return;
    await repo.addWorktree(folder, { newBranch, ref, detach: mode.id === 'detached' });
    changed.fire();
    const open = await notify.info(`Worktree created at ${folder}.`, 'Open in New Window', 'Add to Workspace');
    if (open === 'Open in New Window') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true });
    else if (open === 'Add to Workspace') vscode.workspace.updateWorkspaceFolders((vscode.workspace.workspaceFolders || []).length, 0, { uri: vscode.Uri.file(folder) });
  });

  /** A worktree's uncommitted changes (its HEAD ↔ its files) in the multi-diff editor. */
  cmd('commitCorner.worktreeOpenChanges', async (node) => {
    const repo = await manager.pick(node);
    if (!repo || !node || !node.worktreePath) return;
    const wt = node.worktree || {};
    if (!(await repo.ownsWorktree(node.worktreePath))) {
      notify.warn(`${node.worktreePath} is not a worktree of ${repo.name} (any more).`);
      return;
    }
    const { stdout } = await git(['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd: node.worktreePath, env: { GIT_OPTIONAL_LOCKS: '0' } });
    const entries = parseStatus(stdout).entries.filter((e) => e.kind !== 'ignored');
    if (!entries.length) {
      notify.info(`${wt.branch || path.basename(node.worktreePath)} has no uncommitted changes.`);
      return;
    }
    const head = wt.head || (await git(['rev-parse', 'HEAD'], { cwd: node.worktreePath })).stdout.trim();
    // The left side comes from the shared object database (the worktree's HEAD), the right side
    // is the file in that worktree's folder.
    const resources = entries.map((e) => {
      const file = vscode.Uri.file(path.join(node.worktreePath, ...e.path.split('/')));
      const added = e.kind === 'untracked' || e.x === 'A';
      const deleted = e.y === 'D' || (e.x === 'D' && e.y === '.');
      return [file, added ? undefined : toGitUri(repo.root, e.origPath || e.path, head, { root: node.worktreePath }), deleted ? undefined : file];
    });
    await vscode.commands.executeCommand('vscode.changes', `${wt.branch || path.basename(node.worktreePath)}: uncommitted changes`, resources);
  });

  cmd('commitCorner.worktreeChangesVsBase', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const fromPalette = !node || !node.worktreePath;
    if (fromPalette) {
      // From the Command Palette: which worktree?
      node = await pickWorktree(repo, 'Changes of which worktree since it left the default branch?');
      if (!node) return;
    }
    const wt = node.worktree || {};
    const name = wt.branch || path.basename(node.worktreePath);
    // The base: where it started (see baseOf). From the palette you can pick another.
    const where = await baseOf(repo, wt);
    const fallback = where.fallback;
    let base = where.base;
    if (fromPalette) {
      const choices = [...new Set([base, fallback].filter(Boolean))].map((b) => ({ label: `$(git-branch) ${escapeIcons(b)}`, description: b === base ? 'where it started' : 'default branch', ref: b }));
      const other = { label: '$(list-selection) Other branch or commit…', alwaysShow: true };
      const pick = await vscode.window.showQuickPick([...choices, other], { title: `Changes of ${name}`, placeHolder: 'Compared with…' });
      if (!pick) return;
      base = pick === other ? await pickRef(repo, { placeHolder: `Changes of ${name} since it left…`, head: true }) : pick.ref;
      if (!base) return;
    }
    if (!base) {
      notify.info('No default branch (origin\'s, main or master) to compare with.');
      return;
    }
    const { mergeBase, changes } = await repo.worktreeChangesSince(node.worktreePath, base);
    if (!changes.length) {
      notify.info(`${name} has no changes since it left ${base}.`);
      return;
    }
    // Left: the file where the worktree left the base (shared object database); right: the
    // file in that worktree's folder, so commits and uncommitted work show together.
    const resources = changes.map((c) => {
      const file = vscode.Uri.file(path.join(node.worktreePath, ...c.path.split('/')));
      return [file, c.status === 'A' ? undefined : toGitUri(repo.root, c.origPath || c.path, mergeBase, { root: node.worktreePath }), c.status === 'D' ? undefined : file];
    });
    await vscode.commands.executeCommand('vscode.changes', `${name} vs ${base} (${shortSha(mergeBase)}): committed + uncommitted`, resources);
  });

  // What the agent did since its worktree left the base, and what looks risky (language model).
  cmd('commitCorner.worktreeSummarize', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    if (!node || !node.worktreePath) node = await pickWorktree(repo, 'Summarize the work of which worktree?'); // from the palette
    if (!node) return;
    const wt = node.worktree || {};
    const base = node.base || (await baseOf(repo, wt)).base;
    if (!base) {
      notify.info('No default branch (origin\'s, main or master) to compare with.');
      return;
    }
    const ai = require('../ai');
    await require('../webviews/summaryPanel').SummaryPanel.show(ctx, ai.worktreeSource(repo, node.worktreePath, wt.branch || path.basename(node.worktreePath), base));
  });

  cmd('commitCorner.worktreeOpen', async (node) => {
    if (!node || !node.worktreePath) return;
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.worktreePath), { forceNewWindow: true });
  });

  cmd('commitCorner.worktreeOpenHere', async (node) => {
    if (node && node.worktreePath) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.worktreePath), { forceNewWindow: false });
  });

  cmd('commitCorner.worktreeAddToWorkspace', async (node) => {
    if (node && node.worktreePath) vscode.workspace.updateWorkspaceFolders((vscode.workspace.workspaceFolders || []).length, 0, { uri: vscode.Uri.file(node.worktreePath) });
  });

  cmd('commitCorner.worktreeRemove', async (node) => {
    const repo = await manager.pick(node);
    if (!repo || !node || !node.worktreePath) return;
    if (!(await confirm(`Remove the worktree at ${node.worktreePath}?`, 'Remove', 'The folder is deleted. The branch is kept.'))) return;
    try {
      await repo.removeWorktree(node.worktreePath, false);
    } catch (e) {
      if (!(e instanceof GitError) || !/contains modified or untracked files|is dirty|use --force/.test(e.stderr)) throw e;
      if (await confirm('The worktree has uncommitted changes. Remove it anyway?', 'Force Remove', 'Uncommitted changes in that worktree are lost.')) {
        await repo.removeWorktree(node.worktreePath, true);
      }
    }
    changed.fire();
  });

  cmd('commitCorner.worktreeLock', async (node) => {
    const repo = await manager.pick(node);
    if (!repo || !node) return;
    const reason = await vscode.window.showInputBox({ prompt: 'Reason (optional)' });
    if (reason === undefined) return;
    await repo.lockWorktree(node.worktreePath, reason);
    changed.fire();
  });

  cmd('commitCorner.worktreeUnlock', async (node) => {
    const repo = await manager.pick(node);
    if (repo && node) await repo.unlockWorktree(node.worktreePath);
    changed.fire();
  });

  cmd('commitCorner.worktreePrune', async (arg) => {
    const repo = await manager.pick(arg);
    if (repo) await repo.pruneWorktrees();
    changed.fire();
  });
}

module.exports = { baseOf, WorktreesView, WorktreeNode, register, changesText, onDidChangeWorktrees: changed.event };
