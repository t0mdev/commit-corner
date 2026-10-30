'use strict';

const vscode = require('vscode');
const crypto = require('crypto');

const KEY = 'viewedFiles';
const MAX_SCOPES = 100;

/**
 * "Viewed" marks, like GitHub's checkbox on each file of a pull request: per scope (a pull
 * request, a worktree compared with its base) and file, the fingerprint of the content you
 * looked at (its blob id). A file that changes again (the agent edits it, the PR gets a new
 * push) has another fingerprint, so it is unviewed again by itself. Kept in workspace state;
 * the least recently used scopes are forgotten past 100.
 */
class ViewedStore {
  /** @param {vscode.Memento|undefined} memento */
  constructor(memento) {
    this.memento = memento;
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
  }

  all() {
    const v = this.memento && this.memento.get(KEY);
    return v && typeof v === 'object' ? v : {};
  }

  /** Whether `file` was viewed with this fingerprint (undefined fingerprint: never viewed). */
  isViewed(scope, file, fingerprint) {
    const s = this.all()[scope];
    return !!(fingerprint && s && s.files && s.files[file] === fingerprint);
  }

  /** @param {{path: string, fingerprint?: string}[]} files */
  count(scope, files) {
    return files.filter((f) => this.isViewed(scope, f.path, f.fingerprint)).length;
  }

  /**
   * Mark or unmark files.
   * @param {{path: string, fingerprint?: string}[]} files
   */
  async set(scope, files, viewed) {
    const all = { ...this.all() };
    const s = { files: { ...((all[scope] && all[scope].files) || {}) }, used: Date.now() };
    for (const f of files) {
      if (viewed && f.fingerprint) s.files[f.path] = f.fingerprint;
      else delete s.files[f.path];
    }
    if (Object.keys(s.files).length) all[scope] = s;
    else delete all[scope];
    const scopes = Object.keys(all);
    if (scopes.length > MAX_SCOPES) {
      scopes.sort((a, b) => (all[a].used || 0) - (all[b].used || 0));
      for (const old of scopes.slice(0, scopes.length - MAX_SCOPES)) delete all[old];
    }
    if (this.memento) await this.memento.update(KEY, all);
    this.emitter.fire(scope);
  }

  dispose() {
    this.emitter.dispose();
  }
}

/** The checkbox of a file row: checked when viewed with the current content. */
function checkbox(store, scope, file, fingerprint) {
  const viewed = store.isViewed(scope, file, fingerprint);
  return {
    state: viewed ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
    tooltip: viewed ? 'Viewed (unchecks itself when the file changes again)' : 'Mark as viewed',
    accessibilityInformation: { label: viewed ? 'Viewed' : 'Not viewed', role: 'checkbox' },
  };
}

/**
 * Checkbox clicks in a tree: remember the marks of file rows (nodes with `viewed: {scope,
 * fingerprint, owner}`), then redraw their owners (which say "N of M viewed").
 * @param {vscode.TreeView<any>} treeView
 * @param {{refresh(node?: any): void}} provider
 */
function watchCheckboxes(treeView, provider) {
  return treeView.onDidChangeCheckboxState(async (e) => {
    const owners = new Set();
    // One write per scope and state, however many boxes changed at once.
    const batches = new Map();
    for (const [node, state] of e.items) {
      if (!node || !node.viewed) continue;
      owners.add(node.viewed.owner);
      if (!node.viewed.fingerprint) {
        // A symlink, a submodule, an unreadable file: nothing to compare later.
        vscode.window.setStatusBarMessage(`"${node.path}" cannot be marked as viewed: its content cannot be fingerprinted`, 4000);
        continue;
      }
      const on = state === vscode.TreeItemCheckboxState.Checked;
      const key = `${on}\0${node.viewed.scope}`;
      if (!batches.has(key)) batches.set(key, { scope: node.viewed.scope, on, files: [] });
      batches.get(key).files.push({ path: node.path, fingerprint: node.viewed.fingerprint });
    }
    for (const b of batches.values()) await get().set(b.scope, b.files, b.on);
    for (const o of owners) provider.refresh(o);
  });
}

