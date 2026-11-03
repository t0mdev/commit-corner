'use strict';

const vscode = require('vscode');
const notify = require('./notify');
const { openMultiDiff } = require('./diffs');
const { shortSha, escapeIcons, log } = require('./util');

/**
 * The ways to look at a merge commit's changes ("views"):
 * - 'resolution': what the merge itself changed beyond git's automatic merge of its two
 *   parents (the resolved conflicts, edits made while merging); usually little or nothing;
 * - 'parent1', 'parent2', …: everything that differs from that parent (vs parent 1: what the
 *   merge brought in; vs parent 2: what the other side had).
 * Opening a merge offers them (resolution first); trees and the graph list them as sections.
 */

/** The left side's name in a resolution diff (the tab: "app.js (automatic merge)"). */
const AUTO_LABEL = 'automatic merge';

/** Why a resolution can be approximate, for notes and tooltips. */
const APPROXIMATE = 'approximate: git older than 2.38 merges again without rename detection, merge drivers or several merge bases';

/** The views of a merge commit, in the order they are offered. */
function mergeViews(commit) {
  const parents = commit.parents.map((_, i) => `parent${i + 1}`);
  return commit.parents.length === 2 ? ['resolution', ...parents] : parents;
}

/** Whether `view` is a view of this commit (a string from a page or a node is checked here). */
function isMergeView(commit, view) {
  return typeof view === 'string' && commit.parents.length > 1 && mergeViews(commit).includes(view);
}

const parentIndex = (view) => Number(view.slice('parent'.length)) - 1;

function viewTitle(view) {
  return view === 'resolution' ? 'Merge Resolution' : `Changes vs Parent ${parentIndex(view) + 1}`;
}

/**
 * The parents as people know them: short SHA and subject (`80f222b “Fix login”`), plain text.
 * @returns {Promise<string[]>}
 */
async function parentSides(repo, commit, signal) {
  const res = await repo.exec(['log', '--no-walk=unsorted', '--format=%H%x00%s', ...commit.parents, '--'], { signal, allowFailure: true });
  const subjects = new Map(res.stdout.split('\n').map((l) => l.split('\0')));
  return commit.parents.map((p) => {
    const subject = subjects.get(p) || '';
    const short = subject.length > 50 ? `${subject.slice(0, 49)}…` : subject;
    return short ? `${shortSha(p)} “${short}”` : shortSha(p);
  });
}

/** One line on what the view shows; `sides` from parentSides (else short SHAs). */
function viewDetail(commit, view, sides = []) {
  if (view === 'resolution') return 'Only what the merge changed itself: conflict resolutions and extra edits';
  const i = parentIndex(view);
  const p = sides[i] || shortSha(commit.parents[i]);
  return i === 0 ? `Everything the merge brought in, against ${p}` : `Everything that differs from the merged-in branch ${p}: mostly what the other side changed`;
}

/** A merge's sections for a page before git has counted them (titles, sides by SHA). */
function pendingSections(commit) {
  return mergeViews(commit).map((view) => {
    const i = view === 'resolution' ? -1 : parentIndex(view);
    return { view, title: viewTitle(view), detail: viewDetail(commit, view), left: i < 0 ? undefined : commit.parents[i], side: i < 0 ? undefined : shortSha(commit.parents[i]), countText: 'counting…', pending: true, open: view === 'resolution' };
  });
}

/** "2 files", "no files: a clean merge", with what makes it approximate. */
function countText(view, n, exact) {
  const files = `${n} file${n === 1 ? '' : 's'}`;
  if (view !== 'resolution') return files;
  return `${n ? files : 'no files: a clean merge'}${exact === false ? ' · approximate' : ''}`;
}

/**
 * The files of one view and the side they are compared with: `left` (a commit, or the
 * automatic merge's tree) with its label. Resolution files that had a conflict in git's
 * merge carry `conflict: true`.
 * @param {import('../git/repository').Repository} repo
 * @param {import('../git/parse').Commit} commit
 * @returns {Promise<{files:object[], left:string, leftLabel?:string, exact?:boolean}>}
 */
async function mergeViewFiles(repo, commit, view, signal) {
  if (view === 'resolution') {
    const r = await repo.getMergeResolution(commit.sha, { signal, commit });
    const conflicts = new Set(r.conflicts);
    return { files: r.files.map((f) => (conflicts.has(f.path) || conflicts.has(f.origPath) ? { ...f, conflict: true } : f)), left: r.tree, leftLabel: AUTO_LABEL, exact: r.exact };
  }
  const i = parentIndex(view);
  const left = commit.parents[i];
  const files = i === 0 ? (await repo.getCommitFiles(commit.sha, commit)).files : await repo.diffFiles(left, commit.sha, { blobs: true, signal });
  return { files, left };
}

/**
 * The files of commit `sha` against `base` (a diff's left side, from its URI): its resolution's
 * files when that is its automatic merge (as listed, no new diff), else the diff of the two.
 * leftLabel says when it is the automatic merge.
 * @returns {Promise<{files:object[], leftLabel?:string}>}
 */
async function filesAgainst(repo, sha, base) {
  const commit = await repo.getCommit(sha);
  if (commit.parents[0] === base) return { files: (await repo.getCommitFiles(sha, commit)).files };
  if (commit.parents.length === 2 && !commit.parents.includes(base)) {
    const r = await repo.getMergeResolution(sha, { commit }).catch(() => undefined);
    if (r && r.tree === base) return { files: r.files, leftLabel: AUTO_LABEL };
  }
  return { files: await repo.diffFiles(base, sha, { blobs: true }), leftLabel: commit.parents.includes(base) ? undefined : AUTO_LABEL };
}

