'use strict';

const vscode = require('vscode');
const notify = require('../notify');
const { githubWebUrl, githubCompareUrl } = require('../../git/remoteUrl');
const { isPullRequestRef } = require('../../git/parse');
const { confirm, escapeIcons } = require('../util');

/**
 * "Create Pull Request…": opens github.com's compare page for a published
 * branch, with the base branch chosen here. A plain link: no GitHub API.
 * For forks (a github.com remote called "upstream"), the pull request goes to
 * that repository with the head written as owner:branch.
 */

/**
 * Work out where a pull request for `branch` would go.
 * @returns {Promise<{error?: string, needsPublish?: boolean, headWeb?: string, headBranch?: string, baseRemote?: string, baseWeb?: string, ahead?: number}>}
 */
async function pullRequestTarget(repo, branch) {
  const up = await repo.getUpstream(branch);
  if (!up || up.remote === '.') return { needsPublish: true };
  if (isPullRequestRef(up.merge)) return { error: `"${branch}" follows a pull request; push your work to a branch of its own first.` };
  const remotes = await repo.getRemotes();
  const web = (name) => {
    const r = remotes.find((x) => x.name === name);
    return r ? githubWebUrl(r.pushUrl || r.fetchUrl) || githubWebUrl(r.fetchUrl) : undefined;
  };
  const headRemote = up.pushRemote || up.remote;
  // A triangular setup pushes the branch under its own name.
  const headBranch = up.pushRemote && up.pushRemote !== up.remote ? branch : up.merge.replace(/^refs\/heads\//, '');
  const headWeb = web(headRemote);
  if (!headWeb) return { error: `"${headRemote}" is not a github.com remote.` };
  const baseRemote = headRemote !== 'upstream' && web('upstream') ? 'upstream' : headRemote;
  const counts = await repo.exec(['rev-list', '--count', `${up.trackingRef || `${headRemote}/${headBranch}`}..${branch}`], { allowFailure: true });
  return { headWeb, headBranch, baseRemote, baseWeb: web(baseRemote), ahead: Number(counts.stdout.trim()) || 0 };
}

/** @param {import('../context').Context} ctx */
function register(ctx) {
  const { manager } = ctx;

  ctx.command('commitCorner.createPullRequest', async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo) return;
    // A local branch node (Branches view, graph badge), else the current branch.
    const branch = (arg && arg.type === 'branch' && arg.ref) || await repo.currentBranch();
    if (!branch) {
      notify.warn('Check out or select a branch to create a pull request for (HEAD is detached).');
      return;
    }
    let t = await pullRequestTarget(repo, branch);
    if (t.needsPublish) {
      const current = branch === (await repo.currentBranch());
      const choice = await notify.info(`"${branch}" is not on GitHub yet. Publish it first, then open the pull request.`, { modal: true }, ...(current ? ['Publish Branch'] : []));
      if (choice !== 'Publish Branch') return;
      await vscode.commands.executeCommand('commitCorner.push', { repoRoot: repo.root, noPullRequestOffer: true });
      t = await pullRequestTarget(repo, branch);
      if (t.needsPublish) return; // publishing was cancelled or failed (already reported)
    }
    if (t.error) {
      notify.warn(t.error);
      return;
    }
    if (t.ahead > 0) {
      const choice = await notify.warn(`${t.ahead} commit${t.ahead === 1 ? ' is' : 's are'} not pushed yet and would be missing from the pull request.`, { modal: true }, 'Push First', 'Open Anyway');
      if (!choice) return;
      if (choice === 'Push First') await vscode.commands.executeCommand('commitCorner.push', repo);
    }
    // Base branch: the base repository's branches, its default branch first.
    const def = await repo.remoteDefaultBranch(t.baseRemote);
    const sameRepo = t.baseWeb === t.headWeb;
    const names = (await repo.getBranchNames())
      .filter((n) => n.startsWith(`${t.baseRemote}/`))
      .map((n) => n.slice(t.baseRemote.length + 1))
      .filter((n) => !(sameRepo && n === t.headBranch));
    const ordered = [...new Set([def, ...names].filter(Boolean))].filter((n) => !(sameRepo && n === t.headBranch));
    let base = def;
    if (ordered.length > 1 || !def) {
      const pick = await vscode.window.showQuickPick(ordered.map((n) => ({ label: `$(git-branch) ${escapeIcons(n)}`, description: n === def ? 'default branch' : undefined, name: n })), {
        placeHolder: `Pull request: ${t.headBranch} → which branch of ${t.baseWeb.replace('https://github.com/', '')}?`,
      });
      if (!pick) return;
      base = pick.name;
    }
    if (!base) {
      notify.warn(`No branch to compare with on "${t.baseRemote}". Fetch it first.`);
      return;
    }
    if (sameRepo && base === t.headBranch && !(await confirm(`"${t.headBranch}" is the base branch itself.`, 'Open Anyway'))) return;
    await vscode.env.openExternal(vscode.Uri.parse(githubCompareUrl(t.baseWeb, base, t.headBranch, t.headWeb)));
  });
}

module.exports = { register, pullRequestTarget };
