'use strict';

const vscode = require('vscode');
const notify = require('../notify');
const fs = require('fs');
const { INDEX, WORKTREE, Repository } = require('../../git/repository');
const { ErrorCodes, GitError } = require('../../git/exec');
const { openDiff, openAtRevision, uriAt } = require('../diffs');
const { toGitUri, SCHEME, fromGitUri } = require('../uri');
const { config, confirm, withProgress, log, escapeIcons } = require('../util');
const { pendingRewrite } = require('../rewrites');

/**
 * Normalize the many shapes VS Code passes to SCM commands into
 * [{repo, path, group, status, origPath}].
 *   - SCM resource menus and inline actions: (...selectedResourceStates), spread
 *   - group context menu: (group)
 *   - Explorer context menu: (clickedUri, selectedUris[])
 *   - our own calls: ({repoRoot, path, ...})
 *   - command palette / editor title: (uri?) or nothing -> active editor file
 */
function resolveResources(manager, args) {
  const out = [];
  const add = (r) => {
    if (!r) return;
    if (r.resourceStates) {
      r.resourceStates.forEach(add);
      return;
    }
    if (r.repoRoot && r.path) {
      const repo = manager.getRepository(r.repoRoot);
      if (repo) out.push({ repo, path: r.path, group: r.group, status: r.status, origPath: r.origPath || (r.entry && r.entry.origPath) });
      return;
    }
    const uri = r instanceof vscode.Uri ? r : r.resourceUri;
    if (uri && uri.scheme === 'file') {
      const repo = manager.getRepositoryForUri(uri);
      if (repo) out.push({ repo, path: repo.relative(uri.fsPath) });
    } else if (uri && uri.scheme === SCHEME) {
      // The staged (index) side of a diff: unstage/stage work from there too.
      const q = fromGitUri(uri);
      const repo = manager.getRepository(q.repo);
      if (repo && !q.empty) out.push({ repo, path: q.path });
    }
  };
  if (args[0] instanceof vscode.Uri && Array.isArray(args[1]) && args[1].length) args[1].forEach(add);
  else args.flat().forEach(add);
  if (!out.length && vscode.window.activeTextEditor) add(vscode.window.activeTextEditor.document.uri);
  // de-duplicate
  const seen = new Set();
  return out.filter((r) => {
    const k = `${r.repo.root}\0${r.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function byRepo(resources) {
  const map = new Map();
  for (const r of resources) {
    if (!map.has(r.repo)) map.set(r.repo, []);
    map.get(r.repo).push(r);
  }
  return map;
}

function statusOf(repo, relPath) {
  const s = repo.state;
  if (!s) return {};
  return {
    staged: s.staged.find((e) => e.path === relPath),
    unstaged: s.unstaged.find((e) => e.path === relPath),
    untracked: s.untracked.find((e) => e.path === relPath),
    conflict: s.conflicts.find((e) => e.path === relPath),
  };
}

/** @param {import('../context').Context} ctx */
function register(ctx) {
  const { manager, scm } = ctx;
  const cmd = ctx.command;

  // "Complete Merge" for third-party SCM: once a conflicted file is saved without
  // markers (merge editor or by hand), offer to mark it resolved.
  ctx.own(vscode.workspace.onDidSaveTextDocument(async (doc) => {
    if (doc.uri.scheme !== 'file') return;
    const repo = manager.getRepositoryForUri(doc.uri);
    const s = repo && repo.state;
    if (!s || !s.conflicts.length) return;
    const rel = repo.relative(doc.uri.fsPath);
    if (!s.conflicts.some((e) => e.path === rel) || /^<{7}( |$)|^>{7}( |$)|^={7}$/m.test(doc.getText())) return;
    const choice = await notify.info(`No conflict markers left in "${rel}". Mark it as resolved?`, 'Stage (Resolved)');
    if (choice) await repo.stage([rel]);
  }));

  cmd('commitCorner.refresh', async (arg) => {
    const repo = await manager.pick(arg);
    if (repo) await manager.refresh(repo);
  });

  cmd('commitCorner.openResource', async (r) => {
    const repo = manager.getRepository(r.repoRoot);
    if (!repo) return;
    const { group, status } = r;
    const opts = { preserveFocus: !!r.preserveFocus, ...(r.viewColumn ? { viewColumn: r.viewColumn } : {}) };
    if (group === 'merge' || group === 'untracked') {
      // The file itself: only one of this working tree (never behind a symlinked folder); a
      // symlink or device as git sees it.
      const w = repo.workingFile(r.path);
      if (!w) return;
      if (group === 'merge' && config().get('openConflictsIn', 'file') === 'mergeEditor' && (!w.st || w.st.isFile())) await openMergeEditor(repo, r.path);
      else await vscode.commands.executeCommand('vscode.open', w.st && !w.st.isFile() ? uriAt(repo, WORKTREE, r.path) : vscode.Uri.file(w.abs), opts);
      return;
    }
    if (group === 'staged') {
      await openDiff(repo, {
        path: r.path,
        leftRef: status === 'A' ? null : 'HEAD',
        leftPath: r.origPath || r.path,
        rightRef: status === 'D' ? null : INDEX,
        title: `${base(r.path)} (Staged)`,
        preserveFocus: !!r.preserveFocus,
        viewColumn: r.viewColumn,
      });
      return;
    }
    await openDiff(repo, {
      path: r.path,
      leftRef: status === 'A' ? null : INDEX,
      rightRef: status === 'D' ? null : WORKTREE,
      title: `${base(r.path)} (Working Tree)`,
      preserveFocus: !!r.preserveFocus,
      viewColumn: r.viewColumn,
    });
  });

  cmd('commitCorner.openFile', async (...args) => {
    for (const r of resolveResources(manager, args)) {
      const uri = vscode.Uri.file(r.repo.absolute(r.path));
      if (fs.existsSync(uri.fsPath)) await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
    }
  });

  cmd('commitCorner.openHeadFile', async (...args) => {
    const [r] = resolveResources(manager, args);
    if (r) await openAtRevision(r.repo, 'HEAD', r.origPath || r.path);
  });

  cmd('commitCorner.openChanges', async (...args) => {
    const [r] = resolveResources(manager, args);
    if (!r) return;
    const st = statusOf(r.repo, r.path);
    if (st.unstaged) await vscode.commands.executeCommand('commitCorner.openResource', { repoRoot: r.repo.root, path: r.path, group: 'unstaged', status: st.unstaged.y });
    else if (st.staged) await vscode.commands.executeCommand('commitCorner.openResource', { repoRoot: r.repo.root, path: r.path, group: 'staged', status: st.staged.x, origPath: st.staged.origPath });
    else await openDiff(r.repo, { path: r.path, leftRef: 'HEAD', rightRef: WORKTREE });
  });

  cmd('commitCorner.stage', async (...args) => {
    const resources = resolveResources(manager, args);
    for (const [repo, list] of byRepo(resources)) {
      const skip = new Set();
      for (const r of list.filter((x) => statusOf(repo, x.path).conflict)) {
        if (await hasConflictMarkers(repo, r.path)) {
          const ok = await confirm(`"${r.path}" still contains conflict markers. Stage it anyway?`, 'Stage');
          if (!ok) skip.add(r.path); // the other files are still staged
        }
      }
      await repo.stage(list.filter((r) => !skip.has(r.path)).map((r) => r.path));
    }
  });

  cmd('commitCorner.unstage', async (...args) => {
    for (const [repo, list] of byRepo(resolveResources(manager, args))) {
      const paths = [];
      for (const r of list) {
        paths.push(r.path);
        if (r.origPath) paths.push(r.origPath);
      }
      await repo.unstage(paths);
    }
  });

  cmd('commitCorner.stageAll', async (arg) => {
    const repo = await manager.pick(groupRepo(manager, arg));
    if (!repo) return;
    // Whole groups: git's own selectors, not one pathspec per file (fast, and never "everything" by accident).
    if (arg && arg.id === 'untracked') await repo.stage(((repo.state && repo.state.untracked) || []).map((e) => e.path));
    else if (arg && arg.id === 'unstaged') await repo.stageTracked();
    else if (arg && arg.id === 'merge') await vscode.commands.executeCommand('commitCorner.stage', arg);
    else await repo.stageAll();
  });

  cmd('commitCorner.unstageAll', async (arg) => {
    const repo = await manager.pick(groupRepo(manager, arg));
    if (repo) await repo.unstageAll();
  });

  /** ` (in "name")` when several repositories are open: destructive dialogs say which one. */
  const where = (repos) => (manager.repositories.length > 1 && repos.length ? ` (in ${repos.map((r) => `"${r.name}"`).join(', ')})` : '');

  cmd('commitCorner.discard', async (...args) => {
    let resources = resolveResources(manager, args);
    if (!resources.length) return;
    // What is there now (a repository created in a folder a moment ago is never deleted with it).
    for (const repo of byRepo(resources).keys()) await repo.refreshState({ fresh: true });
    // Intent-to-add files (`git add -N`) have no content in git: discarding means deleting
    // them, like untracked files (to the trash), never emptying them.
    const isNew = (r) => {
      const st = statusOf(r.repo, r.path);
      return r.group === 'untracked' || (!r.group && st.untracked) || (st.unstaged && st.unstaged.x === '.' && st.unstaged.y === 'A');
    };
    // Never discard a repository nested in the tree (an agent's worktree: its .git and its work).
    // Also a folder ("dir/") with one inside, created since its row was listed.
    const holds = (r) => {
      const dir = r.path.endsWith('/') ? r.path : `${r.path}/`;
      return r.repo.nestedRepositories().some((n) => n === r.path || n.startsWith(dir));
    };
    const nestedRepo = resources.filter(holds);
    if (nestedRepo.length) {
      notify.warn(`${nestedRepo.map((r) => `"${r.path}"`).join(', ')} ${nestedRepo.length === 1 ? 'is or holds a repository' : 'are or hold repositories'} of its own (a worktree?) and ${nestedRepo.length === 1 ? 'is' : 'are'} not discarded from here.`);
      resources = resources.filter((r) => !nestedRepo.includes(r));
      if (!resources.length) return;
    }
    const untracked = resources.filter(isNew);
    const tracked = resources.filter((r) => !untracked.includes(r));
    const what = resources.length === 1 ? `"${resources[0].path}"` : `${resources.length} files`;
    const detail = untracked.length ? `${untracked.length} new file(s) will be moved to the trash (you are asked again if the trash is not available).${tracked.length ? ' Changes to the other files cannot be undone.' : ''}` : 'This cannot be undone.';
    // Only new files: they are deleted (to the trash), and the dialog says so.
    const ask = tracked.length
      ? confirm(`Discard changes in ${what}${where([...byRepo(resources).keys()])}?`, 'Discard', detail)
      : confirm(`Delete ${what}${where([...byRepo(resources).keys()])}?`, 'Move to Trash', `${untracked.length === 1 ? 'The new file is' : `The ${untracked.length} new files are`} not in git yet; ${untracked.length === 1 ? 'it goes' : 'they go'} to the trash (you are asked again if the trash is not available).`);
    if (!(await ask)) return;
    for (const [repo, list] of byRepo(tracked)) {
      // Not known as intent-to-add above (state was stale): the git layer skipped it; trash it too.
      const skipped = await repo.discard(list.map((r) => r.path));
      for (const p of skipped) untracked.push({ repo, path: p });
    }
    for (const [repo, list] of byRepo(untracked)) await repo.forgetIntentToAdd((await repo.intentToAdd(list.map((r) => r.path))));
    if (untracked.length) await deleteFiles(untracked.map((r) => r.repo.absolute(r.path)));
    for (const repo of byRepo(resources).keys()) manager.scheduleRefresh(repo);
  });

  cmd('commitCorner.discardAll', async (arg) => {
    const repo = await manager.pick(groupRepo(manager, arg));
    if (!repo || !repo.state) return;
    // Intent-to-add files are new files: kept, like untracked ones.
    const tracked = repo.state.unstaged.filter((e) => !(e.x === '.' && e.y === 'A')).map((e) => e.path);
    if (!tracked.length) return;
    if (!(await confirm(`Discard all ${tracked.length} unstaged change(s)${where([repo])}?`, 'Discard All', 'Staged changes and new (untracked or intent-to-add) files are kept. This cannot be undone.'))) return;
    await repo.discard(tracked);
  });

  cmd('commitCorner.cleanAll', async (arg) => {
    const repo = await manager.pick(groupRepo(manager, arg));
    if (!repo || !repo.state) return;
    await repo.refreshState({ fresh: true }); // what is there now, not a cached look
    // Repositories inside the tree (an agent's worktree) are kept: never trashed with the files.
    const nested = repo.nestedRepositories();
    const files = repo.state.untracked.map((e) => e.path).filter((p) => !nested.includes(p));
    if (!files.length) {
      if (nested.length) notify.info(`Nothing to delete: ${nested.length === 1 ? `"${nested[0]}" is a repository` : `${nested.length} entries are repositories`} of their own (a worktree?), never deleted from here.`);
      return;
    }
    if (!(await confirm(`Delete ${files.length} untracked file(s)${where([repo])}?`, 'Move to Trash', nested.length ? `${nested.length} nested repositor${nested.length === 1 ? 'y is' : 'ies are'} kept.` : undefined))) return;
    await deleteFiles(files.map((f) => repo.absolute(f)));
    manager.scheduleRefresh(repo);
  });

  cmd('commitCorner.ignore', async (...args) => {
    for (const r of resolveResources(manager, args)) {
      const choice = await vscode.window.showQuickPick([
        { label: Repository.ignorePattern(r.path), description: 'this file' },
        { label: `*${extOf(r.path)}`, description: 'all files with this extension', hide: !extOf(r.path) },
        { label: `/${dirOf(r.path)}/`, description: 'the containing folder', hide: !dirOf(r.path) },
      ].filter((x) => !x.hide), { placeHolder: `Add to .gitignore` });
      if (choice) await r.repo.ignore(choice.label);
    }
  });

  cmd('commitCorner.acceptOurs', (...args) => acceptSide(manager, args, 'ours'));
  cmd('commitCorner.acceptTheirs', (...args) => acceptSide(manager, args, 'theirs'));
  cmd('commitCorner.openMergeEditor', async (...args) => {
    const [r] = resolveResources(manager, args);
    if (r) await openMergeEditor(r.repo, r.path);
  });
  cmd('commitCorner.openConflictDiff', async (...args) => {
    const [r] = resolveResources(manager, args);
    if (r) await openDiff(r.repo, { path: r.path, leftRef: ':2', rightRef: ':3', title: `${base(r.path)} (Ours ↔ Theirs)` });
  });

  // ---- commit -------------------------------------------------------------

  const commitCmd = (id, opts) => cmd(id, (arg) => commit(ctx, arg, opts));
  commitCmd('commitCorner.commit', {});
  commitCmd('commitCorner.commitAmend', { amend: true });
  commitCmd('commitCorner.commitSignoff', { signoff: true });
  commitCmd('commitCorner.commitNoVerify', { noVerify: true });
  commitCmd('commitCorner.commitAll', { all: true });
  commitCmd('commitCorner.commitEmpty', { allowEmpty: true });
  commitCmd('commitCorner.commitAndPush', { then: 'push' });
  commitCmd('commitCorner.commitAndSync', { then: 'sync' });

  /** Commit only the selected files (`git commit --only`), leaving everything else as it is. */
  cmd('commitCorner.commitSelected', async (...args) => {
    const resources = resolveResources(manager, args);
    if (!resources.length) return;
    const repo = resources[0].repo;
    const state = await repo.refreshState();
    if (state.conflicts.length || state.operation) {
      notify.warn(state.conflicts.length ? 'Resolve all merge conflicts before committing.' : `Finish the ${state.operation.kind} in progress first (Commit Selected cannot be used during it).`);
      return;
    }
    const paths = [];
    for (const r of resources.filter((x) => x.repo === repo)) {
      paths.push(r.path);
      // A staged rename has two sides: committing only the new name would split it into add + delete.
      const staged = state.staged.find((e) => e.path === r.path);
      const orig = r.origPath || (staged && staged.origPath);
      if (orig) paths.push(orig);
    }
    const provider = scm.get(repo);
    let message = provider ? provider.message.trim() : '';
    // An untouched commit template is not a message (as in Commit).
    if (provider && provider.template && message === provider.template.trim()) message = '';
    if (!message) message = ((await vscode.window.showInputBox({ title: `Commit ${paths.length} selected file${paths.length === 1 ? '' : 's'}`, prompt: 'Commit message', ignoreFocusOut: true })) || '').trim();
    if (!message) return;
    const untracked = resources.filter((r) => r.group === 'untracked').map((r) => r.path);
    if (untracked.length) await repo.stage(untracked); // --only needs git to know the files
    // From "Staged Changes": commit exactly what is staged for these files (line staging must
    // be respected). Otherwise (Changes/Untracked): their working-tree content, like `commit --only`.
    // Per file, by the group it was picked from: Staged → exactly what is staged (line staging is
    // respected); Changes/Untracked → its current content. One commit either way.
    const fromStaged = resources.some((r) => r.group === 'staged');
    const workingTreePaths = resources.filter((r) => r.repo === repo && r.group !== 'staged').map((r) => r.path);
    await withProgress('Committing…', () => (fromStaged ? repo.commitStagedPaths(message, paths, { workingTreePaths }) : repo.commit(message, { only: paths })), vscode.ProgressLocation.SourceControl);
    if (provider) provider.message = provider.template || '';
    require('../webviews/graphPanel').GraphPanel.committedElsewhere(repo);
  });

  cmd('commitCorner.undoLastCommit', async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo) return;
    // Right after a rebase, "undo" almost always means the rebase, not its newest commit.
    const rewrite = pendingRewrite(repo);
    if (rewrite) {
      const choice = await notify.warn(`The last change to ${rewrite.branch || 'HEAD'} was a history rewrite (${rewrite.label}). Undo that instead?`, { modal: true, detail: '"Undo Last Commit" removes only the newest commit and stages its changes; "Undo Rewrite" puts the branch back where it was before the rewrite.' }, 'Undo Rewrite', 'Undo Last Commit');
      if (!choice) return;
      if (choice === 'Undo Rewrite') {
        await vscode.commands.executeCommand('commitCorner.undoRewrite', { repoRoot: repo.root });
        return;
      }
    }
    if (!(await warnIfPushed(repo, 'Undo the last commit'))) return;
    const commit = await repo.undoLastCommit();
    const provider = scm.get(repo);
    if (provider && !provider.message) provider.message = commit.body || commit.subject;
    notify.info(`Undid "${commit.subject}". Its changes are staged.`);
  });

  cmd('commitCorner.recentMessage', async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo) return;
    const own = ctx.extContext.workspaceState.get(`messages:${repo.root}`, []);
    const fromLog = await repo.recentMessages(50);
    const all = [...new Set([...own, ...fromLog])];
    const pick = await vscode.window.showQuickPick(all.map((m) => ({ label: escapeIcons(m.split('\n')[0]), detail: m.includes('\n') ? escapeIcons(m.split('\n').slice(1).join(' ').trim().slice(0, 200)) : undefined, m })), { placeHolder: 'Reuse a commit message' });
    if (pick) scm.get(repo).message = pick.m;
  });

  // ---- operations in progress ---------------------------------------------

  cmd('commitCorner.continueOperation', async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo) return;
    const state = await repo.refreshState();
    const op = state.operation;
    if (!op) {
      notify.info('No merge, rebase, cherry-pick or revert is in progress.');
      return;
    }
    if (state.conflicts.length) {
      notify.warn(`Resolve and stage ${state.conflicts.length} conflicted file(s) first.`);
      return;
    }
    const provider = scm.get(repo);
    // A message typed in the graph's commit box (arg.message) counts as edited.
    const given = arg && typeof arg.message === 'string' ? arg.message.trim() : '';
    if (op.kind === 'bisect') {
      await vscode.commands.executeCommand('commitCorner.operationMenu', repo);
      return;
    }
    if (op.kind === 'merge') {
      const msg = given || (provider && provider.message.trim());
      await repo.commit(msg || undefined);
      if (provider) provider.message = '';
      return;
    }
    // Keep a message the user edited: git continues with MERGE_MSG, so write it there first.
    // Only an edit of the message we prefilled counts; an old draft or the commit template
    // in the box must never replace the commit's own message.
    const typed = given || (provider && provider.message.trim());
    let edited = !!given || !!(provider && provider.prefilled && typed && typed !== provider.prefilled.trim());
    // Unedited, but with a line git would take for a comment ("#123 fix"): continue with the
    // message as shown, so git keeps it.
    const hashed = !edited && !!(provider && provider.prefilled && typed && typed.split('\n').some((l) => l.startsWith('#')));
    if (edited || hashed) await repo.writePendingMessage(typed);
    if (hashed) edited = true;
    await withProgress(`Continuing ${op.kind}…`, () => repo.continueOperation(op.kind, edited ? { message: typed } : {}), vscode.ProgressLocation.SourceControl).catch((e) => {
      if (e instanceof GitError && e.code === ErrorCodes.Conflict) {
        notify.warn(`The ${op.kind} stopped with conflicts. Resolve them in Source Control, then continue.`);
        return;
      }
      throw e;
    });
    if (provider) provider.message = '';
  });

  cmd('commitCorner.abortOperation', async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo) return;
    const op = (await repo.refreshState()).operation;
    if (!op) return;
    if (!(await confirm(`Abort the ${op.kind} in progress?`, 'Abort', 'The repository returns to its state before the operation started.'))) return;
    // Bisect: the End path, which also offers back the changes stashed before it.
    if (op.kind === 'bisect') {
      await vscode.commands.executeCommand('commitCorner.bisectReset', { repoRoot: repo.root });
      return;
    }
    await repo.abortOperation(op.kind);
    // The prefilled merge/cherry-pick message no longer applies.
    const provider = scm.get(repo);
    if (provider && provider.message.trim() === ((provider.lastPendingMessage || '').trim())) provider.message = '';
  });

  cmd('commitCorner.skipOperation', async (arg) => {
    const repo = await manager.pick(arg);
    if (!repo) return;
    const op = (await repo.refreshState()).operation;
    if (op) await repo.skipOperation(op.kind);
  });
}

/** Commit from the SCM input box. */
async function commit(ctx, arg, opts) {
  const { manager, scm } = ctx;
  const repo = await manager.pick(arg);
  if (!repo) return;
  const provider = scm.get(repo);
  const state = await repo.refreshState();
  if (state.conflicts.length) {
    notify.warn('Resolve all merge conflicts before committing.');
    return;
  }
  if (state.operation && ['rebase', 'cherry-pick', 'revert', 'am'].includes(state.operation.kind) && !opts.amend) {
    // At an `edit`/`break` stop the user is rewriting history: staged changes become a new
    // commit (git's own `git commit` behaviour); Continue stays a separate step.
    const editStop = state.operation.kind === 'rebase' && (await repo.isRebaseEditStop());
    if (!editStop) {
      // From the graph's commit box: its message is the commit's message.
      const typed = arg && typeof arg.message === 'string' && arg.message.trim();
      await vscode.commands.executeCommand('commitCorner.continueOperation', typed ? { repoRoot: repo.root, message: typed } : repo);
      return;
    }
    if (!state.staged.length) {
      const choice = await notify.info('The rebase is stopped for editing and nothing is staged.', 'Continue Rebase', 'Amend Stopped Commit');
      if (choice === 'Continue Rebase') await vscode.commands.executeCommand('commitCorner.continueOperation', repo);
      else if (choice) await vscode.commands.executeCommand('commitCorner.commitAmend', repo);
      return;
    }
  }
  // From the graph's commit box (arg.message), else Source Control's input box.
  const fromArg = arg && typeof arg.message === 'string';
  let message = fromArg ? arg.message.trim() : provider ? provider.message.trim() : '';
  // An untouched commit template is not a message (git refuses it too).
  if (!fromArg && provider && provider.template && message === provider.template.trim()) message = '';
  const commitOpts = { amend: opts.amend, signoff: opts.signoff, noVerify: opts.noVerify, all: opts.all, allowEmpty: opts.allowEmpty };

  // Protection only adds up: a workspace's settings can protect more branches, never fewer.
  const c = config();
  const pb = typeof c.inspect === 'function' ? c.inspect('protectedBranches') : undefined;
  const protectedBranches = pb
    ? [...new Set([pb.globalValue, pb.workspaceValue, pb.workspaceFolderValue].flatMap((v) => (Array.isArray(v) ? v : [])))]
    : c.get('protectedBranches', []);
  if (state.head.branch && !opts.amend && protectedBranches.some((p) => globMatch(p, state.head.branch))) {
    const choice = await notify.warn(`"${state.head.branch}" is a protected branch.`, { modal: true, detail: 'Commit to it anyway, or create a new branch for this commit (your changes come along).' }, 'Commit Anyway', 'Create Branch…');
    if (!choice) return;
    if (choice === 'Create Branch…') {
      const { inputBranchName } = require('../pickers');
      const name = await inputBranchName('New branch for this commit', undefined, { repo });
      if (!name) return;
      await repo.createBranch(name, undefined, true); // always switch: the commit goes there
      const after = await repo.refreshState();
      if (after.head.branch === state.head.branch) return; // cancelled
    }
  }

  // Staging everything waits until the message is known: cancelling the message prompt must
  // leave the index as it was.
  let stageAllFirst = false;
  if (!opts.amend && !opts.allowEmpty && !opts.all && !state.staged.length) {
    const hasTracked = state.unstaged.length > 0;
    if (!hasTracked && !state.untracked.length && !(state.operation && state.operation.kind === 'merge')) {
      notify.info('There are no changes to commit.');
      return;
    }
    const mode = config().get('smartCommit', 'ask');
    if (mode === 'never') {
      notify.info('There are no staged changes. Stage changes first.');
      return;
    }
    if (mode === 'ask' && !(state.operation && state.operation.kind === 'merge')) {
      // "Tracked Files Only" only when there are changes to tracked files to commit.
      const choice = await notify.warn(
        'There are no staged changes. Stage all changes and commit them directly?',
        { modal: true, detail: 'Set "commitCorner.smartCommit" to "always" to skip this question.' },
        'Stage All & Commit', ...(hasTracked ? ['Tracked Files Only'] : []));
      if (!choice) return;
      if (choice === 'Stage All & Commit') stageAllFirst = true;
      else commitOpts.all = true;
    } else if (mode === 'always') stageAllFirst = true;
  }

  if (opts.amend) {
    if (!(await warnIfPushed(repo, 'Amend the last commit'))) return;
  }

  const mergeInProgress = state.operation && state.operation.kind === 'merge';
  if (!message && !opts.amend && !mergeInProgress) {
    // Say what is being committed where, so a message typed from a chord is not a leap of faith.
    const count = stageAllFirst ? state.staged.length + state.unstaged.length + state.untracked.length : state.staged.length;
    const what = `${count} ${stageAllFirst ? 'changed' : 'staged'} file${count === 1 ? '' : 's'}`;
    const where = state.head.branch ? `on ${state.head.branch}` : 'on a detached HEAD';
    message = (await vscode.window.showInputBox({ title: `Commit ${what} ${where}`, prompt: 'Commit message', placeHolder: 'Describe your changes', ignoreFocusOut: true })) || '';
    if (!message.trim()) return;
  }
  if (stageAllFirst) await repo.stageAll();

  await withProgress('Committing…', () => repo.commit(message || undefined, commitOpts), vscode.ProgressLocation.SourceControl);
  if (state.operation && state.operation.kind === 'rebase') {
    notify.info('Committed. Continue the rebase when you are done editing.', 'Continue Rebase').then((c) => {
      if (c) vscode.commands.executeCommand('commitCorner.continueOperation', repo);
    });
  }
  if (message) {
    const key = `messages:${repo.root}`;
    const history = [message, ...ctx.extContext.workspaceState.get(key, []).filter((m) => m !== message)].slice(0, 30);
    await ctx.extContext.workspaceState.update(key, history);
  }
  // One draft: whichever box committed, both are emptied.
  if (provider && (!fromArg || provider.message.trim() === message)) provider.message = provider.template || '';
  if (!fromArg) require('../webviews/graphPanel').GraphPanel.committedElsewhere(repo);
  if (opts.then === 'push') await vscode.commands.executeCommand('commitCorner.push', repo);
  else if (opts.then === 'sync') await vscode.commands.executeCommand('commitCorner.sync', repo);
}

/** Minimal glob for branch protection patterns ("release/*"). */
function globMatch(pattern, name) {
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(name);
}

/** Warn before rewriting a commit that is already on the upstream. Returns true to proceed. */
async function warnIfPushed(repo, action) {
  const state = repo.state;
  if (!state || !state.head.upstream || !state.head.sha) return true;
  const pushed = await repo.isAncestor('HEAD', state.head.upstream);
  if (!pushed) return true;
  return confirm(`${action}? The commit is already on ${state.head.upstream}.`, 'Continue', 'You will need to force push afterwards, which rewrites shared history.');
}

async function acceptSide(manager, args, side) {
  for (const [repo, list] of byRepo(resolveResources(manager, args))) {
    for (const r of list) await repo.resolveWith(r.path, side);
  }
}

async function openMergeEditor(repo, relPath) {
  // Its result is written to the working file: only a regular file of this repository (a
  // conflicted symlink could point anywhere), else the file as git sees it.
  const w = repo.workingFile(relPath);
  if (!w) return;
  if (w.st && !w.st.isFile()) {
    await vscode.commands.executeCommand('vscode.open', uriAt(repo, WORKTREE, relPath));
    return;
  }
  const input = (ref, title) => ({ uri: toGitUri(repo.root, relPath, ref), title });
  try {
    await vscode.commands.executeCommand('_open.mergeEditor', {
      base: toGitUri(repo.root, relPath, ':1'),
      input1: input(':2', 'Current (ours)'),
      input2: input(':3', 'Incoming (theirs)'),
      output: vscode.Uri.file(w.abs),
    });
  } catch (e) {
    // `_open.mergeEditor` is internal to VS Code and may change: say so instead of silently
    // falling back to the file with its conflict markers.
    log().warn(`Merge editor unavailable (${e && e.message}); opening ${relPath} with its conflict markers instead`);
    vscode.window.setStatusBarMessage('Commit Corner: the 3-way merge editor could not be opened; showing the conflict markers (see the log)', 6000);
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(w.abs));
  }
}

/** Whether a conflicted file still has markers: a regular file of this repository only, up to 50 MB. */
async function hasConflictMarkers(repo, relPath) {
  const w = repo.workingFile(relPath);
  if (!w || !w.st || !w.st.isFile() || w.st.size > 50 * 1024 * 1024) return false;
  try {
    const text = String(await repo.show(WORKTREE, relPath) || '');
    return /^<{7}( |$)|^>{7}( |$)/m.test(text);
  } catch {
    return false;
  }
}

/**
 * Move files to the trash. Where there is no trash (common on WSL and other
 * remotes), ask before deleting the rest permanently instead of doing it silently.
 */
async function deleteFiles(files) {
  const failed = [];
  for (const file of files) {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(file), { recursive: true, useTrash: true });
    } catch {
      failed.push(file);
    }
  }
  if (!failed.length) return;
  const ok = await confirm(
    `The trash is not available here. Delete ${failed.length} untracked file(s) permanently?`,
    'Delete Permanently',
    failed.slice(0, 10).map((f) => f).join('\n') + (failed.length > 10 ? `\n… and ${failed.length - 10} more` : ''),
  );
  if (!ok) return;
  for (const file of failed) await vscode.workspace.fs.delete(vscode.Uri.file(file), { recursive: true, useTrash: false });
}

function groupRepo(manager, arg) {
  if (arg && arg.repoRoot) return { repoRoot: arg.repoRoot };
  if (arg && arg.resourceStates && arg.resourceStates[0]) return { repoRoot: arg.resourceStates[0].repoRoot };
  return arg && arg.resourceStates ? undefined : arg;
}

function base(p) {
  return p.split('/').pop();
}
function extOf(p) {
  const b = base(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i) : '';
}
function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '';
}

module.exports = { register, resolveResources, openMergeEditor, hasConflictMarkers };
