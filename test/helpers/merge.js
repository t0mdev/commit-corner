'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * A merge commit made with plumbing in the repository at `cwd` (its working tree and index stay
 * as they are), on top of HEAD: mr.txt conflicted (B1 / B2) and was resolved, other.txt came
 * from the first parent only. Returns the merge's SHA.
 */
function makeMerge(cwd, subject = 'Merge side') {
  const index = path.join(os.tmpdir(), `cc-merge-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const run = (args, input) => execFileSync('git', args, { cwd, env, input, encoding: 'utf8' }).trim();
  const commit = (parents, files, message) => {
    run(['read-tree', parents[0]]);
    for (const [p, text] of Object.entries(files)) run(['update-index', '--add', '--cacheinfo', `100644,${run(['hash-object', '-w', '--stdin'], text)},${p}`]);
    return run(['commit-tree', run(['write-tree']), ...parents.flatMap((x) => ['-p', x]), '-m', message]);
  };
  try {
    const base = commit([run(['rev-parse', 'HEAD'])], { 'mr.txt': 'a\nb\nc\n' }, 'merge base');
    const side = commit([base], { 'mr.txt': 'a\nB2\nc\n' }, 'side');
    const first = commit([base], { 'mr.txt': 'a\nB1\nc\n', 'other.txt': 'x\n' }, 'first');
    return commit([first, side], { 'mr.txt': 'a\nRESOLVED\nc\n' }, subject);
  } finally {
    fs.rmSync(index, { force: true });
  }
}

module.exports = { makeMerge };
