'use strict';

const vscode = require('vscode');
const notify = require('./notify');
const { shortSha, formatDate, escapeIcons } = require('./util');

/**
 * Quick picks for refs, remotes and commits.
 */

/**
 * @param {import('../git/repository').Repository} repo
 * @param {{placeHolder?:string, branches?:boolean, remotes?:boolean, tags?:boolean, head?:boolean, allowFreeText?:boolean, exclude?:string[], extra?:vscode.QuickPickItem[]}} o
 * @returns {Promise<string|undefined>} ref name (e.g. "main", "origin/main", "v1.0", or free text)
 */
async function pickRef(repo, o = {}) {
  const opts = { branches: true, remotes: true, tags: true, head: false, allowFreeText: true, ...o };
  const qp = vscode.window.createQuickPick();
  qp.placeholder = opts.placeHolder || 'Select a branch, tag or commit';
  qp.matchOnDescription = true;
  qp.busy = true;
  let done = false;
  let resolveResult;
  const result = new Promise((resolve) => (resolveResult = resolve));
  const finish = (value) => {
    if (done) return;
    done = true;
    resolveResult(value);
    qp.dispose();
  };
  // Registered before loading refs, so Escape during loading ends the command.
  qp.onDidHide(() => finish(undefined));
  qp.onDidAccept(() => finish(qp.selectedItems[0] && qp.selectedItems[0].ref));
  qp.show();
  let refs;
  try {
    refs = await repo.getRefs();
  } catch (e) {
    finish(undefined); // never leave a spinning picker behind
    throw e;
  }
  const items = [];
  if (opts.extra) items.push(...opts.extra);
  if (opts.head) items.push({ label: '$(target) HEAD', description: 'current commit', ref: 'HEAD' });
  const exclude = new Set(opts.exclude || []);
  const section = (label, type, icon) => {
    const list = refs.filter((r) => r.type === type && !exclude.has(r.name));
    if (!list.length) return;
    items.push({ label, kind: vscode.QuickPickItemKind.Separator });
    for (const r of list) {
      items.push({
        label: `$(${icon}) ${escapeIcons(r.name)}`,
        description: `${shortSha(r.sha)}${r.isHead ? ' • current' : ''}${r.upstream && type === 'branch' ? ` • tracks ${escapeIcons(r.upstream.replace(/^refs\/remotes\//, ''))}${r.ahead || r.behind ? ` (${r.ahead ? `↑${r.ahead}` : ''}${r.behind ? `↓${r.behind}` : ''})` : ''}` : ''}`,
        detail: r.subject ? `${escapeIcons(r.subject)} — ${formatDate(r.date)}` : undefined,
        ref: r.rev || r.name,
      });
    }
  };
  if (opts.branches) section('Branches', 'branch', 'git-branch');
  if (opts.remotes) section('Remote branches', 'remote', 'cloud');
  if (opts.tags) section('Tags', 'tag', 'tag');
  if (done) return result;
  qp.items = items;
  qp.busy = false;
  qp.onDidChangeValue((v) => {
    if (!opts.allowFreeText) return;
    // Last, so typing "feat" + Enter picks "feature/login", not the literal text.
    const custom = v.trim() ? [{ label: `$(edit) Use "${v.trim()}" as a revision`, description: 'SHA, HEAD~2, …', ref: v.trim(), alwaysShow: true }] : [];
    qp.items = [...items, ...custom];
  });
  return result;
}

async function pickRemote(repo, placeHolder = 'Select a remote') {
  const remotes = await repo.getRemotes();
  if (!remotes.length) {
    notify.warn('This repository has no remotes.');
    return undefined;
  }
  if (remotes.length === 1) return remotes[0].name;
  const pick = await vscode.window.showQuickPick(remotes.map((r) => ({ label: r.name, description: r.fetchUrl })), { placeHolder });
  return pick && pick.label;
}

/** Pick a commit from recent history. */
async function pickCommit(repo, placeHolder = 'Select a commit', revs) {
  const commits = await repo.log({ maxCount: 300, revs: revs || ['HEAD'] });
  const pick = await vscode.window.showQuickPick(commits.map((c) => ({
    label: escapeIcons(c.subject),
    description: `${shortSha(c.sha)} • ${escapeIcons(c.authorName)} • ${formatDate(c.authorDate)}`,
    sha: c.sha,
  })), { placeHolder, matchOnDescription: true });
  return pick && pick.sha;
}

/**
 * Ask for a branch name, validated with git's rules (roughly). With `repo`, names of existing
 * local branches are refused up front (instead of git's "already exists" afterwards), and a
 * suggested name that exists becomes "<name>-2" (or the next free number).
 * @param {{repo?: import('../git/repository').Repository, allow?: string}} [o] allow: a name that may stay (rename)
 */
async function inputBranchName(prompt, value, o = {}) {
  const existing = new Set(o.repo ? (await o.repo.getRefs().catch(() => [])).filter((r) => r.type === 'branch').map((r) => r.name) : []);
  if (o.allow) existing.delete(o.allow);
  if (value && existing.has(value)) {
    let n = 2;
    while (existing.has(`${value}-${n}`)) n++;
    value = `${value}-${n}`;
  }
  return vscode.window.showInputBox({
    title: 'Branch name',
    prompt,
    value,
    validateInput: (v) => {
      if (!v.trim()) return 'Enter a name';
      if (/[\s~^:?*[\\]|\.\.|@\{|^[-/.]|[/.]$|\.lock$|\/\//.test(v)) return 'Not a valid branch name';
      if (existing.has(v)) return `A branch named "${v}" already exists`;
      return undefined;
    },
  });
}

module.exports = { pickRef, pickRemote, pickCommit, inputBranchName };
