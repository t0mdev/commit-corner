'use strict';

const vscode = require('vscode');
const notify = require('../notify');
const { lastRewrite } = require('../rewrites');
const { parseTodo, serializeTodo, validateTodo, groupHeads, groupEnd } = require('../../git/rebaseTodo');
const { LOG_FORMAT_WITH_BODY, parseLog } = require('../../git/parse');
const { webviewHtml } = require('./html');
const { confirm, shortSha, showError, selectedShas, notice, validMessageShas } = require('../util');
const { pickRef } = require('../pickers');
const { runConflicting } = require('../commands/branchCommands');

/**
 * Interactive rebase UI. Two entry points share one webview:
 *
 *  1. "Interactive Rebase…" commands: we list base..HEAD, the user edits the
 *     plan (reorder, pick/reword/edit/squash/fixup/drop, new messages), and we
 *     run `git rebase -i` with a sequence editor that installs the plan.
 *     New messages are applied with `exec git commit --amend -F <file>`, so no
 *     editor round-trips are needed.
 *
 *  2. A custom editor for `git-rebase-todo` files, used when a rebase is
 *     started in a terminal with VS Code as the git editor. "Start" saves the
 *     todo and closes the tab so git continues.
 */

async function commitInfo(repo, shas) {
  if (!shas.length) return new Map();
  const { stdout } = await repo.exec(['log', '--no-walk=unsorted', `--format=${LOG_FORMAT_WITH_BODY}`, ...shas, '--'], { allowFailure: true });
  const map = new Map();
  for (const c of parseLog(stdout, { body: true })) {
    map.set(c.sha, c);
    // todo files use abbreviated SHAs
    for (const s of shas) if (c.sha.startsWith(s)) map.set(s, c);
  }
  return map;
}

function toWebviewEntries(entries, info) {
  return entries.map((e) => {
    if (e.type !== 'commit') return e;
    const c = info.get(e.sha);
    return {
      ...e,
      author: c ? c.authorName : '',
      email: c ? c.authorEmail : '',
      date: c ? c.authorDate : 0,
      message: c ? c.body || c.subject : e.subject,
      subject: c ? c.subject : e.subject,
    };
  });
}

/**
 * The webview's plan must be a reordering of what the host offered: the same commits (each
 * once) and the same non-commit lines. Anything else — a commit nobody listed, an added
 * "exec" line — is refused, so even a compromised webview cannot run commands.
 * @param {any[]} plan from the webview
 * @param {{type:string, sha?:string, text?:string}[]} offered the entries the host sent
 */
function checkPlan(plan, offered) {
  if (!Array.isArray(plan)) throw new Error('Invalid rebase plan.');
  const shas = new Map(offered.filter((e) => e.type === 'commit').map((e) => [e.sha, e]));
  const others = offered.filter((e) => e.type !== 'commit').map((e) => e.text);
  const seen = new Set();
  for (const e of plan) {
    if (e && e.type === 'commit') {
      if (!shas.has(e.sha) || seen.has(e.sha)) throw new Error('The rebase plan contains a commit that was not offered.');
      seen.add(e.sha);
    } else {
      const i = others.indexOf(e && e.text);
      if (i < 0) throw new Error('The rebase plan contains a line that was not offered.');
      others.splice(i, 1);
    }
  }
  if (seen.size !== shas.size) throw new Error('The rebase plan is missing commits; use "drop" to remove one.');
}

/** Turn the webview's plan into todo entries plus the message overrides. */
function planToTodo(plan, allowMessages) {
  const entries = plan.map((e) => (e.type === 'commit' ? { type: 'commit', action: e.action, sha: e.sha, subject: e.subject } : { type: 'other', text: e.text }));
  const messages = new Map();
  if (!allowMessages) return { entries, messages };
  for (const head of groupHeads(entries)) {
    const end = groupEnd(entries, head);
    const members = entries.slice(head, end + 1).map((e, k) => ({ e, p: plan[head + k] })).filter(({ e }) => e.type === 'commit' && e.action !== 'drop');
    const hasSquash = members.some(({ e }) => e.action === 'squash');
    const reword = entries[head].action === 'reword';
    const editedMessage = plan[head].newMessage;
    let message;
    if (hasSquash) {
      message = editedMessage || members.filter(({ e }, i) => i === 0 || e.action === 'squash').map(({ p }) => p.message.trim()).join('\n\n');
    } else if (reword) message = editedMessage;
    if (reword) entries[head].action = 'pick'; // the message comes from our exec line instead of an editor
    if (message && message.trim()) messages.set(end, message.trim() + '\n');
  }
  return { entries, messages };
}

