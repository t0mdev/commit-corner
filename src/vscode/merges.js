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
const APPROXIMATE = 'approximate: with git older than 2.38 the automatic merge is redone without rename detection';

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

/** One line on what the view shows. */
function viewDetail(commit, view) {
  if (view === 'resolution') return 'Only what the merge itself changed: resolved conflicts and edits beyond git\'s automatic merge';
  const i = parentIndex(view);
  const p = shortSha(commit.parents[i]);
  return i === 0 ? `Everything the merge brought into ${p} (the merged side's changes)` : `Everything that differs from ${p}, the merged tip (mostly the first parent's side)`;
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
    const r = await repo.getMergeResolution(commit.sha, { signal });
    const conflicts = new Set(r.conflicts);
    return { files: r.files.map((f) => (conflicts.has(f.path) || conflicts.has(f.origPath) ? { ...f, conflict: true } : f)), left: r.tree, leftLabel: AUTO_LABEL, exact: r.exact };
  }
  const i = parentIndex(view);
  const left = commit.parents[i];
  const files = i === 0 ? (await repo.getCommitFiles(commit.sha)).files : await repo.diffFiles(left, commit.sha, { blobs: true, signal });
  return { files, left };
}

/** How many files a view has (resolution: also whether that is exact). */
async function countView(repo, commit, view, signal) {
  if (view === 'resolution') {
    const r = await repo.getMergeResolution(commit.sha, { signal });
    return { count: r.files.length, exact: r.exact };
  }
  return { count: await repo.countChanges(commit.parents[parentIndex(view)], commit.sha, { signal }) };
}

/**
 * Ask which view of a merge to open. Shown at once; the counts fill in as git finds them
 * (Enter on the first entry does not wait). Resolves to the view, or undefined.
 */
function pickMergeView(repo, commit) {
  const qp = vscode.window.createQuickPick();
  qp.title = `Merge ${shortSha(commit.sha)}: ${escapeIcons(commit.subject || '')}`;
  qp.placeholder = commit.parents.length === 2 ? 'Which changes of this merge?' : `Which changes of this merge? (it merges ${commit.parents.length} parents: Merge Resolution needs two)`;
  qp.matchOnDetail = true;
  let items = mergeViews(commit).map((view) => ({
    label: `${view === 'resolution' ? '$(git-compare)' : '$(diff)'} ${viewTitle(view)}`,
    description: 'counting…',
    detail: viewDetail(commit, view),
    view,
  }));
  let active = items[0].view;
  const show = () => {
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
      items = items.map((x) => (x.view === item.view ? { ...x, description: text } : x));
      show();
      if (--pending === 0) qp.busy = false;
    });
  }
  return new Promise((resolve) => {
    let chosen;
    qp.onDidChangeActive((a) => {
      if (a[0]) active = a[0].view;
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
  const { files, left, leftLabel, exact } = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `${viewTitle(view)} of ${shortSha(commit.sha)}…` },
    () => mergeViewFiles(repo, commit, view),
  );
  if (view === 'resolution' && !files.length) {
    const others = mergeViews(commit).filter((v) => v !== 'resolution');
    const pick = await notify.info(`${shortSha(commit.sha)} is a clean merge: it changed nothing beyond git's automatic merge of its parents${exact === false ? ` (${APPROXIMATE})` : ''}.`, ...others.map(viewTitle));
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

module.exports = { AUTO_LABEL, APPROXIMATE, mergeViews, isMergeView, viewTitle, viewDetail, countText, mergeViewFiles, countView, pickMergeView, openMergeView };
