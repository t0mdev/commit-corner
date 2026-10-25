'use strict';

const vscode = require('vscode');
const notify = require('../notify');
const { log, config } = require('../util');

/**
 * VS Code's built-in "github" sign-in (the account in the Accounts menu), and
 * the only code that reads its token (`session.accessToken`). The token is
 * used for exactly two things:
 *
 * 1. answerGitPrompt: the answer to git's own credential prompt for
 *    https://github.com (anchored, whole-prompt match), asked through the
 *    askpass helper that only network commands get. Never for ssh prompts:
 *    an ssh server chooses its prompt text and could imitate git's.
 * 2. apiAuthorization: the Authorization header of ./transport.js, which only
 *    talks to api.github.com.
 *
 * Background work (quiet) only uses a session that was already granted; it
 * never shows a sign-in.
 *
 * While a session is granted, git's credential helpers are switched off for
 * https://github.com in the commands that may receive the token
 * (gitCredentialConfig): git hands every credential that worked to its
 * helpers, and `credential.helper=store` would write the token to
 * ~/.git-credentials in plain text, where it outlives signing out.
 */

/** Scopes git needs to push (workflow: changes to .github/workflows). */
const SCOPES = ['repo', 'workflow'];

let declined = false;
/** Whether a GitHub session is granted (kept up to date by watch()). */
let granted = false;

/**
 * VS Code's GitHub session. Quiet (background) requests never show UI. Interactive ones ask
 * to sign in once; after a "no" they stop asking for this window session.
 */
async function getSession(quiet) {
  if (!config().get('githubAuthentication', true)) return undefined;
  try {
    if (quiet || declined) return await vscode.authentication.getSession('github', SCOPES, { silent: true });
    return await vscode.authentication.getSession('github', SCOPES, { createIfNone: true });
  } catch (e) {
    // Cancelled sign-in, or no GitHub provider (e.g. some remote setups): type credentials instead.
    if (!quiet) declined = true;
    log().info(`GitHub sign-in not used: ${e.message}`);
    return undefined;
  }
}

/**
 * Is this git prompt asking for github.com HTTPS credentials?
 * @returns {'username'|'password'|undefined}
 */
function gitPromptKind(prompt) {
  const text = String(prompt);
  if (/[\u0000-\u001f\u007f]/.test(text.replace(/\s+$/, ''))) return undefined;
  // The whole prompt must be git's: "Username|Password for 'https://[user@]github.com[:443]': ".
  const m = /^(Username|Password) for 'https:\/\/(?:[^@'/\s:]+@)?github\.com(?::443)?\/?':\s*$/i.exec(text.trim());
  return m ? /** @type {'username'|'password'} */ (m[1].toLowerCase()) : undefined;
}

/**
 * The answer to a credential prompt from the GitHub session, or undefined (then the user is
 * asked, or a quiet prompt fails).
 * @param {string} prompt
 * @param {{quiet?: boolean, ssh?: boolean, helpersOff?: boolean, getSession?: typeof getSession}} [o]
 *   helpersOff: the asking git command was started with github.com's credential helpers
 *   switched off (gitCredentialConfig). Only then is the token given: otherwise git would hand
 *   it to a helper that may store it (signing in while a push waits must not leak it).
 *   getSession: for tests
 */
async function answerGitPrompt(prompt, o = {}) {
  if (o.ssh || !o.helpersOff) return undefined;
  const kind = gitPromptKind(prompt);
  if (!kind) return undefined;
  const session = await (o.getSession || getSession)(!!o.quiet);
  if (!session) return undefined;
  // GitHub accepts the token as password with any user name; the login keeps logs readable.
  return kind === 'username' ? session.account.label || 'x-access-token' : session.accessToken;
}

/**
 * Authorization header value for api.github.com from an already granted session (never asks),
 * or undefined (public data only, 60 requests an hour).
 */
async function apiAuthorization() {
  const session = await getSession(true);
  return session && session.accessToken ? `Bearer ${session.accessToken}` : undefined;
}

/**
 * git configuration for network commands (as [key, value] pairs): with a granted session,
 * no credential helper for https://github.com, so none stores (or offers) another
 * credential for the account VS Code answers for. Other hosts keep their helpers.
 * @returns {[string, string][]}
 */
function gitCredentialConfig() {
  return granted && config().get('githubAuthentication', true) ? [['credential.https://github.com.helper', '']] : [];
}

/** Keep `granted` current: now, and whenever VS Code's GitHub sessions change. */
function watch() {
  const check = async () => {
    try {
      granted = !!(await vscode.authentication.getSession('github', SCOPES, { silent: true }));
    } catch {
      granted = false;
    }
  };
  check();
  return vscode.authentication.onDidChangeSessions((e) => {
    if (e.provider.id === 'github') check();
  });
}

/** "Sign In to GitHub" (Actions hub, Pull Requests view). */
async function signIn() {
  declined = false;
  const session = await vscode.authentication.getSession('github', SCOPES, { createIfNone: true });
  if (session) notify.info(`Signed in to GitHub as ${session.account.label}. HTTPS pulls and pushes to github.com use this account when git asks for credentials.`);
}

module.exports = { SCOPES, gitPromptKind, answerGitPrompt, apiAuthorization, signIn, gitCredentialConfig, watch };
