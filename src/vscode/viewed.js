'use strict';

const vscode = require('vscode');
const crypto = require('crypto');

const KEY = 'viewedFiles';
const MAX_SCOPES = 100;
const MAX_FILES = 200000;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/** Whether an object has any key (without listing them all). */
function hasKeys(o) {
  for (const k in o) if (own(o, k)) return true;
  return false;
}

/**
 * "Viewed" marks of a pull request's files and of a worktree's changes (a dot until you open a
 * file, like a commit's files): per scope (a pull request, a worktree compared with its base)
 * and file, the fingerprint of the content you looked at (its blob id). A file that changes
 * again (the agent edits it, the PR gets a new push) has another fingerprint, so it is unviewed
 * again by itself. Kept in memory and written to workspace state a second after the first
 * change since the last write (opening file after file is one write); the least recently used
 * scopes are forgotten past 100 scopes or 200000 files in all.
 */
class ViewedStore {
  /** @param {vscode.Memento|undefined} memento */
  constructor(memento) {
    this.memento = memento;
    /** The marks as last written or set (read from workspace state once). */
    this.data = undefined;
    this.timer = undefined;
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
    /** The files whose mark changed: {scope, paths} (the dots redraw only those). */
    this.filesEmitter = new vscode.EventEmitter();
    this.onDidChangeFiles = this.filesEmitter.event;
  }

  all() {
    if (!this.data) {
      const v = this.memento && this.memento.get(KEY);
      this.data = v && typeof v === 'object' ? v : {};
    }
    return this.data;
  }

  /** Whether `file` was viewed with this fingerprint (undefined fingerprint: never viewed). */
  isViewed(scope, file, fingerprint) {
    const all = this.all();
    const s = Object.prototype.hasOwnProperty.call(all, scope) ? all[scope] : undefined;
    // Own properties only: a file named "__proto__" or "constructor" is a file like any other.
    return !!(fingerprint && s && s.files && Object.prototype.hasOwnProperty.call(s.files, file) && s.files[file] === fingerprint);
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
    // Changed in place (only this store holds it): a mark does not copy the other marks. Objects
    // without a prototype: any file name (even "__proto__") is a plain key.
    if (!this.owned) {
      this.data = Object.assign(Object.create(null), this.all());
      this.owned = true;
    }
    const all = this.data;
    let s = own(all, scope) && all[scope] && all[scope].files ? all[scope] : undefined;
    if (!s) s = { files: Object.create(null), used: 0 };
    else if (Object.getPrototypeOf(s.files) !== null) s = { files: Object.assign(Object.create(null), s.files), used: s.used };
    s.used = Date.now();
    for (const f of files) {
      if (viewed && f.fingerprint) s.files[f.path] = f.fingerprint;
      else delete s.files[f.path];
    }
    if (hasKeys(s.files)) all[scope] = s;
    else delete all[scope];
    this.save();
    this.emitter.fire(scope);
    this.filesEmitter.fire({ scope, paths: files.map((f) => f.path) });
  }

  /** Written a moment later: opening file after file is one write. */
  save() {
    if (!this.memento || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1000);
    if (this.timer.unref) this.timer.unref();
  }

  /** The least recently used scopes go past 100 scopes or 200000 files (done when written). */
  prune() {
    const all = this.data;
    if (!all) return;
    const scopes = Object.keys(all).sort((a, b) => (all[a].used || 0) - (all[b].used || 0));
    let total = scopes.reduce((n, k) => n + Object.keys(all[k].files || {}).length, 0);
    let count = scopes.length;
    // Never the newest (the one marked last): it stays, however large.
    for (const k of scopes.slice(0, -1)) {
      if (count <= MAX_SCOPES && total <= MAX_FILES) break;
      total -= Object.keys(all[k].files || {}).length;
      count--;
      delete all[k];
    }
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.prune();
    if (this.memento && this.data) return Promise.resolve(this.memento.update(KEY, this.data)).then(undefined, () => {});
    return Promise.resolve();
  }

