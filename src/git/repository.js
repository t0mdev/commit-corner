'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { git, getVersion, versionAtLeast, GitError, ErrorCodes, getGitPath } = require('./exec');
const P = require('./parse');
const { combineCommitChanges } = require('./multiCommit');
const { BlobReader } = require('./blobReader');
const { normalizePath } = require('./pathUtil');

/** Special "refs" understood by show(): */
const INDEX = ':'; // the index (stage 0)
const WORKTREE = '~worktree~';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const EMPTY_TREE_SHA256 = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321';

/** Spellings git accepts for a false boolean config value. */
const FALSE_VALUES = new Set(['false', 'no', 'off', '0', '']);

/**
 * branch.<name>.rebase / pull.rebase: false, true, merges or interactive (and their
 * abbreviations and boolean spellings). Returns false, true or 'merges'.
 */
function parseRebaseConfig(value) {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  if (FALSE_VALUES.has(v)) return false;
  if (v === 'merges' || v === 'm' || v === 'preserve' || v === 'p') return 'merges';
  return true; // true, yes, on, 1, interactive, i
}

/** Like fs.existsSync, but true for a symlink whatever it points to. */
function lexists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Namespace for fetched pull request refs: invisible to branch lists, visible to git. */
const PR_REF_PREFIX = 'refs/commit-corner/pr';

/**
 * A single git repository (working tree). All git access in the extension goes
 * through here. Read operations run concurrently; operations that write to the
 * repository are serialized so they never fight over index.lock.
 */
class Repository extends EventEmitter {
  /**
   * @param {string} root absolute working tree path
   * @param {string} gitDir absolute path of this worktree's git dir
   * @param {string} commonDir absolute path of the shared git dir (differs for linked worktrees)
   */
  constructor(root, gitDir, commonDir, workspaceRoot) {
    super();
    /** Canonical (symlink-resolved) working tree path, as git reports it. */
    this.root = root;
    /**
     * The path the user opened, when it reaches the repository through a symlink.
     * Editor URIs use this path, so file paths we hand to VS Code use it too.
     */
    this.displayRoot = workspaceRoot && workspaceRoot !== root ? workspaceRoot : root;
    this.gitDir = gitDir;
    this.commonDir = commonDir;
    this.queue = Promise.resolve();
    this.networkQueue = Promise.resolve();
    /** Temporary directories of interactive rebases, removed once no rebase is in progress. */
    this.rebaseTempDirs = new Set();
    /** `--untracked-files` mode for status (commitCorner.untrackedFiles). */
    this.untrackedMode = 'all';
    /** Also list ignored paths (for Explorer decorations). */
    this.includeIgnored = false;
    /** @type {{path:string}[]} ignored entries from the last status, when includeIgnored */
    this.ignored = [];
    /** remote name -> default branch name, learned from `ls-remote --symref`. */
    this.remoteDefaultBranches = new Map();
    /** @type {RepositoryState|undefined} */
    this.state = undefined;
  }

  /** Discover the repository containing `dir`. Resolves undefined if there is none. */
  static async open(dir) {
    try {
      // git 2.29+ also says the object format (SHA-256 repositories have their own empty tree).
      const withFormat = versionAtLeast(await getVersion(), 2, 29);
      const { stdout } = await git(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--show-prefix', ...(withFormat ? ['--show-object-format'] : [])], { cwd: dir });
      const [root, gitDir, common, prefix, format] = stdout.split('\n');
      if (!root) return undefined; // bare repository or inside .git
      if (!(await ownsGitDir(root, gitDir))) {
        const err = new Error(`Not opening ${root}: its git directory ${gitDir} is not the folder's own .git (a repository committed inside another one, or core.worktree pointing elsewhere).`);
        err.code = 'ForeignGitDir';
        throw err;
      }
      const commonDir = normalizePath(path.resolve(dir, common));
      // git resolves symlinks in --show-toplevel. Work out the unresolved root the caller used.
      let workspaceRoot = path.resolve(dir);
      const depth = (prefix || '').split('/').filter(Boolean).length;
      for (let i = 0; i < depth; i++) workspaceRoot = path.dirname(workspaceRoot);
      // As VS Code writes paths (git for Windows prints "C:/…"; fsPath is "c:\…").
      const repo = new Repository(normalizePath(root), normalizePath(gitDir), commonDir, workspaceRoot);
      if (withFormat) repo.objectFormat = (format || '').trim() || 'sha1';
      return repo;
    } catch (e) {
      if (e instanceof GitError && /dubious ownership|safe\.directory/i.test(e.stderr || '')) {
        // git refuses repositories owned by another user (common on WSL mounts). Tell the caller.
        const err = new Error(`git refuses to open ${dir}: it is owned by another user ("dubious ownership").`);
        err.code = 'DubiousOwnership';
        err.directory = (/'([^']+)' is owned by/.exec(e.stderr) || [])[1] || dir;
        throw err;
      }
      if (e instanceof GitError) return undefined;
      throw e;
    }
  }

  get name() {
    return path.basename(this.root);
  }

  /**
   * Run a read-only git command in this repository. GIT_OPTIONAL_LOCKS=0
   * stops reads such as `git diff` from refreshing (and locking) the index
   * behind the user's back.
   */
  exec(args, opts = {}) {
    const env = opts.writes ? opts.env : { GIT_OPTIONAL_LOCKS: '0', ...opts.env };
    return git(args, { cwd: this.root, ...opts, env });
  }

  /** Run a git command that modifies the repository. Serialized; retries briefly on index.lock. */
  run(args, opts = {}) {
    const task = this.queue.then(async () => {
      // Expose what runs (and a way to stop it) so a hook or pinentry waiting forever is visible.
      const controller = new AbortController();
      if (opts.signal) opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
      this.running = { args, started: Date.now(), cancel: () => controller.abort() };
      this.emit('busy', this.running);
      try {
        return await this.runAttempts(args, { ...opts, signal: controller.signal });
      } finally {
        this.running = undefined;
        this.emit('busy', undefined);
      }
    });
    // Keep the queue alive regardless of failures.
    this.queue = task.catch(() => {});
    return task.finally(() => this.emit('didRun', args));
  }

