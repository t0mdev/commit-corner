'use strict';

const vscode = require('vscode');
const notify = require('../notify');
const path = require('path');
const fs = require('fs');
const { TreeProvider, MessageNode, CommitNode } = require('./nodes');
const { SCHEME, fromGitUri } = require('../uri');
const { config, debounce } = require('../util');
const { WORKTREE } = require('../../git/repository');
const { mapRangesToFrom, withEol, eolOf, DiffTooLargeError } = require('../../git/lineDiff');

/**
 * History of the active file (following renames), or of a line range
 * (`git log -L`). Follows the active editor unless pinned.
 */
class FileHistoryView extends TreeProvider {
  constructor(manager) {
    super();
    this.manager = manager;
    /** @type {{repo, rel:string, lines?:{start:number,end:number}}|undefined} */
    this.target = undefined;
    this.pinned = false;
    this.limit = config().get('fileHistoryLimit', 200);
    this.view = require('../util').registerTreeView('commitCorner.fileHistory', vscode.window.createTreeView('commitCorner.fileHistory', { treeDataProvider: this, canSelectMany: true }));
    const follow = debounce(() => this.followEditor(), 250);
    this.disposables = [
      this.view,
      vscode.window.onDidChangeActiveTextEditor(follow),
      this.view.onDidChangeVisibility((e) => {
        if (e.visible) this.followEditor();
      }),
      manager.onDidOpen(follow),
      // New commits, checkouts and resets change the history shown.
      manager.onDidChangeState((repo) => {
        if (!this.target || this.target.repo !== repo) return;
        const head = repo.state && repo.state.head.sha;
        if (head !== this.lastHead) {
          this.lastHead = head;
          this.refresh();
        }
      }),
    ];
    this.setPinnedContext();
    this.followEditor();
  }

  setPinnedContext() {
    vscode.commands.executeCommand('setContext', 'commitCorner.fileHistoryPinned', this.pinned);
  }

  targetFor(uri) {
    if (!uri) return undefined;
    if (uri.scheme === SCHEME) {
      const q = fromGitUri(uri);
      const repo = this.manager.getRepository(q.repo);
      return repo && { repo, rel: q.path };
    }
    if (uri.scheme !== 'file') return undefined;
    const repo = this.manager.getRepositoryForUri(uri);
    if (!repo) return undefined;
    let folder = false;
    try {
      folder = fs.statSync(uri.fsPath).isDirectory();
    } catch { /* deleted file: still has history */ }
    return { repo, rel: repo.relative(uri.fsPath), folder };
  }

  followEditor() {
    if (this.pinned || !this.view.visible) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const t = this.targetFor(editor.document.uri);
    if (!t) return;
    if (this.target && this.target.repo === t.repo && this.target.rel === t.rel && !this.target.lines) return;
    this.setTarget(t);
  }

  setTarget(t) {
    this.target = t;
    this.limit = config().get('fileHistoryLimit', 200);
    this.refresh();
  }

  async getRoots() {
    const t = this.target;
    if (!t) {
      this.view.description = undefined;
      if (!this.manager.repositories.length) return []; // the welcome (Initialize / Clone / Open)
      return [new MessageNode('Open a file in a git repository to see its history', 'info')];
    }
    const name = path.posix.basename(t.rel) || t.repo.name;
    this.view.description = t.lines ? `${name}:${t.lines.start}–${t.lines.end}` : t.folder ? `${name}/` : name;
    if (t.folder) {
      // Folder history: every commit touching something inside; each expands into its files.
      const commits = await t.repo.log({ revs: ['HEAD'], paths: t.rel ? [`:(literal)${t.rel}`] : [], maxCount: this.limit });
      // Stats count only what changed inside the folder.
      const nodes = commits.map((c) => new CommitNode(t.repo, c, { statsPaths: t.rel ? [t.rel] : undefined }));
      if (!nodes.length) nodes.push(new MessageNode('No committed history', 'info'));
      if (commits.length >= this.limit) nodes.push(new MessageNode('Load more…', 'ellipsis', { command: 'commitCorner.fileHistoryMore', title: 'Load more' }));
      return nodes;
    }
    if (t.lines) {
      const commits = await t.repo.lineHistory(t.rel, t.lines.start, t.lines.end, { maxCount: this.limit, ref: t.ref });
      if (!commits.length) return [new MessageNode('No committed history for these lines', 'info')];
      // Clicking opens the file's diff in that commit (at the path it had then).
      return commits.map((c) => new CommitNode(t.repo, c, { change: c.change, currentPath: t.rel }));
    }
    const commits = await t.repo.fileHistory(t.rel, { maxCount: this.limit, allBranches: this.allBranches });
    const nodes = [];
    const state = t.repo.state;
    if (state && [...state.unstaged, ...state.staged].some((e) => e.path === t.rel)) {
      nodes.push(new MessageNode('Uncommitted changes', 'circle-filled', {
        command: 'commitCorner.openCommitFile',
        title: 'Open',
        arguments: [{ repoRoot: t.repo.root, path: t.rel, leftRef: 'HEAD', rightRef: WORKTREE, title: `${name} (HEAD ↔ Working Tree)` }],
      }));
    }
    if (!commits.length) nodes.push(new MessageNode('No committed history', 'info'));
    for (const c of commits) nodes.push(new CommitNode(t.repo, c, { change: c.change, currentPath: t.rel }));
    if (commits.length >= this.limit) {
      nodes.push(new MessageNode('Load more…', 'ellipsis', { command: 'commitCorner.fileHistoryMore', title: 'Load more' }));
    }
    return nodes;
  }