class RebasePanel {
  /**
   * @param {import('../context').Context} ctx
   * @param {vscode.WebviewPanel} panel
   * @param {import('../../git/repository').Repository} repo
   */
  constructor(ctx, panel, repo, base, ontoLabel, entries) {
    this.ctx = ctx;
    this.panel = panel;
    this.repo = repo;
    this.base = base;
    this.ontoLabel = ontoLabel;
    this.entries = entries;
    setupWebview(ctx, panel.webview);
    panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => showError(e, 'Interactive rebase')));
  }

  async onMessage(m) {
    if (!validMessageShas(m)) return;
    if (m.type === 'ready') {
      this.panel.webview.postMessage({ type: 'init', entries: this.entries, onto: this.ontoLabel, branch: this.repo.state && this.repo.state.head.branch, allowMessages: true, mode: 'command' });
    } else if (m.type === 'cancel') {
      // Esc must not silently throw away an edited plan.
      if (m.viaKey && m.dirty && !(await confirm('Discard your changes to the rebase plan?', 'Discard', 'Nothing has been rebased yet.'))) return;
      this.panel.dispose();
      focusEditorArea();
    } else if (m.type === 'start') {
      checkPlan(m.plan, this.entries);
      const { entries, messages } = planToTodo(m.plan, true);
      const problem = validateTodo(entries);
      if (problem) {
        notify.error(problem);
        return;
      }
      if (!entries.some((e) => e.type === 'commit' && e.action !== 'drop') && !(await confirm('Every commit is dropped. Continue?', 'Drop All'))) return;
      // Rewriting commits that are already pushed: say so, as the one-step edits do. A plan that
      // keeps every pushed commit first, untouched and in order does not rewrite them.
      const pushed = this.entries.filter((e) => e.pushed).map((e) => e.sha);
      // The pushed commits that stay first, untouched and in order, are not rewritten; the rest are.
      let kept = 0;
      for (let idx = 0, k = 0; idx < entries.length && k < pushed.length; idx++) {
        const e = entries[idx];
        if (e.type !== 'commit') continue;
        if (e.sha !== pushed[k] || e.action !== 'pick' || messages.has(idx)) break;
        // A squash or fixup into it (the next commit in the plan) rewrites it too.
        const next = entries.slice(idx + 1).find((x) => x.type === 'commit');
        if (next && (next.action === 'squash' || next.action === 'fixup')) break;
        kept = ++k;
      }
      const rewritten = pushed.slice(kept);
      if (rewritten.length) {
        const upstream = (this.repo.state && this.repo.state.head.upstream) || 'the upstream';
        const subjects = rewritten.map((sha) => (this.entries.find((x) => x.sha === sha) || {}).subject).filter(Boolean).slice(0, 3).map((t) => `"${t}"`).join(', ');
        if (!(await confirm(`${rewritten.length} commit${rewritten.length === 1 ? '' : 's'} already on ${upstream} would be rewritten${subjects ? `: ${subjects}${rewritten.length > 3 ? ', …' : ''}` : ''}.`, 'Rewrite Anyway', 'Rewriting pushed commits requires a force push afterwards, which changes history others may have.'))) return;
      }
      this.panel.dispose();
      focusEditorArea();
      await rewrite(this.repo, 'Interactive rebase', 'Rebasing…', () => this.repo.rebaseInteractive(this.base, entries, messages));
      const state = await this.repo.refreshState();
      if (state.operation && state.operation.kind === 'rebase' && !state.conflicts.length) {
        notify.info('The rebase stopped so you can edit a commit. Amend it, then run "Continue".', 'Continue Rebase').then((c) => {
          if (c) vscode.commands.executeCommand('commitCorner.continueOperation', this.repo);
        });
      }
    } else if (m.type === 'openCommit') {
      await vscode.commands.executeCommand('commitCorner.showCommit', { repoRoot: this.repo.root, sha: m.sha });
    }
  }
}

/** After the plan editor closes, the keyboard goes back to the editor area (not nowhere). */
function focusEditorArea() {
  vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup').then(undefined, () => {});
}