const CHANGES_KEY = 'viewedChanges';
const MAX_CHANGES = 10000;
const MAX_COMMITS = 500;
const BLOB = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * The files of commits you opened: the others are bold until you open them
 * (commitCorner.markUnviewedFiles). A mark belongs to the change, not to the commit: the file's
 * path and its blob ids before and after. An amended or rebased commit (an agent's) is a new
 * commit, but the files it did not change differently keep their marks. Marks are short hashes,
 * kept in memory and written to workspace state a second after a change (opening file after file
 * is one write, ~150 KB at most); the 10000 most recently marked are remembered. So are the 500 commits you last marked something in (their rows say "3/12").
 */
class ChangeMarks {
  /** @param {vscode.Memento|undefined} memento */
  constructor(memento) {
    this.memento = memento;
    const saved = memento && memento.get(CHANGES_KEY);
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    /** Least recently marked first (a Set keeps insertion order). */
    this.keys = new Set(list(saved && saved.keys).slice(-MAX_CHANGES));
    this.commits = new Set(list(saved && saved.commits).slice(-MAX_COMMITS));
    this.emitter = new vscode.EventEmitter();
    /** Fires with the keys whose mark changed, and the commit they were marked in (if any). */
    this.onDidChange = this.emitter.event;
    this.timer = undefined;
  }

  /** The mark of one file of commit `sha`: its change when the blob ids are known, else the commit's file. */
  static key(sha, f) {
    const parts = BLOB.test(f.oldBlob || '') && BLOB.test(f.newBlob || '') ? ['c', f.path, f.oldBlob, f.newBlob] : ['f', sha, f.path];
    return crypto.createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 12);
  }

  /**
   * The mark of an uncommitted file: its group's side (staged: the index, else the working file)
   * and that content's blob id, so an edit makes it unviewed again. undefined without an id.
   */
  static worktreeKey(group, relPath, id) {
    if (!BLOB.test(id || '')) return undefined;
    const parts = ['w', group === 'staged' ? 'index' : 'work', relPath, id];
    return crypto.createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 12);
  }

  has(key) {
    return this.keys.has(key);
  }

  /** Whether commit `sha` has had anything marked (its row shows the count once it is known). */
  touched(sha) {
    return this.commits.has(sha);
  }

  /** @param {string[]} keys @param {boolean} on @param {string} [sha] the commit they are from */
  set(keys, on, sha) {
    const changed = keys.filter((k) => this.keys.has(k) !== on);
    // A commit you start on (even when its changes were all marked before, in the commit an
    // amend replaced) shows its count from now on.
    const started = on && !!sha && !this.commits.has(sha);
    if (on && sha) {
      this.commits.delete(sha);
      this.commits.add(sha);
      while (this.commits.size > MAX_COMMITS) this.commits.delete(this.commits.values().next().value);
    }
    // Marked again (opened again): the most recent, last to be forgotten.
    const refreshed = on && keys.length > changed.length;
    for (const k of on ? keys : changed) {
      this.keys.delete(k);
      if (on) this.keys.add(k);
    }
    if (!changed.length && !started) {
      if (refreshed) this.save();
      return;
    }
    while (this.keys.size > MAX_CHANGES) this.keys.delete(this.keys.values().next().value);
    this.save();
    this.emitter.fire({ keys: new Set(changed), sha });
  }

  /** Written a moment later: opening file after file is one write. */
  save() {
    if (!this.memento || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1000);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.memento) this.memento.update(CHANGES_KEY, { keys: [...this.keys], commits: [...this.commits] }).then(undefined, () => {});
  }

  dispose() {
    if (this.timer) this.flush();
    this.emitter.dispose();
  }
}

/** @type {ViewedStore|undefined} */
let store;
/** @type {ChangeMarks|undefined} */
let changes;

function init(memento) {
  store = new ViewedStore(memento);
  changes = new ChangeMarks(memento);
  const both = [store, changes];
  return { dispose: () => both.forEach((s) => s.dispose()) };
}

function get() {
  if (!store) store = new ViewedStore(undefined);
  return store;
}

/** The viewed marks of commit files. */
function commitMarks() {
  if (!changes) changes = new ChangeMarks(undefined);
  return changes;
}

const marksUnviewed = () => require('./util').config().get('markUnviewedFiles', true);

/** Whether you opened file `f` ({path, oldBlob?, newBlob?}) of commit `sha`, or marked it viewed. */
const commitFileViewed = (sha, f) => commitMarks().has(ChangeMarks.key(sha, f));

/** Whether file `f` of commit `sha` should look unviewed (bold): not opened yet, and the setting on. */
const commitFileUnviewed = (sha, f) => marksUnviewed() && !commitFileViewed(sha, f);

/**
 * Mark files of commit `sha` as viewed (or not). A commit with more files than a tenth of what is
 * remembered is marked up to that, so one huge commit never pushes every other mark out.
 */
function markCommitFiles(sha, files, on = true) {
  commitMarks().set(files.slice(0, MAX_CHANGES / 10).map((f) => ChangeMarks.key(sha, f)), on, sha);
}

/**
 * The dot on a commit's file in the tree views until you open it: their rows carry the mark key
 * in their resource URI (`…#commit-corner-history`, query `vk=<key>`).
 */
function registerDecorations() {
  const changed = new vscode.EventEmitter();
  const subs = [
    changed,
    commitMarks().onDidChange(() => changed.fire(undefined)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('commitCorner.markUnviewedFiles')) changed.fire(undefined);
    }),
    vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: changed.event,
      provideFileDecoration(uri) {
        if (uri.fragment !== 'commit-corner-history' || !uri.query.startsWith('vk=') || !marksUnviewed()) return undefined;
        if (commitMarks().has(uri.query.slice(3))) return undefined;
        return new vscode.FileDecoration('●', 'Not viewed', new vscode.ThemeColor('textLink.foreground'));
      },
    }),
  ];
  return { dispose: () => subs.forEach((d) => d.dispose()) };
}

/** "3 of 12": how many files of a commit are viewed. */
function commitCount(sha, files) {
  const m = commitMarks();
  return { viewed: files.filter((f) => m.has(ChangeMarks.key(sha, f))).length, total: files.length };
}

module.exports = { registerDecorations, ViewedStore, ChangeMarks, checkbox, watchCheckboxes, init, get, commitMarks, commitFileViewed, commitFileUnviewed, markCommitFiles, commitCount, marksUnviewed };
