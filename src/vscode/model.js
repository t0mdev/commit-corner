'use strict';

const vscode = require('vscode');
const notify = require('./notify');
const fs = require('fs');
const path = require('path');
const { isSameOrInside } = require('../git/pathUtil');
const { Repository } = require('../git/repository');
const { debounce, config, log, showError } = require('./util');

const IGNORED_GIT_FILES = /(^|[\\/])(index\.lock|.*\.lock|objects|logs|FETCH_HEAD|gc\.pid|COMMIT_EDITMSG)$/;

/**
 * Owns the set of open repositories, keeps their state fresh (file watchers +
 * focus), and tracks which one is "active" (the one the views show).
 */
/**
 * How long to wait before refreshing after a file change: debounced by what a status costs,
 * but at most a few seconds after the first change still pending.
 * @param {number} now @param {number} pendingSince first pending change @param {number} cost ms of the last status
 */
function refreshDelay(now, pendingSince, cost) {
  const delay = Math.min(5000, Math.max(250, cost * 3));
  const maxWait = Math.max(2500, cost * 4);
  return Math.max(0, Math.min(delay, pendingSince + maxWait - now));
}

class RepositoryManager {
  constructor() {
    /** @type {Map<string, Repository>} */
    this.repos = new Map();
    this.pending = new Map();
    /** @type {Repository|undefined} */
    this.active = undefined;
    this._onDidOpen = new vscode.EventEmitter();
    this._onDidClose = new vscode.EventEmitter();
    this._onDidChangeState = new vscode.EventEmitter();
    this._onDidChangeActive = new vscode.EventEmitter();
    /** Fired with the repository after any change to its state (status, refs, HEAD). */
    this.onDidChangeState = this._onDidChangeState.event;
    this.onDidOpen = this._onDidOpen.event;
    this.onDidClose = this._onDidClose.event;
    this.onDidChangeActive = this._onDidChangeActive.event;
    /** @type {Map<string, {dispose():void}[]>} */
    this.repoDisposables = new Map();
    this.refreshers = new Map();
    /** Workspace memento for remembered choices (set by the extension). */
    this.memento = undefined;
    this.askedParent = new Set();
    this.askedOutside = new Set();
    /** dir -> when it was found not to be inside a repository */
    this.notRepos = new Map();
    this.reportedOwnership = new Set();
    /** repo root -> duration of the last status refresh (ms) */
    this.lastRefreshMs = new Map();
    this.disposables = [
      this._onDidOpen, this._onDidClose, this._onDidChangeState, this._onDidChangeActive,
      vscode.workspace.onDidChangeWorkspaceFolders((e) => this.onFoldersChanged(e)),
      vscode.window.onDidChangeActiveTextEditor((ed) => this.onActiveEditor(ed)),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) for (const repo of this.repos.values()) this.scheduleRefresh(repo);
      }),
    ];
  }

  get repositories() {
    return [...this.repos.values()];
  }

  getRepository(root) {
    return this.repos.get(root);
  }

  /** Find the repository that contains a file URI or path. Deepest match wins (nested repos). */
  getRepositoryForUri(uri) {
    if (!uri) return undefined;
    let fsPath;
    if (typeof uri === 'string') fsPath = uri;
    else if (uri.scheme === 'file') fsPath = uri.fsPath;
    else if (uri.scheme === 'commitcorner') {
      try {
        return this.repos.get(JSON.parse(uri.query).repo);
      } catch {
        return undefined;
      }
    } else return undefined;
    let best;
    for (const repo of this.repos.values()) {
      if (repo.contains(fsPath) && (!best || repo.root.length > best.root.length)) best = repo;
    }
    return best;
  }

  /** Find the repository owning a path inside a git dir (e.g. .git/rebase-merge/git-rebase-todo). */
  getRepositoryForGitPath(fsPath) {
    for (const repo of this.repos.values()) {
      for (const dir of [repo.gitDir, repo.commonDir]) {
        if (isSameOrInside(dir, fsPath)) return repo;
      }
    }
    return undefined;
  }

  async initialize() {
    const folders = vscode.workspace.workspaceFolders || [];
    await Promise.all(folders.map((f) => this.scanFolder(f.uri.fsPath)));
    await Promise.all(vscode.window.visibleTextEditors.map((e) => this.discoverForUri(e.document.uri)));
    this.onActiveEditor(vscode.window.activeTextEditor);
    if (!this.active && this.repos.size) this.setActive(this.repositories[0]);
  }

  async scanFolder(folder) {
    await this.openRepository(folder);
    const depth = config().get('repositoryScanDepth', 1);
    if (depth > 0) await this.scanChildren(folder, depth);
  }

  async scanChildren(dir, depth) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const skip = new Set(config().get('repositoryScanIgnoredFolders', ['node_modules', '.git', 'dist', 'out', 'build', '.venv']));
    await Promise.all(entries.filter((e) => e.isDirectory() && !skip.has(e.name)).map(async (e) => {
      const child = path.join(dir, e.name);
      const hasGit = await fs.promises.access(path.join(child, '.git')).then(() => true, () => false);
      if (hasGit) await this.openRepository(child);
      if (depth > 1) await this.scanChildren(child, depth - 1);
    }));
  }

  /**
   * The repository of a file you open. Inside the workspace folders it opens right away (the
   * workspace is trusted). Outside them, opening it would run git there — and git runs programs
   * a repository's own config names (core.fsmonitor, filters, …) — so it is opened only after
   * you agree, remembered per repository ("prompt", the default), always, or never.
   */
  async discoverForUri(uri) {
    if (!uri || uri.scheme !== 'file' || this.getRepositoryForUri(uri)) return;
    // Real paths: a symlink committed in the workspace (link -> some other repository on disk)
    // leads outside it, and that is asked about like any outside repository.
    const real = (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    };
    const dir = real(path.dirname(uri.fsPath));
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => real(f.uri.fsPath));
    if (folders.some((f) => f === dir || isStrictAncestor(f, dir))) {
      await this.openRepository(dir);
      return;
    }
    const mode = config().get('detectRepositoriesOfOpenFiles', 'prompt');
    if (mode === 'never' || mode === false) return;
    if (mode === 'always' || mode === true) {
      await this.openRepository(dir);
      return;
    }
    // Find the repository root by looking for .git, without running git.
    let root = dir;
    while (!fs.existsSync(path.join(root, '.git'))) {
      const up = path.dirname(root);
      if (up === root) return;
      root = up;
    }
    // A linked worktree of a repository that is already open (an agent's, its files shown by
    // Changes vs Base): no question, and no switch either — the views stay on your repository.
    // (Open the worktree in a window, or add it to the workspace, to work in it.)
    if (await this.isWorktreeOfOpenRepository(root)) return;
    const key = `outsideRepo:${root}`;
    const remembered = this.memento && this.memento.get(key);
    if (remembered === true) {
      await this.openRepository(root);
      return;
    }
    if (remembered === false || this.askedOutside.has(root)) return;
    this.askedOutside.add(root);
    notify.info(
      `The file you opened belongs to the git repository ${root}, outside this workspace. Open it in Commit Corner?`,
      { detail: 'Commit Corner runs git there, and git can run programs that the repository\'s own configuration names. Only open repositories you trust.' },
      'Open', 'Never for This Repository',
    ).then(async (choice) => {
      if (!choice) return;
      const allow = choice === 'Open';
      if (this.memento) await this.memento.update(key, allow);
      if (allow) await this.openRepository(root);
    });
  }

  /** Whether `root/.git` is a file pointing into the worktrees of an open repository. */
  async isWorktreeOfOpenRepository(root) {
    let text;
    try {
      text = await fs.promises.readFile(path.join(root, '.git'), 'utf8');
    } catch {
      return false; // a directory (its own repository) or nothing
    }
    const m = /^gitdir: (.+?)\s*$/m.exec(text);
    if (!m) return false;
    const target = await fs.promises.realpath(path.resolve(root, m[1])).catch(() => '');
    if (!target) return false;
    for (const repo of this.repos.values()) {
      const worktrees = await fs.promises.realpath(path.join(repo.commonDir, 'worktrees')).catch(() => '');
      if (worktrees && target.startsWith(worktrees + path.sep)) return true;
    }
    return false;
  }

  /** Open (or return the already open) repository containing `dir`. */
  async openRepository(dir) {
    const existing = this.getRepositoryForUri(dir);
    if (existing && (existing.root === dir || !fs.existsSync(path.join(dir, '.git')))) return existing;
    if (this.pending.has(dir)) return this.pending.get(dir);
    // A folder found not to be in a repository is not asked again for a minute (switching
    // editors in a non-git folder would otherwise start git every time).
    const miss = this.notRepos.get(dir);
    if (miss && Date.now() - miss < 60e3) return undefined;
    // A tab of a worktree that was removed meanwhile: nothing to open, nothing to report.
    if (!fs.existsSync(dir)) {
      this.notRepos.set(dir, Date.now());
      return undefined;
    }
    const promise = (async () => {
      let repo;
      try {
        repo = await Repository.open(dir);
      } catch (e) {
        if (e && e.code === 'GitNotFound') {
          showError(e);
          return undefined;
        }
        if (e && e.code === 'DubiousOwnership') {
          this.reportDubiousOwnership(e);
          return undefined;
        }
        if (e && e.code === 'ForeignGitDir') {
          log().warn(e.message);
          this.notRepos.set(dir, Date.now());
          return undefined;
        }
        throw e;
      }
      if (!repo) {
        if (this.notRepos.size > 500) this.notRepos.clear();
        this.notRepos.set(dir, Date.now());
        return undefined;
      }
      this.notRepos.delete(dir);
      if (this.repos.has(repo.root)) return this.repos.get(repo.root);
      if (!(await this.allowParentRepository(repo))) return undefined;
      this.repos.set(repo.root, repo);
      this.watch(repo);
      log().info(`Opened repository ${repo.root}`);
      try {
        await this.refresh(repo);
      } catch (e) {
        log().error(`Initial refresh of ${repo.root} failed: ${e.message}`);
      }
      this._onDidOpen.fire(repo);
      // A large history without git's commit-graph file: write it once in the background (the
      // graph pages load ~20× faster with it; `git gc` would do the same).
      if (config().get('writeCommitGraph', true)) {
        const timer = setTimeout(() => this.repos.get(repo.root) === repo && repo.ensureCommitGraph().then((wrote) => wrote && log().info(`Wrote the commit-graph file of ${repo.root}`), (e) => log().info(`Commit graph: ${e.message}`)), 30000);
        if (timer.unref) timer.unref();
      }
      if (!this.active) this.setActive(repo);
      this.updateContextKeys();
      return repo;
    })().finally(() => this.pending.delete(dir));
    this.pending.set(dir, promise);
    return promise;
  }

  /**
   * A repository whose root lies *above* a workspace folder (e.g. a dotfiles
   * repo in $HOME) would scan and watch far more than the user opened. Like
   * the built-in git.openRepositoryInParentFolders: ask, always, or never.
   */
  async allowParentRepository(repo) {
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    if (!folders.some((f) => isStrictAncestor(repo.displayRoot, f) || isStrictAncestor(repo.root, f))) return true;
    const mode = config().get('openRepositoryInParentFolders', 'prompt');
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    const key = `parentRepo:${repo.root}`;
    const remembered = this.memento && this.memento.get(key);
    if (remembered !== undefined) return remembered;
    if (this.askedParent.has(repo.root)) return false;
    this.askedParent.add(repo.root);
    // Ask without blocking activation: the repository opens when (and if) the user agrees.
    notify.info(
      `A git repository was found in the parent folder ${repo.root}. Open it?`,
      'Open', 'Never for This Repository',
    ).then(async (choice) => {
      if (!choice) return;
      const allow = choice === 'Open';
      if (this.memento) await this.memento.update(key, allow);
      if (allow) await this.openRepository(repo.displayRoot);
    });
    return false;
  }

  reportDubiousOwnership(e) {
    if (this.reportedOwnership.has(e.directory)) return;
    this.reportedOwnership.add(e.directory);
    // Pasted into a shell: quote the folder name so that no part of it can run as a command.
    const trustCommand = `git config --global --add safe.directory '${String(e.directory).replace(/'/g, "'\\''")}'`;
    notify.warn(
      `${e.message} To trust it, run: ${trustCommand}`,
      'Copy Command',
    ).then((c) => {
      if (c) vscode.env.clipboard.writeText(trustCommand);
    });
  }

  closeRepository(repo) {
    if (!this.repos.delete(repo.root)) return;
    (this.repoDisposables.get(repo.root) || []).forEach((d) => d.dispose());
    this.repoDisposables.delete(repo.root);
    repo.dispose();
    this._onDidClose.fire(repo);
    if (this.active === repo) this.setActive(this.repositories[0]);
    this.updateContextKeys();
  }

  updateContextKeys() {
    vscode.commands.executeCommand('setContext', 'commitCorner.hasRepository', this.repos.size > 0);
    vscode.commands.executeCommand('setContext', 'commitCorner.multipleRepositories', this.repos.size > 1);
  }

  watch(repo) {
    const disposables = [];
    // Debounce grows with how long status takes, so a huge working tree under a busy build
    // is not re-scanned back to back.
    let timer;
    let background;
    /** When the first change of the pending batch arrived (for the maximum wait). */
    let pendingSince = 0;
    const run = () => {
      pendingSince = 0;
      clearTimeout(timer);
      return this.refresh(repo).catch((e) => log().warn(`Refresh failed: ${e.message}`));
    };
    const refresh = () => {
      const cost = this.lastRefreshMs.get(repo.root) || 0;
      if (vscode.window.state && vscode.window.state.focused === false) {
        // In the background (an agent or a terminal is working while you watch on another
        // screen): keep up, but throttled — at most one refresh every few seconds, however
        // many files change. "off" waits for the window to get focus again.
        const mode = vscode.workspace.getConfiguration('commitCorner').get('refreshWhenUnfocused', 'throttled');
        if (mode === 'off' || background) return;
        background = setTimeout(() => {
          background = undefined;
          run();
        }, Math.max(3000, cost * 5));
        return;
      }
      // Debounced, but never postponed forever: files that change all the time (a log, a dev
      // server, an agent's test run) would otherwise keep every view stale while they do.
      const now = Date.now();
      if (!pendingSince) pendingSince = now;
      clearTimeout(timer);
      timer = setTimeout(run, refreshDelay(now, pendingSince, cost));
    };
    refresh.cancel = () => {
      clearTimeout(timer);
      clearTimeout(background);
    };
    // Right away (a few writes in a row still make one refresh): what you just did shows now.
    refresh.soon = () => {
      if (!pendingSince) pendingSince = Date.now();
      clearTimeout(timer);
      timer = setTimeout(run, 30);
    };
    this.refreshers.set(repo.root, refresh);
    disposables.push({ dispose: () => refresh.cancel() });

    // Working tree changes.
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(repo.root), '**/*'));
    const onFile = (uri) => {
      // Edits inside .git are handled by the fs.watch watchers below.
      if (/[\\/]\.git([\\/]|$)/.test(uri.fsPath)) return;
      if (outsideStatus(repo, uri.fsPath)) return;
      refresh();
    };
    watcher.onDidChange(onFile);
    watcher.onDidCreate(onFile);
    watcher.onDidDelete(onFile);
    disposables.push(watcher);

    // HEAD, index, refs, in-progress operations. These live in the git dir,
    // which can be outside the workspace for linked worktrees.
    const watchDir = (dir, recursive) => {
      try {
        const w = fs.watch(dir, { recursive, persistent: false }, (_event, file) => {
          if (file && IGNORED_GIT_FILES.test(String(file))) return;
          refresh();
        });
        w.on('error', () => w.close());
        disposables.push({ dispose: () => w.close() });
      } catch (e) {
        log().warn(`Cannot watch ${dir}: ${e.message}`);
      }
    };
    watchDir(repo.gitDir, false);
    if (repo.commonDir !== repo.gitDir) watchDir(repo.commonDir, false);
    // Refs: git updates a ref by renaming a lock file over it, and a recursive fs.watch on Linux
    // watches the files themselves, losing track after the first update (a commit made in another
    // worktree went unnoticed). So every folder under the shown namespaces gets its own
    // non-recursive watch, which sees files renamed into it, and new folders are added as they
    // appear. (Not refs/commit-corner/pr/*, which can hold thousands of folders.)
    const watchedDirs = new Set();
    const watchTree = (dir) => {
      if (watchedDirs.has(dir) || watchedDirs.size > 2000) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      watchedDirs.add(dir);
      try {
        const w = fs.watch(dir, { persistent: false }, (_event, file) => {
          if (file && IGNORED_GIT_FILES.test(String(file))) return;
          if (file) {
            const sub = path.join(dir, String(file));
            fs.stat(sub, (err, st) => {
              if (!err && st.isDirectory()) watchTree(sub);
            });
          }
          refresh();
        });
        w.on('error', () => {
          w.close();
          watchedDirs.delete(dir);
        });
        disposables.push({ dispose: () => w.close() });
      } catch (e) {
        log().warn(`Cannot watch ${dir}: ${e.message}`);
      }
      for (const e of entries) if (e.isDirectory()) watchTree(path.join(dir, e.name));
    };
    const refsDir = path.join(repo.commonDir, 'refs');
    // refs/ itself (non-recursive) notices namespaces created later (the first remote or tag).
    watchDir(refsDir, false);
    for (const ns of ['heads', 'remotes', 'tags']) {
      const dir = path.join(refsDir, ns);
      if (fs.existsSync(dir)) watchTree(dir);
    }
    // The reftable ref store (git 2.45+, extensions.refStorage=reftable) keeps every ref here.
    const reftable = path.join(repo.commonDir, 'reftable');
    if (fs.existsSync(reftable)) watchDir(reftable, false);

    // Our own mutating commands: refresh right after they finish.
    const onRun = () => refresh.soon();
    repo.on('didRun', onRun);
    disposables.push({ dispose: () => repo.off('didRun', onRun) });
    this.repoDisposables.set(repo.root, disposables);
  }

  scheduleRefresh(repo) {
    const r = this.refreshers.get(repo.root);
    if (r) r();
  }

  async refresh(repo) {
    if (!repo || !this.repos.has(repo.root)) return;
    if (!fs.existsSync(repo.gitDir)) {
      this.closeRepository(repo);
      return;
    }
    repo.untrackedMode = config().get('untrackedFiles', 'all');
    const started = Date.now();
    // Ref tips once per refresh, shared by every view (graph, branches, compare, file provider).
    const [, tips] = await Promise.all([repo.refreshState(), repo.getRefTips().catch(() => '')]);
    repo.refTips = tips;
    this.lastRefreshMs.set(repo.root, Date.now() - started);
    this._onDidChangeState.fire(repo);
    this.updateEditorContext();
  }

  /** Context keys for editor-title buttons: is the active file changed, is it the index side of a diff? */
  updateEditorContext() {
    const editor = vscode.window.activeTextEditor;
    const uri = editor && editor.document.uri;
    let changed = false;
    let isIndex = false;
    let commitFile = false; // a diff opened from a commit's files (Next Unviewed File)
    if (uri && uri.scheme === 'file') {
      const repo = this.getRepositoryForUri(uri);
      const s = repo && repo.state;
      if (s) {
        const rel = repo.relative(uri.fsPath);
        changed = [s.unstaged, s.staged, s.untracked, s.conflicts].some((list) => list.some((e) => e.path === rel));
      }
    } else if (uri && uri.scheme === 'commitcorner') {
      try {
        const q = JSON.parse(uri.query);
        isIndex = q.ref === ':';
        commitFile = typeof q.commit === 'string';
      } catch { /* not ours */ }
    }
    vscode.commands.executeCommand('setContext', 'commitCorner.activeFileChanged', changed);
    vscode.commands.executeCommand('setContext', 'commitCorner.activeEditorIsIndex', isIndex);
    vscode.commands.executeCommand('setContext', 'commitCorner.activeEditorIsCommitFile', commitFile);
    vscode.commands.executeCommand('setContext', 'commitCorner.builtInGitOff', !require('./scm').builtInGitEnabled());
  }

  onActiveEditor(editor) {
    this.updateEditorContext();
    if (!editor || inDiffTab()) return; // a diff (Changes vs Base of an agent's worktree…) is a look, not a switch
    const uri = editor.document.uri;
    const follow = (r) => {
      // A repository nested in the active one (an agent's worktree under .claude/worktrees)
      // does not take the views over; Switch Repository does that on purpose.
      if (r && !(this.active && r !== this.active && isInside(r.root, this.active.root))) this.setActive(r);
    };
    const repo = this.getRepositoryForUri(uri);
    if (repo) follow(repo);
    else this.discoverForUri(uri).then(() => follow(this.getRepositoryForUri(uri)), () => {});
  }

  setActive(repo) {
    if (this.active === repo) return;
    this.active = repo;
    if (repo && this.memento) {
      // Most recently used first in Switch Repository.
      const recent = [repo.root, ...this.recentRoots().filter((r) => r !== repo.root)].slice(0, 30);
      this.memento.update('recentRepositories', recent).then(undefined, () => {});
    }
    this._onDidChangeActive.fire(repo);
  }

  /** Roots of the repositories you showed lately, the latest first. */
  recentRoots() {
    const v = this.memento && this.memento.get('recentRepositories');
    return Array.isArray(v) ? v.filter((r) => typeof r === 'string') : [];
  }

  /**
   * The repository a command should act on: explicit argument, the active
   * editor's repository, the active one, or ask when there are several.
   */
  async pick(arg) {
    if (arg instanceof Repository) return arg;
    if (arg && typeof arg === 'object' && arg.repo instanceof Repository) return arg.repo;
    if (arg && typeof arg === 'object' && typeof arg.repoRoot === 'string') return this.repos.get(arg.repoRoot);
    if (typeof arg === 'string' && this.repos.has(arg)) return this.repos.get(arg);
    if (arg && arg.rootUri) return this.getRepositoryForUri(arg.rootUri.fsPath);
    if (this.active) return this.active;
    const repos = this.repositories;
    if (repos.length === 1) return repos[0];
    if (!repos.length) {
      notify.warn('Commit Corner: no git repository is open.');
      return undefined;
    }
    const choice = await vscode.window.showQuickPick(repos.map((r) => ({ label: r.name, description: r.root, repo: r })), { placeHolder: 'Choose a repository' });
    return choice && choice.repo;
  }

  async onFoldersChanged(e) {
    for (const f of e.added) await this.scanFolder(f.uri.fsPath);
    for (const f of e.removed) {
      const dir = f.uri.fsPath;
      for (const repo of this.repositories) {
        if (isSameOrInside(dir, repo.root)) this.closeRepository(repo);
      }
    }
  }

  dispose() {
    for (const repo of this.repositories) this.closeRepository(repo);
    this.disposables.forEach((d) => d.dispose());
  }
}

function isStrictAncestor(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Whether the active editor tab is a diff or a multi-file diff. */
function inDiffTab() {
  const groups = vscode.window.tabGroups;
  const tab = groups && groups.activeTabGroup && groups.activeTabGroup.activeTab;
  const input = tab && tab.input;
  if (!input) return false;
  return (typeof vscode.TabInputTextDiff === 'function' && input instanceof vscode.TabInputTextDiff)
    || (typeof vscode.TabInputTextMultiDiff === 'function' && input instanceof vscode.TabInputTextMultiDiff);
}

/** Whether folder `inner` lies inside folder `outer`. */
function isInside(inner, outer) {
  const rel = path.relative(outer, inner);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * A file whose changes cannot change the repository's status: inside a repository nested in it
 * (an agent's worktree under .claude/worktrees) or inside an ignored folder (a build output).
 */
function outsideStatus(repo, fsPath) {
  const rel = repo.relative(fsPath);
  if (!rel) return false;
  if (repo.state && repo.nestedRepositories(repo.state).some((n) => rel.startsWith(n))) return true;
  return repo.ignored.some((e) => e.path.endsWith('/') && rel.startsWith(e.path));
}

module.exports = { outsideStatus, RepositoryManager, isStrictAncestor, refreshDelay };