/** How many files a view has (resolution: also whether that is exact). */
async function countView(repo, commit, view, signal) {
  if (view === 'resolution') {
    const r = await repo.getMergeResolution(commit.sha, { signal, commit });
    return { count: r.files.length, exact: r.exact };
  }
  return { count: await repo.countChanges(commit.parents[parentIndex(view)], commit.sha, { signal }) };
}

/**
 * Ask which view of a merge to open. Shown at once; the counts fill in as git finds them
 * (Enter on the first entry does not wait). Resolves to the view, or undefined.
 */
async function pickMergeView(repo, commit) {
  const sides = await parentSides(repo, commit);
  const qp = vscode.window.createQuickPick();
  qp.title = `Merge ${shortSha(commit.sha)}: ${escapeIcons(commit.subject || '')}`;
  qp.placeholder = commit.parents.length === 2 ? 'Which changes of this merge?' : `Which changes of this merge? (it merges ${commit.parents.length} parents: Merge Resolution needs two)`;
  qp.matchOnDetail = true;
  let items = mergeViews(commit).map((view) => ({
    label: `${view === 'resolution' ? '$(git-compare)' : '$(diff)'} ${viewTitle(view)}`,
    description: 'counting…',
    detail: escapeIcons(viewDetail(commit, view, sides)),
    view,
  }));
  let active = items[0].view;
  let moved = false; // the user moved in the list: the active entry stays theirs
  // New items reset the active one, and VS Code reports that (and ours) a moment later: changes
  // reported right after a redraw are its echo, not the user moving.
  let redrawn = 0;
  const show = () => {
    redrawn = Date.now();
    qp.items = items;
    qp.activeItems = items.filter((x) => x.view === active);
  };
  show();
  qp.busy = true;
  const controller = new AbortController();
  let pending = items.length;
  for (const item of items) {
    countView(repo, commit, item.view, controller.signal).then(
      ({ count, exact }) => countText(item.view, count, exact),
      (e) => {
        if (e && e.code !== 'Cancelled') log().warn(`Merge ${shortSha(commit.sha)}, ${item.view}: ${e.message}`);
        return 'unavailable';
      },
    ).then((text) => {
      if (controller.signal.aborted) return;
      // Most merges are clean: then Enter takes what the merge brought in.
      if (item.view === 'resolution' && /^no files/.test(text) && !moved) active = 'parent1';
      const side = item.view === 'resolution' ? '' : `${shortSha(commit.parents[parentIndex(item.view)])} · `;
      items = items.map((x) => (x.view === item.view ? { ...x, description: `${side}${text}` } : x));
      show();
      if (--pending === 0) qp.busy = false;
    });
  }
  return new Promise((resolve) => {
    let chosen;
    qp.onDidChangeActive((a) => {
      if (!a[0] || a[0].view === active || Date.now() - redrawn < 300) return;
      active = a[0].view;
      moved = true;
    });
    qp.onDidAccept(() => {
      chosen = qp.activeItems[0] && qp.activeItems[0].view;
      qp.hide();
    });
    qp.onDidHide(() => {
      controller.abort();
      qp.dispose();
      resolve(chosen);
    });
    qp.show();
  });
}

/** Open one view of a merge in the multi-diff editor. A clean merge says so instead. */
async function openMergeView(repo, commit, view) {
  // Merging again can take a while (big merges, old git): a notification that can stop it.
  const slow = view === 'resolution' && !repo.knownMergeResolution(commit.sha);
  const got = await vscode.window.withProgress(
    { location: slow ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window, title: `${viewTitle(view)} of ${shortSha(commit.sha)}: merging the parents again…`, cancellable: slow },
    (_p, token) => {
      const controller = new AbortController();
      if (token) token.onCancellationRequested(() => controller.abort());
      return mergeViewFiles(repo, commit, view, controller.signal).catch((e) => {
        if (e && e.code === 'Cancelled') return undefined;
        throw e;
      });
    },
  );
  if (!got) return;
  const { files, left, leftLabel, exact } = got;
  if (view === 'resolution' && !files.length) {
    const others = mergeViews(commit).filter((v) => v !== 'resolution');
    const pick = await notify.info(`${shortSha(commit.sha)} is a clean merge: nothing changed beyond git's automatic merge${exact === false ? ' (approximate with git older than 2.38)' : ''}.`, ...others.map(viewTitle));
    const next = others.find((v) => viewTitle(v) === pick);
    if (next) await openMergeView(repo, commit, next);
    return;
  }
  const what = view === 'resolution' ? `merge resolution${exact === false ? ' (approximate)' : ''}` : `vs parent ${parentIndex(view) + 1}`;
  await openMultiDiff(repo, `${shortSha(commit.sha)} ${what} — ${commit.subject}`, files.map((f) => ({
    path: f.path,
    leftRef: f.status === 'A' ? null : left,
    leftPath: f.origPath || f.path,
    rightRef: f.status === 'D' ? null : commit.sha,
    leftLabel,
  })));
}

module.exports = { AUTO_LABEL, APPROXIMATE, mergeViews, isMergeView, viewTitle, viewDetail, parentSides, filesAgainst, pendingSections, countText, mergeViewFiles, countView, pickMergeView, openMergeView };
