'use strict';

const vscode = require('vscode');
const notify = require('../notify');
const { TreeProvider, MessageNode, GroupNode, CommitNode, fileNodes } = require('./nodes');
const { WORKTREE } = require('../../git/repository');
const { shortSha, showError, debounce } = require('../util');
const { openMultiDiff, refLabel } = require('../diffs');
const { pickRef } = require('../pickers');

/**
 * Compare any two refs (or a ref with the working tree): commits on each
 * side, changed files, and which files would conflict if merged.
 *
 * Modes:
 *   threeDot: changes on `right` since it diverged from `left` (what a PR shows)
 *   twoDot:   the full difference between the two tips
 */
class CompareView extends TreeProvider {
  constructor(manager) {
    super();
    this.manager = manager;
    /** @type {{repo, left:string, right:string, mode:'threeDot'|'twoDot', title?:string}|undefined} */
    this.state = undefined;
    this.view = require('../util').registerTreeView('commitCorner.compare', vscode.window.createTreeView('commitCorner.compare', { treeDataProvider: this, canSelectMany: true, showCollapseAll: true }));
    this.disposables = [
      this.view,
      manager.onDidClose((repo) => {
        if (this.state && this.state.repo === repo) this.clear();
      }),
      // Refs (or the working tree) moved: the comparison may have changed. Filtered before the
      // debounce, so a change in another repository cannot swallow this one's.
      manager.onDidChangeState((repo) => {
        if (this.state && this.state.repo === repo) this.onCompareRepoChanged();
      }),
    ];
    this.onCompareRepoChanged = debounce(async () => {
      if (!this.state) return;
      const repo = this.state.repo;
      const sig = this.state.right === WORKTREE ? `${Date.now()}` : (repo.refTips !== undefined ? repo.refTips : await repo.getRefTips().catch(() => ''));
      if (sig !== this.lastSignature) {
        this.lastSignature = sig;
        this.refresh();
      }
    }, 500);
    this.setContext();
  }

  setContext() {
    vscode.commands.executeCommand('setContext', 'commitCorner.compareActive', !!this.state);
    vscode.commands.executeCommand('setContext', 'commitCorner.compareMode', this.state ? this.state.mode : undefined);
  }

  async setComparison(repo, left, right, mode = 'threeDot', title) {
    // With the working tree too, three-dot is the default: what this branch changed since it left
    // `left`, committed or not — not mixed with everything `left` gained since.
    this.state = { repo, left, right, mode, title };
    this.setContext();
    this.refresh();
    await require('../sidebar').showView('compare');
  }

  clear() {
    this.state = undefined;
    this.setContext();
    this.refresh();
  }

  label(ref) {
    return ref === WORKTREE ? 'Working Tree' : /^[0-9a-f]{40,64}$/.test(ref) ? shortSha(ref) : ref;
  }

  /** The left side of file diffs: the merge base in three-dot mode. */
  async fileBase() {
    const { repo, left, right, mode } = this.state;
    if (mode === 'threeDot') {
      const mb = await repo.mergeBase(left, right === WORKTREE ? 'HEAD' : right);
      if (!mb) throw new Error(`${left} and ${right === WORKTREE ? 'HEAD' : right} have no common history`);
      return mb;
    }
    return left;
  }

  async files() {
    const { repo, right } = this.state;
    const base = await this.fileBase();
    const files = right === WORKTREE ? await repo.diffFiles(base) : await repo.diffFiles(base, right);
    if (right === WORKTREE) {
      // `git diff <ref>` ignores untracked files; they are part of the working tree too.
      const state = repo.state || (await repo.refreshState());
      const listed = new Set(files.map((f) => f.path));
      for (const e of state.untracked) if (!listed.has(e.path)) files.push({ status: 'A', path: e.path, added: null, deleted: null, untracked: true });
    }
    return { base, files };
  }