  /** Run a write, retrying briefly while another git process holds index.lock. */
  async runAttempts(args, opts) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.exec(args, { ...opts, writes: true });
      } catch (e) {
        if (e instanceof GitError && e.code === ErrorCodes.IndexLocked && attempt < 4) {
          await delay(100 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
  }

  /**
   * Run `fn` inside the write queue (nothing else writes meanwhile). `fn` must
   * use `this.exec(..., { writes: true })` for its writes, not `run()`.
   */
  locked(fn) {
    const task = this.queue.then(fn);
    this.queue = task.catch(() => {});
    return task.finally(() => this.emit('didRun', ['locked']));
  }

  /**
   * Run a git command that talks to a remote (fetch, push, ls-remote). These
   * do not touch the index or working tree, so they run outside the write
   * queue: a slow or hanging network never blocks staging or committing.
   */
  runNetwork(args, opts = {}) {
    // Network commands queue among themselves (an auto-fetch and a user pull must not race for
    // the same remote-tracking refs), but never behind local writes.
    const task = this.networkQueue.then(() => this.exec(args, { ...opts, network: true }));
    this.networkQueue = task.catch(() => {});
    return task.finally(() => this.emit('didRun', args));
  }

  // ---------------------------------------------------------------------------
  // State

  /**
   * @typedef {{
   *   head: {sha:string|null, branch:string|null, upstream:string|null, ahead:number, behind:number, detached:boolean},
   *   staged: P.StatusEntry[], unstaged: P.StatusEntry[], untracked: P.StatusEntry[], conflicts: P.StatusEntry[],
   *   operation: Operation|undefined,
   *   stashCount: number,
   * }} RepositoryState
   * @typedef {{kind:'rebase'|'merge'|'cherry-pick'|'revert'|'bisect', step?:number, total?:number, head?:string, onto?:string, interactive?:boolean}} Operation
   */
  async refreshState(opts = {}) {
    // Concurrent refreshes can finish out of order: only the newest may publish its result.
    const seq = (this.refreshSeq = (this.refreshSeq || 0) + 1);
    const args = ['status', '--porcelain=v2', '-z', '--branch'];
    args.push(`--untracked-files=${opts.untracked || this.untrackedMode || 'all'}`);
    if (this.includeIgnored) args.push('--ignored=matching');
    const [{ stdout }, operation, stashCount] = await Promise.all([
      this.exec(args, { env: { GIT_OPTIONAL_LOCKS: '0' } }),
      this.getOperation(),
      this.countStashes(),
    ]);
    const status = P.parseStatus(stdout);
    // "normal" mode lists an untracked folder as one "dir/" entry, also when a repository is
    // nested deeper inside it (.claude/ holding .claude/worktrees/agent): list those folders
    // file by file, so the repository is seen as nested and never staged, stashed or deleted.
    if ((opts.untracked || this.untrackedMode || 'all') !== 'all') status.entries = await this.expandFoldersHoldingRepositories(status.entries, { fresh: opts.fresh });
    const state = {
      head: {
        sha: status.branch.oid,
        branch: status.branch.head,
        upstream: status.branch.upstream,
        ahead: status.branch.ahead,
        behind: status.branch.behind,
        detached: !status.branch.head,
      },
      staged: [],
      unstaged: [],
      untracked: [],
      conflicts: [],
      /** Repositories nested in the working tree ("dir/" entries with their own .git). */
      nested: [],
      operation,
      stashCount,
    };
    const ignored = [];
    for (const e of status.entries) {
      if (e.kind === 'ignored') ignored.push(e);
      // A repository inside the tree (an agent's worktree, a clone) shows as "dir/": it is not
      // one of your untracked files (not counted, staged, stashed or cleaned) — like the built-in Git.
      else if (e.kind === 'untracked' && e.path.endsWith('/') && fs.existsSync(path.join(this.root, e.path, '.git'))) state.nested.push(e.path);
      else if (e.kind === 'untracked') state.untracked.push(e);
      else if (e.kind === 'unmerged') state.conflicts.push(e);
      else if (e.kind !== 'ignored') {
        if (e.x !== '.') state.staged.push(e);
        if (e.y !== '.') state.unstaged.push(e);
      }
    }
    // Nested repositories may have come or gone: look again at the next contains().
    this.boundaryCache = undefined;
    // Superseded: do not publish, but the caller still gets what it just read (never older).
    if (seq !== this.refreshSeq) return state;
    this.state = state;
    this.ignored = ignored;
    if (!operation && (this.rebaseTempDirs.size || !this.sweptRebaseDirs)) {
      this.sweptRebaseDirs = true;
      this.cleanupRebaseTempDirs();
    }
    this.emit('didChangeState', state);
    return state;
  }

  /** Untracked "dir/" entries with a repository somewhere below: replaced by their -uall entries. */
  /** @param {{fresh?: boolean}} [o] fresh: no cached answer (before staging or deleting) */
  async expandFoldersHoldingRepositories(entries, o = {}) {
    const dirs = entries.filter((e) => e.kind === 'untracked' && e.path.endsWith('/') && !fs.existsSync(path.join(this.root, e.path, '.git')));
    if (!dirs.length) return entries;
    // A quick look below each folder; folders too big to look through are asked of git (it does
    // not descend into a nested repository), so a large untracked folder stays one row unless
    // a repository really is in it.
    // Every time: a repository created deeper down (.claude/worktrees/new) does not change the
    // folder's own time, and a stale "none here" would let staging or Delete Untracked take it.
    const verdicts = dirs.map((e) => ({ e, holds: holdsRepository(path.join(this.root, e.path)) }));
    const ask = verdicts.filter((v) => v.holds === null).map((v) => v.e);
    const hasNested = (list, dir) => list.some((x) => x.path.startsWith(dir) && x.path.endsWith('/') && fs.existsSync(path.join(this.root, x.path, '.git')));
    const expand = verdicts.filter((v) => v.holds === true).map((v) => v.e);
    let asked = [];
    if (ask.length) {
      // Big folders: git's answer is kept for 30 seconds while the folder's time is the same —
      // for what is shown. Staging and deleting ask fresh (o.fresh), so a repository created a
      // moment ago is never taken with them.
      const cache = this.bigFolderCache || (this.bigFolderCache = new Map());
      const mtimeOf = (e) => {
        try {
          return fs.statSync(path.join(this.root, e.path)).mtimeMs;
        } catch {
          return 0;
        }
      };
      const stale = [];
      for (const e of ask) {
        const hit = !o.fresh && cache.get(e.path);
        if (hit && hit.mtime === mtimeOf(e) && Date.now() - hit.at < 30000) asked = asked.concat(hit.entries);
        else stale.push(e);
      }
      if (stale.length) {
        const { stdout } = await this.exec(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', ...stale.map((e) => lit(e.path))], { env: { GIT_OPTIONAL_LOCKS: '0' } });
        const fresh = P.parseStatus(stdout).entries.filter((x) => x.kind === 'untracked');
        asked = asked.concat(fresh);
        if (cache.size > 200) cache.clear();
        for (const e of stale) cache.set(e.path, { at: Date.now(), mtime: mtimeOf(e), entries: fresh.filter((x) => x.path.startsWith(e.path)) });
      }
      for (const e of ask) if (hasNested(asked, e.path)) expand.push(e);
    }
    if (!expand.length) return entries;
    const drop = new Set(expand.map((e) => e.path));
    const known = expand.filter((e) => ask.includes(e));
    const fresh = expand.filter((e) => !ask.includes(e));
    let inside = asked.filter((x) => known.some((e) => x.path.startsWith(e.path)));
    if (fresh.length) {
      const { stdout } = await this.exec(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', ...fresh.map((e) => lit(e.path))], { env: { GIT_OPTIONAL_LOCKS: '0' } });
      inside = inside.concat(P.parseStatus(stdout).entries.filter((x) => x.kind === 'untracked'));
    }
    return [...entries.filter((e) => !drop.has(e.path)), ...inside];
  }

  /**
   * Write git's commit-graph file when a history of 5,000+ commits has none (cloned without gc,
   * imported). Returns whether it wrote one.
   */
  async ensureCommitGraph() {
    const info = path.join(this.commonDir, 'objects', 'info');
    if (fs.existsSync(path.join(info, 'commit-graph')) || fs.existsSync(path.join(info, 'commit-graphs'))) return false;
    // Not where the repository says no (core.commitGraph / gc.writeCommitGraph false).
    for (const key of ['core.commitGraph', 'gc.writeCommitGraph']) {
      if (FALSE_VALUES.has(String(await this.getConfig(key).catch(() => '') || 'true').toLowerCase())) return false;
    }
    const { stdout } = await this.exec(['rev-list', '--count', '--all'], { allowFailure: true });
    if ((Number(stdout.trim()) || 0) < 5000) return false;
    // Beside your own git work, not in its queue (commit-graph has its own lock): a stage or a
    // commit never waits for it.
    await this.exec(['commit-graph', 'write', '--reachable'], { env: {}, timeout: 300000 });
    return true;
  }

  async countStashes() {
    try {
      const { stdout } = await this.exec(['rev-list', '--walk-reflogs', '--count', 'refs/stash'], { allowFailure: true });
      return Number(stdout.trim()) || 0;
    } catch {
      return 0;
    }
  }

  /** Detect an in-progress rebase/merge/cherry-pick/revert by inspecting the git dir. */
  async getOperation() {
    const g = (...p) => path.join(this.gitDir, ...p);
    const exists = (p) => fs.promises.access(p).then(() => true, () => false);
    const read = (p) => fs.promises.readFile(p, 'utf8').then((s) => s.trim(), () => undefined);
    if (await exists(g('rebase-merge'))) {
      return {
        kind: 'rebase',
        interactive: await exists(g('rebase-merge', 'interactive')),
        step: Number(await read(g('rebase-merge', 'msgnum'))) || undefined,
        total: Number(await read(g('rebase-merge', 'end'))) || undefined,
        head: (await read(g('rebase-merge', 'head-name')) || '').replace(/^refs\/heads\//, ''),
        onto: await read(g('rebase-merge', 'onto')),
      };
    }
    if (await exists(g('rebase-apply'))) {
      if (await exists(g('rebase-apply', 'applying'))) return { kind: 'am' };
      return {
        kind: 'rebase',
        step: Number(await read(g('rebase-apply', 'next'))) || undefined,
        total: Number(await read(g('rebase-apply', 'last'))) || undefined,
        head: (await read(g('rebase-apply', 'head-name')) || '').replace(/^refs\/heads\//, ''),
      };
    }
    if (await exists(g('MERGE_HEAD'))) return { kind: 'merge', head: await read(g('MERGE_HEAD')) };
    if (await exists(g('CHERRY_PICK_HEAD'))) return { kind: 'cherry-pick', head: await read(g('CHERRY_PICK_HEAD')) };
    if (await exists(g('REVERT_HEAD'))) return { kind: 'revert', head: await read(g('REVERT_HEAD')) };
    if (await exists(g('BISECT_LOG'))) return { kind: 'bisect' };
    return undefined;
  }

  /**
   * True when an interactive rebase stopped at an `edit` (or `break`) line,
   * i.e. the user is meant to change history here rather than resolve a
   * conflict: new commits made now are kept as separate commits.
   */
  async isRebaseEditStop() {
    const dir = path.join(this.gitDir, 'rebase-merge');
    if (!fs.existsSync(dir)) return false;
    // `edit` stops leave an "amend" file (also after the user committed on top);
    // `break` stops leave neither "amend" nor a stopped-sha; conflict stops only the latter.
    return fs.existsSync(path.join(dir, 'amend')) || !fs.existsSync(path.join(dir, 'stopped-sha'));
  }

  /** The prepared message of an in-progress merge/cherry-pick/revert/squash, comments stripped. */
  async getPendingMessage() {
    // git writes its comments with core.commentChar ("#" unless configured; "auto" picks one).
    const configured = (await this.getConfig('core.commentChar').catch(() => undefined)) || '#';
    for (const name of ['MERGE_MSG', 'SQUASH_MSG']) {
      try {
        const text = await fs.promises.readFile(path.join(this.gitDir, name), 'utf8');
        const lines = text.split('\n');
        const comment = configured === 'auto' ? (lines.find((l) => /^[#;@!$%^&|:]\s/.test(l)) || '#')[0] : configured[0];
        return cleanPendingMessage(lines, comment);
      } catch { /* not present */ }
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Content

  /** The empty tree of this repository's object format (SHA-1 or SHA-256). */
  get emptyTree() {
    return this.objectFormat === 'sha256' ? EMPTY_TREE_SHA256 : EMPTY_TREE;
  }

  /** A revision with the (SHA-1) empty-tree constant the views use translated for this repository. */
  tree(ref) {
    return ref === EMPTY_TREE ? this.emptyTree : ref;
  }

  /**
   * Read a file's content at a ref.
   * @param {string} ref commit-ish, INDEX (':'), ':1'/':2'/':3' for conflict stages, or WORKTREE
   * @param {string} relPath repository-relative path with forward slashes
   * @returns {Promise<Buffer|null>} null when the file does not exist there
   */
  async show(ref, relPath) {
    ref = this.tree(ref);
    checkRevs(ref);
    if (ref === WORKTREE) {
      // Only files of this working tree ("../.." in a commitcorner: URI must not reach others).
      const rel = path.relative(this.root, path.join(this.root, relPath));
      if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
      try {
        return await fs.promises.readFile(path.join(this.root, relPath));
      } catch (e) {
        // A submodule's working tree is a directory: describe its checked-out commit.
        if (e && e.code === 'EISDIR') return this.submoduleText(ref, relPath);
        return null;
      }
    }
    // INDEX (":") -> ":path"; conflict stage ":2" -> ":2:path"; commit-ish -> "ref:path"
    // ":0:" (not ":") so a path like "1:foo" is not read as conflict stage 1 of "foo".
    const spec = ref === INDEX ? `:0:${relPath}` : `${ref}:${relPath}`;
    if (/^([0-9a-f]{40}|[0-9a-f]{64})([~^]\d*)*$/.test(ref)) {
      // Fixed revision: use the shared batch reader (one process for many files).
      if (!this.blobs) this.blobs = new BlobReader(this.root);
      try {
        const blob = await this.blobs.read(spec);
        if (blob !== null) return blob;
        return this.submoduleText(ref, relPath);
      } catch {
        // fall back to a one-shot read below
      }
    }
    const res = await this.exec(['cat-file', 'blob', spec], { buffer: true, allowFailure: true });
    if (res.exitCode !== 0) return this.submoduleText(ref, relPath);
    return res.stdout;
  }

  /**
   * Whether `dir` is a submodule checkout of this repository, safe to run git in: a real folder
   * (not a symlink) inside this working tree, recorded as a submodule (gitlink, mode 160000) in
   * the index, whose `.git` is a file pointing into our own .git/modules or (older layout) a
   * folder. A symlink to some other repository on disk, or an embedded repository that is not
   * a recorded submodule, is never run git in (its config could name programs).
   */
  async isOwnSubmodule(dir) {
    let st;
    try {
      st = await fs.promises.lstat(dir);
    } catch {
      return false;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    const real = await fs.promises.realpath(dir).catch(() => '');
    const root = await fs.promises.realpath(this.root).catch(() => '');
    if (!real || !root || !real.startsWith(root + path.sep)) return false;
    const rel = path.relative(this.root, dir).split(path.sep).join('/');
    const { stdout } = await this.exec(['ls-files', '-s', '-z', '--', lit(rel)], { allowFailure: true });
    if (!stdout.split('\0').some((l) => l.startsWith('160000 ') && l.endsWith(`\t${rel}`))) return false;
    const dotGit = path.join(dir, '.git');
    let gst;
    try {
      gst = await fs.promises.lstat(dotGit);
    } catch {
      return false;
    }
    if (gst.isDirectory()) return true; // older layout, of a recorded submodule inside the tree
    if (!gst.isFile()) return false;
    const m = /^gitdir: (.+?)\s*$/m.exec(await fs.promises.readFile(dotGit, 'utf8').catch(() => ''));
    if (!m) return false;
    const target = await fs.promises.realpath(path.resolve(dir, m[1])).catch(() => '');
    const modules = await fs.promises.realpath(path.join(this.commonDir, 'modules')).catch(() => '');
    return !!target && !!modules && target.startsWith(modules + path.sep);
  }

  /**
   * "Subproject commit <sha>[-dirty]" for a submodule (gitlink) at a revision, in the
   * index or in the working tree — the text the built-in Git shows in diffs.
   * @returns {Promise<Buffer|null>} null when the path is not a submodule there
   */
  async submoduleText(ref, relPath) {
    let sha;
    if (ref === WORKTREE) {
      const dir = path.join(this.root, relPath);
      if (!(await this.isOwnSubmodule(dir))) return null;
      const head = await git(['rev-parse', 'HEAD'], { cwd: dir, allowFailure: true });
      if (head.exitCode !== 0) return null;
      const st = await git(['status', '--porcelain'], { cwd: dir, allowFailure: true, env: { GIT_OPTIONAL_LOCKS: '0' } });
      return Buffer.from(`Subproject commit ${head.stdout.trim()}${st.stdout.trim() ? '-dirty' : ''}\n`);
    }
    if (ref === INDEX || /^:[0-3]$/.test(ref)) {
      const { stdout } = await this.exec(['ls-files', '-s', '-z', '--', lit(relPath)], { allowFailure: true });
      const want = ref === INDEX ? '0' : ref[1];
      const m = stdout.split('\0').map((l) => /^160000 ([0-9a-f]+) (\d)\t/.exec(l)).find((x) => x && x[2] === want);
      sha = m && m[1];
    } else {
      const { stdout } = await this.exec(['ls-tree', '-z', ref, '--', lit(relPath)], { allowFailure: true });
      const m = /^160000 commit ([0-9a-f]+)\t/.exec(stdout);
      sha = m && m[1];
    }
    return sha ? Buffer.from(`Subproject commit ${sha}\n`) : null;
  }

  async showText(ref, relPath) {
    const buf = await this.show(ref, relPath);
    return buf === null ? null : buf.toString('utf8');
  }

  /** File mode in the index (or HEAD), e.g. "100644"; undefined when untracked. */
  async getIndexMode(relPath) {
    const { stdout } = await this.exec(['ls-files', '-s', '-z', '--', lit(relPath)]);
    const m = /^(\d{6}) /.exec(stdout);
    return m ? m[1] : undefined;
  }

  /**
   * Replace the staged content of a file without touching the working tree.
   * Pass `inQueue` when already running inside locked() (writes then bypass the queue).
   * Pass `asIs` when `content` is already in index form (derived from the staged blob): it is
   * stored byte for byte. Otherwise it is treated as working-tree content and goes through
   * core.autocrlf / .gitattributes conversion like `git add`.
   */
  async writeIndexContent(relPath, content, mode, opts = {}) {
    // A file of a repository nested in this one (an agent's worktree) is not ours to stage.
    if (!this.contains(this.absolute(relPath))) throw new Error(`${relPath} belongs to a repository nested in ${this.name}, not to ${this.name}.`);
    // A symlink's staged content is the path it points to: line staging would mix that with the
    // file behind it. Symlinks are staged whole (Stage), never by lines.
    const current = mode || (await this.getIndexMode(relPath));
    let isLink = current === '120000';
    try {
      isLink = isLink || fs.lstatSync(this.absolute(relPath)).isSymbolicLink();
    } catch { /* missing */ }
    if (isLink) throw new Error(`${relPath} is a symbolic link: stage it as a whole (Stage), not by lines.`);
    if (!mode) {
      mode = await this.getIndexMode(relPath);
      if (!mode) {
        try {
          const st = await fs.promises.stat(path.join(this.root, relPath));
          mode = st.mode & 0o111 ? '100755' : '100644';
        } catch {
          mode = '100644';
        }
      }
    }
    const { stdout } = await this.exec(['hash-object', '-w', '--stdin', opts.asIs ? '--no-filters' : `--path=${relPath}`], { input: content });
    const sha = stdout.trim();
    const args = ['update-index', '--add', '--cacheinfo', `${mode},${sha},${relPath}`];
    if (opts.inQueue) await this.exec(args, { writes: true });
    else await this.run(args);
  }

  // ---------------------------------------------------------------------------
  // History

  /**
   * @param {object} o
   * @param {number} [o.maxCount]
   * @param {number} [o.skip]
   * @param {string[]} [o.revs] revisions; default: all branches, remotes, tags and HEAD
   * @param {string[]} [o.paths]
   * @param {string} [o.author]
   * @param {string} [o.grep] message search (regex, case-insensitive)
   * @param {string} [o.pickaxe] -S search string
   * @param {boolean} [o.follow]
   * @param {boolean} [o.firstParent]
   * @param {boolean} [o.topo] topological ordering (graph); otherwise date order
   * @param {boolean} [o.body]
   * @param {boolean} [o.stats] add `stats` {files, added, deleted} to every commit (merges: against the first parent)
   * @param {AbortSignal} [o.signal]
   * @returns {Promise<P.Commit[]>}
   */
  async log(o = {}) {
    const framed = o.stats ? P.framedLog() : undefined;
    const args = ['log', `--format=${framed ? framed.format : o.body ? P.LOG_FORMAT_WITH_BODY : P.LOG_FORMAT}`, '--decorate=full'];
    if (o.stats) args.push('--shortstat', ...(await this.firstParentDiffArgs()));
    if (o.topo) args.push('--topo-order');
    else args.push('--date-order');
    if (o.maxCount) args.push(`--max-count=${o.maxCount}`);
    if (o.skip) args.push(`--skip=${o.skip}`);
    if (o.author) args.push(`--author=${o.author}`, '--regexp-ignore-case');
    if (o.grep) args.push(`--grep=${o.grep}`, '--regexp-ignore-case');
    // Typed search text is literal ("fix [ui]" must not be an invalid regular expression).
    if ((o.author || o.grep) && !o.regex) args.push('--fixed-strings');
    if (o.pickaxe) args.push(`-S${o.pickaxe}`);
    if (o.follow) args.push('--follow');
    if (o.firstParent) args.push('--first-parent');
    if (o.paths && o.paths.length && !o.follow) args.push('--parents'); // rewritten parents keep the graph connected
    if (o.revs && o.revs.length) {
      // Our own selectors (--branches, --remotes, --tags) are allowed; anything else must not look like an option.
      checkRevs(...o.revs.filter((r) => !/^--(branches|remotes|tags|all)$/.test(r)).map((r) => r.replace(/^\^/, '')));
      args.push(...o.revs);
    }
    else args.push('--branches', '--remotes', '--tags', 'HEAD');
    args.push('--');
    if (o.paths) args.push(...o.paths);
    const res = await this.exec(args, { signal: o.signal, allowFailure: true });
    if (res.exitCode !== 0) {
      // A repository without commits has no HEAD yet: that is an empty history, not an error.
      if (/does not have any commits|bad default revision|bad revision 'HEAD'|ambiguous argument 'HEAD'|unknown revision/.test(res.stderr)) return [];
      throw new GitError({ args, exitCode: res.exitCode, stdout: '', stderr: res.stderr, cwd: this.root });
    }
    return framed ? P.parseLogWithStats(res.stdout, framed) : P.parseLog(res.stdout, { body: o.body });
  }

  /**
   * Diff options that make `log --stat/--shortstat` describe a merge by its first-parent diff
   * without changing which commits are walked (`--diff-merges`, git 2.31+). Older git shows
   * no stats for merges.
   */
  async firstParentDiffArgs() {
    return versionAtLeast(await getVersion(), 2, 31) ? ['--diff-merges=first-parent'] : [];
  }

  /**
   * Change statistics of commits (lines added/deleted, files changed; merges against their
   * first parent), cached by SHA.
   * @param {string[]} shas full SHAs
   * @param {AbortSignal|{signal?: AbortSignal, paths?: string[]}} [opts] `paths`: count only
   *        changes to these paths (e.g. every name a file had in its history)
   * @returns {Promise<Map<string, {files:number, added:number, deleted:number}>>}
   */
  async commitStats(shas, opts = {}) {
    const o = opts instanceof AbortSignal || (opts && typeof opts.aborted === 'boolean') ? { signal: opts } : opts || {};
    const paths = o.paths && o.paths.length ? [...new Set(o.paths)].sort() : [];
    const scope = paths.length ? `\0${paths.join('\0')}` : '';
    if (!this.statsCache) this.statsCache = new Map();
    const out = new Map();
    const missing = [];
    for (const sha of new Set(shas)) {
      if (this.statsCache.has(sha + scope)) out.set(sha, this.statsCache.get(sha + scope));
      else if (/^[0-9a-f]{40,64}$/.test(sha)) missing.push(sha);
    }
    for (let i = 0; i < missing.length; i += 200) {
      const batch = missing.slice(i, i + 200);
      const framed = P.framedLog();
      const { stdout } = await this.exec(['log', '--no-walk=unsorted', `--format=${framed.format}`, '--shortstat', '-M', ...(await this.firstParentDiffArgs()), ...batch, '--', ...paths.map(lit)], { signal: o.signal });
      for (const c of P.parseLogWithStats(stdout, framed)) {
        if (!batch.includes(c.sha)) continue; // only what was asked for
        if (this.statsCache.size > 50000) this.statsCache.clear();
        this.statsCache.set(c.sha + scope, c.stats);
        out.set(c.sha, c.stats);
      }
      // With paths, git leaves out commits that did not touch them: nothing changed there.
      if (paths.length) {
        for (const sha of batch) {
          if (out.has(sha)) continue;
          const none = { files: 0, added: 0, deleted: 0 };
          this.statsCache.set(sha + scope, none);
          out.set(sha, none);
        }
      }
    }
    return out;
  }

  /** A single commit with its full message. */
  async getCommit(ref) {
    checkRevs(ref);
    const { stdout } = await this.exec(['log', '-1', `--format=${P.LOG_FORMAT_WITH_BODY}`, '--decorate=full', ref, '--']);
    const [c] = P.parseLog(stdout, { body: true });
    if (!c) throw new Error(`Commit not found: ${ref}`);
    return c;
  }

  /**
   * Files changed between two trees. `to` undefined compares `from` to the working tree;
   * to === INDEX compares `from` to the index.
   * @returns {Promise<{status:string, path:string, origPath?:string, added:number|null, deleted:number|null, binary:boolean}[]>}
   */
  async diffFiles(from, to, opts = {}) {
    from = this.tree(from);
    checkRevs(from, to);
    const base = ['diff', '-M', '--no-ext-diff', '--no-textconv'];
    let revs;
    if (to === INDEX) revs = ['--cached', from];
    else if (to === undefined) revs = [from];
    else revs = [opts.threeDot ? `${from}...${to}` : from, ...(opts.threeDot ? [] : [to])];
    const tail = ['--', ...(opts.paths || []).map(lit)];
    const [ns, num] = await Promise.all([
      this.exec([...base, '--name-status', '-z', ...revs, ...tail], { signal: opts.signal }),
      this.exec([...base, '--numstat', '-z', ...revs, ...tail], { signal: opts.signal }),
    ]);
    return mergeStats(P.parseNameStatus(ns.stdout), P.parseNumstat(num.stdout));
  }

  /**
   * Lines added and deleted per file of the uncommitted changes: `['--cached']` staged (index vs
   * HEAD), `[]` not staged (working tree vs index).
   * @returns {Promise<Map<string, {added:number|null, deleted:number|null, binary:boolean}>>}
   */
  async numstat(which) {
    const cached = which.length === 1 && which[0] === '--cached';
    const { stdout } = await this.exec(['diff', '--numstat', '-z', '-M', '--no-ext-diff', '--no-textconv', ...(cached ? ['--cached'] : []), '--']);
    return P.parseNumstat(stdout);
  }

  /** The new blob id of each file changed between two revisions (a fingerprint of its content). */
  async changedBlobIds(from, to) {
    checkRevs(from, to);
    const { stdout } = await this.exec(['diff', '--raw', '-z', '--no-abbrev', '-M', '--no-ext-diff', '--no-textconv', from, to, '--']);
    return P.parseRawBlobs(stdout);
  }

  /**
   * The patch between two trees as text, with a --stat summary first: what generated commit
   * messages and summaries describe. `to` as in diffFiles (undefined: the working tree, INDEX:
   * the index); `cwd`: another worktree of this repository (its working tree).
   */
  /**
   * @param {{cwd?: string, withUntracked?: boolean, maxBytes?: number, signal?: AbortSignal}} [opts]
   *        withUntracked (working tree only): new files git does not track yet are in the patch
   *        too, as added — through a temporary copy of the index with intent-to-add entries, so
   *        your own index is never touched. maxBytes: git's output is cut there.
   */
  async patchText(from, to, opts = {}) {
    from = this.tree(from);
    checkRevs(from, ...(to === undefined || to === INDEX ? [] : [to]));
    const revs = to === INDEX ? ['--cached', from] : to === undefined ? [from] : [from, to];
    const args = ['diff', '-M', '--no-ext-diff', '--no-textconv', '--no-color', '-U3', '--stat=120', '--stat-count=200', '--patch', ...revs, '--'];
    if (opts.cwd && !(await this.ownsWorktree(opts.cwd))) throw new Error(`${opts.cwd} is not a worktree of ${this.name}.`);
    const cwd = opts.cwd || this.root;
    const run = (a, env = {}) => git(a, { cwd, env: { GIT_OPTIONAL_LOCKS: '0', ...env }, signal: opts.signal, maxBytes: opts.maxBytes });
    if (!opts.withUntracked || to !== undefined) return (await run(args)).stdout;
    // Its own cap (not the patch's): a list cut in the middle of a name would name no file.
    const listed = await git(['ls-files', '-z', '--others', '--exclude-standard'], { cwd, env: { GIT_OPTIONAL_LOCKS: '0' }, signal: opts.signal, maxBytes: 4e6 });
    const names = listed.stdout.split('\0');
    if (listed.truncated) names.pop();
    const all = names.filter((p) => p && !p.endsWith('/')); // a repository nested there is not a file
    const untracked = all.slice(0, 2000);
    // More new files than that (or a list too long to read): say so, by count, at the top.
    const omitted = all.length - untracked.length + (listed.truncated ? 1 : 0);
    const note = omitted ? `[${omitted}${listed.truncated ? '+' : ''} more new, untracked file(s) not included]\n` : '';
    if (!untracked.length) return note + (await run(args)).stdout;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-corner-index-'));
    try {
      const tmpIndex = path.join(dir, 'index');
      const noHooks = path.join(dir, 'no-hooks');
      fs.mkdirSync(noHooks);
      const real = path.resolve(cwd, (await run(['rev-parse', '--git-path', 'index'])).stdout.trim());
      if (fs.existsSync(real)) fs.copyFileSync(real, tmpIndex);
      const env = { GIT_INDEX_FILE: tmpIndex };
      // Writing the temporary index must not run the repository's hooks (post-index-change: the
      // worktree under review can write .git/hooks) nor leave a shared index in .git.
      // (fsmonitor: a program the repository's config could name; not needed for a diff.)
      const quiet = ['-c', `core.hooksPath=${noHooks}`, '-c', 'core.splitIndex=false', '-c', 'core.fsmonitor=false'];
      // On stdin (any number, any length: Windows allows 32 KB of command line). Files an agent
      // removed meanwhile are left out (git refuses a pathspec that matches nothing): looked
      // at once more right before, and once more if git still finds one gone.
      const present = () => untracked.filter((p) => {
        try {
          fs.lstatSync(path.join(cwd, ...p.split('/')));
          return true;
        } catch {
          return false;
        }
      });
      const addAll = (list) => git([...quiet, 'add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd, env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, signal: opts.signal, allowFailure: true, input: `${list.map(lit).join('\0')}\0` });
      let added = await addAll(present());
      if (added.exitCode !== 0) added = await addAll(present());
      if (added.exitCode !== 0) throw new GitError({ args: ['add', '--intent-to-add'], exitCode: added.exitCode, stdout: added.stdout, stderr: added.stderr });
      return note + (await run([...quiet, ...args], env)).stdout;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** One commit as text: author, message, --stat and patch (first parent for merges). */
  async commitPatchText(sha, opts = {}) {
    checkRevs(sha);
    const { stdout } = await this.exec(['show', '--format=commit %H%nAuthor: %an%nDate: %ad%n%n%B', '--date=short', '-M', ...(await this.firstParentDiffArgs()), '--no-ext-diff', '--no-textconv', '--no-color', '-U3', '--stat=120', '--stat-count=200', '--patch', sha, '--'], { signal: opts.signal, maxBytes: opts.maxBytes });
    return stdout;
  }

  /**
   * Fingerprints of files in another worktree (their current content, `git hash-object`), for
   * "viewed" marks; files that are not there (deleted) or not regular files are left out.
   * @returns {Promise<Map<string, string>>}
   */
  async worktreeFileIds(worktreePath, paths) {
    if (!(await this.ownsWorktree(worktreePath))) throw new Error(`${worktreePath} is not a worktree of ${this.name}.`);
    // Fingerprints by path, size, mtime and inode: an unchanged file is not hashed again (the
    // Worktrees view asks every 10 seconds).
    const cache = this.fileIdCache || (this.fileIdCache = new Map());
    // Bounded, oldest first out (a clear would hash every file of a big worktree on each poll).
    if (cache.size > 60000) for (const k of [...cache.keys()].slice(0, cache.size - 50000)) cache.delete(k);
    const out = new Map();
    const todo = [];
    for (const p of paths) {
      if (p.endsWith('/') || p.includes('\n')) continue;
      let st;
      try {
        st = fs.lstatSync(path.join(worktreePath, ...p.split('/')));
      } catch {
        continue; // deleted
      }
      if (!st.isFile()) continue;
      // ctime too: a rewrite with the old mtime put back (touch -r, cp -p) still changes it.
      const key = `${worktreePath}\0${p}\0${st.size}\0${st.mtimeMs}\0${st.ctimeMs}\0${st.ino}`;
      if (cache.has(key)) {
        const id = cache.get(key);
        cache.delete(key); // used again: last out
        cache.set(key, id);
        out.set(p, id);
      } else todo.push({ p, key });
    }
    // hash-object --stdin-paths reads C-quoted lines: a name starting with " goes on its own.
    const quotedLike = todo.filter((t) => t.p.startsWith('"'));
    todo.splice(0, todo.length, ...todo.filter((t) => !t.p.startsWith('"')));
    for (const t of quotedLike) {
      const r = await git(['hash-object', '--no-filters', '--', t.p], { cwd: worktreePath, env: { GIT_OPTIONAL_LOCKS: '0' }, allowFailure: true });
      const id = r.stdout.trim();
      if (r.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(id)) {
        cache.set(t.key, id);
        out.set(t.p, id);
      }
    }
    const hash = async (list) => {
      // Paths on stdin (never options); --no-filters: the bytes as they are, a fingerprint only.
      const { stdout } = await git(['hash-object', '--no-filters', '--stdin-paths'], { cwd: worktreePath, input: `${list.map((t) => t.p).join('\n')}\n`, env: { GIT_OPTIONAL_LOCKS: '0' } });
      const ids = stdout.trim().split('\n');
      list.forEach((t, k) => {
        if (!/^[0-9a-f]{40,64}$/.test(ids[k] || '')) return;
        cache.set(t.key, ids[k]);
        out.set(t.p, ids[k]);
      });
    };
    if (todo.length) {
      try {
        await hash(todo);
      } catch {
        // A file went away (or became unreadable) meanwhile: one by one, skipping those.
        for (const t of todo) await hash([t]).catch(() => {});
      }
    }
    return out;
  }


  /** Files changed by a commit relative to its first parent (or the empty tree for root commits). */
  async getCommitFiles(sha) {
    checkRevs(sha);
    const commit = await this.getCommit(sha);
    const parent = commit.parents[0] || this.emptyTree;
    const files = await this.diffFiles(parent, sha);
    return { commit, parent: commit.parents[0] || null, files };
  }

  /**
   * Combined changes of several (possibly non-adjacent) commits.
   *
   * Exact mode (default): the selected commits' own patches are replayed,
   * oldest first, into a temporary index on top of the oldest commit's
   * parent; the result is diffed against that parent. Edits from unselected
   * commits in between are NOT included. When a patch does not apply
   * (it depends on an unselected commit), falls back to the per-file
   * approximation of multiCommit.js and reports `exact: false` and `failed`.
   *
   * Files carry beforeRef/afterRef usable with show(): afterRef is the
   * synthetic tree's SHA in exact mode.
   * @param {string[]} shas any order
   * @param {{signal?: AbortSignal}} [opts] abort to stop a computation nobody waits for any more
   */
  async getMultiCommitChanges(shas, opts = {}) {
    checkRevs(...shas);
    const signal = opts.signal;
    const ordered = await this.sortTopologically(shas, signal);
    // -m --first-parent: merges are diffed against their first parent, like everywhere else.
    const framed = P.framedLog();
    const { stdout } = await this.exec(['log', '--no-walk=unsorted', `--format=${framed.format}`, '--decorate=full', '-M', '-m', '--first-parent', '--name-status', '-z', ...ordered, '--'], { signal });
    const byFull = new Map();
    for (const { commit, tail } of framed.split(stdout)) {
      byFull.set(commit.sha, { commit, changes: P.parseNameStatus(tail.replace(/^[\n\0]+/, '')) });
    }
    const full = await this.revParseMany(ordered);
    const commits = [];
    ordered.forEach((sha, i) => {
      const entry = byFull.get(full[i]);
      if (!entry) return;
      commits.push({ sha: entry.commit.sha, parent: entry.commit.parents[0] || null, commit: entry.commit, changes: entry.changes });
    });
    const replay = await this.replayCommits(commits, signal);
    if (!replay.tree) {
      return { commits, files: combineCommitChanges(commits), exact: false, failed: replay.failed, approximate: [] };
    }
    const touched = new Map();
    for (const c of commits) for (const ch of c.changes) for (const p of [ch.path, ch.origPath].filter(Boolean)) {
      if (!touched.has(p)) touched.set(p, []);
      touched.get(p).push(c.sha);
    }
    // Files whose patches only apply with unselected commits: those (and only those) approximate.
    const approx = new Set(replay.failedPaths || []);
    const exactFiles = (await this.diffFiles(replay.base, replay.tree, { signal })).filter((f) => !approx.has(f.path) && !approx.has(f.origPath));
    const approxFiles = approx.size ? combineCommitChanges(commits).filter((f) => approx.has(f.path) || approx.has(f.beforePath) || approx.has(f.afterPath)) : [];
    const files = exactFiles.map((f) => ({
      status: f.status,
      path: f.path,
      origPath: f.origPath,
      beforeRef: f.status === 'A' ? null : replay.base,
      beforePath: f.origPath || f.path,
      afterRef: f.status === 'D' ? null : replay.tree,
      afterPath: f.path,
      added: f.added,
      deleted: f.deleted,
      commits: touched.get(f.path) || touched.get(f.origPath) || [],
    })).concat(approxFiles.map((f) => ({ ...f, approximate: true })));
    return { commits, files, exact: !approx.size, failed: replay.failed, approximate: [...approx], base: replay.base, tree: replay.tree };
  }

  /**
   * Apply the given commits' first-parent patches (oldest first) to a
   * temporary index starting at the first commit's parent. A selection that is
   * one unbroken first-parent chain needs no replay: its result is the newest
   * commit's tree.
   * @param {AbortSignal} [signal]
   * @returns {Promise<{base:string, tree?:string, failed:string[]}>}
   */
  async replayCommits(commits, signal) {
    const base = (commits[0] && commits[0].parent) || this.emptyTree;
    if (commits.length && commits.every((c, i) => i === 0 || c.parent === commits[i - 1].sha)) {
      const tree = await this.revParse(`${commits[commits.length - 1].sha}^{tree}`);
      if (tree) return { base, tree, failed: [] };
    }
    const tmpIndex = this.tempIndexPath('combine');
    const env = { GIT_INDEX_FILE: tmpIndex };
    const failed = [];
    const failedPaths = new Set();
    try {
      // Plumbing on a private index file: no locks on the real index, safe outside the write queue.
      await this.exec(base === this.emptyTree ? ['read-tree', '--empty'] : ['read-tree', base], { env, writes: true, signal });
      for (const c of commits) {
        if (signal && signal.aborted) throw new GitError({ args: ['diff-tree'], exitCode: null, stdout: '', stderr: 'Cancelled' });
        // diff-tree (plumbing): no textconv, external diff, prefix or context settings from the user's config.
        // -M: a rename must stay a rename, or its patch carries the whole old content and fails to
        // apply when an unselected commit edited the file before.
        const { stdout: patch } = await this.exec(['diff-tree', '-p', '-M', '--binary', '--full-index', '--no-textconv', '--no-ext-diff', '--no-color', '-U3', c.parent || this.emptyTree, c.sha, '--'], { signal });
        if (!patch.trim()) continue;
        // A failed (three-way) apply leaves conflict stages in the index: each attempt starts from a
        // copy of the index and puts it back when it fails.
        const apply = async (text) => {
          await fs.promises.copyFile(tmpIndex, `${tmpIndex}.before`);
          const ok = await applyOnce(text);
          if (!ok) await fs.promises.copyFile(`${tmpIndex}.before`, tmpIndex);
          return ok;
        };
        const applyOnce = async (text) => {
          let res = await this.exec(['apply', '--cached', '--whitespace=nowarn'], { env, input: text, allowFailure: true, writes: true, signal });
          // Context drifted because of unselected commits: a three-way apply is a per-file cherry-pick.
          // --3way with --cached: git 2.32+ (older git: straight to the approximate fallback).
          if (res.exitCode !== 0 && versionAtLeast(await getVersion(), 2, 32)) res = await this.exec(['apply', '--cached', '--3way', '--whitespace=nowarn'], { env, input: text, allowFailure: true, writes: true, signal });
          return res.exitCode === 0;
        };
        // Whole, while nothing failed; else file by file: a file that does not apply (it needs an
        // unselected commit) is left to the approximation, every other file stays exact.
        if (!failedPaths.size && (await apply(patch))) continue;
        let commitFailed = false;
        for (const sec of patch.split(/\n(?=diff --git )/).filter((x) => x.startsWith('diff --git '))) {
          const paths = patchPaths(sec);
          if (paths.some((x) => failedPaths.has(x))) {
            commitFailed = true;
            continue;
          }
          if (!(await apply(sec.endsWith('\n') ? sec : `${sec}\n`))) {
            for (const x of paths) failedPaths.add(x);
            commitFailed = true;
          }
        }
        if (commitFailed) failed.push(c.sha);
      }
      const { stdout } = await this.exec(['write-tree'], { env, writes: true, signal });
      return { base, tree: stdout.trim(), failed, failedPaths: [...failedPaths] };
    } finally {
      fs.promises.rm(tmpIndex, { force: true }).catch(() => {});
      fs.promises.rm(`${tmpIndex}.before`, { force: true }).catch(() => {});
    }
  }

  /** Order shas oldest first (parents before children). */
  async sortTopologically(shas, signal) {
    checkRevs(...shas);
    const unique = [...new Set(shas)];
    if (unique.length < 2) return unique;
    // Walk only the region spanned by the selection: everything after their common ancestor
    // (merge-base takes its arguments on the command line: only for a moderate selection).
    const exclude = [];
    if (unique.length <= 200) {
      const mb = await this.exec(['merge-base', '--octopus', ...unique], { allowFailure: true, signal });
      if (mb.exitCode === 0 && mb.stdout.trim()) exclude.push(`^${mb.stdout.trim()}^@`); // (no --not on stdin before git 2.42)
    }
    // Revisions on stdin: a thousand selected commits exceed Windows' command line.
    const { stdout } = await this.exec(['rev-list', '--topo-order', '--reverse', '--stdin'], { signal, input: `${[...unique, ...exclude].join('\n')}\n` });
    const rank = new Map(stdout.split('\n').filter(Boolean).map((s, i) => [s, i]));
    const full = await this.revParseMany(unique);
    const order = unique.map((s, i) => ({ s, r: rank.has(full[i]) ? rank.get(full[i]) : -1 }));
    order.sort((a, b) => a.r - b.r);
    return order.map((o) => o.s);
  }

  /** Resolve many revisions to full commit SHAs in one process (order preserved). */
  async revParseMany(revs) {
    checkRevs(...revs);
    if (!revs.length) return [];
    // On stdin (any number): "<sha>" per line, or "<rev>^{commit} missing".
    const { stdout } = await this.exec(['cat-file', '--batch-check=%(objectname)'], { input: `${revs.map((r) => `${r}^{commit}`).join('\n')}\n` });
    const out = stdout.split('\n').slice(0, revs.length);
    const bad = out.findIndex((l) => !/^[0-9a-f]{40,64}$/.test(l));
    if (bad >= 0) throw new GitError({ args: ['cat-file', '--batch-check'], exitCode: 128, stdout: '', stderr: `fatal: bad revision '${revs[bad]}'` });
    return out;
  }

  async revParse(ref) {
    checkRevs(ref);
    const { stdout } = await this.exec(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true });
    return stdout.trim() || undefined;
  }

  async mergeBase(a, b) {
    checkRevs(a, b);
    const { stdout, exitCode } = await this.exec(['merge-base', a, b], { allowFailure: true });
    return exitCode === 0 ? stdout.trim() : undefined;
  }

  async isAncestor(ancestor, descendant) {
    checkRevs(ancestor, descendant);
    const { exitCode } = await this.exec(['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true });
    return exitCode === 0;
  }

  /** Commits reachable from `right` but not `left` and vice versa. */
  async aheadBehind(left, right) {
    checkRevs(left, right);
    const { stdout } = await this.exec(['rev-list', '--left-right', '--count', `${left}...${right}`]);
    const [behind, ahead] = stdout.trim().split(/\s+/).map(Number);
    return { ahead, behind };
  }

  /**
   * History of one file, following renames. Each commit carries the file's
   * change in that commit (status/path/origPath), so callers know the path
   * the file had at every point in time.
   */
  async fileHistory(relPath, opts = {}) {
    checkRevs(opts.ref);
    const framed = P.framedLog();
    const args = ['log', `--format=${framed.format}`, '--decorate=full', '--follow', '-M', '--name-status', '-z'];
    if (opts.maxCount) args.push(`--max-count=${opts.maxCount}`);
    // allBranches: the file's history on every local and remote branch, not just HEAD's.
    if (opts.allBranches) args.push('--branches', '--remotes', '--tags', 'HEAD');
    else args.push(opts.ref || 'HEAD');
    args.push('--', lit(relPath));
    // Lines changed in this file per commit: a second walk with the same revisions (the
    // name-status walk cannot also print stats).
    const statArgs = ['log', '--format=%x1e%H', '--follow', '-M', '--shortstat', ...(await this.firstParentDiffArgs()), ...args.slice(args.indexOf('-z') + 1)];
    const [res, statRes] = await Promise.all([
      this.exec(args, { allowFailure: true }),
      opts.stats ? this.exec(statArgs, { allowFailure: true }) : undefined,
    ]);
    const statsBySha = new Map();
    if (statRes) {
      for (const chunk of statRes.stdout.split(P.RS)) {
        const nl = chunk.indexOf('\n');
        if (nl > 0) statsBySha.set(chunk.slice(0, nl).trim(), P.parseShortstat(chunk.slice(nl)));
      }
    }
    const out = [];
    // Newest first: the path an older commit has is the one the next newer entry came from.
    let olderPath = relPath;
    for (const { commit, tail } of framed.split(res.stdout)) {
      const [change] = P.parseNameStatus(tail.replace(/^[\n\0]+/, ''));
      // Merges list no files with --follow: the file kept the path it had at that point.
      commit.change = change || { status: 'M', path: olderPath };
      olderPath = commit.change.origPath || commit.change.path;
      if (statsBySha.has(commit.sha)) commit.stats = statsBySha.get(commit.sha);
      out.push(commit);
    }
    return out;
  }

  /** Commits that touched a line range (git log -L). Lines are 1-based inclusive. */
  async lineHistory(relPath, startLine, endLine, opts = {}) {
    checkRevs(opts.ref);
    const framed = P.framedLog();
    const args = ['log', `--format=${framed.format}`, '--decorate=full', `-L${startLine},${endLine}:${relPath}`];
    if (opts.maxCount) args.push(`--max-count=${opts.maxCount}`);
    args.push(opts.ref || 'HEAD', '--');
    const { stdout } = await this.exec(args, { maxBytes: 20 * 1024 * 1024, signal: opts.signal });
    // Each record carries the patch; take the file's path in that commit from it (renames).
    return P.parseLineLog(stdout, framed).map((c) => ({ ...c, change: { status: c.patchPath && c.patchOldPath === '/dev/null' ? 'A' : 'M', path: c.patchPath || relPath, origPath: c.patchOldPath && c.patchOldPath !== '/dev/null' && c.patchOldPath !== c.patchPath ? c.patchOldPath : undefined } }));
  }

  /** Blame a file. `contents` (string) blames unsaved editor text instead of the file on disk. */
  async blame(relPath, contents, opts = {}) {
    const args = ['blame', '--incremental', '-M'];
    if (opts.detectCopies) args.push('-C'); // follows lines moved between files; noticeably slower
    if (opts.ignoreWhitespace) args.push('-w');
    if (contents !== undefined) args.push('--contents', '-');
    checkRevs(opts.rev);
    if (opts.rev) args.push(opts.rev);
    args.push('--', relPath);
    const { stdout } = await this.exec(args, { input: contents, signal: opts.signal });
    return P.parseBlameIncremental(stdout);
  }

  async reflog(maxCount = 200) {
    const { stdout } = await this.exec(['reflog', `--max-count=${maxCount}`, `--format=%H${'%x1f'}%gd${'%x1f'}%gs${'%x1f'}%ct`], { allowFailure: true });
    return P.parseReflog(stdout);
  }

  // ---------------------------------------------------------------------------
  // Refs

  async getRefs() {
    const { stdout } = await this.exec(['for-each-ref', `--format=${P.REF_FORMAT}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes', 'refs/tags']);
    return P.parseRefs(stdout);
  }

  /** A remote's default branch from refs/remotes/<remote>/HEAD (set by clone or `remote set-head`), else main/master if present. */
  async remoteDefaultBranch(remote) {
    checkRemotes(remote);
    const res = await this.exec(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], { allowFailure: true });
    const short = res.stdout.trim();
    if (res.exitCode === 0 && short.startsWith(`${remote}/`)) return short.slice(remote.length + 1);
    for (const name of ['main', 'master']) {
      const r = await this.exec(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${name}`], { allowFailure: true });
      if (r.exitCode === 0) return name;
    }
    return undefined;
  }

  /**
   * What happened on all local and remote branches in the last `days` days (merges left out).
   * @returns {Promise<{days:number, commits:number, authors:number, added:number, deleted:number}>}
   */
  async activitySummary(days) {
    // Cached until a ref moves (or a minute passes, as "7 days ago" moves too): the sidebar asks
    // on every reload, and a week of --shortstat is not free on big repositories.
    const tips = this.refTips !== undefined ? this.refTips : await this.getRefTips();
    const key = `${days}|${tips}|${Math.floor(Date.now() / 60000)}`;
    if (this.summaryCache && this.summaryCache.key === key) return this.summaryCache.value;
    const { stdout } = await this.exec(['log', `--since=${Number(days)}.days.ago`, '--max-count=5000', '--branches', '--remotes', '--no-merges', '--format=%x00%aE', '--shortstat'], { allowFailure: true });
    const out = { days, commits: 0, authors: 0, added: 0, deleted: 0 };
    const authors = new Set();
    for (const chunk of stdout.split('\0')) {
      const nl = chunk.indexOf('\n');
      const email = (nl < 0 ? chunk : chunk.slice(0, nl)).trim().toLowerCase();
      if (!email) continue;
      out.commits++;
      authors.add(email);
      const st = P.parseShortstat(chunk.slice(nl + 1));
      out.added += st.added;
      out.deleted += st.deleted;
    }
    out.authors = authors.size;
    this.summaryCache = { key, value: out };
    return out;
  }

  /**
   * Repository activity over the last `days` days: commits (merges left out), people, lines,
   * busiest files, merged pull requests, active branches and new tags.
   * @param {{days: number, revs?: string[], maxCommits?: number}} o revs default: all local and remote branches
   */
  async activity(o) {
    const days = Math.max(1, Math.round(Number(o.days) || 7));
    const since = `--since=${days}.days.ago`;
    const revs = o.revs && o.revs.length ? o.revs : ['--branches', '--remotes'];
    checkRevs(...revs.filter((r) => !/^--(branches|remotes|tags|all)$/.test(r)));
    const max = o.maxCommits || 5000;
    const F = '%x1f';
    const [log, merges, refs] = await Promise.all([
      // Committer dates throughout: --since selects by them, so the chart and lists use them too.
      // Records start with NUL (never part of commit data); numstat lines follow the header.
      this.exec(['log', since, `--max-count=${max}`, '--no-merges', '--no-renames', `--format=%x00%H${F}%aN${F}%aE${F}%ct${F}%s`, '--numstat', ...revs, '--'], { allowFailure: true }),
      this.exec(['log', since, '--merges', '--max-count=500', `--format=%H${F}%aN${F}%aE${F}%ct${F}%s%x00`, ...revs, '--'], { allowFailure: true }),
      // for-each-ref spells hex escapes %1f (log uses %x1f). git's fields first, then the text
      // a commit's author chose (it may contain our separator: it can only garble itself).
      this.exec(['for-each-ref', '--sort=-committerdate', `--format=${['%(refname)', '%(committerdate:unix)', '%(objecttype)', '%(creatordate:unix)', '%(authorname)', '%(authoremail)', '%(subject)'].join('%1f')}`, 'refs/heads', 'refs/remotes', 'refs/tags'], { allowFailure: true }),
    ]);
    const cutoff = Date.now() - days * 864e5;
    const commits = [];
    const files = new Map();
    for (const rec of log.stdout.split('\0')) {
      const nl = rec.indexOf('\n');
      const head = (nl < 0 ? rec : rec.slice(0, nl)).split('\x1f');
      if (head.length < 5 || !P.HEX_SHA.test(head[0]) || !/^\d+$/.test(head[3])) continue;
      const c = { sha: head[0], author: P.oneLine(head[1]), email: P.oneLine(head[2]).toLowerCase(), date: Number(head[3]) * 1000, subject: P.oneLine(head.slice(4).join(' ')), added: 0, deleted: 0, files: 0 };
      for (const line of (nl < 0 ? '' : rec.slice(nl + 1)).split('\n')) {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
        if (!m) continue;
        const add = m[1] === '-' ? 0 : Number(m[1]);
        const del = m[2] === '-' ? 0 : Number(m[2]);
        c.added += add;
        c.deleted += del;
        c.files++;
        const name = P.unquoteC(m[3]); // "tab\\there.txt" (quoted) -> the real name
        const f = files.get(name) || { path: name, commits: 0, added: 0, deleted: 0 };
        f.commits++;
        f.added += add;
        f.deleted += del;
        files.set(name, f);
      }
      commits.push(c);
    }
    const people = new Map();
    for (const c of commits) {
      const p = people.get(c.email) || { name: c.author, email: c.email, commits: 0, added: 0, deleted: 0, last: 0 };
      p.commits++;
      p.added += c.added;
      p.deleted += c.deleted;
      p.last = Math.max(p.last, c.date);
      people.set(c.email, p);
    }
    // Merged pull requests: GitHub merge commits, or squash merges ending in "(#123)".
    const pulls = new Map();
    for (const line of merges.stdout.split('\0')) {
      const f = line.replace(/^\n+/, '').split('\x1f');
      if (f.length < 5 || !P.HEX_SHA.test(f[0]) || !/^\d+$/.test(f[3])) continue;
      const m = /^Merge pull request #(\d+) from (\S+)/.exec(P.oneLine(f.slice(4).join(' ')));
      if (m) pulls.set(Number(m[1]), { number: Number(m[1]), sha: f[0], title: m[2], author: f[1], email: f[2].toLowerCase(), date: Number(f[3]) * 1000 });
    }
    for (const c of commits) {
      const m = /\(#(\d+)\)\s*$/.exec(c.subject);
      if (m && !pulls.has(Number(m[1]))) pulls.set(Number(m[1]), { number: Number(m[1]), sha: c.sha, title: c.subject.replace(/\s*\(#\d+\)\s*$/, ''), author: c.author, email: c.email, date: c.date });
    }
    const branches = [];
    const tags = [];
    for (const line of refs.stdout.split('\n')) {
      const f = line.split('\x1f');
      if (f.length < 7) continue;
      const ref = P.refFromFullName(f[0]);
      if (ref.type === 'remote' && ref.name.endsWith('/HEAD')) continue;
      const date = Number(ref.type === 'tag' ? f[3] || f[1] : f[1]) * 1000;
      if (!(date >= cutoff)) continue;
      const item = { name: ref.name, rev: ref.rev, type: ref.type, date, author: P.oneLine(f[4]), email: P.oneLine(f[5]).replace(/[<>]/g, '').toLowerCase(), subject: P.oneLine(f.slice(6).join(' ')) };
      if (ref.type === 'tag') tags.push(item);
      else branches.push(item);
    }
    return {
      days,
      since: cutoff,
      truncated: commits.length >= max,
      commits: commits.map(({ sha, author, email, date, subject, added, deleted, files: n }) => ({ sha, author, email, date, subject, added, deleted, files: n })),
      people: [...people.values()].sort((a, b) => b.commits - a.commits || b.added + b.deleted - (a.added + a.deleted)),
      files: [...files.values()].sort((a, b) => b.commits - a.commits || b.added + b.deleted - (a.added + a.deleted)).slice(0, 15),
      pulls: [...pulls.values()].sort((a, b) => b.date - a.date).slice(0, 30),
      branches: branches.slice(0, 20),
      tags: tags.slice(0, 20),
    };
  }

  /** Names of local and remote branches, newest first: cheap (no ahead/behind counting). */
  async getBranchNames() {
    const { stdout } = await this.exec(['for-each-ref', '--format=%(refname)', '--sort=-committerdate', 'refs/heads', 'refs/remotes']);
    return stdout.split('\n').filter((l) => l && !(l.startsWith('refs/remotes/') && l.endsWith('/HEAD'))).map((l) => P.refFromFullName(l).name);
  }

  async getBranches() {
    return (await this.getRefs()).filter((r) => r.type === 'branch');
  }

  async getRemotes() {
    const { stdout } = await this.exec(['remote', '-v']);
    return P.parseRemotes(stdout);
  }

  /** The default branch of a remote (e.g. "origin/main") without network access. */
  async getDefaultBranch(remote = 'origin') {
    checkRemotes(remote);
    const { stdout, exitCode } = await this.exec(['symbolic-ref', '--short', '-q', `refs/remotes/${remote}/HEAD`], { allowFailure: true });
    if (exitCode === 0 && stdout.trim()) return stdout.trim();
    for (const candidate of [`${remote}/main`, `${remote}/master`, `${remote}/develop`, 'main', 'master']) {
      if (await this.revParse(candidate)) return candidate;
    }
    return undefined;
  }

  async getConfig(key) {
    const { stdout, exitCode } = await this.exec(['config', '--get', key], { allowFailure: true });
    return exitCode === 0 ? stdout.trim() : undefined;
  }

  // ---------------------------------------------------------------------------
  // Staging

  /**
   * Run a path-taking command. Long path lists go through stdin
   * (--pathspec-from-file) instead of the command line, which would hit the
   * OS argument limit (E2BIG) and is quadratic in git for many pathspecs.
   */
  runWithPaths(args, paths, opts = {}) {
    if (tooLongForCommandLine(paths)) {
      return this.run([...args, '--pathspec-from-file=-', '--pathspec-file-nul'], { ...opts, input: paths.map(lit).join('\0') + '\0' });
    }
    return this.run([...args, '--', ...paths.map(lit)], opts);
  }

  /** runWithPaths() for use inside locked(): runs directly instead of queueing. */
  execWithPaths(args, paths, opts = {}) {
    if (tooLongForCommandLine(paths)) {
      return this.exec([...args, '--pathspec-from-file=-', '--pathspec-file-nul'], { ...opts, writes: true, input: paths.map(lit).join('\0') + '\0' });
    }
    return this.exec([...args, '--', ...paths.map(lit)], { ...opts, writes: true });
  }

  async stage(paths) {
    // Nested repositories are not staged (they would become submodules).
    const nested = this.nestedRepositories();
    paths = paths.filter((p) => !nested.includes(p) && !nested.includes(`${p}/`));
    // A folder ("dir/" in "normal" untracked mode) may hold a repository created since the last
    // status (an agent's new worktree): look now, and add it file by file without that.
    const out = [];
    for (const p of paths) {
      const abs = path.join(this.root, ...p.replace(/\/$/, '').split('/'));
      let dir = false;
      try {
        const st = fs.lstatSync(abs);
        dir = st.isDirectory() && !st.isSymbolicLink();
      } catch { /* deleted: staged as a deletion */ }
      if (dir && abs !== this.root && fs.existsSync(path.join(abs, '.git'))) {
        // A repository itself: staged only when it is a submodule (a gitlink in the index).
        const { stdout } = await this.exec(['ls-files', '--stage', '--', lit(p.replace(/\/$/, ''))], { env: { GIT_OPTIONAL_LOCKS: '0' } });
        if (/^160000 /m.test(stdout)) out.push(p);
        continue;
      }
      if (!dir || holdsRepository(abs) === false) {
        out.push(p);
        continue;
      }
      const { stdout } = await this.exec(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', lit(p)], { env: { GIT_OPTIONAL_LOCKS: '0' } });
      for (const e of P.parseStatus(stdout).entries) {
        if (e.kind === 'ignored') continue;
        if (e.path.endsWith('/') && fs.existsSync(path.join(this.root, e.path, '.git'))) continue;
        out.push(e.path);
        if (e.origPath) out.push(e.origPath);
      }
    }
    // An empty list must never become "git add -A" (everything).
    if (!out.length) return undefined;
    return this.runWithPaths(['add', '-A'], out);
  }

  /** Stage every change to tracked files (the whole "Changes" group). */
  async stageTracked() {
    const s = await this.refreshState();
    // `add -u` would also mark conflicted files resolved, markers and all: stage the
    // ordinary changes only and leave conflicts for an explicit decision.
    if (s.conflicts.length) return this.stage(s.unstaged.map((e) => e.path));
    return this.run(['add', '-u']);
  }

  async unstage(paths) {
    if (!paths.length) return undefined;
    if (!(this.state && this.state.head.sha) && !(await this.revParse('HEAD'))) {
      return this.runWithPaths(['rm', '--cached', '-r', '-q'], paths);
    }
    return this.runWithPaths(['reset', '-q', 'HEAD'], paths);
  }

  async stageAll() {
    const s = await this.refreshState({ fresh: true });
    // A repository inside the working tree (an agent's worktree, a cloned dependency) is not a
    // file to stage: `add -A` would record it as a submodule.
    const nested = this.nestedRepositories(s);
    const untracked = s.untracked.map((e) => e.path);
    if (s.conflicts.length) return this.stage([...s.unstaged.map((e) => e.path), ...untracked]);
    return this.run(['add', '-A', '--', '.', ...nested.map((p) => `:(exclude,literal)${p.replace(/\/$/, '')}`)]);
  }

  /** Repositories nested in the working tree ("dir/" with a .git), as status found them. */
  nestedRepositories(state = this.state) {
    return (state && state.nested) || [];
  }

  /** A fresh, unique path for a temporary index file inside the git dir. */
  tempIndexPath(kind) {
    return path.join(this.gitDir, `commit-corner-${kind}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  }

  /**
   * Commit exactly what is staged for `paths` (not their working-tree content,
   * unlike `commit --only`), leaving every other staged change staged.
   * Works through a temporary index: HEAD + the staged entries of `paths`.
   * Hooks, signing and commit templates behave as for a normal commit.
   */
  commitStagedPaths(message, paths, opts = {}) {
    // One queue entry for the whole sequence: a stage queued while a slow pre-commit hook runs
    // must not land between the commit and the final reset (which would undo it).
    return this.locked(() => this.commitStagedPathsLocked(message, paths, opts));
  }

  async commitStagedPathsLocked(message, paths, opts) {
    const fromWorktree = new Set(opts.workingTreePaths || []);
    const tmpIndex = this.tempIndexPath('index');
    const env = { GIT_INDEX_FILE: tmpIndex };
    const write = (args, o = {}) => this.exec(args, { ...o, writes: true });
    try {
      if (await this.revParse('HEAD')) await write(['read-tree', 'HEAD'], { env });
      else await write(['read-tree', '--empty'], { env });
      // ls-files has no --pathspec-from-file: with very many paths, list the whole index and
      // keep the wanted ones (the command line would be too long).
      const many = tooLongForCommandLine(paths);
      const wanted = new Set(paths);
      const { stdout } = await this.exec(['ls-files', '-s', '-z', ...(many ? [] : ['--', ...paths.map(lit)])]);
      const staged = new Map();
      for (const rec of stdout.split('\0').filter(Boolean)) {
        const m = /^(\d{6}) ([0-9a-f]+) (\d)\t(.*)$/s.exec(rec);
        if (m && m[3] === '0' && (!many || wanted.has(m[4]))) staged.set(m[4], `${m[1]} ${m[2]} 0\t${m[4]}`);
      }
      const present = [];
      for (const p of fromWorktree) {
        if (lexists(this.absolute(p))) present.push(p); // a dangling symlink still exists
        else staged.delete(p);
      }
      // Paths not in the real index were deleted there: remove them (mode 0) from the commit too.
      // The null id has the repository's hash length (40 for SHA-1, 64 for SHA-256).
      const zero = '0'.repeat(((await this.revParse('HEAD')) || '').length === 64 ? 64 : 40);
      const info = paths.map((p) => staged.get(p) || `0 ${zero} 0\t${p}`);
      await write(['update-index', '-z', '--index-info'], { env, input: info.join('\0') + '\0' });
      // Files picked from "Changes"/"Untracked" are committed with their working-tree content. `git add`
      // into the temporary index gets symlinks, submodules, modes and line-ending filters right.
      if (present.length) await this.execWithPaths(['add', '-A'], present, { env });
      const result = await write(['commit', '--quiet', '--cleanup=whitespace', '-F', '-'], { env, input: message });
      // The real index must now match the new HEAD for these paths: also when a pre-commit hook
      // re-staged (reformatted) them in the temporary index, or when their content came from the
      // working tree. Other staged changes are untouched.
      await this.execWithPaths(['reset', '-q', 'HEAD'], paths);
      return result;
    } finally {
      fs.promises.rm(tmpIndex, { force: true }).catch(() => {});
      fs.promises.rm(`${tmpIndex}.lock`, { force: true }).catch(() => {});
    }
  }

  async unstageAll() {
    if (!(await this.revParse('HEAD'))) return this.run(['rm', '--cached', '-r', '-q', '.']);
    return this.run(['reset', '-q']);
  }

  /**
   * Restore tracked files in the working tree from the index. Files only marked for adding
   * (`git add -N`: their index entry is empty) are left alone — checkout would empty them
   * for good — and returned, for the caller to treat like untracked files.
   * @returns {Promise<string[]>} the intent-to-add paths that were skipped
   */
  async discard(paths) {
    if (!paths.length) return [];
    const ita = await this.intentToAdd(paths);
    const rest = paths.filter((p) => !ita.includes(p));
    if (rest.length) await this.runWithPaths(['checkout', '-q'], rest);
    return ita;
  }

  /** Which of `paths` are intent-to-add entries (added with -N, content not staged). */
  async intentToAdd(paths) {
    const state = this.state || (await this.refreshState());
    const wanted = new Set(paths);
    return state.unstaged.filter((e) => e.x === '.' && e.y === 'A' && wanted.has(e.path)).map((e) => e.path);
  }

  /** Drop intent-to-add entries from the index (the files stay, untracked). */
  forgetIntentToAdd(paths) {
    if (!paths.length) return Promise.resolve();
    return this.runWithPaths(['rm', '--cached', '-q'], paths);
  }

  /**
   * Resolve a conflict by taking one side, then stage it. When the chosen
   * side deleted the file (modify/delete conflicts), the resolution is the
   * deletion.
   */
  async resolveWith(relPath, side) {
    const { stdout } = await this.exec(['ls-files', '-u', '-z', '--', lit(relPath)]);
    const stages = new Set(stdout.split('\0').filter(Boolean).map((l) => /^\d+ [0-9a-f]+ (\d)\t/.exec(l)).filter(Boolean).map((m) => m[1]));
    const stage = side === 'ours' ? '2' : '3';
    if (!stages.has(stage)) {
      await this.run(['rm', '-q', '--', lit(relPath)]);
      return;
    }
    await this.run(['checkout', `--${side}`, '--', lit(relPath)]);
    await this.stage([relPath]);
  }

  // ---------------------------------------------------------------------------
  // Commit

  /**
   * @param {string|undefined} message undefined with amend keeps the old message
   * @param {{amend?:boolean, signoff?:boolean, noVerify?:boolean, all?:boolean, allowEmpty?:boolean}} o
   */
  commit(message, o = {}) {
    const args = ['commit', '--quiet'];
    if (o.amend) args.push('--amend');
    if (o.signoff) args.push('--signoff');
    if (o.noVerify) args.push('--no-verify');
    if (o.all) args.push('--all');
    if (o.allowEmpty) args.push('--allow-empty');
    if (o.only && o.only.length) args.push('--only');
    // Reusing a prepared message (MERGE_MSG): drop git's "# Conflicts:" comment lines.
    // An amend keeps the old message exactly as it was.
    if (message === undefined) args.push('--no-edit', ...(o.amend ? [] : ['--cleanup=strip']));
    // "whitespace" (git's default for -F) keeps lines starting with '#', e.g. "#123 fix".
    else args.push('--cleanup=whitespace', '-F', '-');
    // --only: commit just these paths (their working-tree content), leaving other staged changes staged.
    if (o.only && o.only.length && tooLongForCommandLine(o.only)) {
      // Too many for the command line (Windows: 32 KB) and stdin carries the message: a file.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-corner-paths-'));
      const list = path.join(dir, 'paths');
      fs.writeFileSync(list, `${o.only.map(lit).join('\0')}\0`);
      return this.run([...args, `--pathspec-from-file=${list}`, '--pathspec-file-nul'], { input: message })
        .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
    }
    if (o.only && o.only.length) args.push('--', ...o.only.map(lit));
    return this.run(args, { input: message });
  }

  /** Undo the last commit, keeping its changes staged. Returns the undone commit. */
  async undoLastCommit() {
    const commit = await this.getCommit('HEAD');
    if (commit.parents.length > 1 && !this.allowUndoMerge) {
      throw new Error('The last commit is a merge. Undoing it with a soft reset would turn the merge into ordinary staged changes; use Reset (to the first parent) if that is what you want.');
    }
    if (commit.parents.length) await this.run(['reset', '--soft', 'HEAD~1']);
    else await this.run(['update-ref', '-d', 'HEAD']);
    return commit;
  }

  async recentMessages(count = 30) {
    const { stdout } = await this.exec(['log', `--max-count=${count}`, '--format=%B%x00', 'HEAD', '--'], { allowFailure: true });
    return [...new Set(stdout.split('\0').map((s) => s.trim()).filter(Boolean))];
  }

  // ---------------------------------------------------------------------------
  // Branches & tags

  checkout(ref, opts = {}) {
    checkRevs(ref);
    const args = ['checkout', '-q'];
    if (opts.detach) args.push('--detach');
    if (opts.force) args.push('--force');
    args.push(ref, '--');
    return this.run(args);
  }

  /** Check out a remote branch as a new local tracking branch. */
  checkoutTracking(remoteBranch, localName, force) {
    checkRevs(remoteBranch, localName);
    return this.run(['checkout', '-q', ...(force ? ['--force'] : []), '--track', '-b', localName, remoteBranch, '--']);
  }

  async createBranch(name, startPoint, checkout, o = {}) {
    checkRevs(name, startPoint);
    const track = startPoint ? await this.trackFlag(name, startPoint) : [];
    if (checkout) return this.run(['checkout', '-q', ...(o.force ? ['--force'] : []), ...track, '-b', name, ...(startPoint ? [startPoint] : []), '--']);
    return this.run(['branch', ...track, name, ...(startPoint ? [startPoint] : [])]);
  }

  /**
   * git's default (branch.autoSetupMerge=true) makes a branch created from a
   * remote-tracking branch track it. For a *differently named* branch that
   * means a later push targets the remote branch it was cut from (e.g. a new
   * feature branch tracking origin/main), so don't track in that case.
   */
  async trackFlag(name, startPoint) {
    const { stdout } = await this.exec(['rev-parse', '--symbolic-full-name', `${startPoint}`, '--'], { allowFailure: true });
    const full = stdout.split('\n')[0].trim();
    if (!full.startsWith('refs/remotes/')) return [];
    // Remote names may contain "/" ("up/stream"): strip the longest one that matches.
    const short = full.slice('refs/remotes/'.length);
    const remote = (await this.getRemotes()).map((r) => r.name).sort((a, b) => b.length - a.length).find((n) => short.startsWith(`${n}/`));
    const remoteBranch = remote ? short.slice(remote.length + 1) : short.split('/').slice(1).join('/');
    return remoteBranch === name ? ['--track'] : ['--no-track'];
  }

  deleteBranch(name, force) {
    // `--`: a name like "--x" is a name, not an option.
    return this.run(['branch', force ? '-D' : '-d', '--', name.replace(/^refs\/heads\//, '')]);
  }

  renameBranch(oldName, newName) {
    return this.run(['branch', '-m', '--', oldName, newName]);
  }

  setUpstream(branch, upstream) {
    checkRevs(upstream);
    if (!upstream) return this.run(['branch', '--unset-upstream', '--', branch]);
    return this.run(['branch', `--set-upstream-to=${upstream}`, '--', branch]);
  }

  deleteRemoteBranch(remote, branch) {
    // A full ref name can never be read as an option (a fetched branch may be called "--x").
    const ref = `refs/heads/${branch.replace(/^refs\/heads\//, '')}`;
    checkRemotes(remote);
    return this.runNetwork(['push', remote, '--delete', ref]);
  }

  createTag(name, ref, message) {
    checkRevs(ref, name);
    const args = ['tag'];
    if (message) args.push('-a', '--cleanup=whitespace', name, '-F', '-');
    else args.push(name);
    if (ref) args.push(ref);
    return this.run(args, { input: message || undefined });
  }

  deleteTag(name) {
    return this.run(['tag', '-d', '--', name.replace(/^refs\/tags\//, '')]);
  }

  pushTag(remote, name) {
    checkRemotes(remote);
    // `name` may already be the full ref (tags whose short name starts with "-").
    return this.runNetwork(['push', remote, `refs/tags/${name.replace(/^refs\/tags\//, '')}`]);
  }

  deleteRemoteTag(remote, name) {
    checkRemotes(remote);
    return this.runNetwork(['push', remote, '--delete', `refs/tags/${name.replace(/^refs\/tags\//, '')}`]);
  }

  // ---------------------------------------------------------------------------
  // Merge, rebase, cherry-pick, revert, reset

  merge(ref, o = {}) {
    checkRevs(ref);
    const args = ['merge'];
    if (o.noFf) args.push('--no-ff');
    if (o.ffOnly) args.push('--ff-only');
    if (o.squash) args.push('--squash');
    if (o.noCommit) args.push('--no-commit');
    if (!o.squash) args.push('--no-edit');
    if (!o.squash && !o.noCommit) args.push('--autostash');
    args.push(ref);
    return this.run(args);
  }

  rebase(onto) {
    checkRevs(onto);
    return this.run(['rebase', '--autostash', onto], { env: { GIT_EDITOR: 'true' } });
  }

  /**
   * Run `git rebase -i <base>` with a prepared todo list. New commit messages
   * (reword, or the final message of a squash group) are written to files and
   * applied with `exec git commit --amend -F <file>` lines right after the
   * commit they belong to, so no interactive editor is ever needed.
   * @param {string} base upstream/base commit, or '--root'
   * @param {ReturnType<typeof import('./rebaseTodo').parseTodo>['entries']} entries
   * @param {Map<number,string>} [messages] entry index -> new message
   */
  async rebaseInteractive(base, entries, messages = new Map()) {
    if (base !== '--root') checkRevs(base);
    // Inside .git rather than /tmp: a rebase paused at an edit stop may outlive a reboot.
    const tmpRoot = path.join(this.gitDir, 'commit-corner-rebase');
    // From here until git has started (or failed), no refresh may sweep the folder: the plan is
    // written before the rebase waits in the queue, and git has no rebase-merge folder yet.
    this.rebasesStarting = (this.rebasesStarting || 0) + 1;
    try {
      // A sweep already under way finishes first (it would delete the new plan's folder).
      if (this.sweeping) await this.sweeping;
      return await this.rebaseInteractiveLocked(tmpRoot, base, entries, messages);
    } finally {
      this.rebasesStarting--;
      await this.cleanupRebaseTempDirs();
    }
  }

  async rebaseInteractiveLocked(tmpRoot, base, entries, messages) {
    const { serializeTodo } = require('./rebaseTodo');
    await fs.promises.mkdir(tmpRoot, { recursive: true });
    const dir = await fs.promises.mkdtemp(path.join(tmpRoot, 'r-'));
    const messageFiles = new Map();
    for (const [index, text] of messages) {
      const file = path.join(dir, `msg-${index}-${crypto.randomBytes(6).toString('hex')}`);
      await fs.promises.writeFile(file, text);
      messageFiles.set(index, file);
    }
    const todoFile = path.join(dir, 'todo');
    await fs.promises.writeFile(todoFile, serializeTodo(entries, { messageFiles, git: getGitPath() }));
    const editor = path.join(__dirname, '..', '..', 'scripts', 'sequence-editor.js');
    // ELECTRON_RUN_AS_NODE only for the helper (the extension host may be Electron), not for the
    // hooks and exec lines that the rebase runs.
    const sequenceEditor = `ELECTRON_RUN_AS_NODE=1 ${shellArg(process.execPath)} ${shellArg(editor)} ${shellArg(todoFile)}`;
    this.rebaseTempDirs.add(dir);
    // If the rebase stops (conflict/edit), later exec lines still need the message files;
    // refreshState() removes them once the rebase is over.
    return this.run(['rebase', '-i', '--autostash', ...(base === '--root' ? ['--root'] : [base])], {
      // The extension host may be Electron; make it behave as plain node for the helper script.
      env: { GIT_SEQUENCE_EDITOR: sequenceEditor, GIT_EDITOR: 'true' },
    });
  }

  /**
   * Commit the staged changes as a fixup of `sha` and fold it in right away
   * (`git commit --fixup` + `git rebase -i --autosquash`, accepting git's plan).
   */
  async fixupInto(sha) {
    checkRevs(sha);
    const commit = await this.getCommit(sha);
    // Check before creating the fixup! commit, so a refusal leaves nothing behind.
    if (await this.hasMergesSince(commit.sha)) {
      throw new Error('There are merge commits between that commit and HEAD; folding changes in would flatten them. Use Interactive Rebase instead.');
    }
    await this.run(['commit', '--quiet', `--fixup=${commit.sha}`]);
    const base = commit.parents[0] || '--root';
    return this.run(['rebase', '-i', '--autosquash', '--autostash', ...(base === '--root' ? ['--root'] : [base])], {
      env: { GIT_SEQUENCE_EDITOR: 'true', GIT_EDITOR: 'true' },
    });
  }

  /** True when `range` (sha..HEAD) contains merge commits (a rebase would flatten them). */
  async hasMergesSince(sha) {
    const { stdout } = await this.exec(['rev-list', '--merges', '-n', '1', `${sha}..HEAD`]);
    return !!stdout.trim();
  }

  async cleanupRebaseTempDirs() {
    if (this.rebasesStarting || (await this.getOperation())) return;
    // Checked again after the await: a rebase may have started meanwhile (its plan is in there).
    if (this.rebasesStarting) return;
    // Sweep the whole folder: directories from before a window reload are not in the in-memory set.
    this.rebaseTempDirs.clear();
    this.sweeping = fs.promises.rm(path.join(this.gitDir, 'commit-corner-rebase'), { recursive: true, force: true }).catch(() => {});
    await this.sweeping;
    this.sweeping = undefined;
  }

  /**
   * Replace the message git will use when continuing a merge, cherry-pick,
   * revert or rebase step (what the user typed in the commit box).
   */
  async writePendingMessage(message) {
    const text = message.endsWith('\n') ? message : `${message}\n`;
    await fs.promises.writeFile(path.join(this.gitDir, 'MERGE_MSG'), text);
    const rebaseMessage = path.join(this.gitDir, 'rebase-merge', 'message');
    if (fs.existsSync(rebaseMessage)) await fs.promises.writeFile(rebaseMessage, text);
  }

  /**
   * Continue the operation in progress. `o.message`: the message the user wrote (already in
   * MERGE_MSG): git cleans it with the comment character, so pick one that no line of it
   * starts with — "#123 fix" is a subject, not a comment.
   */
  continueOperation(kind, o = {}) {
    const env = { GIT_EDITOR: 'true' };
    const c = o.message ? ['-c', `core.commentChar=${commentCharFor(o.message)}`] : [];
    switch (kind) {
      case 'rebase': return this.run([...c, 'rebase', '--continue'], { env });
      case 'cherry-pick': return this.run([...c, 'cherry-pick', '--continue'], { env });
      case 'revert': return this.run([...c, 'revert', '--continue'], { env });
      case 'merge': return this.run(['commit', '--no-edit', '--cleanup=strip'], { env });
      case 'am': return this.run(['am', '--continue'], { env });
      default: throw new Error(`Cannot continue ${kind}`);
    }
  }

  abortOperation(kind) {
    switch (kind) {
      case 'rebase': return this.run(['rebase', '--abort']);
      case 'cherry-pick': return this.run(['cherry-pick', '--abort']);
      case 'revert': return this.run(['revert', '--abort']);
      case 'merge': return this.run(['merge', '--abort']);
      case 'am': return this.run(['am', '--abort']);
      case 'bisect': return this.run(['bisect', 'reset']);
      // A conflicted stash apply leaves no operation state; git's way back is reset --merge.
      case 'stash': return this.run(['reset', '--merge']);
      default: throw new Error(`Cannot abort ${kind}`);
    }
  }

  skipOperation(kind) {
    const env = { GIT_EDITOR: 'true' };
    switch (kind) {
      case 'rebase': return this.run(['rebase', '--skip'], { env });
      case 'cherry-pick': return this.run(['cherry-pick', '--skip'], { env });
      case 'revert': return this.run(['revert', '--skip'], { env });
      default: throw new Error(`Cannot skip in ${kind}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Bisect

  /** Start bisecting: `bad` is a commit with the bug, `good` one without. */
  bisectStart(bad, good) {
    checkRevs(bad, ...[].concat(good));
    return this.run(['bisect', 'start', bad, ...(Array.isArray(good) ? good : [good]), '--']);
  }

  /**
   * Mark the current (or given) commit. Resolves the culprit SHA when git has
   * found the first bad commit.
   * @param {'good'|'bad'|'skip'} verdict
   */
  async bisectMark(verdict, ref) {
    checkRevs(ref);
    const { stdout } = await this.run(['bisect', verdict, ...(ref ? [ref] : [])]);
    const m = /^([0-9a-f]{40,64}) is the first bad commit/m.exec(stdout);
    return { done: !!m, culprit: m ? m[1] : undefined, output: stdout.trim() };
  }

  bisectReset() {
    return this.run(['bisect', 'reset']);
  }

  // ---------------------------------------------------------------------------
  // Patches

  /** Commits as an mbox patch series (oldest first), ready for `git am`. */
  async formatPatch(shas) {
    checkRevs(...shas);
    const ordered = await this.sortTopologically(shas);
    const parts = [];
    for (const sha of ordered) {
      const { stdout } = await this.exec(['format-patch', '-1', '--stdout', '--no-signature', sha]);
      parts.push(stdout);
    }
    return parts.join('');
  }

  /**
   * A plain diff: 'staged' (index vs HEAD), 'unstaged' (working tree vs index) or 'all'
   * (working tree vs HEAD: staged + unstaged, tracked files).
   */
  async diffPatch(which) {
    const range = which === 'staged' || which === true ? ['--cached'] : which === 'all' && (await this.revParse('HEAD')) ? ['HEAD'] : [];
    const { stdout } = await this.exec(['diff', '--binary', '--no-textconv', '--no-ext-diff', ...range, '--']);
    return stdout;
  }

  /**
   * Apply a patch: as commits (`git am --3way`, for format-patch output) or to
   * the working tree (`git apply --3way`, any diff).
   */
  applyPatch(text, asCommits) {
    if (asCommits) return this.run(['am', '--3way', '--keep-cr'], { input: text });
    return this.run(['apply', '--3way', '--whitespace=nowarn'], { input: text });
  }

  /** Cherry-pick commits (given in any order; applied oldest first). */
  async cherryPick(shas, o = {}) {
    checkRevs(...shas);
    const ordered = await this.sortTopologically(shas);
    const args = ['cherry-pick'];
    if (o.noCommit) args.push('--no-commit');
    if (o.recordOrigin) args.push('-x');
    // Merge commits need a mainline parent.
    for (const sha of ordered) {
      const c = await this.getCommit(sha);
      if (c.parents.length > 1) {
        args.push('-m', '1');
        break;
      }
    }
    return this.run([...args, ...ordered], { env: { GIT_EDITOR: 'true' } });
  }

  /** Revert commits (newest first, as git expects to unwind history). */
  async revert(shas, o = {}) {
    checkRevs(...shas);
    const ordered = (await this.sortTopologically(shas)).reverse();
    const args = ['revert', '--no-edit'];
    if (o.noCommit) args.push('--no-commit');
    for (const sha of ordered) {
      const c = await this.getCommit(sha);
      if (c.parents.length > 1) {
        args.push('-m', '1');
        break;
      }
    }
    return this.run([...args, ...ordered], { env: { GIT_EDITOR: 'true' } });
  }

  reset(ref, mode = 'mixed') {
    checkRevs(ref);
    return this.run(['reset', `--${mode}`, '-q', ref]);
  }

  /** Restore a file in the working tree (and index) to its state at `ref`. */
  restoreFile(relPath, ref) {
    checkRevs(ref);
    return this.run(['checkout', '-q', ref, '--', lit(relPath)]);
  }

  /**
   * Paths that would conflict if `theirs` were merged into `ours`. Uses
   * `merge-tree --write-tree` on git >= 2.38 (exact), else the legacy
   * merge-tree output (approximate: no rename detection).
   * Never touches the working tree or index.
   * @returns {Promise<{conflicts:string[], exact:boolean}>}
   */
  async predictConflicts(ours, theirs) {
    checkRevs(ours, theirs);
    const v = await getVersion();
    if (versionAtLeast(v, 2, 38)) {
      const { stdout, stderr, exitCode } = await this.exec(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', ours, theirs], { allowFailure: true });
      if (/unrelated histories/i.test(stderr)) throw new Error(`${ours} and ${theirs} have no common history.`);
      if (exitCode !== 0 && exitCode !== 1) throw new Error(`merge-tree failed: ${stderr.trim().split('\n')[0]}`);
      return { conflicts: P.parseWriteTreeConflicts(stdout, exitCode, true), exact: true };
    }
    const base = await this.mergeBase(ours, theirs);
    if (!base) return { conflicts: [], exact: false };
    const { stdout } = await this.exec(['merge-tree', base, ours, theirs], { maxBytes: 50 * 1024 * 1024 });
    // The legacy merge-tree has no rename detection: callers should say the result is approximate.
    return { conflicts: P.parseLegacyMergeTree(stdout), exact: false };
  }

  // ---------------------------------------------------------------------------
  // Remotes

  /** Fetch. Runs outside the write queue (see runNetwork). */
  async fetch(o = {}) {
    if (o.remote !== undefined) checkRemotes(o.remote);
    const args = ['fetch'];
    // Prune by default, unless fetch.prune or remote.<name>.prune says how: then git decides
    // (an explicit --prune would override a remote's prune=false).
    if (o.prune !== false && !(await this.pruneConfigured(o.all ? undefined : o.remote))) args.push('--prune');
    if (o.all) args.push('--all');
    else if (o.remote) args.push(o.remote);
    if (o.refspecs) args.push(...o.refspecs);
    return this.runNetwork(args, { signal: o.signal, timeout: o.timeout, env: o.quiet ? QUIET_NETWORK_ENV : undefined });
  }

  /** Whether fetch.prune, or remote.<remote>.prune (any remote's when none is given), is set. */
  async pruneConfigured(remote) {
    if ((await this.getConfig('fetch.prune')) !== undefined) return true;
    const { stdout } = await this.exec(['config', '--get-regexp', '^remote\\..*\\.prune$'], { allowFailure: true });
    const keys = stdout.split('\n').filter(Boolean).map((l) => l.split(' ')[0]);
    // git prints the section and key in lower case, the remote name as written.
    return remote ? keys.includes(`remote.${remote}.prune`) : keys.length > 0;
  }

  async currentBranch() {
    const { stdout, exitCode } = await this.exec(['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true });
    return exitCode === 0 ? stdout.trim() : undefined;
  }

  /**
   * Upstream configuration of a branch.
   * @returns {Promise<{remote:string, merge:string, trackingRef:string|undefined, pushRemote:string|undefined}|undefined>}
   */
  async getUpstream(branch) {
    const [remote, merge, pushRemote, pushDefault] = await Promise.all([
      this.getConfig(`branch.${branch}.remote`),
      this.getConfig(`branch.${branch}.merge`),
      this.getConfig(`branch.${branch}.pushRemote`),
      this.getConfig('remote.pushDefault'),
    ]);
    if (!remote || !merge) return undefined;
    const res = await this.exec(['rev-parse', '--symbolic-full-name', `${branch}@{upstream}`], { allowFailure: true });
    return { remote, merge, trackingRef: res.exitCode === 0 && res.stdout.trim() ? res.stdout.trim() : undefined, pushRemote: pushRemote || pushDefault || undefined };
  }

  /**
   * Pull = fetch the upstream (outside the write queue, so it never blocks
   * local work) + merge or rebase (inside it). The integration mode follows
   * `rebase` if given, else branch.<name>.rebase / pull.rebase, else merge —
   * so diverged branches never hit git's "Need to specify how to reconcile"
   * error. pull.ff=only|false is honoured for merges.
   * @param {{rebase?:boolean, signal?:AbortSignal, timeout?:number}} o
   */
  async pull(o = {}) {
    const branch = await this.currentBranch();
    if (!branch) throw new GitError({ args: ['pull'], exitCode: 1, stdout: '', stderr: 'fatal: You are not currently on a branch.', cwd: this.root });
    const up = await this.getUpstream(branch);
    if (!up) throw new GitError({ args: ['pull'], exitCode: 1, stdout: '', stderr: `There is no tracking information for the current branch (${branch}).`, cwd: this.root });
    let target = up.trackingRef;
    if (up.remote !== '.') {
      // Fetching the merge ref also updates its remote-tracking branch.
      checkRemotes(up.remote);
      checkRevs(up.merge);
      await this.runNetwork(['fetch', up.remote, up.merge], { signal: o.signal, timeout: o.timeout });
      // e.g. a PR branch tracking refs/pull/<n>/head. Pinned to a SHA right away: a background
      // fetch may rewrite FETCH_HEAD before the merge runs.
      if (!target) target = (await this.revParse('FETCH_HEAD')) || 'FETCH_HEAD';
    }
    if (!target) target = up.merge;
    let rebase = o.rebase;
    if (rebase === undefined) {
      const branchRebase = await this.getConfig(`branch.${branch}.rebase`);
      rebase = parseRebaseConfig(branchRebase !== undefined ? branchRebase : await this.getConfig('pull.rebase'));
    }
    if (rebase) {
      // --fork-point (what `git pull --rebase` does) keeps commits that were removed upstream by a
      // force push from being replayed again. It needs a remote-tracking ref, not a fetched SHA.
      const forkPoint = up.trackingRef || up.remote === '.' ? ['--fork-point'] : [];
      return this.run(['rebase', '--autostash', ...forkPoint, ...(rebase === 'merges' ? ['--rebase-merges'] : []), target], { env: { GIT_EDITOR: 'true' } });
    }
    const ff = await this.getConfig('pull.ff');
    const args = ['merge', '--no-edit', '--autostash'];
    if (ff !== undefined && ff.toLowerCase() === 'only') args.push('--ff-only');
    else if (ff !== undefined && FALSE_VALUES.has(ff.toLowerCase())) args.push('--no-ff');
    // The message `git pull` writes ("Merge branch 'main' of origin"), not the tracking ref's name.
    if (up.merge) args.push('-m', `Merge branch '${up.merge.replace(/^refs\/heads\//, '')}'${up.remote && up.remote !== '.' ? ` of ${up.remote}` : ''}`);
    return this.run([...args, target], { env: { GIT_EDITOR: 'true' } });
  }

  /**
   * Push. Without an explicit remote/refspec, pushes HEAD to the configured
   * upstream branch by name (HEAD:<merge ref>), so a local branch tracking a
   * differently named remote branch works regardless of push.default.
   */
  async push(o = {}) {
    const args = ['push'];
    if (o.force === 'lease') {
      args.push('--force-with-lease');
      // Background fetches move the remote-tracking ref, which would make the lease meaningless;
      // --force-if-includes also requires that we have integrated the remote tip locally.
      if (versionAtLeast(await getVersion(), 2, 30)) args.push('--force-if-includes');
    } else if (o.force) args.push('--force');
    if (o.setUpstream) args.push('--set-upstream');
    if (o.tags) args.push('--follow-tags');
    if (o.remote) {
      checkRemotes(o.remote);
      args.push(o.remote);
      if (o.refspec) args.push(o.refspec);
    } else {
      const branch = await this.currentBranch();
      const up = branch && await this.getUpstream(branch);
      if (up && P.isPullRequestRef(up.merge) && !(up.pushRemote && up.pushRemote !== up.remote)) {
        // A checked-out PR tracks refs/pull/<n>/head, which GitHub never accepts pushes to.
        const err = new GitError({ args: ['push'], exitCode: 1, stdout: '', stderr: `fatal: "${branch}" tracks pull request ref ${up.merge}, which cannot be pushed to. Push to a branch instead.`, cwd: this.root });
        err.code = ErrorCodes.PullRequestUpstream;
        throw err;
      }
      if (up && up.remote !== '.') {
        const triangular = up.pushRemote && up.pushRemote !== up.remote;
        if (triangular) args.push(up.pushRemote, `HEAD:refs/heads/${branch}`);
        else {
          // Like git's push.default=simple: never push to an upstream with a different name
          // unless asked (o.to) or configured (push.default=upstream). A branch created from
          // origin/main must not silently land on origin/main.
          const upName = up.merge.replace(/^refs\/heads\//, '');
          // "matching" (push every same-named branch) is treated like "simple": only the current
          // branch is ever pushed. "nothing" means the user always names the target.
          const mode = ((await this.getConfig('push.default')) || 'simple').toLowerCase();
          if (mode === 'nothing' && !o.to) {
            throw new GitError({ args: ['push'], exitCode: 1, stdout: '', stderr: 'fatal: push.default is "nothing": use "Push to…" to name the remote branch.', cwd: this.root });
          }
          let to = o.to;
          if (!to) {
            if (upName === branch || mode === 'upstream' || mode === 'tracking') to = 'upstream';
            else if (mode === 'current') to = 'sameName';
          }
          if (!to) {
            const err = new GitError({ args: ['push'], exitCode: 1, stdout: '', stderr: `fatal: The upstream of "${branch}" is "${up.remote}/${upName}", which has a different name.`, cwd: this.root });
            err.code = ErrorCodes.UpstreamNameMismatch;
            err.details = { branch, remote: up.remote, upstream: upName };
            throw err;
          }
          args.push(up.remote, to === 'upstream' ? `HEAD:${up.merge}` : `HEAD:refs/heads/${branch}`);
        }
      }
    }
    return this.runNetwork(args, { signal: o.signal, timeout: o.timeout, env: o.quiet ? QUIET_NETWORK_ENV : undefined });
  }

  // `remote add` and `set-url` take "--" (a URL may start with "-"); `rename` and `remove` do
  // not, so names are checked instead.
  addRemote(name, url) {
    checkRemotes(name);
    return this.run(['remote', 'add', '--', name, url]);
  }

  removeRemote(name) {
    checkRemotes(name);
    return this.run(['remote', 'remove', name]);
  }

  renameRemote(oldName, newName) {
    checkRemotes(oldName, newName);
    return this.run(['remote', 'rename', oldName, newName]);
  }

  setRemoteUrl(name, url) {
    checkRemotes(name);
    return this.run(['remote', 'set-url', '--', name, url]);
  }

  /**
   * Signature status of a commit (%G?): G good, B bad, U good but untrusted key,
   * X/Y expired, R revoked, E cannot check, N none.
   */
  async getSignature(sha) {
    checkRevs(sha);
    const { stdout } = await this.exec(['log', '-1', '--format=%G?%x1f%GS%x1f%GK', sha, '--'], { allowFailure: true });
    const [status, signer, key] = stdout.trim().split(P.FS);
    return { status: status || 'N', signer: signer || '', key: key || '' };
  }

  // ---------------------------------------------------------------------------
  // Pull requests (GitHub refs over plain git, no API)

  /**
   * List PRs that GitHub publishes as refs/pull/<n>/{head,merge}. One
   * `ls-remote`, which also tells us the remote's default branch.
   */
  async listPullRequests(remote, opts = {}) {
    checkRemotes(remote);
    const { stdout } = await this.runNetwork(['ls-remote', '--symref', remote, 'HEAD', 'refs/pull/*/head', 'refs/pull/*/merge'], { timeout: opts.timeout, env: opts.quiet ? QUIET_NETWORK_ENV : undefined });
    const head = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(stdout);
    if (head) this.remoteDefaultBranches.set(remote, head[1]);
    return P.parsePullRefs(P.parseLsRemote(stdout.split('\n').filter((l) => !l.startsWith('ref: ')).join('\n')));
  }

  prRef(remote, number, kind = 'head') {
    checkRemotes(remote);
    if (!Number.isSafeInteger(Number(number)) || Number(number) <= 0) throw new Error(`Not a pull request number: ${number}`);
    return `${PR_REF_PREFIX}/${remote}/${number}/${kind}`;
  }

  /**
   * Fetch one PR's head (and its test-merge ref when present) into our
   * private ref namespace. Without a merge ref we also fetch the remote's
   * default branch, so the merge base is not computed against a stale base.
   */
  async fetchPullRequest(remote, number, opts = {}) {
    const head = `+refs/pull/${number}/head:${this.prRef(remote, number, 'head')}`;
    const base = this.remoteDefaultBranches.get(remote);
    // Only update the base's remote-tracking ref when the remote's own fetch refspec maps it there.
    const fetchSpecs = ((await this.exec(['config', '--get-all', `remote.${remote}.fetch`], { allowFailure: true })).stdout || '').split('\n');
    const covered = base && fetchSpecs.some((spec) => spec.replace(/^\+/, '') === `refs/heads/*:refs/remotes/${remote}/*` || spec.replace(/^\+/, '') === `refs/heads/${base}:refs/remotes/${remote}/${base}`);
    const baseSpec = covered ? [`+refs/heads/${base}:refs/remotes/${remote}/${base}`] : [];
    const fetch = (specs) => this.runNetwork(['fetch', '--no-tags', remote, ...specs], { signal: opts.signal, timeout: opts.timeout });
    if (opts.withMerge) {
      try {
        await fetch([head, `+refs/pull/${number}/merge:${this.prRef(remote, number, 'merge')}`]);
        return this.revParse(this.prRef(remote, number, 'head'));
      } catch {
        // The merge ref disappears for closed or conflicting PRs; fall through to head + base.
      }
    }
    // No fresh test merge: forget an old one, so the base is never taken from it.
    await this.exec(['update-ref', '-d', this.prRef(remote, number, 'merge')], { writes: true, allowFailure: true });
    try {
      await fetch([head, ...baseSpec]);
    } catch (e) {
      if (!baseSpec.length) throw e;
      await fetch([head]);
    }
    return this.revParse(this.prRef(remote, number, 'head'));
  }

  /** Fetch every PR head ref of a remote in one go (can be large). */
  fetchAllPullRequests(remote, signal) {
    checkRemotes(remote);
    return this.runNetwork(['fetch', '--no-tags', remote, `+refs/pull/*/head:${PR_REF_PREFIX}/${remote}/*/head`], { signal });
  }

  /** Remove fetched PR refs (all, or those not in `keep`). */
  async pruneFetchedPullRequests(remote, keep = new Set()) {
    const fetched = await this.getFetchedPullRequests(remote);
    const input = [];
    for (const n of fetched.keys()) {
      if (keep.has(n)) continue;
      input.push(`delete ${this.prRef(remote, n, 'head')}`, `delete ${this.prRef(remote, n, 'merge')}`, `delete ${this.prRef(remote, n, 'base')}`);
    }
    if (input.length) await this.run(['update-ref', '--stdin'], { input: `${input.join('\n')}\n` });
    return input.length / 3;
  }

  /**
   * Check out a PR as a local branch that tracks refs/pull/<n>/head, so
   * Pull/Sync later bring in new commits pushed to the PR.
   */
  async checkoutPullRequest(remote, number, name, sha) {
    checkRevs(sha, name);
    checkRemotes(remote);
    await this.run(['checkout', '-q', '-B', name, sha, '--']);
    await this.run(['config', `branch.${name}.remote`, remote]);
    await this.run(['config', `branch.${name}.merge`, `refs/pull/${number}/head`]);
  }

  /** PR refs fetched earlier: Map number -> sha. */
  async getFetchedPullRequests(remote) {
    checkRemotes(remote);
    const { stdout } = await this.exec(['for-each-ref', '--format=%(refname)%1f%(objectname)%1f%(subject)', `${PR_REF_PREFIX}/${remote}/`]);
    const map = new Map();
    for (const line of stdout.split('\n')) {
      const [ref, sha, subject] = line.split(P.FS);
      // Exactly this remote's: "up" must not pick up the refs of a remote called "up/stream".
      const m = /^(.+)\/(\d+)\/head$/.exec((ref || '').slice(PR_REF_PREFIX.length + 1));
      if (m && m[1] === remote) map.set(+m[2], { sha, subject });
    }
    return map;
  }

  /**
   * Work out the base of a PR and the commit the diff starts from, the way
   * GitHub's "Files changed" tab does (three-dot diff from the merge base).
   *
   * With a test-merge ref, its first parent IS the base tip GitHub used, so we
   * compute the merge base from that commit rather than from a possibly stale
   * local remote-tracking branch; the branch name is only a label.
   * @returns {Promise<{baseRef:string, baseTip:string|undefined, mergeBase:string|undefined, merged:boolean}>}
   */
  async resolvePullRequestBase(remote, number, headSha, preferredBase, opts = {}) {
    checkRevs(headSha, preferredBase);
    checkRemotes(remote);
    let baseRef = preferredBase;
    let baseTip;
    if (!preferredBase) {
      // GitHub's test merge records the exact base it used: its first parent. Never a local
      // remote-tracking branch, which may be behind.
      const mergeSha = await this.revParse(this.prRef(remote, number, 'merge'));
      // Only a test merge of this very head counts (its second parent): an older one would
      // bring in the base of an earlier state of the PR.
      if (mergeSha && (await this.revParse(`${mergeSha}^2`)) === headSha) {
        baseTip = await this.revParse(`${mergeSha}^1`);
        baseRef = opts.baseBranch ? `${remote}/${opts.baseBranch}` : (await this.findBranchFor(remote, baseTip)) || `${remote}/${this.remoteDefaultBranches.get(remote) || 'base'}`;
      } else if (opts.baseBranch && (await this.isValidBranchName(opts.baseBranch))) {
        // No test merge (closed, merged or conflicting): fetch the PR's base branch as it is now
        // into the PR's private refs, so a stale local copy cannot add foreign commits.
        const ref = this.prRef(remote, number, 'base');
        try {
          await this.runNetwork(['fetch', '--no-tags', remote, `+refs/heads/${opts.baseBranch}:${ref}`], { timeout: opts.timeout || 120e3, signal: opts.signal });
          baseTip = await this.revParse(ref);
        } catch {
          // Offline or deleted branch: fall back to what is known locally.
        }
        baseRef = `${remote}/${opts.baseBranch}`;
      }
    }
    if (!baseRef) {
      const known = this.remoteDefaultBranches.get(remote);
      baseRef = (known && (await this.revParse(`${remote}/${known}`)) ? `${remote}/${known}` : await this.getDefaultBranch(remote)) || 'HEAD';
    }
    const base = baseTip || baseRef;
    let mergeBase = await this.mergeBase(base, headSha);
    let merged = false;
    if (mergeBase === headSha) {
      // Already merged with a merge commit: diff against the base as it was right before the merge.
      merged = true;
      const { stdout } = await this.exec(['rev-list', '--ancestry-path', '--merges', '--reverse', `${headSha}..${base}`]);
      const mergeCommit = stdout.split('\n')[0];
      if (mergeCommit) {
        const firstParent = await this.revParse(`${mergeCommit}^1`);
        if (firstParent) mergeBase = await this.mergeBase(firstParent, headSha);
        if (mergeBase === headSha) mergeBase = firstParent;
      }
    }
    return { baseRef, baseTip, mergeBase, merged };
  }

  /** Whether a name is a valid branch name (git check-ref-format --branch). */
  async isValidBranchName(name) {
    if (typeof name !== 'string' || !name || name.startsWith('-')) return false;
    const { exitCode } = await this.exec(['check-ref-format', '--branch', name], { allowFailure: true });
    return exitCode === 0;
  }

  /** The remote branch whose tip is `sha`, else the default branch if it contains `sha`. */
  async findBranchFor(remote, sha) {
    if (!sha) return undefined;
    checkRemotes(remote);
    checkRevs(sha);
    const { stdout } = await this.exec(['for-each-ref', '--format=%(refname:short)%1f%(objectname)', '--contains', sha, `refs/remotes/${remote}/`]);
    const candidates = stdout.split('\n').filter(Boolean).map((l) => l.split(P.FS)).filter(([n]) => !n.endsWith('/HEAD'));
    const exact = candidates.find(([, s]) => s === sha);
    if (exact) return exact[0];
    const def = await this.getDefaultBranch(remote);
    if (def && candidates.some(([n]) => n === def)) return def;
    return candidates.length ? candidates[0][0] : undefined;
  }

  // ---------------------------------------------------------------------------
  // Stash

  async getStashes() {
    const { stdout } = await this.exec(['stash', 'list', `--format=%gd%x1f%H%x1f%ct%x1f%P%x1f%gs`], { allowFailure: true });
    return P.parseStashes(stdout);
  }

  /**
   * @param {{message?:string, includeUntracked?:boolean, keepIndex?:boolean, staged?:boolean, paths?:string[]}} o
   */
  async stashPush(o = {}) {
    const args = ['stash', 'push'];
    if (o.staged) {
      const v = await getVersion();
      if (!versionAtLeast(v, 2, 35)) throw new Error(`Stashing only staged changes needs git 2.35 or newer (you have ${v.raw}).`);
      args.push('--staged');
    }
    if (o.includeUntracked) args.push('--include-untracked');
    if (o.keepIndex) args.push('--keep-index');
    if (o.message) args.push('--message', o.message);
    if (o.paths && o.paths.length) return this.runWithPaths(args, o.paths);
    return this.run(args);
  }

  /**
   * Apply or pop a stash, restoring the staged state too. When the staged
   * state cannot be restored ("Conflicts in index"), apply without it rather
   * than failing.
   */
  async stashApply(ref, pop, reinstateIndex = true) {
    checkRevs(ref);
    const verb = pop ? 'pop' : 'apply';
    if (!reinstateIndex) return this.run(['stash', verb, ref]);
    try {
      return await this.run(['stash', verb, '--index', ref]);
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
      // Untracked files of the stash exist again: git has already applied the tracked changes
      // and keeps the stash. Retrying would only fail on those changes; say what happened.
      if (/could not restore untracked files/i.test(`${e.stderr}`)) {
        const exists = /^(.+) already exists, no checkout$/m.exec(`${e.stderr}`);
        e.code = ErrorCodes.Unknown;
        e.message = `The stash's untracked file${exists ? ` "${exists[1]}"` : 's'} could not be restored because ${exists ? 'it exists' : 'they exist'} again. Its tracked changes may already be applied; the stash was kept. Move the file away, then apply the stash again (or drop it).`;
        throw e;
      }
      if (!/Conflicts in index|try without --index/i.test(`${e.stderr}`)) throw e;
      return this.run(['stash', verb, ref]);
    }
  }

  stashDrop(ref) {
    checkRevs(ref);
    return this.run(['stash', 'drop', ref]);
  }

  stashBranch(name, ref) {
    checkRevs(name, ref);
    return this.run(['stash', 'branch', name, ref]);
  }

  /**
   * Files in a stash: tracked changes (stash^1 -> stash) plus untracked files (stash^3) if any.
   */
  async getStashFiles(stash) {
    const tracked = await this.diffFiles(stash.parents[0], stash.sha);
    const out = tracked.map((f) => ({ ...f, beforeRef: stash.parents[0], afterRef: stash.sha }));
    if (stash.parents[2]) {
      const untracked = await this.diffFiles(this.emptyTree, stash.parents[2]);
      for (const f of untracked) out.push({ ...f, status: 'U', beforeRef: null, afterRef: stash.parents[2], untracked: true });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Worktrees

  async getWorktrees() {
    const nul = versionAtLeast(await getVersion(), 2, 36);
    const { stdout } = await this.exec(['worktree', 'list', '--porcelain', ...(nul ? ['-z'] : [])]);
    return P.parseWorktrees(stdout, nul);
  }

  /**
   * Whether `dir` is a linked worktree of this repository: its `.git` is a file (not a link or
   * a folder) whose gitdir lies in our own .git/worktrees. Checked before git runs there.
   */
  async ownsWorktree(dir) {
    let st;
    try {
      st = await fs.promises.lstat(path.join(dir, '.git'));
    } catch {
      return false;
    }
    if (!st.isFile()) return false;
    const m = /^gitdir: (.+?)\s*$/m.exec(await fs.promises.readFile(path.join(dir, '.git'), 'utf8').catch(() => ''));
    if (!m) return false;
    const target = await fs.promises.realpath(path.resolve(dir, m[1])).catch(() => '');
    const worktrees = await fs.promises.realpath(path.join(this.commonDir, 'worktrees')).catch(() => '');
    return !!target && !!worktrees && target.startsWith(worktrees + path.sep);
  }

  /**
   * The branch work usually starts from: origin's default branch, else main or master.
   * @returns {Promise<string|undefined>}
   */
  async defaultBaseRef() {
    for (const candidate of [`origin/${(await this.remoteDefaultBranch('origin').catch(() => undefined)) || 'main'}`, 'main', 'master']) {
      if (await this.revParse(candidate)) return candidate;
    }
    return undefined;
  }

  /**
   * The branch `branch` was created from, when its reflog says ("branch: Created from main")
   * and that is a branch that still exists; else undefined.
   */
  async createdFrom(branch) {
    if (!branch) return undefined;
    checkRevs(branch);
    const { stdout } = await this.exec(['reflog', 'show', '--format=%gs', `refs/heads/${branch}`, '--'], { allowFailure: true });
    const first = stdout.trim().split('\n').pop() || '';
    const m = /^branch: Created from (.+)$/.exec(first);
    if (!m || m[1] === 'HEAD' || /^[0-9a-f]{7,64}$/.test(m[1]) || m[1].startsWith('-')) return undefined;
    // Only a branch is a base ("main", "origin/main"): an expression such as "HEAD~1" or a tag
    // name moves or means something else later.
    const name = m[1].replace(/^refs\/heads\//, '');
    for (const ref of [`refs/heads/${name}`, `refs/remotes/${name}`]) if (await this.revParse(ref)) return name;
    return undefined;
  }

  /**
   * What a worktree has changed since it left `base`: its commits and its uncommitted work
   * together (merge base -> the files in its folder), untracked files included.
   * @returns {Promise<{mergeBase: string, changes: import('./parse').FileChange[]}>}
   */
  async worktreeChangesSince(worktreePath, base) {
    checkRevs(base);
    if (!(await this.ownsWorktree(worktreePath))) throw new Error(`${worktreePath} is not a worktree of ${this.name}.`);
    // The same answer while the worktree's status, HEAD and the base are what they were (the
    // Worktrees view asks every 10 seconds per expanded worktree).
    const [{ raw }, baseTip] = await Promise.all([this.worktreeStatus(worktreePath), this.revParse(base)]);
    const cache = this.changesSinceCache || (this.changesSinceCache = new Map());
    const key = `${worktreePath}\0${base}\0${baseTip}\0${crypto.createHash('sha1').update(raw).digest('hex')}`;
    // Also for at most 30 seconds: a file edited back to the base's content keeps its status line.
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 30000) return hit.result;
    const result = await this.computeWorktreeChangesSince(worktreePath, base);
    for (const k of cache.keys()) if (k.startsWith(`${worktreePath}\0`)) cache.delete(k);
    cache.set(key, { at: Date.now(), result });
    return result;
  }

  async computeWorktreeChangesSince(worktreePath, base) {
    const head = (await git(['rev-parse', 'HEAD'], { cwd: worktreePath })).stdout.trim();
    const mergeBase = (await this.exec(['merge-base', base, head])).stdout.trim();
    const opts = { cwd: worktreePath, env: { GIT_OPTIONAL_LOCKS: '0' } };
    const [diff, untracked] = await Promise.all([
      git(['diff', '--name-status', '-z', '-M', '--no-ext-diff', '--no-textconv', mergeBase, '--'], opts),
      git(['ls-files', '-z', '--others', '--exclude-standard'], opts),
    ]);
    const changes = P.parseNameStatus(diff.stdout);
    for (const p of untracked.stdout.split('\0').filter(Boolean)) changes.push({ status: 'A', path: p });
    return { mergeBase, changes };
  }

  /**
   * Worktrees with what matters at a glance: uncommitted changes, ahead/behind the upstream,
   * and the commit checked out there (subject, author, date). Missing or bare worktrees get
   * no details.
   * @returns {Promise<(ReturnType<typeof P.parseWorktrees>[number] & {isCurrent:boolean, changes?:{staged:number, unstaged:number, untracked:number, conflicts:number}, upstream?:string|null, ahead?:number, behind?:number, commit?:P.Commit, error?:string})[]>}
   */
  async getWorktreeDetails() {
    const list = await this.getWorktrees();
    const heads = list.map((w) => w.head).filter((h) => h && /^[0-9a-f]{40,64}$/.test(h));
    const commits = new Map();
    if (heads.length) {
      const { stdout } = await this.exec(['log', '--no-walk=unsorted', `--format=${P.LOG_FORMAT}`, '--decorate=full', ...new Set(heads), '--'], { allowFailure: true });
      for (const c of P.parseLog(stdout)) commits.set(c.sha, c);
    }
    const same = (a, b) => path.resolve(a) === path.resolve(b);
    // Branches without an upstream (an agent's, typically) are measured against where they started
    // (the branch they were created from), else your local default branch — as Changes vs Base.
    // Looked up once a minute (a poll every 10 seconds must not ask five times again).
    const hit = this.defaultBaseCache;
    let defaultBase = hit && Date.now() - hit.at < 60000 ? hit.value : undefined;
    if (defaultBase === undefined) {
      defaultBase = await this.defaultBaseRef();
      if (defaultBase && /^origin\//.test(defaultBase) && (await this.revParse(`refs/heads/${defaultBase.slice(7)}`))) defaultBase = defaultBase.slice(7);
      this.defaultBaseCache = { at: Date.now(), value: defaultBase || null };
    }
    defaultBase = defaultBase || undefined;
    // Four at a time (two dozen agent worktrees must not start a hundred git processes at once).
    return mapLimit(list, 4, async (w) => {
      const out = { ...w, isCurrent: same(w.path, this.root), commit: commits.get(w.head) };
      if (w.bare || w.prunable || !lexists(w.path)) return out;
      // Only a folder that really is one of our worktrees (another repository may sit at a path
      // whose worktree was deleted by hand): git runs nowhere else.
      if (!same(w.path, this.root) && !(await this.ownsWorktree(w.path))) return { ...out, error: 'not this repository\'s worktree any more' };
      try {
        const { st } = same(w.path, this.root) && this.state ? { st: undefined } : await this.worktreeStatus(w.path);
        let changes;
        let branch;
        if (!st) {
          // This repository's own worktree: the status Source Control just read.
          const s = this.state;
          changes = { staged: s.staged.length, unstaged: s.unstaged.length, untracked: s.untracked.length, conflicts: s.conflicts.length };
          branch = { upstream: s.head.upstream, ahead: s.head.ahead, behind: s.head.behind };
        } else {
          changes = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
          for (const e of st.entries) {
            if (e.kind === 'untracked') {
              // A repository nested there (an agent's worktree) is not an untracked file: as in refreshState.
              if (!(e.path.endsWith('/') && fs.existsSync(path.join(w.path, e.path, '.git')))) changes.untracked++;
            } else if (e.kind === 'unmerged') changes.conflicts++;
            else if (e.kind !== 'ignored') {
              if (e.x !== '.') changes.staged++;
              if (e.y !== '.') changes.unstaged++;
            }
          }
          branch = st.branch;
        }
        Object.assign(out, { changes, upstream: branch.upstream, ahead: branch.ahead, behind: branch.behind });
        if (!branch.upstream && w.head && /^[0-9a-f]{40,64}$/.test(w.head)) Object.assign(out, await this.baseStanding(w, defaultBase));
      } catch (e) {
        out.error = e.message;
      }
      return out;
    });
  }

  /**
   * `git status` of a worktree folder, shared for just under the 10-second poll: the Worktrees
   * view, every graph and the "Changes vs" rows ask about the same worktrees on timers of their
   * own, and one status serves them all (each still gets one at most 9 s old).
   * @returns {Promise<{raw: string, st: ReturnType<typeof P.parseStatus>}>}
   */
  worktreeStatus(dir) {
    const cache = this.worktreeStatusCache || (this.worktreeStatusCache = new Map());
    const hit = cache.get(dir);
    if (hit && Date.now() - hit.at < 9000) return hit.promise;
    // Same untracked listing as everywhere (-uall); a worktree on a slow disk must not stall the view.
    const promise = git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { cwd: dir, env: { GIT_OPTIONAL_LOCKS: '0' }, timeout: 15000 })
      .then((res) => ({ raw: res.stdout, st: P.parseStatus(res.stdout) }));
    cache.set(dir, { at: Date.now(), promise });
    promise.catch(() => cache.delete(dir));
    return promise;
  }

  /**
   * Where a branch without an upstream stands against its base (where it was created from, else
   * the default branch): computed again only when its HEAD moves (or after a minute, for a base
   * that moved).
   */
  async baseStanding(w, defaultBase) {
    const cache = this.baseStandingCache || (this.baseStandingCache = new Map());
    const key = `${w.path}\0${w.branch || ''}\0${w.head}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 60000) return hit.value;
    const base = (w.branch && (await this.createdFrom(w.branch).catch(() => undefined))) || defaultBase;
    let value = {};
    if (base) {
      const ab = await this.exec(['rev-list', '--left-right', '--count', `${base}...${w.head}`], { allowFailure: true });
      const [behind, ahead] = ab.stdout.trim().split(/\s+/).map(Number);
      if (Number.isFinite(ahead)) value = { base, baseAhead: ahead, baseBehind: behind || 0 };
    }
    if (cache.size > 500) cache.clear();
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  async addWorktree(dir, o = {}) {
    checkRevs(o.ref);
    const args = ['worktree', 'add'];
    if (o.newBranch && o.ref) args.push(...(await this.trackFlag(o.newBranch, o.ref)));
    if (o.newBranch) args.push('-b', o.newBranch);
    if (o.detach) args.push('--detach');
    args.push(dir);
    if (o.ref) args.push(o.ref);
    return this.run(args);
  }

  removeWorktree(dir, force) {
    return this.run(['worktree', 'remove', ...(force ? ['--force'] : []), dir]);
  }

  lockWorktree(dir, reason) {
    return this.run(['worktree', 'lock', ...(reason ? ['--reason', reason] : []), dir]);
  }

  unlockWorktree(dir) {
    return this.run(['worktree', 'unlock', dir]);
  }

  pruneWorktrees() {
    return this.run(['worktree', 'prune']);
  }

  // ---------------------------------------------------------------------------
  // Misc

  /** True when a filter (git-lfs, git-crypt, …) transforms this file between index and working tree. */
  async hasFilter(relPath) {
    const { stdout } = await this.exec(['check-attr', '-z', 'filter', '--', relPath], { allowFailure: true });
    const value = stdout.split('\0')[2];
    return !!value && value !== 'unspecified' && value !== 'unset';
  }

  /** A .gitignore pattern matching exactly this path (glob characters and leading #/! escaped). */
  static ignorePattern(relPath) {
    const escaped = relPath.replace(/[\\*?[\]]/g, '\\$&').replace(/^([#!])/, '\\$1').replace(/ +$/, (m) => m.replace(/ /g, '\\ '));
    return `/${escaped}`;
  }

  /**
   * Append a pattern to the repository's .gitignore. A .gitignore that is a symlink (or not a
   * regular file) is refused, like git ≥ 2.32 does: a cloned repository could otherwise point it
   * at a file outside the repository (~/.bashrc). Patterns are one line.
   */
  async ignore(pattern) {
    if (typeof pattern !== 'string' || !pattern || /[\u0000-\u001f\u007f]/.test(pattern)) throw new Error('A .gitignore pattern must be a single line.');
    const file = path.join(this.root, '.gitignore');
    let existing = '';
    try {
      const st = await fs.promises.lstat(file);
      if (!st.isFile()) throw new Error('.gitignore is a symbolic link or not a regular file; edit it by hand.');
      existing = await fs.promises.readFile(file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (existing.split(/\r?\n/).includes(pattern)) return;
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    // O_NOFOLLOW: never write through a symlink created after the check.
    const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants;
    const handle = await fs.promises.open(file, O_WRONLY | O_APPEND | O_CREAT | (O_NOFOLLOW || 0), 0o644);
    try {
      await handle.write(`${sep}${pattern}\n`);
    } finally {
      await handle.close();
    }
  }

  /** Map a path under the display (symlinked) root onto the canonical root. */
  canonical(absPath) {
    const resolved = path.resolve(absPath);
    if (this.displayRoot !== this.root && (resolved === this.displayRoot || resolved.startsWith(this.displayRoot + path.sep))) {
      return this.root + resolved.slice(this.displayRoot.length);
    }
    return resolved;
  }

  relative(absPath) {
    const rel = path.relative(this.root, this.canonical(absPath)).split(path.sep).join('/');
    // macOS hands out decomposed (NFD) names; git reports them composed (core.precomposeunicode).
    return process.platform === 'darwin' ? rel.normalize('NFC') : rel;
  }

  /** Absolute path for a repository-relative path, under the root the user opened. */
  absolute(relPath) {
    return path.join(this.displayRoot, ...relPath.split('/'));
  }

  /**
   * Whether a path belongs to this repository's working tree: inside it, and not inside a
   * repository nested in it (a worktree such as .claude/worktrees/agent, a cloned dependency):
   * a folder with its own `.git` on the way up is a boundary, those files are not ours.
   */
  contains(absPath) {
    const p = this.canonical(absPath);
    if (p === this.root) return true;
    const rel = path.relative(this.root, p);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    if (!this.boundaryCache) this.boundaryCache = new Map();
    for (let dir = p; dir !== this.root && dir.length > this.root.length; dir = path.dirname(dir)) {
      let nested = this.boundaryCache.get(dir);
      if (nested === undefined) {
        // A symlinked folder is not part of this working tree (git stores the link, not what is
        // behind it), and what it points to is not ours either; never follow it to a .git.
        let link = false;
        try {
          link = dir !== p && fs.lstatSync(dir).isSymbolicLink();
        } catch { /* missing */ }
        nested = link || fs.existsSync(path.join(dir, '.git'));
        if (this.boundaryCache.size > 20000) this.boundaryCache.clear();
        this.boundaryCache.set(dir, nested);
      }
      if (nested) return false;
    }
    return true;
  }

  /** Ref tips only (cheap: no commit lookups), for change detection. */
  async getRefTips() {
    const { stdout } = await this.exec(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags']);
    return stdout;
  }

  // ---------------------------------------------------------------------------
  // Repository creation

  dispose() {
    if (this.blobs) this.blobs.dispose();
    this.removeAllListeners();
  }

  static async init(dir) {
    await git(['init', '--', dir], { cwd: path.dirname(path.resolve(dir)) });
    return Repository.open(dir);
  }

  /** Clone into `dir` (which must not exist or be empty). */
  static async clone(url, dir, opts = {}) {
    await git(['clone', '--progress', '--', url, dir], { cwd: path.dirname(path.resolve(dir)), signal: opts.signal, network: true });
    return Repository.open(dir);
  }

  /** Initialize and update submodules recursively. */
  updateSubmodules() {
    return this.run(['submodule', 'update', '--init', '--recursive'], { network: true });
  }
}

/**
 * Mark a path as literal for git's pathspec matching, so "pages/[id].tsx"
 * never matches "pages/i.tsx". (Per argument rather than through
 * GIT_LITERAL_PATHSPECS, which would leak into the user's hooks.)
 */
function lit(p) {
  return `:(literal)${p}`;
}

function mergeStats(changes, numstat) {
  return changes.map((c) => {
    const s = numstat.get(c.path) || { added: null, deleted: null, binary: false };
    return { ...c, added: s.added, deleted: s.deleted, binary: s.binary };
  });
}

/**
 * Whether `gitDir` is the git directory of the working tree `root` itself: `<root>/.git`, or
 * what a `.git` file there (linked worktree, submodule) points to. A repository found any
 * other way — a bare repository committed inside a clone whose config sets core.worktree, or
 * core.worktree pointing at another folder — is someone else's configuration (it can name
 * programs git runs: core.fsmonitor, filters, …), and git itself never checks out a `.git`.
 */
async function ownsGitDir(root, gitDir) {
  const real = (p) => fs.promises.realpath(p).catch(() => path.resolve(p));
  const dotGit = path.join(root, '.git');
  let stat;
  try {
    stat = await fs.promises.stat(dotGit);
  } catch {
    return false;
  }
  let target = dotGit;
  if (stat.isFile()) {
    const m = /^gitdir: (.+?)\s*$/m.exec(await fs.promises.readFile(dotGit, 'utf8').catch(() => ''));
    if (!m) return false;
    target = path.resolve(root, m[1]);
  } else if (!stat.isDirectory()) return false;
  return (await real(target)) === (await real(gitDir));
}

/**
 * The message of MERGE_MSG/SQUASH_MSG without git's comments. git appends its notes as a block
 * at the end ("# Conflicts:", "# Please enter the commit message…"): cut there. Other lines that
 * start with the comment character are dropped too — except the first: a subject such as
 * "#123 fix crash" is the message, not a comment.
 */
function cleanPendingMessage(lines, comment) {
  const esc = comment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`^${esc}\\s*(Conflicts:|Please enter the commit message|It looks like you may be committing|On branch |You are currently|Changes to be committed|Changes not staged|Untracked files)`);
  const end = lines.findIndex((l) => block.test(l));
  const kept = (end >= 0 ? lines.slice(0, end) : lines).filter((l, i) => i === 0 || !l.startsWith(comment));
  return kept.join('\n').trim();
}

/** A comment character no line of `message` starts with (git strips lines starting with it). */
function commentCharFor(message) {
  const starts = new Set(String(message).split('\n').map((l) => l[0]));
  return ['#', ';', '@', '!', '$', '%', '^', '&', '|', ':'].find((c) => !starts.has(c)) || '#';
}

function checkRemotes(...names) {
  for (const n of names) {
    // A remote name reaches git as a bare argument: "--upload-pack=…" would be an option.
    if (typeof n !== 'string' || !n || n.startsWith('-') || /[\u0000-\u001f\u007f\s]/.test(n)) {
      throw new Error(`Refusing to use ${JSON.stringify(n)} as a remote name.`);
    }
  }
}

/**
 * Refuse revisions that git would parse as options. Ref names may legally
 * start with "-" (a tag called "--output=/some/file" fetches fine), so a
 * short name taken from a ref list must never reach git as a bare
 * argument; callers use the full name (refs/tags/…) for such refs.
 */
function checkRevs(...revs) {
  for (const r of revs) {
    // Anything but a string (an array from a webview message, …) would reach git stringified.
    if (r !== undefined && r !== null && typeof r !== 'string') throw new Error(`Refusing to pass a ${typeof r} to git as a revision.`);
    if (typeof r === 'string' && r.startsWith('-')) {
      throw new Error(`Refusing to pass "${r}" to git: it looks like an option. Use the full ref name (refs/…).`);
    }
  }
}

/**
 * Background network calls (auto-fetch, PR listing on open): credential prompts go to the
 * askpass helper marked quiet, which answers only without UI (a granted GitHub session) and
 * refuses everything else — no dialog pops up for work you did not start.
 */
/** The paths a `diff --git` section names (old and new; quoted ones unquoted). */
function patchPaths(sec) {
  const names = new Set();
  for (const line of sec.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('GIT binary patch')) break;
    let m = /^(?:rename|copy) (?:from|to) (.*)$/.exec(line);
    if (m) names.add(P.unquoteC(m[1]));
    else if ((m = /^(?:---|\+\+\+) (.*?)\t?$/.exec(line)) && m[1] !== '/dev/null') names.add(P.unquoteC(m[1]).replace(/^[ab]\//, ''));
  }
  const head = /^diff --git a\/(.*) b\/(.*)$/.exec(sec.split('\n', 1)[0]);
  if (head && !names.size) names.add(head[2]);
  return [...names];
}

/** `fn` over `items`, at most `limit` at a time; results in order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Whether a folder holds a repository (a .git file or folder) anywhere below it: true, false, or
 * null when it is too big to look through quickly (then git is asked). Symlinks are not followed.
 */
function holdsRepository(dir, budget = { left: 5000 }) {
  let list;
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const d of list) {
    if (--budget.left < 0) return null;
    if (d.name === '.git') return true;
    if (d.isDirectory() && !d.isSymbolicLink()) {
      const below = holdsRepository(path.join(dir, d.name), budget);
      if (below !== false) return below;
    }
  }
  return false;
}

// GCM_INTERACTIVE: Git Credential Manager (Windows' default) ignores askpass and would open its
// sign-in window during a background fetch.
const QUIET_NETWORK_ENV = { COMMIT_CORNER_ASKPASS_QUIET: '1', GCM_INTERACTIVE: 'never' };

/** Above this many paths, pass them on stdin instead of the command line. */
const PATHS_ON_COMMAND_LINE = 200;

/**
 * Paths that would make the command line too long: more than 200 of them, or more than 16 KB
 * (Windows allows 32 KB in all; deep monorepo paths reach that long before 200).
 */
function tooLongForCommandLine(paths) {
  if (paths.length > PATHS_ON_COMMAND_LINE) return true;
  let bytes = 0;
  for (const p of paths) bytes += Buffer.byteLength(p) + 12; // ":(literal)" and a separator
  return bytes > 16000;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Quote one argument for the POSIX shell git uses to run GIT_SEQUENCE_EDITOR. */
function shellArg(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

module.exports = { checkRevs, checkRemotes, Repository, INDEX, WORKTREE, EMPTY_TREE, PR_REF_PREFIX, parseRebaseConfig };
