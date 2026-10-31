'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const notify = require('../notify');
const { SCHEME, fromGitUri, toGitUri } = require('../uri');
const { safeRelPath } = require('../../git/repository');
const { normalizePath } = require('../../git/pathUtil');
const { config, log, shortSha, escapeIcons, confirm } = require('../util');
const { splitLines, normLines, anchorOf, relocate, reviewText, MAX_ANCHOR, MAX_LINE } = require('./format');

/**
 * Review comments for an agent: comments on lines of its work (its worktree's files, or a
 * commit in a diff), kept per worktree, sent back as one text to paste into its chat or saved
 * as a file in its worktree. They use VS Code's comment threads (the "+" in the gutter).
 *
 * A comment keeps the text of its lines and their neighbours. In an open editor it moves with
 * the edits made there; when a file is opened (or the review is exported) its lines are looked
 * for again, nearest first. When they are gone, it says that they changed. Kept in workspace
 * state.
 */

const KEY = 'reviewComments';
const MAX_THREADS = 1000;
const MAX_COMMENTS = 50;
const MAX_BODY = 20000;
const MAX_FILE = 2 * 1024 * 1024;
const REVIEW_HEADING = '# Review comments for';
const isFullSha = (s) => typeof s === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(s);
/** Paths compared as the file system does: case and composed/decomposed letters alike off Linux. */
const same = (a, b) => (process.platform === 'linux' ? a === b : a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase());
/** One form for every root (a drive letter in lower case, as VS Code's paths have it). */
const rootPath = (p) => normalizePath(path.resolve(p));
/** Repository text (a path, a branch) in a one-line message: no $(icon) syntax, no control characters. */
const plain = (t) => escapeIcons(String(t).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' '));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isLine = (l) => l === null || l === undefined || (typeof l === 'string' && l.length <= MAX_LINE);

/**
 * @typedef {{id: string, root: string, repoRoot: string, path: string, ref: string|null, start: number,
 *   end: number, anchor: string[], before?: string|null, after?: string|null, outdated?: boolean,
 *   comments: {id: string, body: string, time: number}[], time: number}} Thread
 */

/** The threads, by id, most recently changed last; saved a moment after each change. */
class ReviewStore {
  constructor(memento) {
    this.memento = memento;
    /** @type {Map<string, Thread>} */
    this.threads = new Map();
    const saved = memento && memento.get(KEY);
    for (const t of Array.isArray(saved) ? saved : []) if (valid(t)) this.threads.set(t.id, t);
    this.emitter = new vscode.EventEmitter();
    /** Fires with the root (worktree) whose comments changed, and whether only places moved. */
    this.onDidChange = this.emitter.event;
    this.timer = undefined;
  }

  forRoot(root) {
    return [...this.threads.values()].filter((t) => same(t.root, root));
  }

  roots() {
    const out = [];
    for (const t of this.threads.values()) if (!out.some((r) => same(r, t.root))) out.push(t.root);
    return out;
  }

  /** Store threads (new or changed). `moved`: only their places changed (no list to redraw). */
  put(list, moved = false) {
    for (const t of list) {
      this.threads.delete(t.id);
      this.threads.set(t.id, t);
    }
    // The least recently changed go first past the limit (a workspace reviewed for months).
    while (this.threads.size > MAX_THREADS) this.threads.delete(this.threads.keys().next().value);
    this.changed([...new Set(list.map((t) => t.root))], moved);
  }

  remove(ids) {
    const roots = new Set();
    for (const id of ids) {
      const t = this.threads.get(id);
      if (!t) continue;
      roots.add(t.root);
      this.threads.delete(id);
    }
    if (roots.size) this.changed([...roots], false);
  }

  changed(roots, moved) {
    // Places that moved while typing: written a little later; the list itself soon (a move
    // never puts off a comment added just before it).
    const due = Date.now() + (moved ? 3000 : 500);
    if (!this.timer || due < this.due) {
      clearTimeout(this.timer);
      this.due = due;
      this.timer = setTimeout(() => this.flush(), due - Date.now());
    }
    for (const root of roots) this.emitter.fire({ root, moved });
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.memento) this.memento.update(KEY, [...this.threads.values()]).then(undefined, () => {});
  }

  dispose() {
    if (this.timer) this.flush();
    this.emitter.dispose();
  }
}

/** A stored thread as it must be (workspace state is ours, but never trusted blindly). */
function valid(t) {
  return !!t && typeof t.id === 'string' && typeof t.root === 'string' && path.isAbsolute(t.root) && typeof t.repoRoot === 'string' && path.isAbsolute(t.repoRoot)
    && safeRelPath(t.path) && (t.ref === null || isFullSha(t.ref)) && Number.isSafeInteger(t.start) && Number.isSafeInteger(t.end)
    && t.start >= 0 && t.end >= t.start && Number.isFinite(t.time)
    && Array.isArray(t.anchor) && t.anchor.length <= MAX_ANCHOR && t.anchor.every((l) => typeof l === 'string' && l.length <= MAX_LINE)
    && isLine(t.before) && isLine(t.after)
    && Array.isArray(t.comments) && t.comments.length > 0 && t.comments.length <= MAX_COMMENTS
    && t.comments.every((c) => c && typeof c.id === 'string' && typeof c.body === 'string' && c.body.length <= MAX_BODY && Number.isFinite(c.time));
}

