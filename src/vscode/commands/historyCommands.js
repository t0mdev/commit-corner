'use strict';

const vscode = require('vscode');
const notify = require('../notify');
const { WORKTREE, EMPTY_TREE } = require('../../git/repository');
const { githubWebUrl, githubFileUrl, githubCommitUrl, githubPullUrl } = require('../../git/remoteUrl');
const { openDiff, openMultiDiff, openAtRevision } = require('../diffs');
const { pickRef, pickCommit } = require('../pickers');
const { shortSha, formatDate, config, selectedShas, escapeIcons } = require('../util');
const { fromGitUri, SCHEME } = require('../uri');
const { selectionRanges } = require('./lineStaging');
const { mapRangesToFrom, eolOf, withEol, DiffTooLargeError } = require('../../git/lineDiff');

/**
 * Commands about history: showing commits, multi-commit diffs, file and line
 * history, comparing a file with other revisions, GitHub links, reflog.
 */

const isFullSha = (s) => typeof s === 'string' && /^[0-9a-f]{40,64}$/.test(s);

/** Resolve (repo, relative path) from a URI argument or the active editor. */
function fileTarget(manager, uri) {
  if (!(uri instanceof vscode.Uri)) {
    if (uri && uri.resourceUri) uri = uri.resourceUri;
    else if (uri && uri.repoRoot && uri.path) return { repo: manager.getRepository(uri.repoRoot), rel: uri.path };
    else uri = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
  }
  if (!uri) return undefined;
  if (uri.scheme === SCHEME) {
    const q = fromGitUri(uri);
    return { repo: manager.getRepository(q.repo), rel: q.path, ref: q.ref };
  }
  const repo = manager.getRepositoryForUri(uri);
  if (!repo) return undefined;
  return { repo, rel: repo.relative(uri.fsPath) };
}

/**
 * Open all changes of one commit (vs. its first parent) in the multi-diff editor.
 * @param {import('../../git/repository').Repository} repo
 */
async function showCommit(repo, sha, parentIndex = 0) {
  const { commit, parent: firstParent, files: firstFiles } = await repo.getCommitFiles(sha);
  // Merge commits: optionally against another parent (what the merged branch brought in).
  const parent = parentIndex ? commit.parents[parentIndex] : firstParent;
  const files = parentIndex && parent ? await repo.diffFiles(parent, commit.sha) : firstFiles;
  await openMultiDiff(repo, `${shortSha(commit.sha)}${parentIndex ? ` (vs parent ${parentIndex + 1})` : ''} — ${commit.subject}`, files.map((f) => ({
    path: f.path,
    leftRef: f.status === 'A' ? null : parent || EMPTY_TREE,
    leftPath: f.origPath || f.path,
    rightRef: f.status === 'D' ? null : commit.sha,
  })));
}

/** Open the combined diff of several commits (IntelliJ semantics, see multiCommit.js). */
async function showCommits(repo, shas) {
  if (shas.length === 1) return showCommit(repo, shas[0]);
  const { files, exact, failed, approximate = [] } = await repo.getMultiCommitChanges(shas);
  if (!exact) {
    // Only the files that need unselected commits are approximate; name them.
    const which = approximate.length ? `${approximate.length} file${approximate.length === 1 ? '' : 's'} (${approximate.slice(0, 3).join(', ')}${approximate.length > 3 ? ', …' : ''})` : 'the files';
    notify.warn(
      `${failed.map(shortSha).join(', ')} only applies together with commits you did not select: ${which} span from before the oldest to after the newest selected commit, including edits of unselected commits in between. All other files are exact.`);
  }
  await openMultiDiff(repo, `${shas.length} commits${exact ? '' : ' (approximate)'}`, files.map((f) => ({
    path: f.path,
    leftRef: f.beforeRef === null ? null : f.beforeRef || EMPTY_TREE,
    leftPath: f.beforePath,
    rightRef: f.afterRef,
    rightPath: f.afterPath,
    // The sides are trees built for this view, not commits: name them for what they are.
    leftLabel: 'before',
    rightLabel: `${shas.length} commits`,
  })));
}

/** Diff of the contiguous range oldest^..newest of a selection. */
async function showRange(repo, shas) {
  const ordered = await repo.sortTopologically(shas);
  const oldest = ordered[0];
  const newest = ordered[ordered.length - 1];
  const oldestCommit = await repo.getCommit(oldest);
  const from = oldestCommit.parents[0] || EMPTY_TREE;
  const files = await repo.diffFiles(from, newest);
  await openMultiDiff(repo, `${shortSha(oldest)}^ … ${shortSha(newest)}`, files.map((f) => ({
    path: f.path,
    leftRef: f.status === 'A' ? null : from,
    leftPath: f.origPath || f.path,
    rightRef: f.status === 'D' ? null : newest,
  })));
}

