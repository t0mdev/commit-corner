'use strict';

const vscode = require('vscode');
const { pendingRewrite } = require('../rewrites');
const { formatDate } = require('../util');

/**
 * "Commit Corner: Actions…" (Ctrl+Alt+G Space): one keyboard entry point to
 * every view and the most used actions, grouped, so nothing needs the mouse.
 */
const GROUPS = [
  ['Go to', [
    ['$(source-control) Source Control', 'workbench.view.scm'],
    ['$(git-merge) Graph', 'commitCorner.showGraph'],
    ['$(git-pull-request) Pull Requests', 'commitCorner.sidebar.pullRequests'],
    ['$(git-compare) Compare', 'commitCorner.sidebar.compare'],
    ['$(history) File History', 'commitCorner.sidebar.fileHistory'],
    ['$(git-merge) Graph (sidebar)', 'commitCorner.graphView.focusList'],
    ['$(repo) Repository: branches, tags, stashes', 'commitCorner.sidebar.branches'],
    ['$(list-tree) Worktrees', 'commitCorner.sidebar.worktrees'],
    ['$(dashboard) Worktrees Overview', 'commitCorner.showWorktrees'],
    ['$(git-compare) Changes of a Worktree vs Base (an agent\'s work)', 'commitCorner.worktreeChangesVsBase'],
    ['$(pulse) Repository Activity', 'commitCorner.showActivity'],
    ['$(diff) Changes Since You Last Looked', 'commitCorner.graphView.sinceLastLook'],
  ]],
  ['Commit', [
    ['$(check) Commit', 'commitCorner.commit'],
    ['$(check) Commit & Push', 'commitCorner.commitAndPush'],
    ['$(edit) Commit (Amend)', 'commitCorner.commitAmend'],
    ['$(discard) Undo Last Commit', 'commitCorner.undoLastCommit'],
    ['$(add) Stage Current File', 'commitCorner.stage'],
    ['$(remove) Unstage Current File', 'commitCorner.unstage'],
    ['$(diff) Open Changes of Current File', 'commitCorner.openChanges'],
    ['$(diff-multiple) Open All Changes…', 'commitCorner.openAllChanges'],
  ]],
  ['Sync', [
    ['$(sync) Sync', 'commitCorner.sync'],
    ['$(cloud-download) Fetch', 'commitCorner.fetch'],
    ['$(arrow-down) Pull', 'commitCorner.pull'],
    ['$(arrow-up) Push', 'commitCorner.push'],
  ]],
  ['Branches', [
    ['$(git-branch) Checkout…', 'commitCorner.checkout'],
    ['$(plus) Create Branch…', 'commitCorner.createBranch'],
    ['$(git-merge) Merge into Current Branch…', 'commitCorner.merge'],
    ['$(list-ordered) Interactive Rebase…', 'commitCorner.rebaseInteractive'],
    ['$(discard) Undo Last History Rewrite', 'commitCorner.undoRewrite'],
    ['$(git-compare) Compare Branches, Tags or Commits…', 'commitCorner.compareRefs'],
    ['$(git-pull-request) Open Pull Request…', 'commitCorner.prOpen'],
    ['$(git-pull-request-create) Create Pull Request…', 'commitCorner.createPullRequest'],
  ]],
  ['History', [
    ['$(history) File History', 'commitCorner.fileHistory'],
    ['$(history) Line History', 'commitCorner.lineHistory'],
    ['$(person) Toggle File Blame', 'commitCorner.toggleFileBlame'],
    ['$(git-commit) Show Commit of Current Line', 'commitCorner.showLineCommit'],
    ['$(history) Blame Before This Change (current line)', 'commitCorner.blamePrevious'],
    ['$(arrow-left) Previous Revision', 'commitCorner.diffPrevious'],
    ['$(arrow-right) Next Revision', 'commitCorner.diffNext'],
    ['$(go-to-file) Open File at Revision…', 'commitCorner.openFileAtRevision'],
    ['$(history) Reflog…', 'commitCorner.reflog'],
  ]],
  ['More', [
    ['$(archive) Stash…', 'commitCorner.stash'],
    ['$(arrow-up) Pop Stash…', 'commitCorner.stashPop'],
    ['$(search) Bisect…', 'commitCorner.bisectStart'],
    ['$(file-code) Create Patch…', 'commitCorner.createPatch'],
    ['$(file-code) Apply Patch…', 'commitCorner.applyPatch'],
    ['$(github) Sign In to GitHub (HTTPS credentials)', 'commitCorner.githubSignIn'],
    ['$(output) Show Git Output', 'commitCorner.showOutput'],
  ]],
];

/** Chord shown next to an action ("Ctrl+Alt+G A"), from the extension's own keybindings. */
function shortcutFor(id) {
  const { contributes } = require('../../../package.json');
  const kb = contributes.keybindings.find((k) => k.command === id && !/ctrl\+alt\+\S+ ctrl\+alt/.test(k.key));
  if (!kb) return undefined;
  const key = process.platform === 'darwin' && kb.mac ? kb.mac : kb.key;
  return key.split(' ').map((part) => part.split('+').map((k) => k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1)).join('+')).join(' ');
}

/** @param {import('../context').Context} ctx */
function register(ctx) {
  ctx.command('commitCorner.actions', async () => {
    const items = [];
    // Whatever is in progress comes first.
    const repo = ctx.manager.active;
    const op = repo && repo.state && repo.state.operation;
    if (op) {
      items.push({ label: `${op.kind} in progress`, kind: vscode.QuickPickItemKind.Separator });
      if (op.kind === 'bisect') {
        for (const [label, id] of [['$(pass) Bisect: Mark Good', 'commitCorner.bisectGood'], ['$(error) Bisect: Mark Bad', 'commitCorner.bisectBad'], ['$(debug-step-over) Bisect: Skip', 'commitCorner.bisectSkip'], ['$(debug-stop) Bisect: End', 'commitCorner.bisectReset']]) {
          items.push({ label, id, description: shortcutFor(id) });
        }
      } else {
        items.push({ label: `$(debug-continue) Continue ${op.kind}`, id: 'commitCorner.continueOperation' });
        if (['rebase', 'cherry-pick', 'revert'].includes(op.kind)) items.push({ label: '$(debug-step-over) Skip this commit', id: 'commitCorner.skipOperation' });
        items.push({ label: `$(debug-stop) Abort ${op.kind}`, id: 'commitCorner.abortOperation' });
      }
    }
    // Right after a rewrite, its undo comes first (before "Undo Last Commit", which would
    // undo something else).
    const rewrite = pendingRewrite(repo);
    if (rewrite) {
      items.push({ label: 'Just done', kind: vscode.QuickPickItemKind.Separator });
      items.push({ label: `$(discard) Undo Last History Rewrite: ${rewrite.label}`, id: 'commitCorner.undoRewrite', description: `${formatDate(rewrite.at)} · ${shortcutFor('commitCorner.undoRewrite') || ''}`.replace(/ · $/, '') });
    }
    for (const [group, actions] of GROUPS) {
      items.push({ label: group, kind: vscode.QuickPickItemKind.Separator });
      for (const [label, id] of actions) items.push({ label, id, description: shortcutFor(id) });
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Commit Corner: what do you want to do?', matchOnDescription: true });
    if (pick) await vscode.commands.executeCommand(pick.id);
  });
}

module.exports = { register, GROUPS };