const newId = () => crypto.randomBytes(8).toString('hex');
const markdown = (body) => {
  const md = new vscode.MarkdownString(body);
  md.isTrusted = false; // a comment's links never run commands
  return md;
};

/** One comment of a thread in VS Code's widget (its text renders as Markdown). */
class ReviewComment {
  constructor(thread, c) {
    this.thread = thread; // the VS Code thread
    this.id = c.id;
    this.savedBody = c.body;
    this.body = markdown(c.body);
    this.mode = vscode.CommentMode.Preview;
    this.author = { name: 'You' };
    this.timestamp = new Date(c.time);
    this.contextValue = 'reviewComment';
  }
}

/** @type {ReviewStore|undefined} */
let store;
const get = () => store;

/** @param {import('../context').Context} ctx */
function register(ctx) {
  const { manager } = ctx;
  const cmd = ctx.command;
  store = new ReviewStore(ctx.extContext.workspaceState);
  ctx.extContext.subscriptions.push(store);

  /**
   * A repository's worktrees ({path, head, branch}, the main one first), asked again after 15
   * seconds; callers at the same time share one `git worktree list`.
   */
  const worktreeCache = new Map();
  function worktreesOf(repo, fresh = false) {
    const hit = worktreeCache.get(repo.root);
    if (hit && !fresh && Date.now() - hit.at < 15000) return hit.list;
    const list = repo.getWorktrees().then((all) => all.filter((w) => !w.bare).map((w) => ({ ...w, path: rootPath(w.path) })), () => []);
    worktreeCache.set(repo.root, { at: Date.now(), list });
    return list;
  }

  /** The repository's own folder (its real path, also when it was opened through a symlink). */
  const rootOf = (repo) => rootPath(repo.root);

  /**
   * Where a document is in the review: its worktree (or repository) root, the file there, the
   * commit for a revision; undefined for anything else (a file outside every repository, the
   * index, a branch tip that moves).
   * @returns {Promise<{repo: any, root: string, path: string, ref: string|null}|undefined>}
   */
  async function locate(uri) {
    let repo;
    let ref = null;
    let gitPath;
    if (uri.scheme === SCHEME) {
      let q;
      try {
        q = fromGitUri(uri);
      } catch {
        return undefined;
      }
      if (q.empty || !isFullSha(q.ref)) return undefined;
      repo = manager.getRepository(q.repo);
      if (!repo) return undefined;
      ref = q.ref;
      gitPath = q.path;
    } else if (uri.scheme === 'file') {
      repo = manager.getRepositoryForUri(uri);
    } else return undefined;
    // An agent's worktree outside the repository's folder: every open repository's worktrees.
    const candidates = repo ? [repo] : manager.repositories;
    let best = await bestRoot(candidates, path.resolve(uri.fsPath));
    // macOS: /tmp/wt opened, git lists /private/tmp/wt.
    if (!best && uri.scheme === 'file') {
      const real = await fs.promises.realpath(uri.fsPath).catch(() => undefined);
      if (real && !same(real, uri.fsPath)) best = await bestRoot(manager.repositories, real);
    }
    if (!best) return undefined;
    // git's names are composed (NFC); a macOS path may not be.
    const file = (gitPath || best.path).normalize('NFC');
    return safeRelPath(file) ? { repo: best.repo, root: best.root, path: file, ref } : undefined;
  }

  /** The repository root or worktree an absolute path lies in (the innermost), with the path inside it. */
  async function bestRoot(candidates, abs) {
    let best;
    for (const r of candidates) {
      const display = path.resolve(r.displayRoot || r.root);
      const roots = [{ dir: display, root: rootOf(r) }, { dir: rootOf(r), root: rootOf(r) }, ...(await worktreesOf(r)).map((w) => ({ dir: w.path, root: w.path }))];
      for (const { dir, root } of roots) {
        // macOS: git names folders composed (NFC), the file system may hand them out decomposed.
        const rel = process.platform === 'darwin' ? path.relative(dir.normalize('NFC'), abs.normalize('NFC')) : path.relative(dir, abs);
        if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
        // (Opened through the symlinked workspace path: filed under the real one.)
        if (!best || dir.length > best.dir.length) best = { repo: r, dir, root, path: rel.split(path.sep).join('/') };
      }
    }
    return best;
  }

  /**
   * The worktree a comment on a commit is for: the agent's whose branch has the commit (not
   * yet in the main worktree's), else the repository's own.
   */
  async function ownerOfCommit(repo, sha, fallback) {
    // Asked now: the agent may have committed a moment ago.
    const [main, ...others] = await worktreesOf(repo, true);
    if (!main || !others.length || !same(fallback, rootOf(repo))) return fallback;
    const has = await Promise.all([main, ...others].map((w) => (w.head ? repo.isAncestor(sha, w.head).catch(() => false) : false)));
    if (has[0]) return fallback;
    const i = has.findIndex((x, k) => k > 0 && x);
    return i > 0 ? others[i - 1].path : fallback;
  }

  const controller = vscode.comments.createCommentController('commitCorner.review', 'Review for the agent');
  ctx.extContext.subscriptions.push(controller);
  controller.options = { prompt: 'Comment for the agent…', placeHolder: 'What should the agent change here? (Markdown)' };
  const enabled = () => config().get('review.comments', true);
  controller.commentingRangeProvider = {
    async provideCommentingRanges(document) {
      if (!enabled()) return [];
      const at = await locate(document.uri).catch(() => undefined);
      return at ? [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)] : [];
    },
  };

  /** VS Code threads shown, by document URI; each knows its stored thread (by id). */
  const shown = new Map();
  const idOf = new WeakMap();
  const pending = new Set();

  function title(t) {
    return `For the agent${t.ref ? ` · in ${shortSha(t.ref)}` : ''}${t.outdated ? ' · ⚠ these lines have changed' : ''}`;
  }

  function track(document, thread, t) {
    idOf.set(thread, t.id);
    const key = document.uri.toString();
    if (!shown.has(key)) shown.set(key, new Set());
    shown.get(key).add(thread);
  }

  function untrack(thread) {
    for (const [key, set] of shown) {
      set.delete(thread);
      if (!set.size) shown.delete(key);
    }
  }

  function show(document, t) {
    const thread = controller.createCommentThread(document.uri, new vscode.Range(t.start, 0, t.end, 0), []);
    thread.comments = t.comments.map((c) => new ReviewComment(thread, c));
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    decorate(thread, t);
    track(document, thread, t);
  }

  function decorate(thread, t) {
    thread.label = title(t);
    thread.canReply = true;
    thread.contextValue = t.outdated ? 'reviewThread:outdated' : 'reviewThread';
  }

  /** Does a stored thread belong in this document: a file's by worktree and path, a commit's by repository, path and commit. */
  const belongs = (t, at) => same(t.path, at.path) && (t.ref ? t.ref === at.ref && same(t.repoRoot, at.repo.root) : !at.ref && same(t.root, at.root));

  const queryPath = (uri) => {
    try {
      return String(fromGitUri(uri).path || '');
    } catch {
      return '';
    }
  };

  /** The stored threads of a document, found again in its text as it is now. */
  async function showFor(document) {
    const key = document.uri.toString();
    if (!enabled() || !store.threads.size || pending.has(key)) return;
    // Cheap first: no comment on a file of that name, nothing to look up.
    const name = path.basename(document.uri.scheme === SCHEME ? queryPath(document.uri) : document.uri.fsPath);
    if (![...store.threads.values()].some((t) => same(path.posix.basename(t.path), name))) return;
    pending.add(key);
    try {
      const at = await locate(document.uri).catch(() => undefined);
      if (!at) return;
      // (Not those it shows already: one added while this was looking.)
      const showing = new Set([...(shown.get(key) || [])].map((th) => idOf.get(th)));
      const mine = [...store.threads.values()].filter((t) => belongs(t, at) && !showing.has(t.id));
      if (!mine.length) return;
      const normed = mine.some((t) => !t.ref) ? normLines(splitLines(document.getText())) : [];
      const moved = mine.filter((t) => follow(t, normed));
      for (const t of mine) show(document, t);
      if (moved.length) store.put(moved, true);
    } finally {
      pending.delete(key);
    }
  }

  /** Look for a thread's lines again (opened, exported): moved there, or "changed". True when anything changed. */
  function follow(t, normed) {
    if (t.ref) return false; // a revision never changes
    const at = relocate(normed, t.start, t);
    const outdated = at === undefined;
    const start = outdated ? Math.min(t.start, Math.max(0, normed.length - 1)) : at;
    if (start === t.start && outdated === !!t.outdated) return false;
    t.end = start + (t.end - t.start);
    t.start = start;
    t.outdated = outdated;
    return true;
  }

  /**
   * An edit in an open editor: threads below it move by the lines it added or removed, exactly as
   * VS Code reports them (all of an edit's changes refer to the text before it); lines inserted
   * or deleted right at a thread's first line are a move too. A thread the edit touches (its own
   * lines: typed in, replaced, a whole file reloaded) is looked at where it would be now first,
   * then close by; not there, it says that its lines changed. Lines are read one by one, and only
   * for touched threads.
   */
  function onEdit(e) {
    const set = shown.get(e.document.uri.toString());
    if (!set || !e.contentChanges.length) return;
    const changes = e.contentChanges.map((c) => ({ c, delta: (c.text.match(/\r\n|\r|\n/g) || []).length - (c.range.end.line - c.range.start.line) }));
    const count = e.document.lineCount;
    const cache = new Map();
    const line = (i) => {
      if (!cache.has(i)) cache.set(i, normLines([e.document.lineAt(i).text])[0]);
      return cache.get(i);
    };
    // The whole text normalized, once per edit, when a search reaches far (a file reloaded).
    let all;
    const lines = () => all || (all = Array.from({ length: count }, (_, i) => line(i)));
    const moved = [];
    for (const thread of set) {
      const t = store.threads.get(idOf.get(thread));
      if (!t || t.ref) continue;
      let shift = 0;
      let touched = false;
      let reach = 0;
      let first = Infinity; // where the first change of its own lines began
      for (const { c, delta } of changes) {
        const r = c.range;
        // Wholly above: ending before its first line, or right at its start leaving that line
        // whole (lines inserted or deleted before it): a move. A thread whose lines are gone
        // also looks for them after a change at its start (an undo puts them back there).
        const atStart = r.end.line === t.start && r.end.character === 0 && (/[\r\n]$/.test(c.text) || (c.text === '' && r.start.character === 0));
        if (r.end.line < t.start || atStart) {
          shift += delta;
          if (!(atStart && t.outdated)) continue;
        } else if (r.start.line > t.end) continue;
        else first = Math.min(first, r.start.line); // an edit of its own lines (not one before them)
        touched = true;
        reach += Math.abs(delta) + (r.end.line - r.start.line) + 1;
      }
      if (!shift && !touched) continue;
      let start = Math.max(0, t.start + shift);
      const was = !!t.outdated;
      if (touched) {
        const n = t.anchor.length;
        const here = Math.min(start, Math.max(0, count - 1));
        // Where it would be now: its lines still there (with a neighbour as before) is the answer.
        const there = n && here + n <= count && t.anchor.every((a, k) => line(here + k) === normLines([a])[0]);
        const neighbour = t.before == null || t.after == null || (here > 0 && line(here - 1) === normLines([t.before])[0]) || (here + n < count && line(here + n) === normLines([t.after])[0]);
        if (there && neighbour) {
          start = here;
          t.outdated = false;
        } else {
          // Close by, as far as the edit reached.
          const radius = reach + n + 2;
          let found;
          if (radius > 2000) found = relocate(lines(), here, t, radius);
          else {
            const lo = Math.max(0, here - radius);
            const window = [];
            for (let i = lo; i <= Math.min(count - 1, here + radius + n); i++) window.push(line(i));
            const at = relocate(window, here - lo, t, radius);
            found = at === undefined ? undefined : lo + at;
          }
          t.outdated = found === undefined;
          // Gone: kept where the edit took them (an undo brings them back there).
          // (`first` is a line of the text before the edit: moved into today's by the changes above the thread.)
          start = t.outdated ? Math.max(0, Math.min(here + Math.min(0, first - t.start), count - 1)) : found;
        }
      }
      if (start === t.start && was === !!t.outdated) continue; // nothing to tell anyone
      t.end = start + (t.end - t.start);
      t.start = start;
      thread.range = new vscode.Range(t.start, 0, t.end, 0);
      // The title only when it changes (each change is a message to VS Code's window).
      if (was !== !!t.outdated) decorate(thread, t);
      moved.push(t);
    }
    if (moved.length) store.put(moved, true);
  }

  /** Show the threads of every open document (at start, after a repository opened, setting on again). */
  const showAll = () => vscode.workspace.textDocuments.forEach((d) => showFor(d).catch((e) => log().warn(`Review comments: ${e.message}`)));

  function hideAll() {
    for (const set of shown.values()) for (const th of set) th.dispose();
    shown.clear();
  }

  ctx.extContext.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((d) => showFor(d).catch((e) => log().warn(`Review comments: ${e.message}`))),
    vscode.workspace.onDidCloseTextDocument((d) => {
      const key = d.uri.toString();
      for (const th of shown.get(key) || []) th.dispose();
      shown.delete(key);
    }),
    vscode.workspace.onDidChangeTextDocument(onEdit),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('commitCorner.review.comments')) return;
      if (enabled()) showAll();
      else hideAll();
    }),
    // Editors restored with the window are open before the repositories are known: shown once they are.
    manager.onDidOpen(() => showAll()),
  );
  Promise.resolve(manager.ready).then(showAll, () => {});

  /** The VS Code thread's stored thread (a new one: none yet). */
  const recordOf = (thread) => thread && store.threads.get(idOf.get(thread));

  // Add Comment / Reply (the widget's button): a new thread is stored with its lines' text.
  async function add(reply) {
    const thread = reply && reply.thread;
    const text = reply && typeof reply.text === 'string' ? reply.text.trim().slice(0, MAX_BODY) : '';
    if (!thread || !text) return;
    const c = { id: newId(), body: text, time: Date.now() };
    let t = recordOf(thread);
    if (t) {
      if (t.comments.length >= MAX_COMMENTS) {
        notify.info(`A comment thread holds at most ${MAX_COMMENTS} comments.`);
        return;
      }
      t.comments.push(c);
    } else {
      const at = await locate(thread.uri);
      if (!at) {
        thread.dispose();
        notify.info('Review comments go on the files of a repository or its worktrees, or on a commit.');
        return;
      }
      const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === thread.uri.toString());
      const lines = document ? splitLines(document.getText()) : [];
      const range = thread.range || new vscode.Range(0, 0, 0, 0);
      const start = Math.max(0, range.start.line);
      const end = Math.max(start, Math.min(range.end.line, start + MAX_ANCHOR * 5));
      const root = at.ref ? await ownerOfCommit(at.repo, at.ref, at.root) : at.root;
      t = { id: newId(), root, repoRoot: at.repo.root, path: at.path, ref: at.ref, start, end, ...anchorOf(lines, start, end), comments: [c], time: c.time };
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      if (document) track(document, thread, t);
      else idOf.set(thread, t.id);
    }
    thread.comments = t.comments.map((x) => new ReviewComment(thread, x));
    decorate(thread, t);
    store.put([t]);
  }
  cmd('commitCorner.review.add', add);
  // The widget's button reads "Reply" once a thread has a comment: the same thing.
  cmd('commitCorner.review.reply', add);

  function deleteThread(thread) {
    const t = recordOf(thread);
    if (t) store.remove([t.id]);
    untrack(thread);
    if (thread && thread.dispose) thread.dispose();
  }
  cmd('commitCorner.review.deleteThread', deleteThread);

  const redraw = (comment) => (comment.thread.comments = [...comment.thread.comments]);
  cmd('commitCorner.review.editComment', (comment) => {
    if (!(comment instanceof ReviewComment)) return;
    comment.body = comment.savedBody; // edited as the text you wrote
    comment.mode = vscode.CommentMode.Editing;
    redraw(comment);
  });
  cmd('commitCorner.review.cancelEdit', (comment) => {
    if (!(comment instanceof ReviewComment)) return;
    comment.body = markdown(comment.savedBody);
    comment.mode = vscode.CommentMode.Preview;
    redraw(comment);
  });
  cmd('commitCorner.review.saveComment', (comment) => {
    if (!(comment instanceof ReviewComment)) return;
    const t = recordOf(comment.thread);
    const body = String(typeof comment.body === 'string' ? comment.body : comment.body.value).trim().slice(0, MAX_BODY);
    if (!t || !body) return;
    const c = t.comments.find((x) => x.id === comment.id);
    if (c) c.body = body;
    comment.savedBody = body;
    comment.body = markdown(body);
    comment.mode = vscode.CommentMode.Preview;
    redraw(comment);
    store.put([t]);
  });
  cmd('commitCorner.review.deleteComment', (comment) => {
    if (!(comment instanceof ReviewComment)) return;
    const t = recordOf(comment.thread);
    if (!t) return;
    t.comments = t.comments.filter((x) => x.id !== comment.id);
    if (!t.comments.length) {
      deleteThread(comment.thread);
      return;
    }
    comment.thread.comments = comment.thread.comments.filter((x) => x !== comment);
    store.put([t]);
  });

  /** The repository and branch of a root it knows (its own folder or one of its worktrees). */
  async function whose(root) {
    for (const r of manager.repositories) {
      if (same(rootOf(r), root)) return { repo: r, branch: (r.state && r.state.head && r.state.head.branch) || undefined, main: true };
      const w = (await worktreesOf(r)).find((x) => same(x.path, root));
      if (w) return { repo: r, branch: w.branch || undefined, main: false };
    }
    return undefined;
  }

  /** How a root is named to you: its branch, else its folder. */
  const nameOf = async (root) => {
    const w = await whose(root);
    return w && w.branch ? `branch ${w.branch}` : path.basename(root);
  };

  /**
   * The worktree (root) a command is for: the node's, the thread's or comment's, else (from the
   * keyboard) the one of the file in front of you, else picked from those with comments.
   */
  async function rootFor(arg, ask) {
    if (arg && typeof arg.worktreePath === 'string') return path.resolve(arg.worktreePath);
    if (arg && typeof arg.reviewRoot === 'string') return path.resolve(arg.reviewRoot);
    // A comment's (or thread's) menu: its worktree. One deleted since is nothing to act on (VS
    // Code then hands over its id only), never another worktree's comments.
    const comment = arg instanceof ReviewComment || (arg && typeof arg === 'object' && 'commentUniqueId' in arg);
    if (comment || (arg && typeof arg === 'object' && ('commentThreadHandle' in arg || idOf.has(arg)))) {
      const t = recordOf(comment ? arg.thread : arg);
      if (t) return t.root;
      notify.info('That review comment is gone (deleted since).');
      return CANCELLED;
    }
    const roots = store.roots();
    const here = await activeRoot();
    const mine = here && roots.find((r) => same(r, here));
    if (mine) return mine;
    if (roots.length <= 1) return roots[0];
    const items = [];
    for (const r of roots) {
      const w = await whose(r);
      items.push({ label: `$(${w && w.main ? 'repo' : 'folder'}) ${escapeIcons(w && w.branch ? w.branch : path.basename(r))}`, description: plural(store.forRoot(r).length, 'comment'), detail: escapeIcons(r), root: r });
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `${ask} of which worktree?`, matchOnDetail: true });
    return pick ? pick.root : CANCELLED;
  }
  const CANCELLED = Symbol('cancelled');

  /**
   * The worktree of the active editor's file. For a commit's revision: the one its comments are
   * filed under (an agent's, for its commits), if that is one worktree; else none (you pick).
   */
  async function activeRoot() {
    const ed = vscode.window.activeTextEditor;
    const at = ed && (await locate(ed.document.uri).catch(() => undefined));
    if (!at || !at.ref) return at && at.root;
    const roots = [...store.threads.values()].filter((t) => t.ref === at.ref && same(t.repoRoot, at.repo.root)).map((t) => t.root);
    return roots.length && roots.every((r) => same(r, roots[0])) ? roots[0] : undefined;
  }

  const noComments = () => notify.info(enabled() ? 'No review comments yet: add them with the + in the gutter of a file (or of a commit\'s diff).' : 'Review comments are turned off (setting commitCorner.review.comments).');

  /** Whether one of the root's comments is open for editing (its text is not saved yet). */
  const editing = (root) => [...shown.values()].some((set) => [...set].some((th) => {
    const t = recordOf(th);
    return t && same(t.root, root) && th.comments.some((c) => c.mode === vscode.CommentMode.Editing);
  }));
  const editingNote = () => notify.info('Save (or cancel) the comment you are editing first: the review takes the saved text.');

  /**
   * A file's lines now: an open editor's text, else the file (a regular one inside the
   * worktree), else the commit's; undefined when it is not there.
   */
  async function currentLines(repo, root, t) {
    if (t.ref) {
      if (!repo) return undefined;
      const size = await repo.blobSize(t.ref, t.path).catch(() => undefined);
      if (size === undefined || size > MAX_FILE) return undefined;
      const blob = await repo.show(t.ref, t.path).catch(() => null);
      return blob ? splitLines(await decode(blob, toGitUri(t.repoRoot, t.path, t.ref))) : undefined;
    }
    const abs = path.join(root, ...t.path.split('/'));
    const open = openDocument(abs);
    if (open) return splitLines(open.getText());
    if (!(await insideRoot(root, t.path))) return undefined;
    const { readAtMost } = require('../commands/fileCommands');
    const buf = await readAtMost(abs, MAX_FILE).catch(() => undefined);
    if (!buf) return undefined;
    // As VS Code reads it (files.encoding, a BOM), so the stored lines compare.
    return splitLines(await decode(buf, vscode.Uri.file(abs)));
  }

  /** Text as VS Code reads that file (files.encoding, a BOM), so the stored lines compare. */
  const decode = (buf, uri) => Promise.resolve().then(() => (vscode.workspace.decode ? vscode.workspace.decode(buf, { uri }) : buf.toString('utf8'))).catch(() => buf.toString('utf8'));

  /** The open editor of a working file, also when it was opened through the symlinked workspace path. */
  function openDocument(abs) {
    return vscode.workspace.textDocuments.find((d) => {
      if (d.uri.scheme !== 'file') return false;
      let p = path.resolve(d.uri.fsPath);
      for (const r of manager.repositories) {
        const display = path.resolve(r.displayRoot || r.root);
        if (!same(display, path.resolve(r.root)) && (same(p, display) || same(p.slice(0, display.length + 1), display + path.sep))) p = path.resolve(r.root) + p.slice(display.length);
      }
      return same(p, abs);
    });
  }

  /** A stored thread's place and title in every editor that shows it. */
  function redecorate(t) {
    for (const set of shown.values()) {
      for (const th of set) {
        if (idOf.get(th) !== t.id) continue;
        th.range = new vscode.Range(t.start, 0, t.end, 0);
        decorate(th, t);
      }
    }
  }

  /** The review of a root as text: each comment with the code it is about, as it is now. */
  async function build(root) {
    const threads = store.forRoot(root);
    if (!threads.length) return undefined;
    // Files are read only from a folder known now as the repository's or one of its worktrees.
    const w = await whose(root);
    const known = !!w && (w.main || (await w.repo.ownsWorktree(root).catch(() => false)));
    // Shown in an editor: kept in place by its edits; only checked there, never looked for elsewhere.
    const tracked = new Set();
    for (const set of shown.values()) for (const th of set) tracked.add(idOf.get(th));
    const files = new Map(); // one read per file (and commit), however many comments it has
    const out = [];
    const moved = [];
    for (const t of threads) {
      const key = `${t.ref || ''}\0${t.path}`;
      if (!files.has(key)) {
        const repo = manager.getRepository(t.repoRoot);
        const lines = t.ref || known ? await currentLines(repo, root, t) : undefined;
        files.set(key, lines && { lines, normed: t.ref ? undefined : normLines(lines) });
      }
      const file = files.get(key);
      if (!file) {
        out.push({ path: t.path, ref: t.ref, start: t.start, end: t.end, state: 'missing', code: t.anchor, comments: t.comments.map((c) => c.body) });
        continue;
      }
      if (!t.ref && tracked.has(t.id)) {
        const here = file.normed.slice(t.start, t.start + t.anchor.length);
        const outdated = here.length !== t.anchor.length || here.some((l, k) => l !== t.anchor[k].slice(0, MAX_LINE).trim());
        if (outdated !== !!t.outdated) {
          t.outdated = outdated;
          moved.push(t);
          redecorate(t);
        }
      } else if (!t.ref && follow(t, file.normed)) {
        moved.push(t);
        redecorate(t);
      }
      const state = t.outdated ? 'changed' : 'current';
      const here = file.lines.slice(t.start, Math.min(t.end, t.start + MAX_ANCHOR - 1) + 1);
      out.push({ path: t.path, ref: t.ref, start: t.start, end: t.end, state, code: state === 'current' ? here : t.anchor, now: state === 'changed' ? here : undefined, comments: t.comments.map((c) => c.body) });
    }
    if (moved.length) store.put(moved, true);
    return { text: reviewText({ name: path.basename(root), branch: w && w.branch, threads: out }), count: out.length, who: w };
  }

  cmd('commitCorner.review.copy', async (arg) => {
    const root = await rootFor(arg, 'Copy the review');
    if (root === CANCELLED) return;
    if (root && editing(root)) return void editingNote();
    const review = root && (await build(root));
    if (!review) return void noComments();
    await vscode.env.clipboard.writeText(review.text);
    const name = review.who && review.who.branch ? `branch ${review.who.branch}` : path.basename(root);
    // The command is done; the notification just says so.
    notify.info(`Copied ${plural(review.count, 'review comment')} (${plain(name)}) for your agent's chat.`).then(undefined, () => {});
  });

  cmd('commitCorner.review.save', async (arg) => {
    const root = await rootFor(arg, 'Save the review');
    if (root === CANCELLED) return;
    if (!root || !store.forRoot(root).length) return void noComments();
    if (editing(root)) return void editingNote();
    // Only a folder known now as the repository's or one of its worktrees (comments outlive them).
    const w = await whose(root);
    if (!w || (!w.main && !(await w.repo.ownsWorktree(root).catch(() => false)))) {
      notify.warn(`${plain(root)} is not a worktree of an open repository any more.`);
      return;
    }
    // The folder itself must not be a link (one put in its place since git listed it).
    if (await isLink(root)) {
      notify.warn(`${plain(root)} is a symbolic link now: the review was not saved.`);
      return;
    }
    const name = config().get('review.fileName', '.review-comments.md');
    if (!fileNameOk(name)) {
      notify.warn('commitCorner.review.fileName must be a plain file name (no folders, no device names).');
      return;
    }
    const review = await build(root);
    if (!review) {
      notify.info('No review comments yet.');
      return;
    }
    // Only a name that may be written (free, or an earlier review) gets ignored; then ignored
    // first (the file and its temporary twin), so git never sees it, even for a moment.
    try {
      await checkTarget(root, name);
    } catch (e) {
      notify.warn(`The review was not saved: ${plain(e.message)}`);
      return;
    }
    const ignored = await excludeFile(w.repo, name).then(() => true, (e) => {
      log().info(`Review file not excluded: ${e.message}`);
      return false;
    });
    try {
      await writeReview(root, name, review.text);
    } catch (e) {
      notify.warn(`The review was not saved: ${plain(e.message)}`);
      return;
    }
    const tell = `Read ${name} and address the review comments in it.`;
    const label = w.branch ? `branch ${w.branch}` : path.basename(root);
    notify[ignored ? 'info' : 'warn'](`Saved ${plural(review.count, 'review comment')} to ${plain(name)} in ${plain(label)}${ignored ? ' (ignored by git).' : '. It is NOT ignored by git: do not commit it.'}`, 'Copy Instruction', 'Open File').then(async (choice) => {
      if (choice === 'Copy Instruction') await vscode.env.clipboard.writeText(tell);
      else if (choice === 'Open File') await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, name)), { preview: false });
    }).then(undefined, (e) => log().warn(`Review file: ${e.message}`));
  });

  function clearRoot(root) {
    const ids = new Set(store.forRoot(root).map((t) => t.id));
    for (const set of [...shown.values()]) {
      for (const th of [...set]) {
        if (!ids.has(idOf.get(th))) continue;
        untrack(th);
        th.dispose();
      }
    }
    store.remove([...ids]);
  }

  cmd('commitCorner.review.clear', async (arg) => {
    const root = await rootFor(arg, 'Delete the review comments');
    if (root === CANCELLED) return;
    const threads = root ? store.forRoot(root) : [];
    if (!threads.length) return void noComments();
    // Counted as everywhere else (a comment with its replies is one), the replies said apart.
    const n = threads.length;
    const replies = threads.reduce((sum, t) => sum + t.comments.length - 1, 0);
    const files = [...new Set(threads.map((t) => t.path))].map((p) => path.posix.basename(p));
    const where = files.length > 3 ? `${files.slice(0, 3).join(', ')} and ${files.length - 3} more files` : files.join(', ');
    const detail = `In ${plain(where)}${replies ? `, with ${replies} ${replies === 1 ? 'reply' : 'replies'}` : ''}. This cannot be undone: copy or save the review first if the agent still needs it.`;
    if (!(await confirm(`Delete ${n === 1 ? 'the review comment' : `all ${n} review comments`} of ${plain(await nameOf(root))}?`, 'Delete', detail))) return;
    clearRoot(root);
  });

  // A comment's row in the Worktrees view: its file at its line (the commit's revision for one on a commit).
  cmd('commitCorner.review.open', async (arg) => {
    const t = arg && store.threads.get(arg.reviewThread);
    if (!t) return;
    const uri = t.ref ? toGitUri(t.repoRoot, t.path, t.ref) : vscode.Uri.file(path.join(t.root, ...t.path.split('/')));
    await vscode.window.showTextDocument(uri, { preview: true, selection: new vscode.Range(t.start, 0, t.start, 0) });
  });

  let had;
  const updateContext = () => {
    const has = store.threads.size > 0;
    if (has !== had) vscode.commands.executeCommand('setContext', 'commitCorner.hasReviewComments', (had = has));
  };
  ctx.extContext.subscriptions.push(store.onDidChange(updateContext));
  updateContext();
  return { store, controller };
}

