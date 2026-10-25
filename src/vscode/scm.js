'use strict';

const vscode = require('vscode');
const notify = require('./notify');
const { toGitUri } = require('./uri');
const { config, statusIcon, STATUS_LABELS, log, escapeIcons } = require('./util');

/** Conflict XY codes -> description. */
const CONFLICT_LABELS = {
  DD: 'Both deleted', AU: 'Added by us', UD: 'Deleted by them', UA: 'Added by them', DU: 'Deleted by us', AA: 'Both added', UU: 'Both modified',
};

/** Is the built-in Git extension active? Used to avoid duplicate gutter marks and badges. */
function builtInGitEnabled() {
  const ext = vscode.extensions.getExtension('vscode.git');
  // `null` scope: git.enabled is resource-scoped; asking without one logs a warning each time.
  return !!ext && vscode.workspace.getConfiguration('git', null).get('enabled', true);
}

function autoSetting(key) {
  const value = config().get(key, 'auto');
  if (value === 'auto') return !builtInGitEnabled();
  return value === 'always' || value === true;
}

/**
 * Source Control provider for one repository: Merge / Staged / Changes /
 * Untracked groups, the commit message box, and quick-diff (gutter) support.
 */
const COMMIT_KEY = process.platform === 'darwin' ? 'Cmd+Enter' : 'Ctrl+Enter';

class ScmProvider {
  /**
   * @param {import('../git/repository').Repository} repo
   * @param {(uri: vscode.Uri) => any} owner the repository that owns a file (handles nested repos)
   * @param {vscode.Memento} [memento] keeps the prefilled message across reloads (to clear it later)
   */
  constructor(repo, owner, memento) {
    this.repo = repo;
    this.memento = memento;
    this.prefilledKey = `scm.prefilled:${repo.root}`;
    /** The operation's message we put in the box (MERGE_MSG…), as long as the operation lasts. */
    this.prefilled = memento && memento.get(this.prefilledKey);
    const sc = vscode.scm.createSourceControl('commitCorner', `Commit Corner`, vscode.Uri.file(repo.root));
    this.sc = sc;
    sc.inputBox.placeholder = `Message (${COMMIT_KEY} to commit)`;
    sc.acceptInputCommand = { command: 'commitCorner.commit', title: 'Commit', arguments: [{ repoRoot: repo.root }] };
    this.quickDiff = {
      provideOriginalResource: async (uri) => {
        // A nested repository's files belong to it, not to this (outer) one.
        if (uri.scheme !== 'file' || !repo.contains(uri.fsPath) || (owner && owner(uri) !== repo)) return undefined;
        const rel = repo.relative(uri.fsPath);
        if (this.isUntracked(rel)) return undefined;
        const s = repo.state;
        if (s && s.conflicts.some((e) => e.path === rel)) return undefined;
        // Ignored or otherwise unknown files have no staged version: no gutter (rather than "all added").
        // Symlinks (mode 120000) store a path, not the file behind them: no line diff for those.
        const mode = await repo.getIndexMode(rel);
        if (!mode || mode === '120000') return undefined;
        return toGitUri(repo.root, rel, ':');
      },
    };
    this.updateQuickDiff();
    this.merge = sc.createResourceGroup('merge', 'Merge Changes');
    this.staged = sc.createResourceGroup('staged', 'Staged Changes');
    this.unstaged = sc.createResourceGroup('unstaged', 'Changes');
    this.untracked = sc.createResourceGroup('untracked', 'Untracked Changes');
    // Group commands receive the group: let them find their repository even when it is empty.
    for (const g of [this.merge, this.staged, this.unstaged, this.untracked]) g.repoRoot = repo.root;
    this.merge.hideWhenEmpty = true;
    this.staged.hideWhenEmpty = true;
    this.untracked.hideWhenEmpty = true;
    this.prefillTemplate();
    this.untrackedSet = new Set();
    this.disposables = [sc, this.merge, this.staged, this.unstaged, this.untracked];
    this.lastPendingMessage = undefined;
  }

  /** Gutter markers follow the setting (and the built-in Git being on/off) without a reload. */
  updateQuickDiff() {
    this.sc.quickDiffProvider = autoSetting('quickDiff') ? this.quickDiff : undefined;
  }