  dispose() {
    if (this.timer) this.flush();
    this.emitter.dispose();
    this.filesEmitter.dispose();
  }
}

/**
 * The files of a pull request's "Files changed" and of a worktree's "Changes vs …" carry their
 * mark in their row's resource URI (query `vs=<key>`), like a commit's files: the decoration
 * provider looks the key up here. Keys are hashes of scope, path and fingerprint, so a row drawn
 * again finds its entry; the oldest are forgotten past MAX_SCOPED (a row that old is redrawn
 * with a fresh key long before).
 */
const MAX_SCOPED = 200000;
const scopedRows = new Map();
/** scope -> its keys in scopedRows (a mark redraws the dots of its list only) */
const scopedByScope = new Map();
/** A file of a list (scope and path) -> its current key. */
const scopedPlaces = new Map();

/** The key of a file of a list with viewed marks (registered for the decorations). */
function scopedKey(scope, file, fingerprint) {
  // The whole hash: these keys are never stored, and no file can take another one's dot.
  const key = crypto.createHash('sha1').update(['s', scope, file, fingerprint || ''].join('\0')).digest('hex');
  // One entry per file of a list: its contents changed (a new key), the old entry goes.
  const place = `${scope}\0${file}`;
  const previous = scopedPlaces.get(place);
  if (previous && previous !== key) dropScoped(previous);
  scopedPlaces.set(place, key);
  const before = scopedRows.get(key);
  scopedRows.delete(key);
  scopedRows.set(key, { scope, file, fingerprint, uri: before && before.uri });
  if (!scopedByScope.has(scope)) scopedByScope.set(scope, new Set());
  scopedByScope.get(scope).add(key);
  while (scopedRows.size > MAX_SCOPED) dropScoped(scopedRows.keys().next().value);
  return key;
}

function dropScoped(key) {
  const entry = scopedRows.get(key);
  if (!entry) return;
  scopedRows.delete(key);
  const keys = scopedByScope.get(entry.scope);
  if (keys) {
    keys.delete(key);
    if (!keys.size) scopedByScope.delete(entry.scope);
  }
  const place = `${entry.scope}\0${entry.file}`;
  if (scopedPlaces.get(place) === key) scopedPlaces.delete(place);
}

/** The dots shown for these files of a list (their URIs), to redraw just those. */
function scopedUris(scope, paths) {
  const want = new Set(paths);
  const out = [];
  for (const k of scopedByScope.get(scope) || []) {
    const r = scopedRows.get(k);
    if (r && r.uri && want.has(r.file)) out.push(r.uri);
  }
  return out;
}

/**
 * Folders of file trees with marks (a pull request's, a comparison's, a commit's): a dot while a
 * file in them is not viewed. key -> {files (rows with unviewed() and markId()), uri}. The key
 * covers the folder's list, path and its files' contents, so a file that changes gives the folder
 * a new key (VS Code asks for its dot again) and two lists never share a folder's entry. Each
 * file's markId points back to the folders it is in (a mark redraws just those).
 */
const MAX_FOLDERS = 50000;
const folderRows = new Map();
const foldersOf = new Map();
/** A folder's place (its list and path) -> its current key. */
const folderPlaces = new Map();

/**
 * @param {any[]} files the folder's file rows (and its sub-folders')
 * @param {string} id its list, path and a digest of its files' contents (see fileNodes)
 */
function folderKey(files, id) {
  const key = crypto.createHash('sha1').update(`d\0${id}`).digest('hex');
  // One entry per folder of a list: its contents changed (a new key), the old entry goes, and
  // with it the old rows it held.
  const place = id.slice(0, id.lastIndexOf('\0'));
  const previous = folderPlaces.get(place);
  if (previous && previous !== key) dropFolder(previous);
  folderPlaces.set(place, key);
  const before = folderRows.get(key);
  folderRows.delete(key);
  folderRows.set(key, { files, place, uri: before && before.uri });
  // The same key: the same files (by content), already indexed.
  if (!before) {
    for (const f of files) {
      const m = f.markId();
      if (!foldersOf.has(m)) foldersOf.set(m, new Set());
      foldersOf.get(m).add(key);
    }
  }
  while (folderRows.size > MAX_FOLDERS) dropFolder(folderRows.keys().next().value);
  return key;
}