function setupWebview(ctx, webview) {
  webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] };
  webview.html = webviewHtml(webview, ctx.extensionUri, { title: 'Interactive Rebase', script: 'rebase.js', style: 'rebase.css' });
}

/** Custom editor for .git/rebase-merge/git-rebase-todo. */
class RebaseTodoEditorProvider {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async resolveCustomTextEditor(document, panel) {
    const ctx = this.ctx;
    setupWebview(ctx, panel.webview);
    // Only a repository that is already open: opening the folder two levels up would run git
    // (and the programs its config names) for any file called git-rebase-todo, without asking.
    // Without one the todo is still editable, just without commit details.
    const repo = ctx.manager.getRepositoryForGitPath(document.uri.fsPath);
    let writing = false;
    let decided = false;
    const send = async () => {
      const { entries, comments } = parseTodo(document.getText());
      const info = repo ? await commitInfo(repo, entries.filter((e) => e.type === 'commit').map((e) => e.sha)) : new Map();
      const onto = (comments.find((c) => /^# Rebase /.test(c)) || '').replace(/^# /, '');
      panel.webview.postMessage({ type: 'init', entries: toWebviewEntries(entries, info), onto, allowMessages: false, mode: 'todo' });
    };
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === document && !writing) send();
    });
    panel.onDidDispose(() => {
      sub.dispose();
      // Closing (or "Reopen With… Text Editor") changes nothing: like closing git's own editor, the
      // todo as saved is what runs. Abort Rebase is the explicit way out, so say what happens.
      if (!decided) {
        notice('todoClosed', 'Rebase todo closed without Start or Abort: git runs the todo as it is saved, as with any editor. Use "Abort Rebase" (Ctrl+Alt+G Space) to undo the rebase.');
      }
    });
    panel.webview.onDidReceiveMessage(async (m) => {
      if (!validMessageShas(m)) return;
      try {
        if (m.type === 'ready') await send();
        else if (m.type === 'start' || m.type === 'cancel') {
          if (m.type === 'cancel' && m.viaKey && !(await confirm('Abort the rebase?', 'Abort Rebase', 'git stops and the branch stays as it was before "git rebase -i".'))) return;
          let text = '';
          if (m.type === 'start') {
            checkPlan(m.plan, parseTodo(document.getText()).entries);
            const { entries } = planToTodo(m.plan, false);
            const problem = validateTodo(entries);
            if (problem) {
              notify.error(problem);
              return;
            }
            text = serializeTodo(entries);
          }
          // An empty todo makes git abort the rebase.
          writing = true;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
          await vscode.workspace.applyEdit(edit);
          await document.save();
          writing = false;
          decided = true;
          // Closing this editor lets `git rebase -i` (waiting on it) continue.
          panel.dispose();
          focusEditorArea();
        } else if (m.type === 'openCommit' && repo) {
          await vscode.commands.executeCommand('commitCorner.showCommit', { repoRoot: repo.root, sha: m.sha });
        }
      } catch (e) {
        writing = false;
        showError(e, 'Rebase todo');
      }
    });
  }
}


/**
 * Run a history rewrite and remember where the branch was, so it can be undone in one step
 * (`git reset --keep` back to the old tip; the rewritten commits stay in the reflog).
 */
async function rewrite(repo, label, progress, fn) {
  const before = await repo.revParse('HEAD');
  const branch = await repo.currentBranch();
  await runConflicting(repo, progress, fn, 'rebase');
  const state = await repo.refreshState();
  if (state.operation) return; // paused (conflict or edit stop): Abort is the way back
  const after = await repo.revParse('HEAD');
  if (!before || !after || before === after) return;
  lastRewrite.set(repo.root, { branch, before, after, label, at: Date.now() });
  const choice = await notify.info(`${label}: ${branch || 'HEAD'} is now ${shortSha(after)} (was ${shortSha(before)}).`, 'Undo', 'Show in Graph');
  if (choice === 'Undo') await vscode.commands.executeCommand('commitCorner.undoRewrite', { repoRoot: repo.root });
  else if (choice === 'Show in Graph') await vscode.commands.executeCommand('commitCorner.showGraph', { repoRoot: repo.root, revealSha: after });
}

