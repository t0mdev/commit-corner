'use strict';

/**
 * The last history rewrite (interactive rebase, fold, reword, …) per repository, so it can be
 * undone in one step and other "undo" actions can tell it apart.
 * repo root -> {branch, before, after, label, at}
 */
const lastRewrite = new Map();

/** The repository's last rewrite if HEAD is still where it left it, else undefined. */
function pendingRewrite(repo) {
  const last = repo && lastRewrite.get(repo.root);
  const head = repo && repo.state && repo.state.head;
  if (!last || !head || head.sha !== last.after || (head.branch || undefined) !== (last.branch || undefined)) return undefined;
  return last;
}

module.exports = { lastRewrite, pendingRewrite };