/** @param {import('../context').Context} ctx */
function register(ctx) {
  const { manager } = ctx;
  const cmd = ctx.command;

  cmd('commitCorner.showCommit', async (node, nodes) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const shas = selectedShas(node, nodes);
    if (shas.length > 1) {
      await showCommits(repo, shas);
      return;
    }
    const sha = shas[0] || await pickCommit(repo, 'Show the changes of a commit');
    if (sha) await showCommit(repo, sha);
  });

  cmd('commitCorner.showCommitParent2', async (node) => {
    const repo = await manager.pick(node);
    if (!repo || !node || !node.sha) return;
    const c = await repo.getCommit(node.sha);
    if (c.parents.length < 2) {
      notify.info('That commit is not a merge commit.');
      return;
    }
    await showCommit(repo, c.sha, 1);
  });

  cmd('commitCorner.showCommits', async (node, nodes) => {
    const repo = await manager.pick(node);
    const shas = selectedShas(node, nodes);
    if (repo && shas.length) await showCommits(repo, shas);
  });

  cmd('commitCorner.showCommitRange', async (node, nodes) => {
    const repo = await manager.pick(node);
    const shas = selectedShas(node, nodes);
    if (repo && shas.length) await showRange(repo, shas);
  });

  /**
   * File History multi-selection: compare the file between two selected
   * revisions (older ↔ newer), or show the combined change of several
   * (before the oldest ↔ after the newest).
   */
  const compareRevisions = async (node, nodes, combined) => {
    const repo = await manager.pick(node);
    const list = (Array.isArray(nodes) && nodes.length ? nodes : [node]).filter((n) => n && n.sha && n.path);
    if (!repo || !list.length) return;
    const order = await repo.sortTopologically(list.map((n) => n.sha));
    const bySha = new Map(list.map((n) => [n.sha, n]));
    const oldest = bySha.get(order[0]);
    const newest = bySha.get(order[order.length - 1]);
    const name = (newest.currentPath || newest.path).split('/').pop();
    if (combined !== true) {
      // Compare two revisions with each other (oldest ↔ newest of the selection).
      // A revision that deleted the file has nothing to show on its side.
      await openDiff(repo, { path: newest.path, leftRef: oldest.status === 'D' ? null : oldest.sha, leftPath: oldest.path, rightRef: newest.status === 'D' ? null : newest.sha, rightPath: newest.path, title: `${name} (${shortSha(oldest.sha)} ↔ ${shortSha(newest.sha)})` });
      return;
    }
    // The combined change of the selected revisions: before the oldest ↔ after the newest.
    await openDiff(repo, {
      path: newest.path,
      leftRef: oldest.status === 'A' ? null : `${oldest.sha}^`,
      leftPath: oldest.origPath || oldest.path,
      rightRef: newest.status === 'D' ? null : newest.sha,
      rightPath: newest.path,
      title: `${name} (${list.length} revisions: ${shortSha(oldest.sha)}^ ↔ ${shortSha(newest.sha)})`,
    });
  };
  cmd('commitCorner.compareRevisions', (node, nodes) => compareRevisions(node, nodes, false));
  cmd('commitCorner.combinedRevisions', (node, nodes) => compareRevisions(node, nodes, true));

  /** Diff one file of a commit (node from history/commit trees). */
  cmd('commitCorner.openCommitFile', async (node) => {
    const repo = manager.getRepository(node.repoRoot);
    if (!repo) return;
    await openDiff(repo, {
      path: node.path,
      leftRef: node.status === 'A' || node.leftRef === null ? null : node.leftRef || (typeof node.parent === 'string' ? node.parent : undefined) || EMPTY_TREE,
      leftPath: node.origPath || node.path,
      rightRef: node.status === 'D' ? null : node.rightRef || node.sha,
      title: node.title,
      preserveFocus: !!node.preserveFocus,
      commit: isFullSha(node.viewedSha) ? node.viewedSha : undefined,
    });
    // A file of one commit: opened, it is no longer bold (here and in the graph).
    if (isFullSha(node.viewedSha)) await require('./fileCommands').markOpened(repo, node.viewedSha, { path: node.path, oldBlob: node.oldBlob, newBlob: node.newBlob });
  });

  cmd('commitCorner.openFileAtCommit', async (node) => {
    const repo = manager.getRepository(node.repoRoot);
    if (repo) await openAtRevision(repo, node.status === 'D' ? `${node.sha}^` : node.sha, node.status === 'D' ? node.origPath || node.path : node.path, { preview: false });
  });

  cmd('commitCorner.restoreFileFromCommit', async (node) => {
    const repo = manager.getRepository(node.repoRoot);
    if (!repo) return;
    // Deleted in that commit: the version to restore is the one just before it.
    const deleted = node.status === 'D';
    const rev = deleted ? `${node.sha}^` : node.sha;
    const ok = await notify.warn(`Replace "${node.path}" in the working tree with its version from ${deleted ? `before ${shortSha(node.sha)} (deleted there)` : shortSha(node.sha)}?`, { modal: true }, 'Restore');
    if (ok) await repo.restoreFile(node.path, rev);
  });

  cmd('commitCorner.compareWithRef', async (uri) => {
    const t = fileTarget(manager, uri);
    if (!t || !t.repo) return;
    const ref = await pickRef(t.repo, { placeHolder: `Compare ${t.rel} with…`, head: true });
    if (!ref) return;
    await openDiff(t.repo, { path: t.rel, leftRef: ref, rightRef: WORKTREE });
  });

  cmd('commitCorner.compareWithPrevious', async (uri) => {
    const t = fileTarget(manager, uri);
    if (!t || !t.repo) return;
    // The index (":", ":1"–":3") and the working tree are not revisions: their history is HEAD's.
    const isRevision = t.ref && !t.ref.startsWith(':') && t.ref !== WORKTREE;
    const history = await t.repo.fileHistory(t.rel, { maxCount: 2, ref: isRevision ? t.ref : 'HEAD' });
    if (!history.length) {
      notify.info('This file has no committed history yet.');
      return;
    }
    const dirty = t.repo.state && [...t.repo.state.unstaged, ...t.repo.state.staged].some((e) => e.path === t.rel);
    if (dirty && !t.ref) {
      // Working tree differs from HEAD: compare with the last committed version.
      const c = history[0];
      await openDiff(t.repo, { path: t.rel, leftRef: c.sha, leftPath: c.change.path, rightRef: WORKTREE });
    } else {
      const c = history[0];
      await openDiff(t.repo, { path: t.rel, leftRef: c.change.status === 'A' ? null : `${c.sha}^`, leftPath: c.change.origPath || c.change.path, rightRef: c.sha, rightPath: c.change.path, title: `${t.rel.split('/').pop()} (${shortSha(c.sha)}^ ↔ ${shortSha(c.sha)}) ${c.subject}` });
    }
  });

  cmd('commitCorner.openFileAtRevision', async (uri) => {
    const t = fileTarget(manager, uri);
    if (!t || !t.repo) return;
    const history = await t.repo.fileHistory(t.rel, { maxCount: 500 });
    const pick = await vscode.window.showQuickPick(history.map((c) => ({
      label: c.subject,
      description: `${shortSha(c.sha)} • ${c.authorName} • ${formatDate(c.authorDate)}`,
      c,
    })), { placeHolder: `Open ${t.rel} at revision…`, matchOnDescription: true });
    if (!pick) return;
    const c = pick.c;
    await openAtRevision(t.repo, c.change.status === 'D' ? `${c.sha}^` : c.sha, c.change.status === 'D' ? c.change.origPath || c.change.path : c.change.path, { preview: false });
  });

  // Ctrl+C in a tree view: the selected commits' SHAs (or, for other rows, their branch or
  // tag name, or file path) — one per line.
  cmd('commitCorner.copySelection', async (viewId) => {
    const view = require('../util').treeViews.get(viewId);
    const sel = view ? view.selection : [];
    const what = (n) => {
      if (!n) return undefined;
      if (n.commit && typeof n.sha === 'string') return n.sha; // a commit row
      if (n.change && n.change.path) return n.change.path; // a file row
      if (n.ref) return String(n.ref); // a branch, tag or remote branch
      if (typeof n.sha === 'string' && /^[0-9a-f]{7,64}$/.test(n.sha)) return n.sha; // a stash, a PR head
      return undefined;
    };
    const text = [...new Set(sel.map(what).filter(Boolean))];
    if (!text.length) return;
    await vscode.env.clipboard.writeText(text.join('\n'));
    vscode.window.setStatusBarMessage(`Copied ${text.length === 1 ? (isShaLike(text[0]) ? shortSha(text[0]) : text[0]) : `${text.length} lines`}`, 2000);
  });
  const isShaLike = (t) => /^[0-9a-f]{40,64}$/.test(t);

  cmd('commitCorner.copySha', async (node, nodes) => {
    const shas = selectedShas(node, nodes);
    if (!shas.length) return;
    await vscode.env.clipboard.writeText(shas.join('\n'));
    vscode.window.setStatusBarMessage(shas.length === 1 ? `Copied ${shortSha(shas[0])}` : `Copied ${shas.length} SHAs`, 2000);
  });

  cmd('commitCorner.copyMessage', async (node) => {
    const repo = await manager.pick(node);
    if (!repo || !node || !node.sha) return;
    const c = await repo.getCommit(node.sha);
    await vscode.env.clipboard.writeText(c.body || c.subject);
  });

  async function remoteBase(repo) {
    const remotes = await repo.getRemotes();
    const preferred = remotes.find((r) => r.name === 'upstream' && githubWebUrl(r.fetchUrl))
      || remotes.find((r) => r.name === 'origin' && githubWebUrl(r.fetchUrl))
      || remotes.find((r) => githubWebUrl(r.fetchUrl));
    return preferred ? githubWebUrl(preferred.fetchUrl) : undefined;
  }

  /** The pull request a commit came from ("… (#123)", "Merge pull request #123"), on github.com. */
  cmd('commitCorner.openPullRequestOnGitHub', async (node) => {
    const repo = await manager.pick(node);
    const n = node && Number(node.number);
    if (!repo || !Number.isSafeInteger(n) || n <= 0) return;
    const base = await remoteBase(repo);
    if (!base) {
      notify.warn('No github.com remote found.');
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(githubPullUrl(base, n)));
  });

  cmd('commitCorner.openCommitOnGitHub', async (node) => {
    const repo = await manager.pick(node);
    if (!repo || !node || !node.sha) return;
    const base = await remoteBase(repo);
    if (!base) {
      notify.warn('No github.com remote found.');
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(githubCommitUrl(base, node.sha)));
  });

  async function fileLink(uri) {
    const t = fileTarget(manager, uri);
    if (!t || !t.repo) return undefined;
    const base = await remoteBase(t.repo);
    if (!base) {
      notify.warn('No github.com remote found.');
      return undefined;
    }
    const sha = t.ref && /^[0-9a-f]{40,64}$/.test(t.ref) ? t.ref : await t.repo.revParse('HEAD');
    const { stdout } = await t.repo.exec(['branch', '-r', '--contains', sha], { allowFailure: true });
    if (!stdout.trim()) notify.warn(`${shortSha(sha)} is not on any remote branch yet; the link works once you push.`);
    const editor = vscode.window.activeTextEditor;
    let start;
    let end;
    if (editor && (!(uri instanceof vscode.Uri) || editor.document.uri.toString() === uri.toString())) {
      let [r] = selectionRanges(editor);
      if (editor.document.uri.scheme === 'file') {
        // The link points at the commit: carry the selection through uncommitted edits above it.
        const committed = await t.repo.showText(sha, t.rel);
        const text = editor.document.getText();
        if (committed === null) notify.warn(`"${t.rel}" is not in ${shortSha(sha)} yet; the link works once it is committed and pushed.`);
        else if (committed !== text) {
          try {
            [r] = mapRangesToFrom(committed, withEol(text, eolOf(committed, eolOf(text))), [r]);
          } catch (e) {
            if (!(e instanceof DiffTooLargeError)) throw e;
          }
        }
      }
      start = r.start + 1;
      end = r.end + 1;
    }
    return githubFileUrl(base, sha, t.rel, start, end);
  }

  cmd('commitCorner.openFileOnGitHub', async (uri) => {
    const url = await fileLink(uri);
    if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
  });

  cmd('commitCorner.copyPermalink', async (uri) => {
    const url = await fileLink(uri);
    if (!url) return;
    await vscode.env.clipboard.writeText(url);
    vscode.window.setStatusBarMessage('Permalink copied', 2000);
  });

  cmd('commitCorner.reflog', async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo) return;
    const entries = await repo.reflog(300);
    const pick = await vscode.window.showQuickPick(entries.map((e) => ({
      label: escapeIcons(e.message),
      description: `${e.selector} • ${shortSha(e.sha)} • ${formatDate(e.date)}`,
      e,
    })), { placeHolder: 'Reflog: every position HEAD has been at. Pick one to act on.', matchOnDescription: true });
    if (!pick) return;
    const node = { repoRoot: repo.root, sha: pick.e.sha };
    const action = await vscode.window.showQuickPick([
      { label: '$(diff) Show changes', id: 'commitCorner.showCommit' },
      { label: '$(git-branch) Create branch here…', id: 'commitCorner.createBranch' },
      { label: '$(debug-restart) Reset current branch to here…', id: 'commitCorner.reset' },
      { label: '$(check) Check out (detached)', id: 'commitCorner.checkoutDetached' },
      { label: '$(copy) Copy SHA', id: 'commitCorner.copySha' },
    ], { placeHolder: `${shortSha(pick.e.sha)} — ${pick.e.message}` });
    if (action) await vscode.commands.executeCommand(action.id, node);
  });
}

module.exports = { register, showCommit, showCommits, showRange, fileTarget };
