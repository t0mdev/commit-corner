'use strict';

const vscode = require('vscode');
const path = require('path');
const notify = require('../notify');
const { ErrorCodes, GitError } = require('../../git/exec');
const { githubWebUrl } = require('../../git/remoteUrl');
const { pickRef, pickRemote, inputBranchName } = require('../pickers');
const { confirm, withProgress, shortSha, showError, config, selectedShas, notice } = require('../util');

/**
 * Branch, tag, merge/rebase/reset and remote (fetch/pull/push) commands.
 *
 * Tree items and webviews pass node objects; these always carry `repoRoot`
 * and, depending on the node, `ref` (branch/tag name), `sha`, `remote`.
 */

/** @param {import('../context').Context} ctx */
function register(ctx) {
  const { manager } = ctx;
  const cmd = ctx.command;

  /** Checkout with a "stash and retry" escape hatch for dirty working trees. */
  async function checkoutWithStash(repo, doCheckout) {
    try {
      await doCheckout();
    } catch (e) {
      if (!(e instanceof GitError) || (e.code !== ErrorCodes.LocalChangesOverwritten && e.code !== ErrorCodes.UntrackedOverwritten)) throw e;
      const untracked = e.code === ErrorCodes.UntrackedOverwritten;
      const choice = await notify.warn(
        untracked ? 'Untracked files would be overwritten by checkout.' : 'Your local changes would be overwritten by checkout.',
        { modal: true }, 'Stash & Checkout', 'Force Checkout (discard changes)');
      if (choice === 'Stash & Checkout') {
        const before = new Set((await repo.getStashes()).map((s) => s.sha));
        await repo.stashPush({ message: 'Commit Corner: auto-stash before checkout', includeUntracked: true });
        // The stash this created (none, if nothing could be stashed): found by SHA, not position.
        const ours = (await repo.getStashes()).find((s) => !before.has(s.sha));
        try {
          await doCheckout();
        } catch (err) {
          // Say where the changes are: the checkout failed for another reason, after stashing.
          throw new Error(`Checkout failed after stashing: ${String(err.message).split('\n')[0]} Your changes are safe in the stash "Commit Corner: auto-stash before checkout" (Pop Stash… brings them back).`);
        }
        // "Keep" first (the default for Enter): the changes were made on another branch, and
        // popping them here may conflict; bringing them along is the deliberate choice.
        const pop = await notify.info('Checked out. Your changes are in a stash.', { modal: true, detail: 'Keep them in the stash for later (Pop Stash… brings them back), or pop them onto this branch now.' }, 'Keep in Stash', 'Pop Stash Here');
        if (pop === 'Pop Stash Here' && ours) {
          const now = (await repo.getStashes()).find((s) => s.sha === ours.sha);
          if (now) await runConflicting(repo, 'Popping stash…', () => repo.stashApply(now.ref, true), 'stash').catch((err) => showError(err, 'Pop stash'));
        }
      } else if (choice && choice.startsWith('Force')) {
        await doCheckout(true);
      }
    }
  }

  /** Check out a branch name, remote branch (creating a tracking branch), tag or commit. */
  async function checkoutRef(repo, ref, type) {
    const refs = await repo.getRefs();
    const local = refs.find((r) => r.type === 'branch' && r.name === ref);
    if (local) {
      // Checked out in another worktree (an agent's): git refuses; offer that worktree instead.
      const elsewhere = (await repo.getWorktrees().catch(() => [])).find((w) => w.branch === ref && path.resolve(w.path) !== path.resolve(repo.root));
      if (elsewhere) {
        const choice = await notify.info(`"${ref}" is checked out in the worktree ${elsewhere.path}.`, { modal: true, detail: 'A branch can be checked out in one worktree at a time. Open that worktree instead?' }, 'Open in New Window', 'Open Here');
        if (choice) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(elsewhere.path), { forceNewWindow: choice === 'Open in New Window' });
        return undefined;
      }
      return checkoutWithStash(repo, (force) => repo.checkout(ref, { force }));
    }
    const remote = refs.find((r) => r.type === 'remote' && r.name === ref);
    if (remote || type === 'remote') {
      // Remote names may contain "/": strip the longest matching remote name.
      const remoteNames = (await repo.getRemotes()).map((x) => x.name).sort((a, b) => b.length - a.length);
      const remoteName = remoteNames.find((n) => ref.startsWith(`${n}/`)) || ref.slice(0, ref.indexOf('/'));
      const localName = ref.slice(remoteName.length + 1);
      const existing = refs.find((r) => r.type === 'branch' && r.name === localName);
      if (existing) {
        const choice = await vscode.window.showQuickPick([
          { label: `Check out "${localName}"`, description: existing.upstream === ref ? 'already tracks this branch' : `local branch (${shortSha(existing.sha)})`, action: 'local' },
          { label: `Reset "${localName}" to ${ref} and check out`, description: 'discards commits only on the local branch', action: 'reset' },
          { label: 'Create a new tracking branch…', action: 'new' },
          { label: `Check out ${ref} detached`, action: 'detach' },
        ], { placeHolder: `A local branch "${localName}" already exists` });
        if (!choice) return undefined;
        if (choice.action === 'local') return checkoutWithStash(repo, (force) => repo.checkout(localName, { force }));
        if (choice.action === 'detach') return checkoutWithStash(repo, (force) => repo.checkout(ref, { detach: true, force }));
        if (choice.action === 'reset') {
          if (!(await confirm(`Reset "${localName}" to ${ref}?`, 'Reset', 'Commits only on the local branch will no longer be on any branch (they stay in the reflog).'))) return undefined;
          return checkoutWithStash(repo, (force) => repo.run(['checkout', '-q', ...(force ? ['--force'] : []), '-B', localName, '--track', ref, '--']));
        }
        const name = await inputBranchName('Name of the new tracking branch', `${localName}-2`, { repo });
        if (!name) return undefined;
        return checkoutWithStash(repo, (force) => repo.checkoutTracking(ref, name, force));
      }
      return checkoutWithStash(repo, (force) => repo.checkoutTracking(ref, localName, force));
    }
    return checkoutWithStash(repo, (force) => repo.checkout(ref, { detach: true, force }));
  }
  ctx.checkoutRef = checkoutRef;
  ctx.checkoutWithStash = checkoutWithStash;

  cmd('commitCorner.checkout', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    if (node && (node.ref || node.sha)) {
      await checkoutRef(repo, node.ref || node.sha, node.type);
      return;
    }
    const ref = await pickRef(repo, {
      placeHolder: 'Check out a branch, tag or commit',
      extra: [
        { label: '$(plus) Create new branch…', ref: '\0new' },
        { label: '$(plus) Create new branch from…', ref: '\0newFrom' },
      ],
      exclude: repo.state && repo.state.head.branch ? [repo.state.head.branch] : [],
    });
    if (!ref) return;
    if (ref === '\0new') return vscode.commands.executeCommand('commitCorner.createBranch', repo);
    if (ref === '\0newFrom') return vscode.commands.executeCommand('commitCorner.createBranchFrom', repo);
    await checkoutRef(repo, ref);
  });

  cmd('commitCorner.checkoutDetached', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const ref = node && (node.sha || node.ref) || await pickRef(repo, { placeHolder: 'Check out (detached HEAD)' });
    if (ref) await checkoutWithStash(repo, (force) => repo.checkout(ref, { detach: true, force }));
  });

  cmd('commitCorner.createBranch', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const start = node && (node.sha || node.ref);
    const name = await inputBranchName(start ? `New branch at ${node.ref || shortSha(node.sha)}` : 'New branch name (from the current commit)', undefined, { repo });
    if (!name) return;
    const checkout = config().get('checkoutNewBranch', true);
    // Switching to a new branch at another commit can meet local changes: the same "Stash &
    // Checkout" way out as Checkout (the typed name is kept).
    if (checkout) await checkoutWithStash(repo, (force) => repo.createBranch(name, start, true, { force }));
    else await repo.createBranch(name, start, false);
  });

  cmd('commitCorner.createBranchFrom', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const start = await pickRef(repo, { placeHolder: 'Create the branch from…', head: true });
    if (!start) return;
    const suggested = start.includes('/') ? start.slice(start.indexOf('/') + 1) : '';
    const name = await inputBranchName(`New branch from ${start}`, suggested, { repo });
    if (!name) return;
    await checkoutWithStash(repo, (force) => repo.createBranch(name, start, true, { force }));
  });

  cmd('commitCorner.deleteBranch', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const name = node && node.ref || await pickRef(repo, { placeHolder: 'Delete a local branch', remotes: false, tags: false, allowFreeText: false, exclude: [repo.state && repo.state.head.branch].filter(Boolean) });
    if (!name) return;
    if (repo.state && repo.state.head.branch === name) {
      notify.warn('Cannot delete the branch you are on. Check out another branch first.');
      return;
    }
    if (!(await confirm(`Delete branch "${name}"?`, 'Delete'))) return;
    try {
      await repo.deleteBranch(name, false);
    } catch (e) {
      if (!(e instanceof GitError) || e.code !== ErrorCodes.BranchNotFullyMerged) throw e;
      if (await confirm(`"${name}" is not fully merged. Delete it anyway?`, 'Force Delete', 'Its unmerged commits will only be reachable through the reflog.')) {
        await repo.deleteBranch(name, true);
      }
    }
  });

  cmd('commitCorner.deleteRemoteBranch', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const full = node && node.ref || await pickRef(repo, { placeHolder: 'Delete a remote branch', branches: false, tags: false, allowFreeText: false });
    if (!full) return;
    // Remote names may contain "/": prefer the remote recorded on the node, else the longest matching remote.
    const remotes = (await repo.getRemotes()).map((r) => r.name).sort((a, b) => b.length - a.length);
    const short = full.replace(/^refs\/remotes\//, '');
    const remote = node && node.remote || remotes.find((r) => short.startsWith(`${r}/`)) || short.slice(0, short.indexOf('/'));
    const branch = short.slice(remote.length + 1);
    if (!(await confirm(`Delete "${branch}" on remote "${remote}"?`, 'Delete Remote Branch', 'This changes the shared repository for everyone.'))) return;
    await withProgress(`Deleting ${full}…`, () => repo.deleteRemoteBranch(remote, branch));
  });

  cmd('commitCorner.renameBranch', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const oldName = node && node.ref || (repo.state && repo.state.head.branch);
    if (!oldName) return;
    const newName = await inputBranchName(`Rename "${oldName}" to`, oldName, { repo, allow: oldName });
    if (!newName || newName === oldName) return;
    await repo.renameBranch(oldName, newName);
  });

  cmd('commitCorner.merge', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const ref = node && (node.ref || node.sha) || await pickRef(repo, { placeHolder: `Merge into ${repo.state && repo.state.head.branch || 'HEAD'}`, exclude: [repo.state && repo.state.head.branch].filter(Boolean) });
    if (!ref) return;
    const how = await vscode.window.showQuickPick([
      { label: 'Merge', description: 'fast-forward when possible', o: {} },
      { label: 'Merge (no fast-forward)', description: 'always create a merge commit', o: { noFf: true } },
      { label: 'Fast-forward only', o: { ffOnly: true } },
      { label: 'Squash', description: 'stage the combined changes without committing', o: { squash: true } },
    ], { placeHolder: `Merge ${ref} into ${repo.state && repo.state.head.branch || 'HEAD'}` });
    if (!how) return;
    await runConflicting(repo, `Merging ${ref}…`, () => repo.merge(ref, how.o), 'merge');
  });

  cmd('commitCorner.rebase', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const current = repo.state && repo.state.head.branch;
    const ref = node && (node.ref || node.sha) || await pickRef(repo, { placeHolder: `Rebase ${current || 'HEAD'} onto…`, exclude: [current].filter(Boolean) });
    if (!ref) return;
    if (!(await confirm(`Rebase "${current || 'HEAD'}" onto "${ref.length === 40 ? shortSha(ref) : ref}"?`, 'Rebase', 'This rewrites the commits of the current branch.'))) return;
    await runConflicting(repo, `Rebasing onto ${ref}…`, () => repo.rebase(ref), 'rebase');
  });

  cmd('commitCorner.setUpstream', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const branch = node && node.type === 'branch' && node.ref || (repo.state && repo.state.head.branch);
    if (!branch) return;
    const upstream = await pickRef(repo, { placeHolder: `Upstream for "${branch}"`, branches: false, tags: false, extra: [{ label: '$(close) Unset upstream', ref: '\0unset' }] });
    if (!upstream) return;
    await repo.setUpstream(branch, upstream === '\0unset' ? undefined : upstream);
  });

  cmd('commitCorner.reset', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const ref = node && (node.sha || node.ref) || await pickRef(repo, { placeHolder: 'Reset the current branch to…', head: true });
    if (!ref) return;
    const branch = repo.state && repo.state.head.branch || 'HEAD';
    const mode = await vscode.window.showQuickPick([
      { label: 'Soft', description: 'keep all changes staged', mode: 'soft' },
      { label: 'Mixed', description: 'keep changes in the working tree, unstaged (default)', mode: 'mixed' },
      { label: 'Hard', description: 'discard all changes — cannot be undone for uncommitted work', mode: 'hard' },
      { label: 'Keep', description: 'like hard, but refuse if local changes would be lost', mode: 'keep' },
    ], { placeHolder: `Reset ${branch} to ${ref.length >= 40 ? shortSha(ref) : ref}` });
    if (!mode) return;
    if (mode.mode === 'hard' && !(await confirm(`Hard reset ${branch} to ${ref.length >= 40 ? shortSha(ref) : ref}?`, 'Reset --hard', 'All uncommitted changes to tracked files will be lost.'))) return;
    await repo.reset(ref, mode.mode);
  });

  cmd('commitCorner.cherryPick', async (node, nodes) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const shas = selectedShas(node, nodes);
    if (!shas || !shas.length) return;
    await runConflicting(repo, `Cherry-picking ${shas.length} commit(s)…`, () => repo.cherryPick(shas), 'cherry-pick');
  });

  cmd('commitCorner.cherryPickNoCommit', async (node, nodes) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const shas = selectedShas(node, nodes);
    if (!shas.length) return;
    // The changes land staged, ready to edit or combine before committing.
    await runConflicting(repo, `Applying ${shas.length} commit(s)…`, () => repo.cherryPick(shas, { noCommit: true }), 'cherry-pick');
  });

  cmd('commitCorner.revert', async (node, nodes) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const shas = selectedShas(node, nodes);
    if (!shas || !shas.length) return;
    if (!(await confirm(`Revert ${shas.length === 1 ? shortSha(shas[0]) : `${shas.length} commits`}?`, 'Revert', 'New commits that undo the changes will be created.'))) return;
    await runConflicting(repo, 'Reverting…', () => repo.revert(shas), 'revert');
  });

  // ---- tags ---------------------------------------------------------------

  cmd('commitCorner.createTag', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const target = node && (node.sha || node.ref);
    const name = await vscode.window.showInputBox({ prompt: `Tag name${target ? ` at ${target.length >= 40 ? shortSha(target) : target}` : ' (at HEAD)'}`, validateInput: (v) => (/^[^\s~^:?*[\\-][^\s~^:?*[\\]*$/.test(v) && !/\.\.|@\{|\.lock$|\/$|\.$/.test(v) ? undefined : 'Not a valid tag name') });
    if (!name) return;
    const message = await vscode.window.showInputBox({ prompt: 'Annotation message (leave empty for a lightweight tag)' });
    if (message === undefined) return;
    await repo.createTag(name, target, message || undefined);
  });

  cmd('commitCorner.deleteTag', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const name = node && node.ref || await pickRef(repo, { placeHolder: 'Delete a tag', branches: false, remotes: false, allowFreeText: false });
    if (!name) return;
    if (!(await confirm(`Delete tag "${name}" locally?`, 'Delete'))) return;
    await repo.deleteTag(name);
  });

  cmd('commitCorner.pushTag', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const name = node && node.ref || await pickRef(repo, { placeHolder: 'Push a tag', branches: false, remotes: false, allowFreeText: false });
    if (!name) return;
    const remote = await pickRemote(repo);
    if (remote) await withProgress(`Pushing tag ${name}…`, () => repo.pushTag(remote, name));
  });

  cmd('commitCorner.deleteRemoteTag', async (node) => {
    const repo = await manager.pick(node);
    if (!repo || !node || !node.ref) return;
    const remote = await pickRemote(repo);
    if (!remote) return;
    if (!(await confirm(`Delete tag "${node.ref}" on "${remote}"?`, 'Delete Remote Tag'))) return;
    await withProgress(`Deleting remote tag ${node.ref}…`, () => repo.deleteRemoteTag(remote, node.ref));
  });

  // ---- remotes ------------------------------------------------------------

  /** Network operations show a cancellable notification and honour the configured timeout. */
  const net = (title, task) => withProgress(title, (signal) => task(signal, networkTimeout()));

  cmd('commitCorner.fetch', async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo) return;
    const all = config().get('fetchAllRemotes', true);
    await net('Fetching…', (signal, timeout) => repo.fetch({ all: all && !(arg && arg.remote), remote: arg && arg.remote, signal, timeout }));
  });

  cmd('commitCorner.pull', (arg) => pull(arg, undefined));
  cmd('commitCorner.pullRebase', (arg) => pull(arg, true));

  async function pull(arg, rebase) {
    const repo = await manager.pick(arg);
    if (!repo) return false;
    const branch = await repo.currentBranch();
    if (!branch) {
      notify.warn('You are not on a branch (detached HEAD), so there is nothing to pull into.');
      return false;
    }
    if (!(await repo.getUpstream(branch))) {
      const choice = await notify.warn(`"${branch}" has no upstream branch.`, 'Set Upstream…');
      if (choice) await vscode.commands.executeCommand('commitCorner.setUpstream', repo);
      return false;
    }
    if (rebase === undefined && config().get('pullRebase', false)) rebase = true;
    return runConflicting(repo, `Pulling${rebase ? ' (rebase)' : ''}…`, (signal) => repo.pull({ rebase, signal, timeout: networkTimeout() }), rebase ? 'rebase' : 'merge', { notification: true });
  }

  async function push(arg, force, to) {
    const repo = await manager.pick(arg);
    if (!repo) return;
    const branch = await repo.currentBranch();
    if (!branch) {
      notify.warn('You are not on a branch (detached HEAD). Create a branch to push.');
      return;
    }
    const upstream = await repo.getUpstream(branch);
    const target = upstream ? `${upstream.pushRemote || upstream.remote}/${upstream.merge.replace(/^refs\/heads\//, '')}` : undefined;
    if (force && !(await confirm(`Force push "${branch}"${target ? ` to ${target}` : ''}?`, 'Force Push (with lease)', 'Commits on the remote that you do not have locally will be overwritten. --force-with-lease refuses if the remote changed since your last fetch.'))) return;
    try {
      if (!upstream) {
        const remote = await pickRemote(repo, `Publish "${branch}" to…`);
        if (!remote) return;
        await net(`Publishing ${branch}…`, (signal, timeout) => repo.push({ remote, refspec: `refs/heads/${branch}:refs/heads/${branch}`, setUpstream: true, force: force && 'lease', signal, timeout }));
        // A freshly published branch usually becomes a pull request.
        const r = (await repo.getRemotes()).find((x) => x.name === remote);
        if (r && githubWebUrl(r.fetchUrl) && !arg?.noPullRequestOffer) {
          notice('publishPullRequest', `Published "${branch}" to ${remote}.`, 'Create Pull Request…').then((c) => {
            if (c) vscode.commands.executeCommand('commitCorner.createPullRequest', { repoRoot: repo.root, ref: branch, type: 'branch' });
          });
        }
      } else {
        await net(`Pushing ${branch}…`, (signal, timeout) => repo.push({ force: force && 'lease', tags: config().get('pushFollowTags', false), to, signal, timeout }));
      }
    } catch (e) {
      if (e instanceof GitError && e.code === ErrorCodes.UpstreamNameMismatch) {
        // Same rule as git's push.default=simple: make the target explicit.
        const d = e.details;
        const choice = await notify.warn(
          `"${d.branch}" tracks "${d.remote}/${d.upstream}", which has a different name. Where should it be pushed?`,
          { modal: true, detail: 'Set "push.default" in your git config (current or upstream) to stop being asked.' },
          `Push to ${d.remote}/${d.branch}`, `Push to ${d.remote}/${d.upstream}`);
        if (choice) await push(repo, force, choice.endsWith(`/${d.branch}`) ? 'sameName' : 'upstream');
        return;
      }
      if (e instanceof GitError && e.code === ErrorCodes.PullRequestUpstream) {
        const choice = await notify.warn(`"${branch}" follows a pull request, which can only be pulled from. Push your commits to a branch instead (for example the PR's source branch, if you can write to it).`, 'Push to Branch…');
        if (choice) await vscode.commands.executeCommand('commitCorner.pushTo', repo);
        return;
      }
      if (e instanceof GitError && e.code === ErrorCodes.PushRejected && !force) {
        const choice = await notify.warn('Push was rejected: the remote has commits you do not have.', { modal: true }, 'Pull & Push', 'Force Push (with lease)…');
        if (choice === 'Pull & Push') {
          if (await pull(repo, undefined)) await push(repo, false);
        } else if (choice) await push(repo, true);
        return;
      }
      throw e;
    }
  }

  cmd('commitCorner.push', (arg) => push(arg, false));
  cmd('commitCorner.pushForce', (arg) => push(arg, true));

  cmd('commitCorner.pushTo', async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo) return;
    const branch = await repo.currentBranch();
    const remote = await pickRemote(repo, 'Push to which remote?');
    if (!remote) return;
    const dest = await vscode.window.showInputBox({ prompt: `Branch on "${remote}" to push ${branch || 'HEAD'} to`, value: branch || '' });
    if (!dest) return;
    const setUpstream = branch ? (await vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: `Make ${remote}/${dest} the upstream of "${branch}"?` })) === 'Yes' : false;
    await net(`Pushing to ${remote}/${dest}…`, (signal, timeout) => repo.push({ remote, refspec: `HEAD:refs/heads/${dest}`, setUpstream, signal, timeout }));
  });

  cmd('commitCorner.sync', async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo) return;
    const branch = await repo.currentBranch();
    if (!branch || !(await repo.getUpstream(branch))) return push(repo, false);
    const state = await repo.refreshState();
    if (state.head.behind > 0 || config().get('syncAlwaysPull', true)) {
      if (!(await pull(repo, undefined))) return;
    }
    const after = await repo.refreshState();
    if (after.conflicts.length || after.operation) return;
    if (after.head.ahead > 0) await push(repo, false);
  });

  cmd('commitCorner.addRemote', async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo) return;
    const name = await vscode.window.showInputBox({ prompt: 'Remote name', value: (await repo.getRemotes()).length ? '' : 'origin' });
    if (!name) return;
    const url = await vscode.window.showInputBox({ prompt: `URL for "${name}"`, placeHolder: 'git@github.com:owner/repo.git' });
    if (!url) return;
    await repo.addRemote(name, url);
    if (await confirm(`Fetch from "${name}" now?`, 'Fetch')) await withProgress(`Fetching ${name}…`, (signal) => repo.fetch({ remote: name, signal }));
  });

  cmd('commitCorner.renameRemote', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const name = node && node.remote || await pickRemote(repo, 'Rename which remote?');
    if (!name) return;
    const next = await vscode.window.showInputBox({ prompt: `New name for "${name}"`, value: name, validateInput: (v) => (/^[\w.-]+$/.test(v) ? undefined : 'Letters, digits, ".", "_" and "-" only') });
    if (next && next !== name) await repo.renameRemote(name, next);
  });

  cmd('commitCorner.setRemoteUrl', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const name = node && node.remote || await pickRemote(repo, 'Change the URL of which remote?');
    if (!name) return;
    const current = (await repo.getRemotes()).find((r) => r.name === name);
    const url = await vscode.window.showInputBox({ prompt: `URL for "${name}"`, value: current && current.fetchUrl });
    if (url && (!current || url !== current.fetchUrl)) await repo.setRemoteUrl(name, url);
  });

  cmd('commitCorner.removeRemote', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const name = node && node.remote || await pickRemote(repo, 'Remove which remote?');
    if (!name) return;
    if (!(await confirm(`Remove remote "${name}"?`, 'Remove', 'Its remote-tracking branches are deleted locally. Nothing on the server changes.'))) return;
    await repo.removeRemote(name);
  });
}

