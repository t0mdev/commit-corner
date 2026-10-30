'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const notify = require('../notify');
const viewed = require('../viewed');
const { WORKTREE, EMPTY_TREE } = require('../../git/repository');
const { openDiff, uriAt } = require('../diffs');
const { pickRef } = require('../pickers');
const { SCHEME, fromGitUri } = require('../uri');
const { shortSha, log, escapeIcons } = require('../util');
const { mapRangesToFrom, withEol, eolOf } = require('../../git/lineDiff');

/**
 * What you do with a file row anywhere (a commit's file in the graph or a tree, a comparison's,
 * a pull request's, File History's): open the file as it is now (at the line you were looking
 * at), compare it with the working file or a base branch, copy its path, reveal it; and the
 * viewed marks of commit files (bold until opened), with Next Unviewed File.
 */

const isFullSha = (s) => typeof s === 'string' && /^[0-9a-f]{40,64}$/.test(s);
/** Repository text (a path) in the status bar: no $(icon) syntax, no control characters. */
const plain = (t) => escapeIcons(String(t).replace(/[\u0000-\u001f\u007f]/g, ' '));
/** Above this, a file is opened at the same line number instead of a mapped one. */
const MAP_LIMIT = 2 * 1024 * 1024;

/** @type {vscode.Memento|undefined} */
let state;
const BASE_KEY = 'compareBase';

/**
 * The branch "Compare with Base" uses: the one you last picked for this repository (while it
 * exists), else the remote's default branch (origin/main), else main / master.
 */
async function compareBase(repo, memento = state) {
  const saved = memento && (memento.get(BASE_KEY) || {})[repo.root];
  if (typeof saved === 'string' && saved && !saved.startsWith('-') && (await repo.revParse(saved).catch(() => undefined))) return saved;
  return (await repo.getDefaultBranch().catch(() => undefined)) || undefined;
}

async function rememberBase(repo, ref, memento = state) {
  if (!memento) return;
  const all = { ...(memento.get(BASE_KEY) || {}) };
  all[repo.root] = ref;
  // Repositories come and go; a few dozen are plenty.
  const roots = Object.keys(all);
  if (roots.length > 50) delete all[roots[0]];
  await memento.update(BASE_KEY, all);
}

/** {repo, path, ref, commit?} of a commitcorner: editor (a revision, one side of a diff). */
function revisionOf(manager, uri) {
  if (!uri || uri.scheme !== SCHEME) return undefined;
  let q;
  try {
    q = fromGitUri(uri);
  } catch {
    return undefined;
  }
  const repo = manager.getRepository(q.repo);
  return repo && typeof q.path === 'string' ? { repo, path: q.path, ref: q.empty ? null : q.ref, commit: isFullSha(q.commit) ? q.commit : undefined, anchor: q.anchor } : undefined;
}

/** The two sides of the active diff tab (or the one editor), as URIs. */
function activeUris() {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab && tab.input;
  if (input instanceof vscode.TabInputTextDiff) return [input.modified, input.original];
  if (input instanceof vscode.TabInputText) return [input.uri];
  const ed = vscode.window.activeTextEditor;
  return ed ? [ed.document.uri] : [];
}

/** The line you are at in an editor showing `ref`:`relPath` of this repository (0-based), if any. */
function lineInEditors(repo, relPath, ref) {
  const editors = vscode.window.activeTextEditor ? [vscode.window.activeTextEditor, ...vscode.window.visibleTextEditors] : vscode.window.visibleTextEditors;
  for (const ed of editors) {
    const uri = ed.document.uri;
    if (uri.scheme !== SCHEME) continue;
    let q;
    try {
      q = fromGitUri(uri);
    } catch {
      continue;
    }
    if (q.repo === repo.root && q.path === relPath && (!ref || q.ref === ref)) return { line: ed.selection.active.line, ref: q.ref };
  }
  return undefined;
}

/**
 * The working-tree line that line `line` of `ref`:`fromPath` became: through a diff of the two
 * texts; the same number when that is too big or fails.
 */