/** @param {import('../context').Context} ctx */
function register(ctx) {
  const { manager } = ctx;
  const cmd = ctx.command;

  /**
   * node.sha: start the rebase at this commit (it is included in the plan).
   * Otherwise ask for the upstream to rebase onto.
   */
  cmd('commitCorner.rebaseInteractive', async (node) => {
    const repo = await manager.pick(node);
    if (!repo) return;
    const state = await repo.refreshState();
    if (state.operation) {
      notify.warn(`A ${state.operation.kind} is already in progress. Continue or abort it first.`);
      return;
    }
    let base;
    let onto;
    let revs;
    if (node && node.sha) {
      const commit = await repo.getCommit(node.sha);
      if (!(await repo.isAncestor(commit.sha, 'HEAD'))) {
        notify.warn(`${shortSha(commit.sha)} is not part of the current branch's history.`);
        return;
      }
      base = commit.parents[0] || '--root';
      onto = base === '--root' ? 'the root' : shortSha(base);
      revs = base === '--root' ? ['HEAD'] : ['HEAD', `^${base}`];
    } else {
      // The common case first: rewrite the last few commits of this branch.
      const LAST = '\0last';
      let ref = await pickRef(repo, { placeHolder: 'Rebase the current branch interactively onto…', exclude: [state.head.branch].filter(Boolean), extra: [{ label: '$(history) Last N commits of this branch…', ref: LAST }] });
      if (!ref) return;
      if (ref === LAST) {
        const n = await vscode.window.showInputBox({ title: 'Interactive rebase', prompt: 'How many of the latest commits?', value: '5', validateInput: (v) => (/^[1-9]\d{0,3}$/.test(v.trim()) ? undefined : 'A number from 1 to 9999') });
        if (!n) return;
        const count = (await repo.log({ revs: ['HEAD'], maxCount: Number(n) + 1, firstParent: true })).length;
        if (count <= Number(n)) ref = '--root'; // the whole branch
        else ref = `HEAD~${Number(n)}`;
      }
      if (ref === '--root') {
        base = '--root';
        onto = 'the root';
        revs = ['HEAD'];
      }
      const mb = ref === '--root' ? 'root' : await repo.mergeBase(ref, 'HEAD');
      if (!mb) {
        notify.warn(`HEAD and ${ref} have no common history.`);
        return;
      }
      if (ref !== '--root') {
        base = ref;
        onto = ref;
        revs = ['HEAD', `^${mb}`];
      }
    }
    const commits = await repo.log({ revs, topo: true, body: true });
    if (commits.some((c) => c.parents.length > 1)) {
      const go = await confirm('The range contains merge commits.', 'Continue', 'Interactive rebase linearizes history: merge commits are dropped and their changes replayed as regular commits.');
      if (!go) return;
    }
    const linear = commits.filter((c) => c.parents.length <= 1).reverse();
    if (!linear.length) {
      notify.info('There are no commits to rebase.');
      return;
    }
    // Commits already on the upstream are marked: rewriting them needs a force push.
    const upstream = state.head.upstream;
    const pushed = new Set();
    if (upstream) for (const c of linear) if (await repo.isAncestor(c.sha, upstream)) pushed.add(c.sha);
    const entries = linear.map((c) => ({ type: 'commit', action: 'pick', sha: c.sha, subject: c.subject, author: c.authorName, email: c.authorEmail, date: c.authorDate, message: c.body || c.subject, pushed: pushed.has(c.sha) }));
    const panel = vscode.window.createWebviewPanel('commitCorner.rebase', `Rebase ${state.head.branch || 'HEAD'}`, vscode.ViewColumn.Active, { retainContextWhenHidden: true });
    new RebasePanel(ctx, panel, repo, base, onto, entries); // eslint-disable-line no-new
  });

  /**
   * One-step history edits from the graph or a commit list, done as an
   * interactive rebase without the editor: squash/fixup a commit into its
   * parent, reword it, or drop it.
   * @param {'squash'|'fixup'|'reword'|'drop'} action
   */
  async function quickEdit(node, action) {
    const repo = await manager.pick(node);
    if (!repo || !node || !node.sha) return;
    const state = await repo.refreshState();
    if (state.operation) {
      notify.warn(`A ${state.operation.kind} is in progress. Continue or abort it first.`);
      return;
    }
    const commit = await repo.getCommit(node.sha);
    if (!(await repo.isAncestor(commit.sha, 'HEAD'))) {
      notify.warn(`${shortSha(commit.sha)} is not part of the current branch, so it cannot be edited here.`);
      return;
    }
    const folds = action === 'squash' || action === 'fixup';
    if (folds && !commit.parents[0]) {
      notify.warn('The first commit of the history has no parent to fold into.');
      return;
    }
    const first = folds ? await repo.getCommit(commit.parents[0]) : commit;
    const base = first.parents[0] || '--root';
    const commits = await repo.log({ revs: base === '--root' ? ['HEAD'] : ['HEAD', `^${base}`], topo: true, body: true });
    if (commits.some((c) => c.parents.length > 1)) {
      notify.warn('There are merge commits between this commit and HEAD. Use "Interactive Rebase…" instead.');
      return;
    }
    const entries = commits.reverse().map((c) => ({ type: 'commit', action: 'pick', sha: c.sha, subject: c.subject }));
    const idx = entries.findIndex((e) => e.sha === commit.sha);
    if (idx < 0) {
      notify.warn(`${shortSha(commit.sha)} could not be located in the current branch's history.`);
      return;
    }
    const messages = new Map();
    if (action === 'drop') {
      if (!(await confirm(`Drop commit ${shortSha(commit.sha)} "${commit.subject}"?`, 'Drop Commit', 'Its changes are removed from the branch (the commit stays in the reflog).'))) return;
    } else if (action === 'reword') {
      const subject = await vscode.window.showInputBox({ prompt: `New subject for ${shortSha(commit.sha)} (the body is kept)`, value: commit.subject, validateInput: (v) => (v.trim() ? undefined : 'Enter a subject') });
      if (subject === undefined || subject === commit.subject) return;
      const body = (commit.body || '').split('\n').slice(1).join('\n');
      messages.set(idx, `${subject.trim()}${body ? `\n${body}` : ''}\n`);
    } else if (action === 'squash') {
      messages.set(idx, `${(first.body || first.subject).trim()}\n\n${(commit.body || commit.subject).trim()}\n`);
    }
    entries[idx].action = action === 'reword' ? 'pick' : action;
    // The oldest rewritten commit is the parent when folding, the commit itself otherwise.
    if (state.head.upstream && (await repo.isAncestor(first.sha, state.head.upstream))) {
      if (!(await confirm(`${shortSha(first.sha)} is already on ${state.head.upstream}.`, 'Rewrite Anyway', 'Rewriting pushed commits requires a force push afterwards.'))) return;
    }
    await rewrite(repo, { squash: 'Squash into parent', fixup: 'Fixup into parent', reword: 'Reword', drop: 'Drop commit' }[action], 'Rewriting history…', () => repo.rebaseInteractive(base, entries, messages));
  }
  /** Squash several selected commits into the oldest of them (moved together, messages combined). */
  cmd('commitCorner.squashSelected', async (node, nodes) => {
    const repo = await manager.pick(node);
    const shas = selectedShas(node, nodes);
    if (!repo || shas.length < 2) return;
    const state = await repo.refreshState();
    if (state.operation) {
      notify.warn(`A ${state.operation.kind} is in progress. Continue or abort it first.`);
      return;
    }
    for (const sha of shas) {
      if (!(await repo.isAncestor(sha, 'HEAD'))) {
        notify.warn(`${shortSha(sha)} is not part of the current branch.`);
        return;
      }
    }
    const ordered = await repo.sortTopologically(shas);
    const oldest = await repo.getCommit(ordered[0]);
    const base = oldest.parents[0] || '--root';
    const commits = (await repo.log({ revs: base === '--root' ? ['HEAD'] : ['HEAD', `^${base}`], topo: true, body: true })).reverse();
    if (commits.some((c) => c.parents.length > 1)) {
      notify.warn('There are merge commits in that range. Use "Interactive Rebase…" instead.');
      return;
    }
    const selected = new Set(ordered.map((s) => commits.find((c) => c.sha.startsWith(s) || s.startsWith(c.sha))).filter(Boolean).map((c) => c.sha));
    const group = commits.filter((c) => selected.has(c.sha));
    // The squashed group takes the place of its oldest commit; everything else keeps its order.
    const entries = [];
    for (const c of commits) {
      if (c.sha === group[0].sha) group.forEach((g, i) => entries.push({ type: 'commit', action: i === 0 ? 'pick' : 'squash', sha: g.sha, subject: g.subject }));
      else if (!selected.has(c.sha)) entries.push({ type: 'commit', action: 'pick', sha: c.sha, subject: c.subject });
    }
    const subject = await vscode.window.showInputBox({ prompt: `Subject of the squashed commit (the ${group.length} messages become its body)`, value: group[0].subject });
    if (subject === undefined) return;
    // Body: the first commit's body, then the full messages of the others.
    const firstBody = (group[0].body || '').split('\n').slice(1).join('\n').trim();
    const body = [firstBody, ...group.slice(1).map((c) => (c.body || c.subject).trim())].filter(Boolean).join('\n\n');
    if (state.head.upstream && (await repo.isAncestor(group[0].sha, state.head.upstream))) {
      if (!(await confirm('Some of these commits are already pushed.', 'Rewrite Anyway', 'Rewriting pushed commits requires a force push afterwards.'))) return;
    }
    const end = entries.findIndex((e) => e.sha === group[group.length - 1].sha);
    const messages = new Map([[end, `${subject.trim() || group[0].subject}\n\n${body}\n`]]);
    await rewrite(repo, `Squash ${group.length} commits`, `Squashing ${group.length} commits…`, () => repo.rebaseInteractive(base, entries, messages));
  });

  /** Commit what is staged as a fix for an older commit and fold it in (fixup! + autosquash). */
  cmd('commitCorner.fixupStagedInto', async (node) => {
    const repo = await manager.pick(node);
    if (!repo || !node || !node.sha) return;
    const state = await repo.refreshState();
    if (state.operation) {
      notify.warn(`A ${state.operation.kind} is in progress. Continue or abort it first.`);
      return;
    }
    if (!state.staged.length) {
      notify.info('Stage the changes that belong to that commit first.');
      return;
    }
    if (!(await repo.isAncestor(node.sha, 'HEAD'))) {
      notify.warn(`${shortSha(node.sha)} is not part of the current branch.`);
      return;
    }
    const target = await repo.getCommit(node.sha);
    const pushed = state.head.upstream && (await repo.isAncestor(target.sha, state.head.upstream));
    if (await repo.hasMergesSince(target.sha)) {
      notify.warn('There are merge commits after that commit; folding changes in would flatten them. Use Interactive Rebase instead.');
      return;
    }
    const detail = `${pushed ? 'That commit is already pushed: a force push will be needed. ' : ''}Later commits are rebased on top; unstaged changes are kept (autostash). Other "fixup!" commits in that range are folded in too.`;
    if (!(await confirm(`Fold the ${state.staged.length} staged file(s) into ${shortSha(target.sha)} "${target.subject}"?`, 'Fixup', detail))) return;
    await rewrite(repo, 'Fold staged changes', 'Folding staged changes…', () => repo.fixupInto(target.sha));
  });

  cmd('commitCorner.undoRewrite', async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo) return;
    const last = lastRewrite.get(repo.root);
    if (!last) {
      notify.info('No history rewrite to undo in this session. The reflog (Commit Corner: Reflog…) has older states.');
      return;
    }
    const head = await repo.revParse('HEAD');
    const branch = await repo.currentBranch();
    if (head !== last.after || branch !== last.branch) {
      notify.warn(`${last.branch || 'HEAD'} has moved since "${last.label}"; undo it from the reflog instead (Commit Corner: Reflog…).`);
      return;
    }
    // --keep refuses to touch uncommitted changes in files the reset would change.
    await repo.run(['reset', '--keep', last.before]);
    lastRewrite.delete(repo.root);
    // A notification, not a status bar flash: screen readers announce it, and it stays to be read.
    notify.info(`Undid "${last.label}": ${branch || 'HEAD'} is back at ${shortSha(last.before)}. The rewritten commits stay in the reflog.`);
  });

  cmd('commitCorner.squashIntoParent', (node) => quickEdit(node, 'squash'));
  cmd('commitCorner.fixupIntoParent', (node) => quickEdit(node, 'fixup'));
  cmd('commitCorner.rewordCommit', (node) => quickEdit(node, 'reword'));
  cmd('commitCorner.dropCommit', (node) => quickEdit(node, 'drop'));

  return vscode.window.registerCustomEditorProvider('commitCorner.rebaseTodo', new RebaseTodoEditorProvider(ctx), {
    webviewOptions: { retainContextWhenHidden: true },
    supportsMultipleEditorsPerDocument: false,
  });
}

module.exports = { register, planToTodo, checkPlan, RebaseTodoEditorProvider };