  /** Start with the commit template (commit.template), like `git commit` does. */
  async prefillTemplate() {
    try {
      const file = await this.repo.getConfig('commit.template');
      if (!file || this.sc.inputBox.value) return;
      const resolved = file.startsWith('~') ? require('path').join(require('os').homedir(), file.slice(1)) : require('path').resolve(this.repo.root, file);
      const text = (await require('fs').promises.readFile(resolved, 'utf8')).split('\n').filter((l) => !l.startsWith('#')).join('\n').trim();
      this.template = text;
      if (text && !this.sc.inputBox.value) this.sc.inputBox.value = text;
    } catch { /* no template */ }
  }

  isUntracked(rel) {
    return this.untrackedSet.has(rel);
  }

  /** Rebuild resource groups from the repository state. */
  async update() {
    const state = this.repo.state;
    if (!state) return;
    const repo = this.repo;
    const res = (entry, group) => this.resource(entry, group);
    // Status limit: tens of thousands of entries (an un-ignored build folder) make the view unusable.
    const limit = config().get('statusLimit', 10000);
    const total = state.conflicts.length + state.staged.length + state.unstaged.length + state.untracked.length;
    let budget = limit > 0 ? limit : Infinity;
    const take = (list) => {
      const n = Math.max(0, Math.min(list.length, budget));
      budget -= n;
      return n < list.length ? list.slice(0, n) : list;
    };
    this.merge.resourceStates = take(state.conflicts).map((e) => res(e, 'merge'));
    this.staged.resourceStates = take(state.staged).map((e) => res(e, 'staged'));
    this.unstaged.resourceStates = take(state.unstaged).map((e) => res(e, 'unstaged'));
    this.untracked.resourceStates = take(state.untracked).map((e) => res(e, 'untracked'));
    this.untrackedSet = new Set(state.untracked.map((e) => e.path));
    if (budget < 0 || (limit > 0 && total > limit)) {
      if (!this.warnedLimit) {
        this.warnedLimit = true;
        notify.warn(
          `${this.repo.name} has ${total} changed files; Source Control shows the first ${limit}. Add generated folders to .gitignore, or raise "commitCorner.statusLimit".`,
          'Open Settings',
        ).then((c) => c && vscode.commands.executeCommand('workbench.action.openSettings', 'commitCorner.statusLimit'));
      }
    } else this.warnedLimit = false;
    this.sc.count = autoSetting('countBadge') ? total : 0;

    const branch = state.head.branch || (state.head.sha ? `${state.head.sha.slice(0, 7)} (detached)` : 'no commits');
    // With the built-in Git on, our own status bar items stay hidden (no duplicates): VS Code
    // then shows the active Source Control provider's commands, so give it branch and sync.
    const ownItems = config().get('statusBar', 'auto');
    const vsCodeShowsOurs = builtInGitEnabled() && ownItems !== 'always';
    const arg = [{ repoRoot: repo.root }];
    const h = state.head;
    this.sc.statusBarCommands = vsCodeShowsOurs ? [
      { command: 'commitCorner.checkout', title: `$(${h.branch ? 'git-branch' : 'debug-disconnect'}) ${escapeIcons(branch)}${state.staged.length + state.unstaged.length + state.untracked.length ? '*' : ''}`, tooltip: `${repo.name}: check out another branch (Commit Corner)`, arguments: arg },
      h.upstream
        ? { command: 'commitCorner.sync', title: `$(sync)${h.behind ? ` ${h.behind}↓` : ''}${h.ahead ? ` ${h.ahead}↑` : ''}`, tooltip: `Sync with ${h.upstream}: pull ${h.behind || 0}, push ${h.ahead || 0} (Commit Corner)`, arguments: arg }
        // Publish only for a branch: a detached HEAD (bisect, an old commit) has nothing to publish.
        : h.branch ? { command: 'commitCorner.push', title: '$(cloud-upload)', tooltip: 'Publish this branch (Commit Corner)', arguments: arg } : undefined,
    ].filter(Boolean) : [];
    this.sc.inputBox.placeholder = state.operation
      ? `Message for ${state.operation.kind} (${COMMIT_KEY} to ${state.operation.kind === 'merge' ? 'commit the merge' : 'continue'})`
      : `Message (${COMMIT_KEY} to commit on "${branch}")`;

    // Prefill MERGE_MSG/SQUASH_MSG once when an operation (or a squash merge, which has no
    // MERGE_HEAD) leaves a prepared message.
    const squashPending = !state.operation && require('fs').existsSync(require('path').join(repo.gitDir, 'SQUASH_MSG'));
    const op = state.operation;
    if (squashPending || (op && ['merge', 'cherry-pick', 'revert', 'rebase'].includes(op.kind))) {
      const msg = await repo.getPendingMessage();
      const box = this.sc.inputBox.value;
      if (msg && msg !== this.lastPendingMessage && (!box || box === this.template)) {
        this.sc.inputBox.value = msg;
        // Remember what we put there: only an edit of *this* text is a new message (see Continue).
        this.prefilled = msg;
        if (this.memento) this.memento.update(this.prefilledKey, msg);
      }
      this.lastPendingMessage = msg;
    } else {
      // The operation is over (also aborted in a terminal): its message, still untouched, goes too.
      if (this.prefilled && this.sc.inputBox.value.trim() === this.prefilled.trim()) this.sc.inputBox.value = '';
      if (this.prefilled && this.memento) this.memento.update(this.prefilledKey, undefined);
      this.lastPendingMessage = undefined;
      this.prefilled = undefined;
    }
  }