  dispose() {
    super.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

/** @param {import('../context').Context} ctx */
function register(ctx, view) {
  const cmd = ctx.command;

  cmd('commitCorner.fileHistory', async (uri) => {
    const target = view.targetFor(uri instanceof vscode.Uri ? uri : uri && uri.resourceUri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri));
    if (!target) {
      notify.info('Open a file inside a git repository first.');
      return;
    }
    if (target.folder) {
      // A folder's history is not tied to the active editor.
      view.pinned = true;
      view.setPinnedContext();
    }
    view.setTarget(target);
    await require('../sidebar').showView('fileHistory');
  });

  cmd('commitCorner.folderHistory', (uri) => vscode.commands.executeCommand('commitCorner.fileHistory', uri));

  cmd('commitCorner.lineHistory', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const target = view.targetFor(editor.document.uri);
    if (!target) return;
    const sel = editor.selection;
    let end = sel.end.line;
    if (sel.end.character === 0 && end > sel.start.line) end--;
    let range = { start: sel.start.line, end };
    let ref = 'HEAD';
    if (editor.document.uri.scheme === SCHEME) {
      // A file opened at a revision: its line numbers belong to that revision.
      const q = fromGitUri(editor.document.uri);
      if (q.ref && /^[0-9a-f]{40,64}/.test(q.ref)) ref = q.ref;
    } else if (editor.document.uri.scheme === 'file') {
      // git log -L works on HEAD's version of the file: map the selection through uncommitted edits.
      const headText = await target.repo.showText('HEAD', target.rel);
      if (headText === null) {
        notify.info('This file has no committed history yet.');
        return;
      }
      try {
        const work = withEol(editor.document.getText(), eolOf(headText));
        [range] = mapRangesToFrom(headText, work, [range]);
      } catch (e) {
        if (!(e instanceof DiffTooLargeError)) throw e; // too different to map: use the lines as they are
      }
    }
    view.pinned = true;
    view.setPinnedContext();
    view.setTarget({ ...target, ref, lines: { start: range.start + 1, end: range.end + 1 } });
    await require('../sidebar').showView('fileHistory');
  });

  cmd('commitCorner.fileHistoryPin', () => {
    view.pinned = true;
    view.setPinnedContext();
  });
  cmd('commitCorner.fileHistoryUnpin', () => {
    view.pinned = false;
    view.setPinnedContext();
    view.target = undefined;
    view.followEditor();
    view.refresh();
  });
  cmd('commitCorner.fileHistoryRefresh', () => view.refresh());
  const setAll = (value) => {
    view.allBranches = value;
    vscode.commands.executeCommand('setContext', 'commitCorner.fileHistoryAll', value);
    view.refresh();
  };
  cmd('commitCorner.fileHistoryAllBranches', () => setAll(true));
  cmd('commitCorner.fileHistoryCurrentBranch', () => setAll(false));
  cmd('commitCorner.fileHistoryMore', () => {
    view.limit += config().get('fileHistoryLimit', 200);
    view.refresh();
  });
}

module.exports = { FileHistoryView, register };
