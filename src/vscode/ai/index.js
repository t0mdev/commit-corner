'use strict';

const vscode = require('vscode');
const { config } = require('../util');
const { INDEX, EMPTY_TREE } = require('../../git/repository');
const P = require('./prompt');

/**
 * Language models: generated commit messages and summaries of changes. A deliberate exception
 * to "no network of its own", like the GitHub API; see docs/DEVELOPMENT.md. Review these files together:
 *
 *   index.js   this file: choosing a model, asking it, the commands' data
 *   prompt.js  exactly what is sent (instructions + the diff, fitted to the model)
 *   ../webviews/summaryPanel.js + media/summary.js   answers shown as text, never as HTML
 *
 * Only through VS Code's Language Model API (vscode.lm): the model provider you installed and
 * signed in to (GitHub Copilot, …) answers. No HTTP request is made here and nothing is added
 * to the dependencies. VS Code asks you once whether Commit Corner may use a model, and nothing
 * is sent unless you ask (✨ Generate, Summarize). What is sent: the diff of what you asked
 * about, fitted to the model's input size, and for a commit message the branch name and the
 * last 10 commit subjects (for their style). Off: "commitCorner.ai.enabled": false.
 *
 * Answers are untrusted text (the diff may contain instructions meant for the model): they go
 * into the message box or a text-only page, and nothing runs because of them.
 */

class AiUnavailable extends Error {}

function enabled() {
  return config().get('ai.enabled', true) !== false;
}

/** The model to ask: the family from the settings, else Copilot's default, else any. */
async function chooseModel() {
  if (!enabled()) throw new AiUnavailable('Generated messages and summaries are off (setting "commitCorner.ai.enabled").');
  if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') throw new AiUnavailable('This version of VS Code has no language model API.');
  const family = String(config().get('ai.modelFamily', '') || '').trim();
  let models = family ? await vscode.lm.selectChatModels({ family }) : [];
  if (!models.length) models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  if (!models.length) models = await vscode.lm.selectChatModels();
  if (!models.length) throw new AiUnavailable('No language model is available. Install GitHub Copilot Chat (or another extension that provides language models) and sign in.');
  return models[0];
}

/**
 * Whether new files' content may be sent: your own settings only (commitCorner.ai.includeUntracked
 * and untrackedFiles in user settings) — a workspace's settings cannot widen what leaves.
 */
function sendUntracked(repo) {
  const c = config();
  const include = c.inspect ? c.inspect('ai.includeUntracked') : undefined;
  const mode = c.inspect ? c.inspect('untrackedFiles') : undefined;
  const on = include && include.globalValue !== undefined ? include.globalValue : true;
  // "no" may come from anywhere (it only narrows what is sent); "on" only from you.
  return on !== false && !(mode && mode.globalValue === 'no') && !(repo && repo.untrackedMode === 'no');
}

/** Characters of changes that fit: about 3 per token, with room for the instructions and the answer. */
function budgetFor(model) {
  const tokens = Number(model.maxInputTokens) || 8000;
  return Math.max(6000, Math.min(400000, Math.floor((tokens - 2000) * 3)));
}

/** git's output is cut at 4 characters per character of budget: enough to fit, never unbounded. */
const bytesFor = (budget) => budget * 4;

/** An AbortSignal that follows a cancellation token (git stops when you press Stop). */
function signalOf(token) {
  const c = new AbortController();
  if (token) {
    if (token.isCancellationRequested) c.abort();
    else token.onCancellationRequested(() => c.abort());
  }
  return c.signal;
}

/** Language model errors in words a user can act on. */
function friendly(e) {
  const E = vscode.LanguageModelError;
  if (E && e instanceof E) {
    if (e.code === E.NoPermissions().code) return new AiUnavailable('Commit Corner may not use language models. Allow it when VS Code asks, or under Accounts → Manage Language Model Access.');
    if (e.code === E.NotFound().code) return new AiUnavailable('The language model is not available any more.');
    if (e.code === E.Blocked().code) return new AiUnavailable(`The language model did not answer (blocked or rate-limited): ${e.message}`);
  }
  return e;
}

/**
 * Ask the model. `onText(all)` gets the answer so far while it arrives.
 * @returns {Promise<string>} the whole answer (what arrived, if cancelled)
 */
async function ask(model, prompt, token, onText) {
  // Stopped (or the page closed) while the changes were read: nothing is sent.
  if (token && token.isCancellationRequested) return '';
  let res;
  try {
    res = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      { justification: 'Commit Corner describes changes you asked about: a commit message or a review summary.' },
      token,
    );
  } catch (e) {
    throw friendly(e);
  }
  let all = '';
  try {
    for await (const chunk of res.text) {
      all += chunk;
      if (onText) onText(all);
    }
  } catch (e) {
    if (token && token.isCancellationRequested) return all;
    throw friendly(e);
  }
  return all;
}

/**
 * A commit message for what Commit would commit: the staged changes, or (nothing staged)
 * all changes, as smart commit stages them.
 * @param {import('../../git/repository').Repository} repo
 * @param {{token?: vscode.CancellationToken, onText?: (text: string) => void}} [o]
 */
