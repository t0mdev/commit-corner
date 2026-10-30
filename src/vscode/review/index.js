'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const notify = require('../notify');
const { SCHEME, fromGitUri, toGitUri } = require('../uri');
const { safeRelPath } = require('../../git/repository');
const { config, debounce, log, shortSha, escapeIcons, confirm } = require('../util');
const { splitLines, anchorOf, relocate, reviewText, MAX_ANCHOR } = require('./format');

/**
 * Review comments for an agent: comments on lines of its work (its worktree's files, or a
 * commit in a diff), kept per worktree, sent back as one text to paste into its chat or saved
 * as a file in its worktree. They use VS Code's comment threads (the "+" in the gutter).
 *
 * A comment keeps the text of its lines, so it follows them when the file changes (an agent's
 * edit above it), and says so when they themselves changed. Kept in workspace state.
 */

const KEY = 'reviewComments';
const MAX_THREADS = 1000;
const MAX_BODY = 20000;
const MAX_FILE = 2 * 1024 * 1024;
const isFullSha = (s) => typeof s === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(s);
const same = (a, b) => (process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase());
/** Repository text (a path, a branch) in a one-line message: no $(icon) syntax, no control characters. */
const plain = (t) => escapeIcons(String(t).replace(/[\u0000-\u001f\u007f]/g, ' '));

/**
 * @typedef {{id: string, root: string, repoRoot: string, path: string, ref: string|null, start: number,
 *   end: number, anchor: string[], outdated?: boolean, comments: {id: string, body: string, time: number}[], time: number}} Thread
 */

/** The threads, by id; saved a moment after each change. */
class ReviewStore {
  constructor(memento) {
    this.memento = memento;
    /** @type {Map<string, Thread>} */
    this.threads = new Map();
    const saved = memento && memento.get(KEY);
    for (const t of Array.isArray(saved) ? saved : []) if (valid(t)) this.threads.set(t.id, t);
    this.emitter = new vscode.EventEmitter();
    /** Fires with the root (worktree) whose comments changed. */
    this.onDidChange = this.emitter.event;
    this.save = debounce(() => {
      if (this.memento) this.memento.update(KEY, [...this.threads.values()]).then(undefined, () => {});
    }, 500);
  }

  forRoot(root) {
    return [...this.threads.values()].filter((t) => same(t.root, root));
  }

  roots() {
    return [...new Set([...this.threads.values()].map((t) => t.root))];
  }

  put(t) {
    this.threads.delete(t.id);
    this.threads.set(t.id, t);
    // The oldest go first past the limit (a workspace reviewed for months).
    while (this.threads.size > MAX_THREADS) this.threads.delete(this.threads.keys().next().value);
    this.changed(t.root);
  }

  remove(id) {
    const t = this.threads.get(id);
    if (!t) return;
    this.threads.delete(id);
    this.changed(t.root);
  }

  clear(root) {
    for (const t of this.forRoot(root)) this.threads.delete(t.id);
    this.changed(root);
  }

  changed(root) {
    this.save();
    this.emitter.fire(root);
  }

  dispose() {
    if (this.memento) this.memento.update(KEY, [...this.threads.values()]).then(undefined, () => {});
    this.emitter.dispose();
  }
}

/** A stored thread as it must be (workspace state is ours, but never trusted blindly). */
function valid(t) {
  return !!t && typeof t.id === 'string' && typeof t.root === 'string' && path.isAbsolute(t.root) && typeof t.repoRoot === 'string'
    && safeRelPath(t.path) && (t.ref === null || isFullSha(t.ref)) && Number.isSafeInteger(t.start) && Number.isSafeInteger(t.end)
    && t.start >= 0 && t.end >= t.start && Array.isArray(t.anchor) && t.anchor.every((l) => typeof l === 'string')
    && Array.isArray(t.comments) && t.comments.length > 0 && t.comments.every((c) => c && typeof c.body === 'string' && typeof c.id === 'string');
}

const newId = () => crypto.randomBytes(8).toString('hex');