  async getRoots() {
    if (!this.state) {
      this.view.description = undefined;
      // No repository at all: VS Code's welcome (Initialize / Clone / Open) instead of a row.
      if (!this.manager.repositories.length) return [];
      return [new MessageNode('Compare branches, tags or commits…', 'git-compare', { command: 'commitCorner.compareRefs', title: 'Compare' })];
    }
    const { repo, left, right, mode, title } = this.state;
    const L = this.label(left);
    const R = this.label(right);
    this.view.description = `${title ? `${title}: ` : ''}${L} ${mode === 'threeDot' ? '...' : '..'} ${R}`;
    const roots = [];
    const header = new MessageNode(`${L} ↔ ${R}`, 'git-compare');
    header.getTreeItem = () => {
      const item = new vscode.TreeItem(`${L} ↔ ${R}`, vscode.TreeItemCollapsibleState.None);
      item.description = mode === 'threeDot' ? 'changes since they diverged' : 'full difference';
      item.iconPath = new vscode.ThemeIcon('git-compare');
      item.contextValue = 'compareHeader';
      item.tooltip = mode === 'threeDot'
        ? `Three-dot: what ${R}${right === WORKTREE ? ' (HEAD plus uncommitted changes)' : ''} changed since it branched off ${L} (like a pull request).`
        : `Two-dot: every difference between ${L} and ${R}.`;
      return item;
    };
    roots.push(header);

    if (right === WORKTREE) {
      // The commits on HEAD since it left `left` (the uncommitted part is in the files below).
      const { ahead } = await repo.aheadBehind(left, 'HEAD');
      roots.push(new GroupNode(`Commits on HEAD since ${L} (${ahead})`, async () => {
        const commits = await repo.log({ revs: ['HEAD', `^${left}`], maxCount: 500, topo: true });
        return commits.map((c) => new CommitNode(repo, c));
      }, { icon: 'arrow-up', collapsed: ahead > 20 || ahead === 0 }));
    }
    if (right !== WORKTREE) {
      const { ahead, behind } = await repo.aheadBehind(left, right);
      roots.push(new GroupNode(`Commits only in ${R} (${ahead})`, async () => {
        const commits = await repo.log({ revs: [right, `^${left}`], maxCount: 500, topo: true });
        return commits.map((c) => new CommitNode(repo, c));
      }, { icon: 'arrow-up', collapsed: ahead > 20 || ahead === 0 }));
      roots.push(new GroupNode(`Commits only in ${L} (${behind})`, async () => {
        const commits = await repo.log({ revs: [left, `^${right}`], maxCount: 500, topo: true });
        return commits.map((c) => new CommitNode(repo, c));
      }, { icon: 'arrow-down', collapsed: true }));
    }

    const { base, files } = await this.files();
    const added = files.reduce((n, f) => n + (f.added || 0), 0);
    const deleted = files.reduce((n, f) => n + (f.deleted || 0), 0);
    roots.push(new GroupNode(`Files changed (${files.length})`, fileNodes(repo, files, { leftRef: base, rightRef: right }), {
      icon: 'files', description: `+${added} −${deleted}`, contextValue: 'compareFiles',
    }));

    if (right !== WORKTREE) {
      roots.push(new GroupNode('Merge preview', async () => {
        try {
          const { conflicts, exact } = await repo.predictConflicts(left, right);
          const note = exact ? [] : [new MessageNode('Approximate: git < 2.38 cannot preview renames, so renamed files may show as false conflicts', 'info')];
          if (!conflicts.length) return [new MessageNode(`${R} merges into ${L} without conflicts`, 'pass'), ...note];
          return [...conflicts.map((p) => new MessageNode(p, 'warning')), ...note];
        } catch (e) {
          return [new MessageNode(`Could not compute: ${e.message}`, 'error')];
        }
      }, { icon: 'git-merge', collapsed: true, tooltip: `Which files would conflict if ${R} were merged into ${L}. Computed in memory; nothing is checked out.` }));
    }
    return roots;
  }

  dispose() {
    super.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

/** @param {import('../context').Context} ctx */
function register(ctx, view) {
  const { manager } = ctx;
  const cmd = ctx.command;

  cmd('commitCorner.compareRefs', async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo) return;
    const left = await pickRef(repo, { placeHolder: 'Compare: base (left side)…', head: true });
    if (!left) return;
    const right = await pickRef(repo, {
      placeHolder: `Compare ${left} with…`,
      head: true,
      extra: [{ label: '$(file-directory) Working Tree', description: 'uncommitted files on disk', ref: WORKTREE }],
    });
    if (!right) return;
    await view.setComparison(repo, left, right);
  });

  cmd('commitCorner.compareWithCurrent', async (node) => {
    const repo = await manager.pick(node);
    if (!repo || !node) return;
    const current = repo.state && repo.state.head.branch || 'HEAD';
    await view.setComparison(repo, current, node.ref || node.sha);
  });

  cmd('commitCorner.compareWithWorkingTree', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const ref = node && (node.ref || node.sha) || await pickRef(repo, { placeHolder: 'Compare the working tree with…', head: true });
    // Three-dot by default: what the work since `ref` changed, committed and uncommitted (an
    // agent's branch against main); the title bar switches to the full two-dot difference.
    if (ref) await view.setComparison(repo, ref, WORKTREE, 'threeDot');
  });

  cmd('commitCorner.compareSelectForCompare', async (node) => {
    if (!node) return;
    ctx.pendingCompare = { repoRoot: node.repoRoot, ref: node.ref || node.sha };
    vscode.commands.executeCommand('setContext', 'commitCorner.hasPendingCompare', true);
    vscode.window.setStatusBarMessage(`Selected ${refLabel(node.ref || node.sha)} for compare. Right-click another ref → "Compare with Selected".`, 5000);
  });

  cmd('commitCorner.compareWithSelected', async (node) => {
    const p = ctx.pendingCompare;
    if (!p || !node) return;
    const repo = manager.getRepository(p.repoRoot);
    if (!repo || repo.root !== node.repoRoot) {
      notify.warn('Both refs must be in the same repository.');
      return;
    }
    await view.setComparison(repo, p.ref, node.ref || node.sha);
  });

  cmd('commitCorner.compareSwap', async () => {
    const s = view.state;
    if (!s || s.right === WORKTREE) return;
    await view.setComparison(s.repo, s.right, s.left, s.mode, s.title);
  });

  cmd('commitCorner.compareUseTwoDot', async () => {
    const s = view.state;
    if (s) await view.setComparison(s.repo, s.left, s.right, 'twoDot', s.title);
  });

  cmd('commitCorner.compareUseThreeDot', async () => {
    const s = view.state;
    if (s) await view.setComparison(s.repo, s.left, s.right, 'threeDot', s.title);
  });

  cmd('commitCorner.compareClear', () => view.clear());

  cmd('commitCorner.compareOpenAll', async () => {
    const s = view.state;
    if (!s) return;
    try {
      const { base, files } = await view.files();
      await openMultiDiff(s.repo, `${view.label(s.left)} ${s.mode === 'threeDot' ? '...' : '..'} ${view.label(s.right)}`, files.map((f) => ({
        path: f.path,
        leftRef: f.status === 'A' ? null : base,
        leftPath: f.origPath || f.path,
        rightRef: f.status === 'D' ? null : s.right,
      })));
    } catch (e) {
      showError(e, 'Compare');
    }
  });

  cmd('commitCorner.compareRefresh', () => view.refresh());
}

module.exports = { CompareView, register };