function dropFolder(key) {
  const entry = folderRows.get(key);
  if (!entry) return;
  for (const f of entry.files) {
    const m = f.markId();
    const set = foldersOf.get(m);
    if (set) {
      set.delete(key);
      if (!set.size) foldersOf.delete(m);
    }
  }
  folderRows.delete(key);
  if (folderPlaces.get(entry.place) === key) folderPlaces.delete(entry.place);
}

/** The URIs of the folders shown with any of these files (by markId), to redraw their dots. */
function foldersWith(ids) {
  const out = new Set();
  for (const id of ids) {
    for (const key of foldersOf.get(id) || []) {
      const f = folderRows.get(key);
      if (f && f.uri) out.add(f.uri);
    }
  }
  return [...out];
}

/** What a file can be fingerprinted as (its blob id, or "deleted"): only those can be marked. */
const FINGERPRINT = /^([0-9a-f]{40}([0-9a-f]{24})?|deleted)$/;

/**
 * Whether file `file` of a list with viewed marks should look unviewed (a dot): not opened (or
 * marked) with this content, the setting on, and a fingerprint to mark it with.
 */
function scopedUnviewed(scope, file, fingerprint) {
  return marksUnviewed() && scopedState(scope, file, fingerprint) === 'new';
}

/**
 * A file of a list with viewed marks: 'new' (not viewed with this content), 'viewed', or
 * 'none' (no fingerprint: it cannot be marked). Whatever the setting says (its menu offers
 * Mark as Viewed / Not Viewed even without the dots).
 */
function scopedState(scope, file, fingerprint) {
  if (!FINGERPRINT.test(fingerprint || '')) return 'none';
  return get().isViewed(scope, file, fingerprint) ? 'viewed' : 'new';
}

/** The tooltip line of a file of a list with viewed marks. */
function scopedTooltip(scope, file, fingerprint) {
  const state = scopedState(scope, file, fingerprint);
  if (state === 'none') return 'Cannot be marked as viewed (no content to compare: a symbolic link, a submodule or an unreadable file)';
  if (state === 'viewed') return '✓ Viewed (Mark as Not Viewed in its menu brings it back)';
  return marksUnviewed() ? '● Not viewed (the dot goes when you open it)' : 'Not viewed yet (opening it marks it viewed)';
}

/**
 * Mark a file of a list viewed (or not): when it was opened, or from its menu. A file without a
 * fingerprint (a symlink, a submodule, an unreadable file) has nothing to compare later: never
 * marked (its row has no dot and no Mark menu).
 * @param {{scope: string, fingerprint?: string}} v the row's `viewed`
 */
async function markScoped(v, file, on = true) {
  await markScopedMany([{ viewed: v, path: file }], on);
}

/** No list's scope or file path is this long; anything longer was not made by a row. */
const MAX_KEY = 8192;

/**
 * Mark files of lists viewed (or not): several rows selected, or a folder's. One write per list.
 * @param {{viewed: {scope: string, fingerprint?: string}, path: string}[]} rows
 */
async function markScopedMany(rows, on = true) {
  const byScope = new Map();
  for (const r of rows) {
    const v = r && r.viewed;
    if (!v || typeof v.scope !== 'string' || typeof r.path !== 'string' || v.scope.length > MAX_KEY || r.path.length > MAX_KEY) continue;
    if (!FINGERPRINT.test(v.fingerprint || '')) continue;
    // Opened from this list (even a file viewed before): the list meant when two show the same diff.
    if (on) lastScope = v.scope;
    if (get().isViewed(v.scope, r.path, v.fingerprint) === on) continue;
    if (!byScope.has(v.scope)) byScope.set(v.scope, []);
    byScope.get(v.scope).push({ path: r.path, fingerprint: v.fingerprint });
  }
  for (const [scope, files] of byScope) await get().set(scope, files, on);
}