/** One comment of a thread in VS Code's widget. */
class ReviewComment {
  constructor(thread, c) {
    this.thread = thread; // the VS Code thread
    this.id = c.id;
    this.body = c.body;
    this.savedBody = c.body;
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

  /** Worktree paths per repository, looked up again after 15 seconds. */
  const worktreeCache = new Map();
  async function worktreesOf(repo) {
    const hit = worktreeCache.get(repo.root);
    if (hit && Date.now() - hit.at < 15000) return hit.paths;
    const paths = await repo.getWorktrees().then((list) => list.filter((w) => !w.bare).map((w) => path.resolve(w.path)), () => []);
    worktreeCache.set(repo.root, { at: Date.now(), paths });
    return paths;
  }

  /**
   * Where a document is in the review: its worktree (or repository) root, the file there, the
   * commit for a revision; undefined for anything else (a file outside every repository, the
   * index, a branch tip that moves).
   * @returns {Promise<{repo: any, root: string, path: string, ref: string|null}|undefined>}
   */
  async function locate(uri) {
    let repo;
    let ref = null;
    if (uri.scheme === SCHEME) {
      let q;
      try {
        q = fromGitUri(uri);
      } catch {
        return undefined;
      }
      if (q.empty || !isFullSha(q.ref)) return undefined;
      repo = manager.getRepository(q.repo);
      ref = q.ref;
    } else if (uri.scheme === 'file') {
      repo = manager.getRepositoryForUri(uri);
    } else return undefined;
    // An agent's worktree outside the repository's folder: every open repository's worktrees.
    const candidates = repo ? [repo] : manager.repositories;
    const abs = path.resolve(uri.fsPath);
    let best;
    for (const r of candidates) {
      for (const root of [path.resolve(r.displayRoot || r.root), path.resolve(r.root), ...(await worktreesOf(r))]) {
        const rel = path.relative(root, abs);
        if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
        if (!best || root.length > best.root.length) best = { repo: r, root, path: rel.split(path.sep).join('/') };
      }
    }
    if (!best || !safeRelPath(best.path)) return undefined;
    // A revision's path is git's (the URI's path may be a worktree's folder for the same file).
    if (ref) best.path = fromGitUri(uri).path;
    return safeRelPath(best.path) ? { ...best, ref } : undefined;
  }

  const controller = vscode.comments.createCommentController('commitCorner.review', 'Review for the agent');
  ctx.extContext.subscriptions.push(controller);
  controller.options = { prompt: 'Comment for the agent…', placeHolder: 'What should the agent change here?' };
  controller.commentingRangeProvider = {
    async provideCommentingRanges(document) {
      if (!config().get('review.comments', true)) return [];
      const at = await locate(document.uri).catch(() => undefined);
      return at ? [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)] : [];
    },
  };

  /** VS Code threads shown, by document URI; each knows its stored thread's id. */
  const shown = new Map();
  const RECORD = Symbol('reviewThread');

  function title(t) {
    return `For the agent${t.ref ? ` · in ${shortSha(t.ref)}` : ''}${t.outdated ? ' · these lines have changed' : ''}`;
  }

  function show(document, t) {
    const range = new vscode.Range(t.start, 0, t.end, 0);
    const thread = controller.createCommentThread(document.uri, range, []);
    thread[RECORD] = t.id;
    thread.comments = t.comments.map((c) => new ReviewComment(thread, c));
    decorate(thread, t);
    const key = document.uri.toString();
    if (!shown.has(key)) shown.set(key, new Set());
    shown.get(key).add(thread);
    return thread;
  }

  function decorate(thread, t) {
    thread.label = title(t);
    thread.canReply = true;
    thread.contextValue = t.outdated ? 'reviewThread:outdated' : 'reviewThread';
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  /** The stored threads of a document, found again in its text as it is now. */
  async function showFor(document) {
    const key = document.uri.toString();
    if (shown.has(key)) return;
    const at = await locate(document.uri).catch(() => undefined);
    if (!at) return;
    const mine = store.forRoot(at.root).filter((t) => t.path === at.path && t.ref === at.ref);
    if (!mine.length) return;
    const lines = splitLines(document.getText());
    for (const t of mine) {
      follow(t, lines);
      show(document, t);
    }
  }

  /** Move a thread to where its lines are now; "changed" when they are not there any more. */
  function follow(t, lines) {
    if (t.ref) return false; // a revision never changes
    const at = relocate(lines, t.start, t.anchor);
    const outdated = at === undefined;
    const start = outdated ? Math.min(t.start, Math.max(0, lines.length - 1)) : at;
    const moved = start !== t.start || outdated !== !!t.outdated;
    if (moved) {
      t.end = start + (t.end - t.start);
      t.start = start;
      t.outdated = outdated;
    }
    return moved;
  }

  const reflow = new Map();
  ctx.extContext.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((d) => showFor(d).catch((e) => log().warn(`Review comments: ${e.message}`))),
    vscode.workspace.onDidCloseTextDocument((d) => {
      const key = d.uri.toString();
      for (const th of shown.get(key) || []) th.dispose();
      shown.delete(key);
    }),
    // Edits (yours, or the agent's on disk): the threads follow their lines, a moment later.
    vscode.workspace.onDidChangeTextDocument((e) => {
      const key = e.document.uri.toString();
      if (!shown.has(key)) return;
      clearTimeout(reflow.get(key));
      reflow.set(key, setTimeout(() => {
        reflow.delete(key);
        const lines = splitLines(e.document.getText());
        for (const th of shown.get(key) || []) {
          const t = store.threads.get(th[RECORD]);
          if (!t || !follow(t, lines)) continue;
          th.range = new vscode.Range(t.start, 0, t.end, 0);
          decorate(th, t);
          store.put(t);
        }
      }, 400));
    }),
    { dispose: () => reflow.forEach((h) => clearTimeout(h)) },
  );
  for (const d of vscode.workspace.textDocuments) showFor(d).catch(() => {});

