'use strict';

const { config } = require('../util');
const auth = require('./auth');
const pulls = require('./pulls');

/**
 * Everything the extension does with GitHub.com beyond git itself. The GitHub
 * REST API is a deliberate exception (docs/DEVELOPMENT.md); everything
 * still works without it (PR numbers from `git ls-remote`, diffs from
 * refs/pull/*). Review these four files together:
 *
 *   index.js      this public surface (nothing else is exported)
 *   transport.js  the only HTTP: GET https://api.github.com, endpoint allowlist
 *   auth.js       VS Code's GitHub sign-in; the only code that reads the token
 *   pulls.js      the calls below, cache, offline backoff, data checks
 *
 * Endpoints (all GET, api.github.com):
 *   /repos/{owner}/{repo}/pulls?state=…        PR list: titles, authors, state, branches
 *   /repos/{owner}/{repo}/pulls/{n}/reviews    approvals / changes requested
 *   /repos/{owner}/{repo}/commits/{sha}/check-runs   CI checks of the PR head
 *   /repos/{owner}/{repo}/commits/{sha}/status       commit statuses of the PR head
 *
 * The token (when you signed in to GitHub in VS Code) goes only to the
 * Authorization header of those requests and to git's own credential prompt
 * for https://github.com; git's credential helpers are kept from storing it.
 * Requests use an already granted session and never ask you to sign in;
 * signed out, public repositories still work.
 */

/** Whether the API may be used (`commitCorner.pullRequests.githubApi`). */
function enabled() {
  return config().get('pullRequests.githubApi', 'auto') !== 'off';
}

/** "owner/repo" of a github.com web URL ("https://github.com/o/r"), or undefined. */
function slugOf(webUrl) {
  // GitHub owner and repository names: letters, digits, "-", "_", "." (never "." or ".." alone).
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(webUrl || '');
  if (!m || ['.', '..'].includes(m[1]) || ['.', '..'].includes(m[2])) return undefined;
  return { owner: m[1], repo: m[2] };
}

/** @param {import('../context').Context} ctx */
function register(ctx) {
  ctx.command('commitCorner.githubSignIn', auth.signIn);
  ctx.extContext.subscriptions.push(auth.watch());
}

module.exports = {
  enabled,
  slugOf,
  // Pull requests (REST API)
  listPullRequests: pulls.listPullRequests,
  pullRequestStatus: pulls.pullRequestStatus,
  GitHubApiError: pulls.GitHubApiError,
  // git credential prompts (askpass)
  answerGitPrompt: auth.answerGitPrompt,
  isGitHubPrompt: (prompt) => !!auth.gitPromptKind(prompt),
  gitCredentialConfig: auth.gitCredentialConfig,
  register,
};
