'use strict';

const vscode = require('vscode');

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

/** @type {ViewedStore|undefined} */
let store;

function init(memento) {
  store = new ViewedStore(memento);
  return store;
}

function get() {
  if (!store) store = new ViewedStore(undefined);
  return store;
}

module.exports = { ViewedStore, checkbox, watchCheckboxes, init, get };
