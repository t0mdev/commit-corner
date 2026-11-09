'use strict';

const vscode = require('vscode');
const notify = require('../notify');
const { TreeProvider, MessageNode, GroupNode, CommitNode, fileNodes, fingerprintOf } = require('./nodes');
const viewed = require('../viewed');
const { WORKTREE } = require('../../git/repository');
const { shortSha, showError, debounce, log } = require('../util');
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
      // With several repositories, a first row names the one shown (a click switches).
      ...this.watchRepositories(manager),
      // Nothing shown yet: the repository row follows the active repository.
      manager.onDidChangeActive(() => {
        if (!this.state) this.refresh();
      }),
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
      const tips = repo.refTips !== undefined ? repo.refTips : await repo.getRefTips().catch(() => '');
      // A ref moved (a commit, a checkout): everything again.
      if (tips !== this.lastSignature) {
        this.lastSignature = tips;
        this.refresh();
        return;
      }
      // Only files changed (the working tree): their list again, redrawn only if it differs.
      if (this.state.right === WORKTREE) await this.reloadFiles();
    }, 500);
    this.setContext();
  }

  /** The compared repository (else the active one). */
  shownRepository() {
    return (this.state && this.state.repo) || this.manager.active;
  }

  /** Another repository picked from the row: this comparison was of the old one. */
  repositorySwitched() {
    if (this.state && this.state.repo !== this.manager.active) this.clear();
    else this.refresh();
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

  /**
   * The left side of file diffs, as a commit id (so a file's menus read the very revision shown,
   * even when the branch moves): the merge base in three-dot mode.
   */
  async fileBase(state = this.state) {
    const { repo, left, right, mode } = state;
    if (mode === 'threeDot') {
      const mb = await repo.mergeBase(left, right === WORKTREE ? 'HEAD' : right);
      if (!mb) throw new Error(`${left} and ${right === WORKTREE ? 'HEAD' : right} have no common history`);
      return mb;
    }
    return (await repo.revParse(left)) || left;
  }

  /**
   * The files changed, with the right side as a commit id (or the working tree) and each file's
   * blob ids (one git diff for both).
   */
  async files(state = this.state) {
    const { repo, right } = state;
    const base = await this.fileBase(state);
    const rightRef = right === WORKTREE ? WORKTREE : (await repo.revParse(right)) || right;
    const files = right === WORKTREE ? await repo.diffFiles(base) : await repo.diffFiles(base, rightRef, { blobs: true });
    if (right === WORKTREE) {
      // `git diff <ref>` ignores untracked files; they are part of the working tree too.
      const state = repo.state || (await repo.refreshState());
      const listed = new Set(files.map((f) => f.path));
      for (const e of state.untracked) if (!listed.has(e.path)) files.push({ status: 'A', path: e.path, added: null, deleted: null, untracked: true });
    }
    return { base, right: rightRef, files };
  }

  /**
   * The files with what the Files changed row needs: each file's fingerprint on the right side
   * (its blob id there; for the working tree, the file as it is now, hashed again only when it
   * changed) and a signature to tell whether anything shown changed.
   */
  async loadFiles(state = this.state) {
    // Numbered when started: of two loads, the one started later shows what is newer.
    const seq = (this.loadSeq = (this.loadSeq || 0) + 1);
    const { repo, right } = state;
    const { base, right: rightRef, files } = await this.files(state);
    const ids = right === WORKTREE
      ? await repo.worktreeFileIds(repo.root, files.filter((f) => f.status !== 'D').map((f) => f.path)).catch(() => new Map())
      : new Map(files.filter((f) => f.status !== 'D' && f.newBlob).map((f) => [f.path, f.newBlob]));
    const marks = files.map((f) => ({ path: f.path, fingerprint: fingerprintOf(ids, f) }));
    const signature = files.map((f, i) => `${f.status}\0${f.path}\0${f.origPath || ''}\0${f.added}\0${f.deleted}\0${marks[i].fingerprint || ''}`).join('\n');
    const data = { seq, base, rightRef, files, ids, marks, signature };
    // The newest data of this comparison, whichever load (a refresh or a reload) finishes first.
    if (!this.latest || this.latest.state !== state || this.latest.data.seq < seq) this.latest = { state, data };
    return data;
  }

  /**
   * The working tree changed but no ref moved: the Files changed row alone, when its files or
   * their contents differ (an edit then brings a viewed file's dot back). One at a time.
   */
  async reloadFiles() {
    if (this.reloading) {
      this.reloadAgain = true;
      return;
    }
    this.reloading = true;
    const state = this.state;
    try {
      const data = await this.loadFiles(state);
      // Onto the row shown now (a refresh meanwhile may have replaced it), unless what it shows
      // was loaded later than this (then it is the newer one) or is the same.
      const group = this.filesGroup;
      if (this.state !== state || !group || !group.data || group.data.seq > data.seq || data.signature === group.data.signature) return;
      group.data = data;
      group.label = `Files changed (${data.files.length})`;
      this.redraw(group);
    } catch (e) {
      log().info(`Compare: ${e.message}`);
    } finally {
      this.reloading = false;
      if (this.reloadAgain) {
        this.reloadAgain = false;
        if (this.state === state) this.reloadFiles();
      }
    }
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

    this.lastSignature = repo.refTips;
    const state = this.state;
    let loaded = await this.loadFiles(state);
    // Another comparison since (Swap, a mode switch): its own drawing shows it, not this one.
    if (this.state !== state) return [];
    // A reload that started later finished first: its data is the newer one.
    if (this.latest && this.latest.state === state && this.latest.data.seq > loaded.seq) loaded = this.latest.data;
    // Viewed marks, as in a pull request: per comparison, by content (the right side's), so a file
    // that changes again (a new commit there, an edit in the working tree) is unviewed again.
    const scope = `compare:${repo.root}:${left}:${right === WORKTREE ? 'working tree' : right}:${mode}`;
    // The row's data: replaced by reloadFiles when the working tree changes what it shows.
    const data = () => filesGroup.data;
    const filesGroup = new GroupNode(`Files changed (${loaded.files.length})`, () => {
      const { base, rightRef, files, ids } = data();
      return fileNodes(repo, files, { leftRef: base, rightRef, contextValue: right === WORKTREE ? 'file:compareWork' : 'file:compare' }, { viewed: { scope, ids, owner: filesGroup, provider: this, label: `${L} ↔ ${R}` } });
    }, {
      icon: 'files',
      // Short (a narrow sidebar cuts the end): "+12 −3 · 2/5 viewed".
      description: () => {
        const { files, marks } = data();
        const added = files.reduce((n, f) => n + (f.added || 0), 0);
        const deleted = files.reduce((n, f) => n + (f.deleted || 0), 0);
        const seen = viewed.get().count(scope, marks);
        const count = !seen ? '' : seen === files.length ? ' · all viewed' : ` · ${seen}/${files.length} viewed`;
        return `+${added} −${deleted}${count}`;
      },
      // (Worked out when shown: the dots follow the setting.)
      get tooltip() {
        return `${viewed.marksUnviewed() ? 'A file you have not opened has a dot; one that changes again gets it back.' : 'Opening a file marks it viewed; one that changes again is unviewed again.'} "2/5 viewed": viewed so far.`;
      },
      contextValue: 'compareFiles',
      // The same row when its count changes (its folders keep their open or collapsed state).
      id: `compareFiles\0${scope}`,
      props: { repoRoot: repo.root, viewedScope: scope },
    });
    filesGroup.data = loaded;
    // What Mark All and the count read: always the files shown now.
    Object.defineProperty(filesGroup, 'viewedFiles', { get: () => data().marks, enumerable: true });
    this.filesGroup = filesGroup;
    this.viewedOwners.set(scope, filesGroup);
    roots.push(filesGroup);

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

  // A branch, tag or commit with any other, picked from a list (the working tree included).
  cmd('commitCorner.compareWith', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const ref = node && (node.ref || node.sha);
    if (!ref) {
      await vscode.commands.executeCommand('commitCorner.compareRefs', { repoRoot: repo.root });
      return;
    }
    const other = await pickRef(repo, {
      placeHolder: `Compare ${refLabel(ref)} with…`,
      head: true,
      extra: [{ label: '$(file-directory) Working Tree', description: 'uncommitted files on disk', ref: WORKTREE }],
    });
    if (!other) return;
    // The working tree as with Compare with Working Tree (three-dot: the work since `ref`).
    if (other === WORKTREE) await view.setComparison(repo, ref, WORKTREE, 'threeDot');
    else await view.setComparison(repo, ref, other);
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