/** A plain file name: no folders, no ".git", nothing Windows treats as a device or trims. */
function fileNameOk(name) {
  return typeof name === 'string' && /^[^\\/:*?"<>|\u0000-\u001f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]{1,100}$/.test(name) && !/^git~\d/i.test(name) && !/[. ]$/.test(name) && name !== '.' && name !== '..'
    && !/^\.git$/i.test(name) && !/^(con|prn|aux|nul|conin\$|conout\$|com[\d¹²³]|lpt[\d¹²³])\s*(\..*)?$/i.test(name);
}

/** Every folder from the root to the file is a real folder (no symlink to elsewhere), the file a regular one. */
async function insideRoot(root, rel) {
  if (!safeRelPath(rel)) return false;
  const parts = rel.split('/');
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    const st = await fs.promises.lstat(dir).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  }
  const st = await fs.promises.lstat(path.join(root, ...parts)).catch(() => null);
  return !!st && st.isFile();
}

/** Temporary twin of the review file while it is written (also kept from git). */
const tmpName = (name) => `.${name}.${newId()}.tmp`;

/**
 * Write the review file in the root: written beside it and renamed over it (never through a
 * symlink or a hard link), never over a file that is not an earlier review, and only while the
 * root is still the folder that was checked (not a symlink put there since).
 */
