'use strict';

const vscode = require('vscode');
const { config, STATUS_LABELS } = require('./util');
const { builtInGitEnabled } = require('./scm');

const COLORS = {
  M: 'gitDecoration.modifiedResourceForeground',
  A: 'gitDecoration.addedResourceForeground',
  D: 'gitDecoration.deletedResourceForeground',
  R: 'gitDecoration.renamedResourceForeground',
  U: 'gitDecoration.untrackedResourceForeground',
  '!': 'gitDecoration.conflictingResourceForeground',
};

/**
 * Explorer and editor-tab decorations (M/A/D/R/U/! badges and colours),
 * propagated to parent folders. Only active when the built-in Git extension
 * is off (or the setting forces it), so the two never fight over badges.
 */
class FileDecorations {
  /** @param {import('./model').RepositoryManager} manager */
  constructor(manager) {
    this.manager = manager;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this._onDidChange.event;
    /** repo root -> Map(absolute path -> {letter, tooltip}) */
    this.byRepo = new Map();
    /** repo root -> {files:Set<string>, dirs:string[]} of ignored paths (absolute) */
    this.ignoredByRepo = new Map();
    this.disposables = [
      this._onDidChange,
      vscode.window.registerFileDecorationProvider(this),
      manager.onDidChangeState((repo) => this.update(repo)),
      manager.onDidOpen((repo) => {
        repo.includeIgnored = this.enabled();
      }),
      manager.onDidClose((repo) => {
        const old = this.byRepo.get(repo.root);
        this.byRepo.delete(repo.root);
        if (old) this._onDidChange.fire([...old.keys()].map((p) => vscode.Uri.file(p)));
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('commitCorner.explorerDecorations') || e.affectsConfiguration('git.enabled')) {
          for (const repo of manager.repositories) {
            repo.includeIgnored = this.enabled();
            manager.scheduleRefresh(repo);
            this.update(repo, true);
          }
        }
      }),
    ];
    for (const repo of manager.repositories) {
      repo.includeIgnored = this.enabled();
      if (repo.includeIgnored) manager.scheduleRefresh(repo);
      this.update(repo);
    }
  }

  enabled() {
    const v = config().get('explorerDecorations', 'auto');
    return v === 'always' || (v === 'auto' && !builtInGitEnabled());
  }

  update(repo, force) {
    const next = new Map();
    const s = repo.state;
    if (s && this.enabled()) {
      const set = (rel, letter, tooltip) => next.set(repo.absolute(rel), { letter, tooltip });
      for (const e of s.untracked) set(e.path, 'U', 'Untracked');
      for (const e of s.staged) {
        const letter = e.kind === 'renamed' ? 'R' : e.x === 'T' ? 'M' : e.x;
        set(e.path, letter, `${STATUS_LABELS[letter] || letter} (staged)`);
      }
      for (const e of s.unstaged) {
        const letter = e.y === 'T' ? 'M' : e.y;
        // An added-then-modified file stays "A"; otherwise the working tree state wins.
        if (!(next.has(repo.absolute(e.path)) && next.get(repo.absolute(e.path)).letter === 'A')) set(e.path, letter, STATUS_LABELS[letter] || letter);
      }
      for (const e of s.conflicts) set(e.path, '!', 'Conflict');
    }
    // Ignored paths are dimmed like the built-in Git does (directories end with "/").
    const prevIgnored = this.ignoredByRepo.get(repo.root);
    const ignored = { files: new Set(), dirs: [], dirSet: new Set() };
    if (s && this.enabled()) {
      for (const e of repo.ignored || []) {
        const abs = repo.absolute(e.path.replace(/\/$/, ''));
        if (e.path.endsWith('/')) {
          ignored.dirs.push(abs);
          ignored.dirSet.add(abs);
        } else ignored.files.add(abs);
      }
    }
    this.ignoredByRepo.set(repo.root, ignored);
    const had = (ig, p) => ig.files.has(p) || ig.dirSet.has(p);
    const ignoredChanged = [...ignored.files, ...ignored.dirs].filter((p) => !prevIgnored || !had(prevIgnored, p));
    if (prevIgnored) for (const p of [...prevIgnored.files, ...prevIgnored.dirs]) if (!had(ignored, p)) ignoredChanged.push(p);
    const prev = this.byRepo.get(repo.root) || new Map();
    this.byRepo.set(repo.root, next);
    const changed = [];
    for (const [p, d] of next) {
      const old = prev.get(p);
      if (force || !old || old.letter !== d.letter) changed.push(p);
    }
    for (const p of prev.keys()) if (!next.has(p)) changed.push(p);
    changed.push(...ignoredChanged);
    if (changed.length) this._onDidChange.fire(changed.map((p) => vscode.Uri.file(p)));
  }

  provideFileDecoration(uri) {
    if (uri.scheme !== 'file' || uri.fragment) return undefined;
    for (const map of this.byRepo.values()) {
      const d = map.get(uri.fsPath);
      if (!d) continue;
      const deco = new vscode.FileDecoration(d.letter === '!' ? 'C' : d.letter, d.tooltip, new vscode.ThemeColor(COLORS[d.letter] || COLORS.M));
      // Folders show that something inside changed (colour only), like the built-in Git.
      deco.propagate = d.letter !== 'D';
      return deco;
    }
    const path = require('path');
    for (const ig of this.ignoredByRepo.values()) {
      // Walk up the path: the file itself or any ignored parent folder.
      let p = uri.fsPath;
      let hit = ig.files.has(p);
      while (!hit) {
        if (ig.dirSet.has(p)) hit = true;
        const parent = path.dirname(p);
        if (parent === p) break;
        p = parent;
      }
      if (hit) {
        return new vscode.FileDecoration(undefined, 'Ignored', new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'));
      }
    }
    return undefined;
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}

module.exports = { FileDecorations };