async function mapToWorkingLine(repo, ref, fromPath, workPath, line) {
  try {
    // A regular file of this repository only (never a symlink: it may point at /dev/zero), both
    // sides sized before they are read.
    const w = repo.workingFile(workPath);
    if (!w || !w.st || !w.st.isFile() || w.st.size > MAP_LIMIT) return line;
    const size = await repo.blobSize(ref, fromPath);
    if (size === undefined || size > MAP_LIMIT) return line;
    const old = (await repo.show(ref, fromPath) || Buffer.alloc(0)).toString('utf8');
    const now = await readAtMost(w.abs, MAP_LIMIT);
    if (now === undefined) return line;
    // The working file's line endings (core.autocrlf: CRLF here, LF in the blob) must not make
    // every line a change.
    const [r] = mapRangesToFrom(withEol(now.toString('utf8'), eolOf(old, '\n')), old, [{ start: line, end: line }]);
    return r ? r.start : line;
  } catch (e) {
    log().debug(`Open working file: line not mapped (${e.message})`);
    return line;
  }
}

/** At most `max` bytes of a file (undefined when it is longer). */
async function readAtMost(abs, max) {
  // Never through a link, never blocking on a FIFO: a regular file, as opened.
  const fh = await fs.promises.open(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    if (!(await fh.stat()).isFile()) return undefined;
    const buf = Buffer.alloc(max + 1);
    let got = 0;
    // Until the end (or one byte past the limit): a read may return less than asked for.
    for (;;) {
      const { bytesRead } = await fh.read(buf, got, max + 1 - got, got);
      if (!bytesRead) break;
      got += bytesRead;
      if (got > max) return undefined;
    }
    return buf.subarray(0, got);
  } finally {
    await fh.close();
  }
}

/**
 * Where file `revPath` of revision `ref` is in the working tree now: the File History's
 * `known` name, else the same path, else git's rename since that revision; on a case-insensitive
 * disk, with the casing it has there. undefined when it is gone (or not this repository's).
 * @returns {Promise<{rel: string, abs: string, st: fs.Stats, renamed: boolean}|undefined>}
 */
async function workingPathOf(repo, ref, revPath, known) {
  let rel = known || revPath;
  let w = repo.workingFile(rel);
  if (!w) return undefined;
  if (!w.st && ref && ref !== WORKTREE && !ref.startsWith(':')) {
    const now = await repo.currentPathOf(ref, revPath).catch(() => undefined);
    if (now) {
      rel = now;
      w = repo.workingFile(rel);
    }
  }
  if (!w || !w.st) return undefined;
  if (process.platform !== 'linux' && !w.st.isSymbolicLink()) {
    // Foo.js renamed to foo.js: the old name still opens on Windows and macOS; use the name on
    // disk (compared below the repository root, which may itself be a link or a mapped drive).
    try {
      const fixed = repo.relative(fs.realpathSync.native(w.abs));
      if (fixed && fixed !== rel && fixed.toLowerCase() === rel.toLowerCase()) rel = fixed;
    } catch { /* keep it */ }
  }
  const now = repo.workingFile(rel) || w;
  return { rel, abs: now.abs, st: now.st || w.st, renamed: rel !== revPath };
}

/**
 * The file of a commit to open after `current` that you have not viewed: in the graph's order,
 * around to the start. undefined when all are viewed.
 */
function nextUnviewedOf(sha, files, current) {
  const ordered = treeOrder(files);
  const at = ordered.findIndex((f) => f.path === current || f.origPath === current);
  const after = [...ordered.slice(at + 1), ...ordered.slice(0, Math.max(0, at))];
  return after.find((f) => !viewed.commitFileViewed(sha, f));
}

/**
 * A row's revision of the file against `ref` (ref left, as Compare with Branch does for files).
 * Rows without a revision: the working file under its name now (none: an empty side). A file
 * deleted in that commit: as it was before. Renamed in that commit (or staged as a rename): the
 * base usually has the old name.
 */
async function compareNodeWith(repo, node, ref) {
  const name = node.path.split('/').pop();
  const deleted = node.status === 'D' && isFullSha(node.sha);
  let rightRef = deleted ? `${node.sha}^` : isFullSha(node.sha) ? node.sha : undefined;
  let rightPath = deleted ? node.origPath || node.path : node.path;
  if (!rightRef) {
    const work = await workingPathOf(repo, node.sha, node.path, node.currentPath);
    rightRef = work ? WORKTREE : null;
    if (work) rightPath = work.rel;
  }
  const leftPath = node.origPath && node.origPath !== node.path && (await repo.blobSize(ref, node.path).catch(() => undefined)) === undefined ? node.origPath : node.path;
  const label = rightRef === WORKTREE ? 'Working Tree' : rightRef ? `${shortSha(node.sha)}${deleted ? '^' : ''}` : 'deleted';
  await openDiff(repo, { path: rightPath, leftRef: ref, leftPath, rightRef, rightPath, title: `${name} (${ref} ↔ ${label})`, viewColumn: viewColumnOf(node) });
}