/**
 * The lists with viewed marks shown lately (a pull request's files, a worktree's changes), for
 * Next Unviewed File in their diffs: scope -> {label, rows}. Rows have ownUri() (the side of
 * their diff no other list shares) and open() (shows the diff and marks the file viewed). The 20
 * last loaded.
 */
const MAX_LISTS = 20;
const lists = new Map();
const listsEmitter = new vscode.EventEmitter();
/** A list was shown (again): the active diff may belong to it now (the title-bar button). */
const onDidChangeLists = listsEmitter.event;
/** The list a file was last opened from: the one meant when two lists show the same diff. */
let lastScope;

/**
 * @param {string} scope @param {string} label ("pull request #7")
 * @param {any[]} rows in the order shown; `single`: opens as a plain editor (else as a diff)
 */
function registerList(scope, label, rows) {
  // index: ownUri -> row number, built when first looked up; kept while the list is drawn again
  // with the same files and contents (each open redraws it).
  // (Its sides too: a rebase that leaves the files as they were still moves every diff.)
  // (Not their contents: a row's diff is the same whatever the file holds, and an agent editing
  // must not make every draw build it again.)
  const signature = rows.map((r) => `${r.path}\0${r.status || (r.change && r.change.status) || ''}\0${r.leftRef || ''}\0${r.rightRef || r.sha || ''}\0${(r.owner && r.owner.mergeBase) || ''}`).join('\n');
  const before = lists.get(scope);
  lists.delete(scope);
  lists.set(scope, { label, rows, signature, index: before && before.signature === signature ? before.index : undefined });
  while (lists.size > MAX_LISTS) lists.delete(lists.keys().next().value);
  if (!before || before.signature !== signature) listsEmitter.fire(scope);
}

/**
 * How a URI is looked up: a working file's on a file system that ignores case (Windows, macOS)
 * in lower case — VS Code reports a tab's file in the casing it saw first, which may differ from
 * the path git gave.
 */
const CASELESS = process.platform !== 'linux';
const uriKey = (u) => (CASELESS && u.startsWith('file:') ? u.toLowerCase() : u);

function indexOf(list) {
  if (!list.index) {
    list.index = new Map();
    list.rows.forEach((r, i) => list.index.set(uriKey(r.ownUri()), i));
  }
  return list.index;
}

/**
 * The list (and row) whose file the active tab shows, if one does: `shown` as viewed.activeShown()
 * gives it. By the side only that row opens (pull requests from the same base share the other),
 * and in the way it opens (a diff, or a plain editor for a worktree's added or deleted file: a
 * worktree's file opened to edit it is not its diff). Two lists that still match (two pull
 * requests deleting the same file): the one a file was last opened from, else the newest.
 * @param {{uris: string[], diff: boolean}} shown
 */
function listOfShown(shown) {
  const found = [];
  for (const [scope, list] of [...lists].reverse()) {
    const index = indexOf(list);
    const uris = shown.uris.map(uriKey);
    for (const u of uris) {
      const at = index.get(u);
      // And its other side, where that is this list's own too (not another diff of the same file,
      // such as Source Control's of a working file).
      const row = at === undefined ? undefined : list.rows[at];
      const left = row && row.leftUri && row.leftUri();
      if (row && !row.single === shown.diff && (!left || uris.includes(uriKey(left)))) {
        found.push({ scope, list, at });
        break;
      }
    }
  }
  return found.find((f) => f.scope === lastScope) || found[0];
}

/** What the active tab shows: its URIs (as strings) and whether it is a diff. */
function activeShown() {
  const tab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup && vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab && tab.input;
  if (vscode.TabInputTextDiff && input instanceof vscode.TabInputTextDiff) return { uris: [String(input.modified), String(input.original)], diff: true };
  if (vscode.TabInputText && input instanceof vscode.TabInputText) return { uris: [String(input.uri)], diff: false };
  return { uris: [], diff: false };
}