  /** The VS Code thread's stored thread (a new one: none yet). */
  const recordOf = (thread) => thread && store.threads.get(thread[RECORD]);

  // Add Comment / Reply (the widget's button): a new thread is stored with its lines' text.
  async function add(reply) {
    const thread = reply && reply.thread;
    const text = reply && typeof reply.text === 'string' ? reply.text.trim().slice(0, MAX_BODY) : '';
    if (!thread || !text) return;
    const c = { id: newId(), body: text, time: Date.now() };
    let t = recordOf(thread);
    if (t) {
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
      t = { id: newId(), root: at.root, repoRoot: at.repo.root, path: at.path, ref: at.ref, start, end, anchor: anchorOf(lines, start, end), comments: [c], time: c.time };
      thread[RECORD] = t.id;
      const key = thread.uri.toString();
      if (!shown.has(key)) shown.set(key, new Set());
      shown.get(key).add(thread);
    }
    thread.comments = t.comments.map((x) => new ReviewComment(thread, x));
    decorate(thread, t);
    store.put(t);
  }
  cmd('commitCorner.review.add', add);
  // The widget's button reads "Reply" once a thread has a comment: the same thing.
  cmd('commitCorner.review.reply', add);

  function deleteThread(thread) {
    const t = recordOf(thread);
    if (t) store.remove(t.id);
    for (const set of shown.values()) set.delete(thread);
    if (thread && thread.dispose) thread.dispose();
  }
  cmd('commitCorner.review.deleteThread', deleteThread);

  cmd('commitCorner.review.editComment', (comment) => {
    if (!(comment instanceof ReviewComment)) return;
    comment.mode = vscode.CommentMode.Editing;
    comment.thread.comments = [...comment.thread.comments];
  });
  cmd('commitCorner.review.cancelEdit', (comment) => {
    if (!(comment instanceof ReviewComment)) return;
    comment.body = comment.savedBody;
    comment.mode = vscode.CommentMode.Preview;
    comment.thread.comments = [...comment.thread.comments];
  });
  cmd('commitCorner.review.saveComment', (comment) => {
    if (!(comment instanceof ReviewComment)) return;
    const t = recordOf(comment.thread);
    const body = String(typeof comment.body === 'string' ? comment.body : comment.body.value).trim().slice(0, MAX_BODY);
    if (!t || !body) return;
    const c = t.comments.find((x) => x.id === comment.id);
    if (c) c.body = body;
    comment.body = comment.savedBody = body;
    comment.mode = vscode.CommentMode.Preview;
    comment.thread.comments = [...comment.thread.comments];
    store.put(t);
  });
  cmd('commitCorner.review.deleteComment', async (comment) => {
    if (!(comment instanceof ReviewComment)) return;
    const t = recordOf(comment.thread);
    if (!t) return;
    t.comments = t.comments.filter((x) => x.id !== comment.id);
    if (!t.comments.length) {
      deleteThread(comment.thread);
      return;
    }
    comment.thread.comments = comment.thread.comments.filter((x) => x !== comment);
    store.put(t);
  });