  /** @returns {vscode.SourceControlResourceState & {entry:any, group:string, repoRoot:string}} */
  resource(entry, group) {
    const repo = this.repo;
    const uri = vscode.Uri.file(repo.absolute(entry.path));
    let status;
    let tooltip;
    if (group === 'merge') {
      status = '!';
      tooltip = CONFLICT_LABELS[entry.x + entry.y] || 'Conflict';
    } else if (group === 'untracked') {
      status = 'U';
      tooltip = 'Untracked';
    } else {
      status = group === 'staged' ? entry.x : entry.y;
      if (entry.kind === 'renamed' && group === 'staged') status = 'R';
      tooltip = STATUS_LABELS[status] || status;
      if (entry.origPath && group === 'staged') tooltip += ` from ${entry.origPath}`;
    }
    const deleted = status === 'D';
    return {
      resourceUri: uri,
      decorations: {
        strikeThrough: deleted,
        faded: false,
        tooltip,
        iconPath: statusIcon(status),
      },
      contextValue: `${group}:${status}`,
      command: { command: 'commitCorner.openResource', title: 'Open Changes', arguments: [{ repoRoot: repo.root, path: entry.path, origPath: entry.origPath, group, status }] },
      entry,
      group,
      status,
      repoRoot: repo.root,
      path: entry.path,
    };
  }

  get message() {
    return this.sc.inputBox.value;
  }

  set message(v) {
    this.sc.inputBox.value = v;
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Creates one ScmProvider per open repository and keeps them updated. */
class ScmManager {
  /** @param {import('./model').RepositoryManager} manager */
  constructor(manager) {
    this.manager = manager;
    /** @type {Map<string, ScmProvider>} */
    this.providers = new Map();
    this.disposables = [
      manager.onDidOpen((repo) => this.add(repo)),
      manager.onDidClose((repo) => this.remove(repo)),
      manager.onDidChangeState((repo) => {
        const p = this.providers.get(repo.root);
        if (p) p.update().catch((e) => log().warn(`Source Control update failed: ${e.message}`));
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('commitCorner.quickDiff') || e.affectsConfiguration('git.enabled')) {
          for (const p of this.providers.values()) p.updateQuickDiff();
        }
      }),
    ];
    for (const repo of manager.repositories) this.add(repo);
  }

  add(repo) {
    if (this.providers.has(repo.root)) return;
    const p = new ScmProvider(repo, (uri) => this.manager.getRepositoryForUri(uri), this.manager.memento);
    this.providers.set(repo.root, p);
    p.update().catch((e) => log().warn(`Source Control update failed: ${e.message}`));
  }

  remove(repo) {
    const p = this.providers.get(repo.root);
    if (p) p.dispose();
    this.providers.delete(repo.root);
  }

  get(repo) {
    return repo && this.providers.get(repo.root);
  }

  dispose() {
    for (const p of this.providers.values()) p.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

module.exports = { ScmManager, ScmProvider, builtInGitEnabled, CONFLICT_LABELS };