/** Where a row's command opens its editor: beside the editor graph when it came from there. */
function viewColumnOf(node) {
  return node && node.viewColumn === vscode.ViewColumn.Beside ? vscode.ViewColumn.Beside : undefined;
}

/** File `file` of commit `sha` with its blob ids (what its viewed mark keys on), looked up when the row had none. */
async function withBlobs(repo, sha, file) {
  if (file.oldBlob && file.newBlob) return file;
  const { files } = await repo.getCommitFiles(sha);
  return files.find((x) => x.path === file.path);
}

/** Mark a file of a commit opened (or, `on` false, not viewed): only a file the commit has. */
async function markOpened(repo, sha, file, on = true) {
  if (!isFullSha(sha) || !file || typeof file.path !== 'string') return;
  const f = await withBlobs(repo, sha, file);
  if (f) viewed.markCommitFiles(sha, [f], on);
}

/**
 * A commit's files in the order the graph shows them: folder by folder, sub-folders before the
 * files beside them, each by name.
 */
function treeOrder(files) {
  const cmp = (a, b) => {
    const pa = a.path.split('/');
    const pb = b.path.split('/');
    for (let i = 0; ; i++) {
      const lastA = i === pa.length - 1;
      const lastB = i === pb.length - 1;
      if (pa[i] !== pb[i] || lastA || lastB) {
        if (lastA !== lastB) return lastA ? 1 : -1; // a folder before a file
        return pa[i].localeCompare(pb[i], 'en'); // as the graph sorts (whatever the locale)
      }
    }
  };
  return files.slice().sort(cmp);
}

/** Open file `f` of commit `sha` (parent: its first parent) as a diff, marked as a file of that commit. */
async function openCommitFileDiff(repo, sha, parent, f, o = {}) {
  await openDiff(repo, {
    path: f.path,
    leftRef: f.status === 'A' ? null : parent || EMPTY_TREE,
    leftPath: f.origPath || f.path,
    rightRef: f.status === 'D' ? null : sha,
    title: `${f.path.split('/').pop()} (${shortSha(sha)})`,
    preserveFocus: !!o.preserveFocus,
    preview: o.preview,
    viewColumn: o.viewColumn,
    commit: sha,
  });
}

