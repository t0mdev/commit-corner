'use strict';

const vscode = require('vscode');
const notify = require('../notify');
const { INDEX, WORKTREE } = require('../../git/repository');
const { SCHEME, fromGitUri } = require('../uri');
const { openDiff, openMultiDiff } = require('../diffs');
const { shortSha } = require('../util');

/**
 * Stepping through a file's history from a diff editor (previous / next
 * revision), and "open all changes" for Source Control groups.
 */

/** Repo, path and right-hand revision of the active editor or diff tab. */
async function currentRevision(manager) {
  const tab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab && tab.input;
  let uri = input && (input.modified || input.uri);
  if (!uri && vscode.window.activeTextEditor) uri = vscode.window.activeTextEditor.document.uri;
  if (!uri) return undefined;
  if (uri.scheme === SCHEME) {
    const q = fromGitUri(uri);
    const repo = manager.getRepository(q.repo);
    // History is followed from the file's current name (anchor), not the name it had back then.
    const rel = q.anchor || q.path;
    if (!repo || q.empty || !q.ref || q.ref.startsWith(':')) return repo && { repo, rel, sha: q.empty ? undefined : WORKTREE };
    return { repo, rel, sha: await repo.revParse(q.ref) };
  }
  if (uri.scheme === 'file') {
    const repo = manager.getRepositoryForUri(uri);
    return repo && { repo, rel: repo.relative(uri.fsPath), sha: WORKTREE };
  }
  return undefined;
}

/** Open the diff of the file in history entry `c` (its change in that commit). */
function openEntry(repo, c, currentPath) {
  const ch = c.change;
  return openDiff(repo, {
    anchor: currentPath,
    path: ch.path,
    leftRef: ch.status === 'A' ? null : `${c.sha}^`,
    leftPath: ch.origPath || ch.path,
    rightRef: ch.status === 'D' ? null : c.sha,
    title: `${(currentPath || ch.path).split('/').pop()} (${shortSha(c.sha)}) ${c.subject}`,
    preview: false,
  });
}

/** @param {import('../context').Context} ctx */
function register(ctx) {
  const { manager } = ctx;
  const cmd = ctx.command;

  async function step(direction) {
    const cur = await currentRevision(manager);
    if (!cur) return;
    // History is listed from HEAD, newest first, following renames.
    const history = await cur.repo.fileHistory(cur.rel, { maxCount: 2000 });
    if (!history.length) {
      vscode.window.setStatusBarMessage('Commit Corner: no history for this file', 3000);
      return;
    }
    const idx = cur.sha === WORKTREE ? -1 : history.findIndex((c) => c.sha === cur.sha);
    if (direction < 0) {
      const target = history[idx + 1];
      if (!target) {
        vscode.window.setStatusBarMessage('Commit Corner: this is the oldest revision', 3000);
        return;
      }
      await openEntry(cur.repo, target, cur.rel);
    } else if (idx > 0) {
      await openEntry(cur.repo, history[idx - 1], cur.rel);
    } else if (idx === 0) {
      // Newest commit already shown: the next step is the working tree.
      await openDiff(cur.repo, { path: cur.rel, leftRef: history[0].sha, leftPath: history[0].change.path, rightRef: WORKTREE, title: `${cur.rel.split('/').pop()} (${shortSha(history[0].sha)} ↔ Working Tree)`, preview: false });
    } else if (cur.sha !== WORKTREE) {
      // The shown commit did not change this file (e.g. a diff from a multi-commit view).
      vscode.window.setStatusBarMessage('Commit Corner: this revision is not in the file\'s history; showing its latest change instead', 4000);
      await openEntry(cur.repo, history[0], cur.rel);
    } else {
      vscode.window.setStatusBarMessage('Commit Corner: this is the newest revision', 3000);
    }
  }

  cmd('commitCorner.diffPrevious', () => step(-1));
  cmd('commitCorner.diffNext', () => step(1));

  /** Open every file of a Source Control group in the multi-diff editor. */
  cmd('commitCorner.openAllChanges', async (group) => {
    if (!group || !group.resourceStates) {
      // From the palette or the keyboard: pick the group.
      const repo = await manager.pick(group);
      const provider = repo && ctx.scm.get(repo);
      if (!provider) return;
      const groups = [provider.staged, provider.unstaged, provider.untracked, provider.merge].filter((g) => g.resourceStates.length);
      if (!groups.length) {
        notify.info('There are no changes.');
        return;
      }
      const pick = groups.length === 1 ? { g: groups[0] } : await vscode.window.showQuickPick(groups.map((g) => ({ label: g.label, description: `${g.resourceStates.length} file(s)`, g })), { placeHolder: 'Open all changes of…' });
      if (!pick) return;
      group = pick.g;
    }
    const states = group && group.resourceStates;
    if (!states || !states.length) return;
    const repo = manager.getRepository(states[0].repoRoot);
    if (!repo) return;
    const titles = { staged: 'Staged Changes', unstaged: 'Changes', untracked: 'Untracked Files', merge: 'Merge Changes' };
    const files = states.map((r) => {
      if (group.id === 'staged') return { path: r.path, leftRef: r.status === 'A' ? null : 'HEAD', leftPath: r.entry.origPath || r.path, rightRef: r.status === 'D' ? null : INDEX };
      if (group.id === 'merge') return { path: r.path, leftRef: ':2', rightRef: WORKTREE };
      if (group.id === 'untracked') return { path: r.path, leftRef: null, rightRef: WORKTREE };
      return { path: r.path, leftRef: r.status === 'A' ? null : INDEX, rightRef: r.status === 'D' ? null : WORKTREE };
    });
    await openMultiDiff(repo, `${titles[group.id] || 'Changes'} (${repo.name})`, files);
  });
}

module.exports = { register, currentRevision };