  /** The worktree (root) a command is for: the node's, the thread's, else picked from those with comments. */
  async function rootFor(arg) {
    if (arg && typeof arg.worktreePath === 'string') return path.resolve(arg.worktreePath);
    if (arg && typeof arg.reviewRoot === 'string') return arg.reviewRoot;
    const t = recordOf(arg);
    if (t) return t.root;
    const roots = store.roots();
    if (roots.length <= 1) return roots[0];
    const pick = await vscode.window.showQuickPick(roots.map((r) => ({ label: `$(folder) ${escapeIcons(path.basename(r))}`, description: `${store.forRoot(r).length} comment${store.forRoot(r).length === 1 ? '' : 's'}`, detail: escapeIcons(r), root: r })), { placeHolder: 'Review comments of which worktree?' });
    return pick && pick.root;
  }

  /** The review of a root as text: each comment with the code it is about, as it is now. */
  async function build(root) {
    const threads = store.forRoot(root);
    if (!threads.length) return undefined;
    const repo = manager.getRepository(threads[0].repoRoot) || manager.repositories.find((r) => same(path.resolve(r.root), root));
    const out = [];
    for (const t of threads) {
      const lines = await currentLines(repo, root, t);
      let { start, end } = t;
      let outdated = !!t.outdated;
      if (lines && !t.ref) {
        // Where its lines are now, kept (a later change to them then says where they were last).
        if (follow(t, lines)) store.put(t);
        ({ start, end } = t);
        outdated = !!t.outdated;
      }
      const code = lines && !outdated ? lines.slice(start, Math.min(end, start + MAX_ANCHOR - 1) + 1) : t.anchor;
      out.push({ path: t.path, ref: t.ref, start, end, outdated, code, comments: t.comments.map((c) => c.body) });
    }
    const branch = await branchOf(root);
    return { text: reviewText({ name: path.basename(root), branch, threads: out }), count: out.length, branch };
  }

  /** A file's lines now: an open editor's text, else the file (a regular one inside the worktree), else the commit's. */
  async function currentLines(repo, root, t) {
    if (t.ref) {
      if (!repo) return undefined;
      const size = await repo.blobSize(t.ref, t.path).catch(() => undefined);
      if (size === undefined || size > MAX_FILE) return undefined;
      const blob = await repo.show(t.ref, t.path).catch(() => null);
      return blob ? splitLines(blob.toString('utf8')) : undefined;
    }
    const abs = path.join(root, ...t.path.split('/'));
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && same(path.resolve(d.uri.fsPath), abs));
    if (open) return splitLines(open.getText());
    if (!(await insideRoot(root, t.path))) return undefined;
    const { readAtMost } = require('../commands/fileCommands');
    const buf = await readAtMost(abs, MAX_FILE).catch(() => undefined);
    return buf ? splitLines(buf.toString('utf8')) : undefined;
  }

  /** The worktree's current branch, read from its HEAD file (no git run in a folder for it). */
  async function branchOf(root) {
    for (const r of manager.repositories) {
      if (same(path.resolve(r.root), root)) return r.state && r.state.head && r.state.head.branch || undefined;
    }
    for (const r of manager.repositories) {
      const list = await r.getWorktrees().catch(() => []);
      const w = list.find((x) => same(path.resolve(x.path), root));
      if (w) return w.branch || undefined;
    }
    return undefined;
  }

  cmd('commitCorner.review.copy', async (arg) => {
    const root = await rootFor(arg);
    const review = root && (await build(root));
    if (!review) {
      notify.info('No review comments yet: add them with the + in the gutter of a file (or of a commit\'s diff).');
      return;
    }
    await vscode.env.clipboard.writeText(review.text);
    // The command is done; the notification's answer comes whenever it comes.
    notify.info(`Copied ${review.count} review comment${review.count === 1 ? '' : 's'} for ${plain(review.branch || path.basename(root))}: paste them into the agent's chat.`, 'Clear Comments', 'Keep').then((choice) => {
      if (choice === 'Clear Comments') clearRoot(root);
    }, () => {});
  });

  cmd('commitCorner.review.save', async (arg) => {
    const root = await rootFor(arg);
    const review = root && (await build(root));
    if (!review) {
      notify.info('No review comments yet.');
      return;
    }
    const name = config().get('review.fileName', '.review-comments.md');
    if (typeof name !== 'string' || !/^[^\\/:*?"<>|\u0000-\u001f]+$/.test(name) || name === '.' || name === '..' || /^\.git$/i.test(name.replace(/[. ]+$/, ''))) {
      notify.warn('commitCorner.review.fileName must be a plain file name (no folders).');
      return;
    }
    const file = path.join(root, name);
    await writeReview(file, review.text);
    await excludeFile(root, name).catch((e) => log().info(`Review file not excluded: ${e.message}`));
    const tell = `Read ${name} and address the review comments in it.`;
    notify.info(`Saved ${review.count} review comment${review.count === 1 ? '' : 's'} to ${plain(name)} in ${plain(path.basename(root))} (git ignores it). Tell the agent: "${plain(tell)}"`, 'Copy That', 'Open File').then(async (choice) => {
      if (choice === 'Copy That') await vscode.env.clipboard.writeText(tell);
      else if (choice === 'Open File') await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
    }).then(undefined, (e) => log().warn(`Review file: ${e.message}`));
  });

  function clearRoot(root) {
    for (const t of store.forRoot(root)) {
      for (const [key, set] of shown) {
        for (const th of [...set]) {
          if (th[RECORD] === t.id) {
            th.dispose();
            set.delete(th);
          }
        }
        if (!set.size) shown.delete(key);
      }
    }
    store.clear(root);
  }

  cmd('commitCorner.review.clear', async (arg) => {
    const root = await rootFor(arg);
    if (!root) return;
    const n = store.forRoot(root).length;
    if (!n) return;
    if (!(await confirm(`Delete the ${n} review comment${n === 1 ? '' : 's'} of ${plain(path.basename(root))}?`, 'Delete'))) return;
    clearRoot(root);
  });

  // A comment's row in the Worktrees view: its file at its line (the commit's revision for one on a commit).
  cmd('commitCorner.review.open', async (arg) => {
    const t = arg && store.threads.get(arg.reviewThread);
    if (!t) return;
    const uri = t.ref ? toGitUri(t.repoRoot, t.path, t.ref) : vscode.Uri.file(path.join(t.root, ...t.path.split('/')));
    await vscode.window.showTextDocument(uri, { preview: true, selection: new vscode.Range(t.start, 0, t.start, 0) });
  });

  const updateContext = () => vscode.commands.executeCommand('setContext', 'commitCorner.hasReviewComments', store.threads.size > 0);
  ctx.extContext.subscriptions.push(store.onDidChange(updateContext));
  updateContext();
  return { store, controller };
}