function networkTimeout() {
  const seconds = config().get('networkTimeoutSeconds', 0);
  return seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * Run a merge-like operation. Conflicts are an expected outcome, not an
 * error: explain where to resolve them. Resolves true when the operation
 * completed without conflicts.
 * @param {'merge'|'rebase'|'cherry-pick'|'revert'|'am'|'stash'|'patch'} kind
 */
async function runConflicting(repo, title, task, kind, opts = {}) {
  // Undoing a conflicted stash apply uses `reset --merge`, which would also throw away changes
  // that were staged before; only offer it when nothing was staged.
  const canUndoStash = kind === 'stash' && !((await repo.refreshState()).staged.length);
  try {
    await withProgress(title, task, opts.notification ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window);
    return true;
  } catch (e) {
    if (!(e instanceof GitError) || e.code !== ErrorCodes.Conflict) throw e;
    // What actually stopped (a pull may rebase because of pull.rebase in git config).
    const op = await repo.getOperation();
    if (op && op.kind !== kind && ['merge', 'rebase', 'cherry-pick', 'revert', 'am'].includes(op.kind)) kind = op.kind;
    if (kind === 'stash') {
      // A conflicted stash apply/pop keeps the stash and leaves no operation to continue.
      const choice = await notify.warn(
        'The stash was applied with conflicts and has been kept. Resolve the conflicts in Source Control and stage the files.',
        'Open Source Control', ...(canUndoStash ? ['Undo the Apply'] : []));
      if (choice === 'Open Source Control') await vscode.commands.executeCommand('workbench.view.scm');
      else if (choice) await repo.abortOperation('stash');
      return false;
    }
    if (kind === 'patch') {
      const choice = await notify.warn('The patch was applied with conflicts. Resolve them in Source Control and stage the files.', 'Open Source Control');
      if (choice) await vscode.commands.executeCommand('workbench.view.scm');
      return false;
    }
    const choice = await notify.warn(
      `The ${kind} stopped with conflicts. Resolve them in Source Control (Merge Changes), stage, then continue.`,
      'Open Source Control', `Abort ${kind}`);
    if (choice === 'Open Source Control') await vscode.commands.executeCommand('workbench.view.scm');
    else if (choice) await repo.abortOperation(kind);
    return false;
  }
}

module.exports = { register, runConflicting, networkTimeout };