/** The next row of a list (after index `at`, around to the start) not viewed yet. */
function nextUnviewedRow(scope, list, at) {
  const rows = list.rows;
  const after = [...rows.slice(at + 1), ...rows.slice(0, Math.max(0, at))];
  return after.find((r) => scopedState(scope, r.path, r.viewed && r.viewed.fingerprint) === 'new');
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
    if (!this.memento) return Promise.resolve();
    return Promise.resolve(this.memento.update(CHANGES_KEY, { keys: [...this.keys], commits: [...this.commits] })).then(undefined, () => {});
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

/** Marks not written yet, written now (the window is closing): what deactivate waits for. */
function flushAll() {
  const pending = [store, changes].filter((s) => s && s.timer);
  return Promise.all(pending.map((s) => s.flush()));
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

/**
 * The dots setting, read once until it changes (it is asked for every row and every dot). The
 * listener is added when this module loads, before any other listener reads the setting.
 */
let dotsOn;
vscode.workspace.onDidChangeConfiguration((e) => {
  if (e.affectsConfiguration('commitCorner.markUnviewedFiles')) dotsOn = undefined;
});
function marksUnviewed() {
  if (dotsOn === undefined) dotsOn = !!require('./util').config().get('markUnviewedFiles', true);
  return dotsOn;
}

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
 * The dot on a file in the tree views until you open it: a commit's files carry their mark key in
 * their resource URI (`…#commit-corner-history`, query `vk=<key>`), the files of a pull request
 * or a worktree's changes theirs (`vs=<key>`, see scopedKey).
 */
function registerDecorations() {
  const changed = new vscode.EventEmitter();
  // Only the rows whose mark changed are asked again (all at once would make every dot blink).
  // The URIs come from the rows VS Code asked about: commit marks by key, the lists' entries.
  const commitUris = new Map();
  const redraw = (uris) => {
    if (uris.length) changed.fire(uris);
  };
  const subs = [
    changed,
    commitMarks().onDidChange((e) => redraw([...[...e.keys].map((k) => commitUris.get(k)).filter(Boolean), ...foldersWith([...e.keys].map((k) => `k\0${k}`))])),
    get().onDidChangeFiles((e) => {
      const paths = new Set(e.paths);
      redraw([...scopedUris(e.scope, paths), ...foldersWith(e.paths.map((p) => `s\0${e.scope}\0${p}`))]);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('commitCorner.markUnviewedFiles')) changed.fire(undefined);
    }),
    vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: changed.event,
      provideFileDecoration(uri) {
        if (uri.fragment !== 'commit-corner-history' || !marksUnviewed()) return undefined;
        const dot = new vscode.FileDecoration('●', 'Not viewed', new vscode.ThemeColor('textLink.foreground'));
        if (uri.query.startsWith('vf=')) {
          const folder = folderRows.get(uri.query.slice(3));
          if (!folder) return undefined;
          folder.uri = uri;
          return folder.files.some((f) => f.unviewed()) ? new vscode.FileDecoration('●', 'Has files not viewed', new vscode.ThemeColor('textLink.foreground')) : undefined;
        }
        if (uri.query.startsWith('vk=')) {
          const key = uri.query.slice(3);
          commitUris.delete(key);
          commitUris.set(key, uri);
          while (commitUris.size > MAX_SCOPED) commitUris.delete(commitUris.keys().next().value);
          return commitMarks().has(key) ? undefined : dot;
        }
        const row = uri.query.startsWith('vs=') && scopedRows.get(uri.query.slice(3));
        if (!row) return undefined;
        row.uri = uri;
        return scopedUnviewed(row.scope, row.file, row.fingerprint) ? dot : undefined;
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

module.exports = { flushAll, folderCount: () => folderRows.size, scopedCount: () => scopedRows.size, registerDecorations, ViewedStore, ChangeMarks, scopedKey, folderKey, scopedUnviewed, scopedState, scopedTooltip, markScoped, markScopedMany, registerList, onDidChangeLists, listOfShown, activeShown, nextUnviewedRow, FINGERPRINT, init, get, commitMarks, commitFileViewed, commitFileUnviewed, markCommitFiles, commitCount, marksUnviewed };