/** Whether a path is a symbolic link itself. */
const isLink = (p) => fs.promises.lstat(p).then((st) => st.isSymbolicLink(), () => false);

async function writeReview(root, name, text) {
  // Where the folder really is (a mapped drive, a symlinked parent are fine); the folder itself
  // must not be a link, and must still be the same folder when the file is renamed into it.
  if (await isLink(root)) throw new Error('the worktree folder is a link.');
  const real = await fs.promises.realpath(root);
  const file = path.join(root, name);
  await checkTarget(root, name);
  const tmp = path.join(root, tmpName(name));
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  try {
    const fh = await fs.promises.open(tmp, O_WRONLY | O_CREAT | O_EXCL | (O_NOFOLLOW || 0), 0o644);
    try {
      await fh.writeFile(text);
    } finally {
      await fh.close();
    }
    if ((await isLink(root)) || (await fs.promises.realpath(root)) !== real) throw new Error('the worktree folder changed while the review was written.');
    await renameOver(tmp, file);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true, maxRetries: 3 }).catch(() => {});
    throw e;
  }
}

/** The review file's name in the root may be written: free, or an earlier review (never another file). */
async function checkTarget(root, name) {
  const file = path.join(root, name);
  const st = await fs.promises.lstat(file).catch(() => null);
  if (!st) return;
  if (!st.isFile()) throw new Error(`${name} exists and is not a regular file.`);
  const { readAtMost } = require('../commands/fileCommands');
  const head = await readAtMost(file, MAX_FILE).catch(() => undefined);
  if (!head || !head.toString('utf8').replace(/^\uFEFF/, '').startsWith(REVIEW_HEADING)) throw new Error(`${name} exists and is not an earlier review: it is left as it is.`);
}

