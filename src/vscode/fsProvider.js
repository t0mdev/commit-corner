'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { SCHEME, fromGitUri, isImmutableRef } = require('./uri');
const { INDEX, WORKTREE } = require('../git/repository');

/** Immutable content cache budget (bytes): big blobs must not pin hundreds of MB. */
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * Serves file contents at git revisions. Read-only except for the index
 * (ref ':'), which can be edited and saved directly: saving writes the new
 * staged content without touching the working tree.
 */
class GitFileSystemProvider {
  /** @param {import('./model').RepositoryManager} manager */
  constructor(manager) {
    this.manager = manager;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeFile = this.emitter.event;
    /** Immutable content cache (ref is a SHA): uri -> Uint8Array */
    this.cache = new Map();
    this.cacheBytes = 0;
    /** uri -> {data, at}: a stat() result reused by the readFile() that follows it. */
    this.recent = new Map();
    /** Open mutable documents to notify when the repository changes. */
    this.mutable = new Map();
    /** repo root -> last HEAD/index signature, to skip no-op change events. */
    this.signatures = new Map();
    this.disposables = [
      vscode.workspace.registerFileSystemProvider(SCHEME, this, { isCaseSensitive: true }),
      manager.onDidChangeState((repo) => this.notifyRepositoryChanged(repo)),
      vscode.workspace.onDidCloseTextDocument((d) => {
        if (d.uri.scheme === SCHEME) this.mutable.delete(d.uri.toString());
      }),
    ];
  }

  async notifyRepositoryChanged(repo) {
    if (![...this.mutable.values()].some((uri) => fromGitUri(uri).repo === repo.root)) return;
    // Only the index, HEAD or a ref moving can change what mutable URIs (":", "HEAD", "origin/main") show.
    let indexStamp = 0;
    try {
      indexStamp = fs.statSync(path.join(repo.gitDir, 'index')).mtimeMs;
    } catch { /* no index yet */ }
    const tips = (repo.refTips !== undefined ? repo.refTips : await repo.getRefTips().catch(() => ''));
    // Working-tree entries shown as git sees them (a symlink, a submodule's folder): their own
    // stamp, so a re-pointed link shows its new target (a submodule follows its HEAD as before).
    const stamps = [];
    for (const uri of this.mutable.values()) {
      const q = fromGitUri(uri);
      if (q.repo !== repo.root || q.ref !== WORKTREE) continue;
      const w = repo.workingFile(q.path);
      stamps.push(w && w.st ? `${w.st.mtimeMs}:${w.st.ctimeMs}` : '-');
    }
    const sig = `${repo.state && repo.state.head.sha}|${repo.state && repo.state.head.branch}|${indexStamp}|${tips}|${stamps.join(',')}`;
    if (this.signatures.get(repo.root) === sig) return;
    this.signatures.set(repo.root, sig);
    const events = [];
    for (const uri of this.mutable.values()) {
      if (fromGitUri(uri).repo === repo.root) events.push({ type: vscode.FileChangeType.Changed, uri });
    }
    if (events.length) this.emitter.fire(events);
  }

  watch() {
    return new vscode.Disposable(() => {});
  }

  async load(uri) {
    const key = uri.toString();
    const cached = this.cache.get(key);
    if (cached) return cached;
    const q = fromGitUri(uri);
    if (q.empty || !q.ref) return new Uint8Array(0);
    // Only repositories that are already open (and so were allowed): a commitcorner: URI must not
    // make git run in some other folder. After a reload, wait until discovery has finished.
    if (!this.manager.getRepository(q.repo) && this.manager.ready) await this.manager.ready;
    const repo = this.manager.getRepository(q.repo);
    if (!repo) throw vscode.FileSystemError.Unavailable(`Repository not found: ${q.repo}`);
    const buf = await repo.show(q.ref, q.path);
    const data = buf ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(0);
    if (isImmutableRef(q.ref)) {
      if (data.byteLength <= MAX_CACHE_BYTES / 4) {
        this.cache.set(key, data);
        this.cacheBytes += data.byteLength;
        while (this.cacheBytes > MAX_CACHE_BYTES && this.cache.size) {
          const [oldKey, old] = this.cache.entries().next().value;
          this.cache.delete(oldKey);
          this.cacheBytes -= old.byteLength;
        }
      }
    } else this.mutable.set(key, uri);
    return data;
  }

  async stat(uri) {
    const q = fromGitUri(uri);
    const data = await this.load(uri);
    // VS Code reads right after stat: keep a mutable revision's bytes for that one read.
    if (!isImmutableRef(q.ref)) this.recent.set(uri.toString(), { data, at: Date.now() });
    const stat = { type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: data.byteLength };
    if (q.ref !== INDEX || q.empty) stat.permissions = vscode.FilePermission.Readonly;
    if (isImmutableRef(q.ref)) stat.mtime = 0;
    return stat;
  }

  readFile(uri) {
    const hit = this.recent.get(uri.toString());
    this.recent.delete(uri.toString());
    if (hit && Date.now() - hit.at < 1500) return hit.data;
    return this.load(uri);
  }

  async writeFile(uri, content) {
    const q = fromGitUri(uri);
    if (q.ref !== INDEX || q.empty) throw vscode.FileSystemError.NoPermissions('Only the staged (index) version of a file can be edited.');
    const repo = this.manager.getRepository(q.repo);
    if (!repo) throw vscode.FileSystemError.Unavailable(q.repo);
    const s = repo.state || (await repo.refreshState());
    if (s.conflicts.some((e) => e.path === q.path)) {
      throw vscode.FileSystemError.NoPermissions('This file has merge conflicts; resolve them before editing its staged version.');
    }
    // The editor shows the staged blob byte for byte, so it is written back the same way.
    await repo.writeIndexContent(q.path, Buffer.from(content), undefined, { asIs: true });
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    await this.manager.refresh(repo);
  }

  readDirectory() {
    return [];
  }

  createDirectory() {
    throw vscode.FileSystemError.NoPermissions();
  }

  delete() {
    throw vscode.FileSystemError.NoPermissions();
  }

  rename() {
    throw vscode.FileSystemError.NoPermissions();
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }
}

module.exports = { GitFileSystemProvider };