/** @param {import('../context').Context} ctx */
function register(ctx) {
  const { manager } = ctx;
  const cmd = ctx.command;
  state = ctx.extContext.workspaceState;

  /**
   * The file as it is now in the working tree. From a row (node: repoRoot, path, sha?,
   * currentPath?) or from a revision editor / diff (no node). At the line you were looking at in
   * that revision (mapped through the edits since); followed across a rename.
   */
  cmd('commitCorner.openWorkingFile', async (node) => {
    let repo;
    let revPath; // its path in that revision
    let known; // its path now, when known (File History follows renames)
    let ref;
    let at;
    if (node && typeof node.repoRoot === 'string' && typeof node.path === 'string') {
      repo = manager.getRepository(node.repoRoot);
      if (!repo) return;
      revPath = node.path;
      known = node.currentPath;
      ref = node.status === 'D' ? undefined : typeof node.sha === 'string' && node.sha !== WORKTREE ? node.sha : undefined;
      // That revision open in an editor (its diff, say): the line you are at there.
      at = lineInEditors(repo, revPath, ref);
    } else {
      const uri = node instanceof vscode.Uri ? node : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
      const r = revisionOf(manager, uri) || activeUris().map((u) => revisionOf(manager, u)).find((x) => x && x.ref);
      if (!r) return;
      repo = r.repo;
      revPath = r.path;
      known = r.anchor;
      ref = r.ref || undefined;
      const ed = vscode.window.activeTextEditor;
      at = ed && uri && ed.document.uri.toString() === uri.toString() ? { line: ed.selection.active.line, ref } : lineInEditors(repo, r.path, r.ref);
    }
    const work = await workingPathOf(repo, ref, revPath, known);
    if (!work) {
      notify.info(`"${revPath}" is not in the working tree (deleted${ref ? ` since ${shortSha(ref)}` : ''}, or moved where git cannot follow it).`);
      return;
    }
    // A symlink opens what it points to only when that is a regular file of this repository;
    // otherwise as git sees it (the link's text). Never a device or a folder.
    const viewColumn = viewColumnOf(node);
    let target;
    try {
      target = fs.statSync(work.abs);
    } catch { /* a dangling link */ }
    let openPath = work.abs;
    let mapPath = work.rel; // the regular file whose lines the revision's are mapped to
    if (work.st.isSymbolicLink()) {
      let real;
      try {
        real = fs.realpathSync(work.abs);
      } catch { /* dangling */ }
      const inside = real && repo.contains(real) && repo.ownFolder(path.dirname(real));
      if (!inside || !target || !target.isFile()) {
        await vscode.commands.executeCommand('vscode.open', uriAt(repo, WORKTREE, work.rel), { preview: false, viewColumn });
        vscode.window.setStatusBarMessage(`${plain(work.rel)} is a symlink${inside ? '' : ' to outside the repository'}: shown as its link`, 4000);
        return;
      }
      openPath = real; // the file that was checked (not whatever the link points to later)
      mapPath = repo.relative(real);
    } else if (!target || !target.isFile()) {
      notify.info(`"${work.rel}" is not a regular file.`);
      return;
    }
    if (work.renamed) vscode.window.setStatusBarMessage(`Renamed since: ${plain(revPath)} → ${plain(work.rel)}`, 4000);
    let line = at ? at.line : undefined;
    if (line !== undefined && at.ref && at.ref !== WORKTREE) line = await mapToWorkingLine(repo, at.ref, revPath, mapPath, line);
    const uri = vscode.Uri.file(openPath);
    try {
      const selection = line !== undefined ? new vscode.Range(line, 0, line, 0) : undefined;
      await vscode.window.showTextDocument(uri, { preview: false, selection, viewColumn });
    } catch {
      await vscode.commands.executeCommand('vscode.open', uri, { preview: false, viewColumn }); // binary: its own editor
    }
  });

  /**
   * This revision of the file against the working file, which it may be under another name
   * now (renamed since). A deleted file's revision is the one before.
   */
  cmd('commitCorner.compareFileWithWorkingTree', async (node) => {
    const repo = node && typeof node.path === 'string' ? manager.getRepository(node.repoRoot) : undefined;
    if (!repo || !isFullSha(node.sha)) return;
    const deleted = node.status === 'D';
    const rev = deleted ? `${node.sha}^` : node.sha;
    const revPath = deleted ? node.origPath || node.path : node.path;
    const work = await workingPathOf(repo, node.sha, node.path, node.currentPath);
    if (work && work.renamed) vscode.window.setStatusBarMessage(`Renamed since: ${plain(revPath)} → ${plain(work.rel)}`, 4000);
    const current = work ? work.rel : revPath;
    await openDiff(repo, { path: current, leftRef: rev, leftPath: revPath, rightRef: work ? WORKTREE : null, rightPath: current, viewColumn: viewColumnOf(node) });
  });

  const nodeRepo = (node) => node && typeof node.path === 'string' && typeof node.repoRoot === 'string' ? manager.getRepository(node.repoRoot) : undefined;

  // This revision of the file (or the working file, for rows without one) against a branch, tag
  // or commit you pick; that one is "Compare with Base" from then on.
  cmd('commitCorner.compareFileWithRefPick', async (node) => {
    const repo = nodeRepo(node);
    if (!repo) return;
    const base = await compareBase(repo);
    const extra = base ? [{ label: `$(star-full) ${escapeIcons(base)}`, description: 'base (Compare with Base Branch)', ref: base }] : [];
    const ref = await pickRef(repo, { placeHolder: `Compare ${node.path.split('/').pop()}${isFullSha(node.sha) ? ` (${shortSha(node.sha)})` : ''} with…`, head: true, extra });
    if (!ref) return;
    // Remembered only when it is a revision here (a typo is not the base from then on).
    if (!ref.startsWith('-') && (await repo.revParse(ref).catch(() => undefined))) await rememberBase(repo, ref);
    await compareNodeWith(repo, node, ref);
  });

  // One click: against the base (the last branch you compared with, else origin/main).
  cmd('commitCorner.compareFileWithBase', async (node) => {
    const repo = nodeRepo(node);
    if (!repo) return;
    const base = await compareBase(repo);
    if (!base) {
      await vscode.commands.executeCommand('commitCorner.compareFileWithRefPick', node);
      return;
    }
    await compareNodeWith(repo, node, base);
  });

  // The path relative to the repository, with the separator VS Code's own Copy Relative Path uses.
  cmd('commitCorner.copyFilePath', async (node) => {
    if (!node || typeof node.path !== 'string') return;
    let p = node.currentPath || node.path;
    const sep = vscode.workspace.getConfiguration('explorer').get('copyRelativePathSeparator', 'auto');
    if (sep === '\\' || (sep === 'auto' && process.platform === 'win32')) p = p.replace(/\//g, '\\');
    await vscode.env.clipboard.writeText(p);
    vscode.window.setStatusBarMessage(`Copied ${plain(p)}`, 2000);
  });

  cmd('commitCorner.revealFileInExplorer', async (node) => {
    const repo = nodeRepo(node);
    if (!repo) return;
    const work = await workingPathOf(repo, node.sha, node.path, node.currentPath);
    if (!work) {
      notify.info(`"${node.path}" is not in the working tree.`);
      return;
    }
    const uri = vscode.Uri.file(work.abs);
    // A repository outside the workspace folders has no Explorer entry: the OS file manager then.
    if (vscode.workspace.getWorkspaceFolder(uri)) await vscode.commands.executeCommand('revealInExplorer', uri);
    else await vscode.commands.executeCommand('revealFileInOS', uri);
  });

  // Viewed marks of commit files (bold until opened).
  const commitShas = (node) => (node ? (Array.isArray(node.shas) && node.shas.length ? node.shas : [node.sha]).filter(isFullSha) : []);
  const markCommits = (on) => async (node) => {
    const repo = node && manager.getRepository(node.repoRoot);
    if (!repo) return;
    for (const sha of commitShas(node).slice(0, 200)) {
      const { files } = await repo.getCommitFiles(sha);
      viewed.markCommitFiles(sha, files, on);
    }
  };
  cmd('commitCorner.markCommitViewed', markCommits(true));
  cmd('commitCorner.markCommitUnviewed', markCommits(false));
  // One file of a commit, from its menu in a tree (node: repoRoot, commitViewed = its commit, path, change).
  const markFile = (on) => async (node) => {
    const repo = node && manager.getRepository(node.repoRoot);
    const sha = node && node.commitViewed;
    if (!repo || !isFullSha(sha) || typeof node.path !== 'string') return;
    const change = node.change || {};
    await markOpened(repo, sha, { path: node.path, oldBlob: change.oldBlob, newBlob: change.newBlob }, on);
  };
  cmd('commitCorner.markCommitFileViewed', markFile(true));
  cmd('commitCorner.markCommitFileUnviewed', markFile(false));

  /**
   * The next file of the same commit you have not opened (after the one shown, around to the
   * start): from a diff opened from a commit's file list, or a node {repoRoot, sha, path?}.
   */
  cmd('commitCorner.nextUnviewedFile', async (node) => {
    let repo;
    let sha;
    let current;
    if (node && isFullSha(node.sha) && typeof node.repoRoot === 'string') {
      repo = manager.getRepository(node.repoRoot);
      sha = node.sha;
      current = node.path;
    } else {
      const r = activeUris().map((u) => revisionOf(manager, u)).find((x) => x && x.commit);
      if (r) {
        repo = r.repo;
        sha = r.commit;
        current = r.path;
      }
    }
    if (!repo || !sha) {
      vscode.window.setStatusBarMessage('Next Unviewed File works in a diff opened from a commit\'s files', 4000);
      return;
    }
    const { parent, files } = await repo.getCommitFiles(sha);
    const next = nextUnviewedOf(sha, files, current);
    if (!next) {
      vscode.window.setStatusBarMessage(`All ${files.length} file${files.length === 1 ? '' : 's'} of ${shortSha(sha)} are viewed`, 4000);
      return;
    }
    await openCommitFileDiff(repo, sha, parent, next);
    viewed.markCommitFiles(sha, [next]);
  });
}

module.exports = { register, compareBase, rememberBase, markOpened, treeOrder, nextUnviewedOf, compareNodeWith, openCommitFileDiff, mapToWorkingLine, workingPathOf, readAtMost };