/** rename, again for a moment on Windows when a virus scanner or the indexer still holds the file. */
async function renameOver(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (e) {
      if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      await new Promise((res) => setTimeout(res, 100 * (attempt + 1)));
    }
  }
}

/**
 * Keep git from seeing the review file (and its temporary twin): lines in the repository's
 * info/exclude (shared by all its worktrees), once. Only in the repository's own git folder:
 * its git dir is the common dir (a main worktree) or one of the common dir's worktrees (a
 * linked one); a .git file that points elsewhere gets nothing written.
 */
async function excludeFile(repo, name) {
  const common = await fs.promises.realpath(repo.commonDir);
  const gitDir = await fs.promises.realpath(repo.gitDir);
  if (gitDir !== common && !gitDir.startsWith(path.join(common, 'worktrees') + path.sep)) throw new Error('the repository\'s git folder is not its own');
  const info = path.join(common, 'info');
  let st = await fs.promises.lstat(info).catch(() => null);
  if (!st) {
    await fs.promises.mkdir(info); // its parent is the repository's git folder
    st = await fs.promises.lstat(info);
  }
  if (!st.isDirectory()) throw new Error('info is not a folder');
  const file = path.join(info, 'exclude');
  const fst = await fs.promises.lstat(file).catch(() => null);
  if (fst && !fst.isFile()) throw new Error('info/exclude is not a regular file');
  const { readAtMost } = require('../commands/fileCommands');
  const buf = fst ? await readAtMost(file, MAX_FILE) : Buffer.alloc(0);
  if (!buf) throw new Error('info/exclude is too large');
  const existing = buf.toString('utf8');
  const glob = name.replace(/([*?[\\!#])/g, '\\$1');
  const wanted = [`/${glob}`, `/.${glob}.*.tmp`].filter((l) => !existing.split(/\r?\n/).includes(l));
  if (!wanted.length) return;
  const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants;
  const fh = await fs.promises.open(file, O_WRONLY | O_APPEND | O_CREAT | (O_NOFOLLOW || 0), 0o644);
  try {
    // The file opened is the one checked (not a link put in its place since).
    const [a, b] = [await fh.stat(), await fs.promises.lstat(file)];
    if (!a.isFile() || a.ino !== b.ino || a.dev !== b.dev || (await fs.promises.realpath(info)) !== info) throw new Error('info/exclude changed while it was written');
    await fh.write(`${existing && !existing.endsWith('\n') ? '\n' : ''}${wanted.join('\n')}\n`);
  } finally {
    await fh.close();
  }
}

module.exports = { register, get, same, ReviewStore, valid, insideRoot, excludeFile, writeReview, checkTarget, fileNameOk };
