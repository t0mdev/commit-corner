'use strict';

/**
 * Combine the changes of several (possibly non-contiguous) commits into one
 * per-file diff, IntelliJ style:
 *
 *   for every file touched by any selected commit,
 *     before = the file before the OLDEST selected commit that touched it
 *     after  = the file after  the NEWEST selected commit that touched it
 *
 * Renames are followed across the selection, so a file modified in commit A
 * and renamed in commit C shows up once, as a rename with A's and C's edits.
 *
 * Note: if unselected commits between the two also touched the file, their
 * edits are part of the result. That is inherent to showing a single diff per
 * file, and the same trade-off IntelliJ makes.
 */

/**
 * @param {{sha:string, parent:string|null, changes:{status:string, path:string, origPath?:string}[]}[]} commitsOldestFirst
 * @returns {{status:string, path:string, origPath?:string, beforeRef:string|null, beforePath:string|null, afterRef:string|null, afterPath:string|null, commits:string[]}[]}
 */
function combineCommitChanges(commitsOldestFirst) {
  /** Map keyed by the file's current (latest seen) path. */
  const files = new Map();

  for (const commit of commitsOldestFirst) {
    for (const ch of commit.changes) {
      const isRename = ch.status === 'R';
      const isCopy = ch.status === 'C';
      const key = isRename ? ch.origPath : ch.path;
      let entry = files.get(key);
      if (!entry || isCopy) {
        // First time we see this file in the selection: "before" is its state in this commit's parent.
        // A copy always starts a new entry and shows as an added file.
        const beforeExists = ch.status !== 'A' && !isCopy;
        entry = {
          beforeRef: beforeExists ? commit.parent : null,
          beforePath: beforeExists ? (isRename ? ch.origPath : ch.path) : null,
          afterRef: null,
          afterPath: null,
          commits: [],
        };
      } else if (!isCopy) files.delete(key);

      entry.commits.push(commit.sha);
      if (ch.status === 'D') {
        entry.afterRef = null;
        entry.afterPath = null;
      } else {
        entry.afterRef = commit.sha;
        entry.afterPath = ch.path;
      }
      files.set(isRename || isCopy ? ch.path : key, entry);
      if (isRename) files.delete(ch.origPath);
    }
  }

  const result = [];
  for (const [path, e] of files) {
    const before = e.beforePath !== null;
    const after = e.afterPath !== null;
    if (!before && !after) continue; // added then deleted within the selection
    let status;
    if (!before) status = 'A';
    else if (!after) status = 'D';
    else if (e.beforePath !== e.afterPath) status = 'R';
    else status = 'M';
    result.push({
      status,
      path: after ? e.afterPath : e.beforePath,
      origPath: status === 'R' ? e.beforePath : undefined,
      beforeRef: e.beforeRef,
      beforePath: e.beforePath,
      afterRef: e.afterRef,
      afterPath: e.afterPath,
      commits: e.commits,
      key: path,
    });
  }
  result.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

module.exports = { combineCommitChanges };