/** Every folder from the root to the file is a real folder (no symlink to elsewhere, no .git). */
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

/** Write the review file: never through a symlink, never over something that is not a regular file. */
async function writeReview(file, text) {
  const st = await fs.promises.lstat(file).catch(() => null);
  if (st && !st.isFile()) throw new Error(`${path.basename(file)} exists and is not a regular file.`);
  const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = fs.constants;
  const fh = await fs.promises.open(file, O_WRONLY | O_CREAT | O_TRUNC | (O_NOFOLLOW || 0), 0o644);
  try {
    await fh.writeFile(text);
  } finally {
    await fh.close();
  }
}

/**
 * Keep git from seeing the review file: its name in the repository's info/exclude (shared by
 * all its worktrees), once. The worktree's .git file says where that is.
 */
async function excludeFile(root, name) {
  const dotGit = path.join(root, '.git');
  const st = await fs.promises.lstat(dotGit);
  let common;
  if (st.isDirectory()) common = dotGit;
  else if (st.isFile()) {
    const m = /^gitdir: (.+?)\s*$/m.exec(await fs.promises.readFile(dotGit, 'utf8'));
    if (!m) return;
    const gitDir = path.resolve(root, m[1]);
    const c = await fs.promises.readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => '');
    common = c.trim() ? path.resolve(gitDir, c.trim()) : gitDir;
  } else return;
  const info = path.join(common, 'info');
  await fs.promises.mkdir(info, { recursive: true });
  const file = path.join(info, 'exclude');
  const fst = await fs.promises.lstat(file).catch(() => null);
  if (fst && !fst.isFile()) return;
  const existing = fst ? await fs.promises.readFile(file, 'utf8') : '';
  const line = `/${name.replace(/([*?[\\!#])/g, '\\$1')}`;
  if (existing.split(/\r?\n/).includes(line)) return;
  const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants;
  const fh = await fs.promises.open(file, O_WRONLY | O_APPEND | O_CREAT | (O_NOFOLLOW || 0), 0o644);
  try {
    await fh.write(`${existing && !existing.endsWith('\n') ? '\n' : ''}${line}\n`);
  } finally {
    await fh.close();
  }
}

module.exports = { register, get, ReviewStore, valid, insideRoot, excludeFile, writeReview };
