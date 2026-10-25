'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { layout, GraphLayout } = require('../src/git/graph');

test('linear history stays in one lane', () => {
  const { rows, maxWidth } = layout([
    { sha: 'c', parents: ['b'] },
    { sha: 'b', parents: ['a'] },
    { sha: 'a', parents: [] },
  ]);
  assert.equal(maxWidth, 1);
  assert.deepEqual(rows.map((r) => r.col), [0, 0, 0]);
  assert.deepEqual(rows[1].lines.map((l) => l.kind), ['in', 'out']);
  assert.equal(rows[2].isRoot, true);
});

test('branch and merge: side branch gets its own lane, then converges', () => {
  // m merges b2 into a2; topo order
  const { rows } = layout([
    { sha: 'm', parents: ['a2', 'b2'] },
    { sha: 'b2', parents: ['b1'] },
    { sha: 'b1', parents: ['a1'] },
    { sha: 'a2', parents: ['a1'] },
    { sha: 'a1', parents: [] },
  ]);
  assert.equal(rows[0].col, 0);
  assert.equal(rows[0].isMerge, true);
  assert.deepEqual(rows[0].lines.filter((l) => l.kind === 'out').map((l) => l.to), [0, 1]);
  assert.equal(rows[1].col, 1);
  assert.equal(rows[2].col, 1);
  // a2 keeps the main line vertical; the side lane (awaiting a1) folds into it.
  assert.equal(rows[3].col, 0);
  assert.ok(rows[3].lines.some((l) => l.kind === 'pass' && l.from === 1 && l.to === 0));
  assert.equal(rows[4].col, 0);
  assert.equal(rows[4].lines.filter((l) => l.kind === 'in').length, 1);
});

test('incremental layout equals one-shot layout', () => {
  const commits = [
    { sha: 'd', parents: ['c', 'x'] },
    { sha: 'x', parents: ['b'] },
    { sha: 'c', parents: ['b'] },
    { sha: 'b', parents: ['a'] },
    { sha: 'a', parents: [] },
  ];
  const one = layout(commits).rows;
  const g = new GraphLayout();
  const two = [...g.add(commits.slice(0, 2)), ...g.add(commits.slice(2))];
  assert.deepEqual(two, one);
});

test('every lane at the bottom of a row continues at the top of the next', () => {
  const commits = [
    { sha: 'e', parents: ['d'] },
    { sha: 'f', parents: ['b'] },
    { sha: 'd', parents: ['c', 'f'] },
    { sha: 'c', parents: ['b'] },
    { sha: 'b', parents: ['a'] },
    { sha: 'a', parents: [] },
  ];
  const { rows } = layout(commits);
  for (let i = 0; i < rows.length - 1; i++) {
    const bottoms = new Set(rows[i].lines.filter((l) => l.kind !== 'in').map((l) => l.to));
    const tops = new Set(rows[i + 1].lines.filter((l) => l.kind !== 'out').map((l) => l.from));
    assert.deepEqual([...bottoms].sort(), [...tops].sort(), `row ${i}`);
  }
});

test('a branch tip whose parent is already awaited does not leave a dangling lane', () => {
  // E branches off M, which the working-tree row (*) already waits for.
  const { rows } = layout([
    { sha: '*', parents: ['M'] },
    { sha: 'E', parents: ['M'] },
    { sha: 'M', parents: ['V', 'R'] },
    { sha: 'R', parents: ['A'] },
    { sha: 'V', parents: ['A'] },
    { sha: 'A', parents: [] },
  ]);
  assert.deepEqual(rows[1].lines.map((l) => `${l.kind}${l.from}>${l.to}`), ['pass0>0', 'out1>0']);
  // M has one incoming lane block (from * and E merged into lane 0) and no extra lanes stay open at the root.
  assert.equal(rows[2].lines.filter((l) => l.kind === 'pass').length, 0);
  assert.equal(rows[rows.length - 1].lines.filter((l) => l.kind === 'pass').length, 0);
});