async function commitMessage(repo, o = {}) {
  const model = await chooseModel();
  const s = await repo.refreshState();
  const from = s.head.sha || EMPTY_TREE;
  const staged = s.staged.length > 0;
  if (!staged && !s.unstaged.length && !s.untracked.length) throw new AiUnavailable('Nothing to describe: there are no changes.');
  const budget = budgetFor(model);
  // Nothing staged: what smart commit would stage, new files included (with their content).
  // New files only where you show them (untrackedFiles "no": you chose not to see them).
  const patch = await repo.patchText(from, staged ? INDEX : undefined, { withUntracked: !staged && sendUntracked(repo), maxBytes: bytesFor(budget), signal: signalOf(o.token) });
  // This branch's own recent subjects (not every branch's and tag's), each at most 200 characters.
  const subjects = s.head.sha ? (await repo.log({ revs: ['HEAD'], maxCount: 10 }).catch(() => [])).map((c) => String(c.subject).slice(0, 200)) : [];
  const fitted = P.fitPatch(patch, budget);
  // Commit subjects can hold a secret too (a pasted token): the same removal as the diff.
  const clean = (t) => P.redactSecrets(t).text;
  const prompt = P.commitMessagePrompt({ patch: fitted.text, subjects: subjects.map(clean), branch: s.head.branch ? clean(s.head.branch) : undefined });
  const text = await ask(model, prompt, o.token, o.onText && ((t) => o.onText(P.cleanMessage(t))));
  return P.cleanMessage(text);
}

/**
 * The changes a summary is about, as a fitted patch.
 * @typedef {{key?: string, title: string, what: string, patch: (budget: number, signal?: AbortSignal) => Promise<{text: string, files: number, cut: number, secrets: number, withheld: number}>}} SummarySource
 */

/** A worktree's work since it left its base (committed and uncommitted, like Changes vs Base). */
function worktreeSource(repo, worktreePath, name, base) {
  return {
    key: `${repo.root}\0worktree\0${worktreePath}\0${base}`, // one page per repository and subject
    title: `${name} vs ${base}`,
    // The names are the agent's: kept to plain characters in the instructions.
    what: `the changes in a worktree (${plain(name)}) since it left ${plain(base)} (committed and uncommitted)`,
    patch: async (budget, signal) => {
      const { mergeBase } = await repo.worktreeChangesSince(worktreePath, base);
      // New files the agent has not added yet are part of its work: in the patch, as added.
      return P.fitPatch(await repo.patchText(mergeBase, undefined, { cwd: worktreePath, withUntracked: sendUntracked(repo), maxBytes: bytesFor(budget), signal }), budget);
    },
  };
}

/** A name for the instruction text: letters, digits and . / _ - only, at most 60 characters. */
function plain(name) {
  return String(name).replace(/[^\w./-]/g, '_').slice(0, 60);
}

/** A pull request: what it changes since its merge base (GitHub's "Files changed"). */
function pullRequestSource(repo, number, mergeBase, headSha) {
  return {
    key: `${repo.root}\0pr\0${number}`,
    title: `PR #${number}`,
    what: `the changes of pull request #${number}`,
    patch: async (budget, signal) => P.fitPatch(await repo.patchText(mergeBase, headSha, { maxBytes: bytesFor(budget), signal }), budget),
  };
}

/** Commits, each with its message and patch (oldest first), sharing the budget. */
function commitsSource(repo, shas) {
  const list = shas.slice(0, 30);
  return {
    key: `${repo.root}\0commits\0${list.join(',')}`,
    title: list.length === 1 ? `commit ${list[0].slice(0, 7)}` : `${list.length} commits (${list.slice(0, 3).map((x) => x.slice(0, 7)).join(', ')}${list.length > 3 ? ', …' : ''})`,
    what: list.length === 1 ? 'the changes of this commit' : `the changes of these ${list.length} commits${shas.length > list.length ? ` (the first ${list.length} of ${shas.length} selected)` : ''}`,
    patch: async (budget, signal) => {
      const each = Math.floor(budget / list.length);
      const sum = { files: 0, cut: 0, secrets: 0, withheld: 0 };
      const parts = [];
      for (const sha of await repo.sortTopologically(list)) {
        const fitted = P.fitPatch(await repo.commitPatchText(sha, { maxBytes: bytesFor(each), signal }), each);
        for (const k of Object.keys(sum)) sum[k] += fitted[k];
        parts.push(fitted.text);
      }
      return { text: parts.join('\n\n'), ...sum };
    },
  };
}

/**
 * Summarize: the model's answer, as it arrives, through `onText`.
 * @param {SummarySource} source
 * @returns {Promise<{text: string, model: string, files: number, cut: number, secrets: number, withheld: number}>}
 */
async function summarize(source, o = {}) {
  const model = await chooseModel();
  const fitted = await source.patch(budgetFor(model), signalOf(o.token));
  if (!fitted.files) throw new AiUnavailable('Nothing to summarize: no changes.');
  const text = await ask(model, P.summaryPrompt({ what: source.what, patch: fitted.text }), o.token, o.onText);
  // The model and who provides it (the fallback may be another vendor's than Copilot).
  return { text, model: `${model.name || model.family || model.id}${model.vendor && model.vendor !== 'copilot' ? ` (${model.vendor})` : ''}`, files: fitted.files, cut: fitted.cut, secrets: fitted.secrets || 0, withheld: fitted.withheld || 0 };
}

module.exports = { AiUnavailable, enabled, commitMessage, summarize, worktreeSource, pullRequestSource, commitsSource, chooseModel };
