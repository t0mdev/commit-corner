'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/git/lineDiff');

const L = (...lines) => lines.map((l) => l + '\n').join('');

test('splitLines keeps terminators and a missing final newline', () => {
  assert.deepEqual(D.splitLines('a\nb\r\nc'), ['a\n', 'b\r\n', 'c']);
  assert.deepEqual(D.splitLines(''), []);
});

test('diffLines finds minimal changes', () => {
  const a = D.splitLines(L('1', '2', '3', '4', '5'));
  const b = D.splitLines(L('1', 'two', '3', '5', '6'));
  assert.deepEqual(D.diffLines(a, b), [
    { origStart: 1, origEnd: 2, modStart: 1, modEnd: 2 },
    { origStart: 3, origEnd: 4, modStart: 3, modEnd: 3 },
    { origStart: 5, origEnd: 5, modStart: 4, modEnd: 5 },
  ]);
});

test('diffLines on identical and empty inputs', () => {
  assert.deepEqual(D.diffLines(['a\n'], ['a\n']), []);
  assert.deepEqual(D.diffLines([], ['a\n']), [{ origStart: 0, origEnd: 0, modStart: 0, modEnd: 1 }]);
});

test('diffLines is consistent: applying all changes reproduces the target', () => {
  // Pseudo-random but deterministic inputs.
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 200; round++) {
    const a = Array.from({ length: Math.floor(rnd() * 30) }, () => `${Math.floor(rnd() * 6)}\n`);
    const b = Array.from({ length: Math.floor(rnd() * 30) }, () => `${Math.floor(rnd() * 6)}\n`);
    const changes = D.diffLines(a, b);
    assert.deepEqual(D.combine(a, b, changes, () => true), b);
    assert.deepEqual(D.combine(a, b, changes, () => false), a);
  }
});

test('applySelection stages only the selected line of a modification', () => {
  const index = L('a', 'b', 'c', 'd');
  const work = L('a', 'B', 'C', 'd');
  // select line 1 (0-based) = "B"
  assert.equal(D.applySelection(index, work, [{ start: 1, end: 1 }]), L('a', 'B', 'c', 'd'));
  // whole hunk granularity takes both lines
  assert.equal(D.applySelection(index, work, [{ start: 1, end: 1 }], 'changes'), work);
});

test('applySelection handles pure insertions and deletions', () => {
  const index = L('a', 'b', 'c');
  const work = L('a', 'new1', 'new2', 'b');
  // select only new2 (line 2)
  assert.equal(D.applySelection(index, work, [{ start: 2, end: 2 }]), L('a', 'new2', 'b', 'c'));
  // deletion of "c" sits after line 3 ("b"); selecting line 3 picks it up
  assert.equal(D.applySelection(index, work, [{ start: 3, end: 3 }]), L('a', 'b'));
});

test('revertSelection discards only the selected change', () => {
  const index = L('a', 'b', 'c', 'd');
  const work = L('A', 'b', 'c', 'D');
  assert.equal(D.revertSelection(index, work, [{ start: 3, end: 3 }]), L('A', 'b', 'c', 'd'));
});

test('mapLineToFrom maps through insertions', () => {
  const changes = D.diffLines(D.splitLines(L('a', 'b')), D.splitLines(L('a', 'x', 'y', 'b')));
  assert.equal(D.mapLineToFrom(changes, 0), 0);
  assert.equal(D.mapLineToFrom(changes, 3), 1);
});

test('large edit distances stay exact (no approximation)', () => {
  const a = Array.from({ length: 2000 }, (_, i) => `a${i}\n`);
  const b = Array.from({ length: 2000 }, (_, i) => `b${i}\n`);
  const changes = D.diffLines(a, b);
  assert.deepEqual(D.combine(a, b, changes, () => true), b);
});

test('line staging after a large paste stages exactly the selected edit', () => {
  // Reviewer scenario: 1600 lines pasted at the top, one line edited further down.
  const index = Array.from({ length: 100 }, (_, i) => `l${i}\n`).join('');
  const pasted = Array.from({ length: 1600 }, (_, i) => `p${i}\n`).join('');
  const work = pasted + index.replace('l50\n', 'l50 edited\n');
  const editedLine = 1600 + 50;
  const staged = D.applySelection(index, work, [{ start: editedLine, end: editedLine }]);
  assert.equal(staged, index.replace('l50\n', 'l50 edited\n'));
});

test('diffs that are too expensive are refused, not approximated', () => {
  const a = Array.from({ length: 30000 }, (_, i) => `a${i}\n`);
  const b = Array.from({ length: 30000 }, (_, i) => `b${i}\n`);
  assert.throws(() => D.diffLines(a, b), D.DiffTooLargeError);
});

test('diffLines is minimal on random inputs (matches an LCS reference)', () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const lcs = (a, b) => {
    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    return dp[a.length][b.length];
  };
  for (let round = 0; round < 300; round++) {
    const a = Array.from({ length: Math.floor(rnd() * 25) }, () => `${Math.floor(rnd() * 4)}`);
    const b = Array.from({ length: Math.floor(rnd() * 25) }, () => `${Math.floor(rnd() * 4)}`);
    const edits = D.diffLines(a, b).reduce((n, c) => n + (c.origEnd - c.origStart) + (c.modEnd - c.modStart), 0);
    assert.equal(edits, a.length + b.length - 2 * lcs(a, b), JSON.stringify({ a, b }));
  }
});

test('a staged text without a final newline is not glued to appended lines', () => {
  const index = 'a\nb\nc';
  const work = 'a\nb\nc\nd\ne';
  // The file still has no final newline after the staged line.
  assert.equal(D.applySelection(index, work, [{ start: 3, end: 3 }]), 'a\nb\nc\nd');
  assert.equal(D.applySelection(index, work, [{ start: 4, end: 4 }]), 'a\nb\nc\ne');
  assert.equal(D.applySelection(index, work, [{ start: 3, end: 4 }]), work);
  // Working copy only gained a final newline: it belongs to the last line.
  assert.equal(D.applySelection('a\nb', 'a\nb\n', [{ start: 1, end: 1 }]), 'a\nb\n');
  assert.equal(D.applySelection('a\nb', 'a\nb\n', [{ start: 0, end: 0 }]), 'a\nb');
  // Reverting the appended lines restores the original, still without a final newline.
  assert.equal(D.revertSelection(index, work, [{ start: 3, end: 4 }]), index);
});

test('random texts with and without final newlines: selecting everything gives the target', () => {
  let seed = 3;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const text = () => {
    const lines = Array.from({ length: Math.floor(rnd() * 8) }, () => `${Math.floor(rnd() * 4)}`);
    return lines.join('\n') + (lines.length && rnd() < 0.5 ? '\n' : '');
  };
  for (let i = 0; i < 500; i++) {
    const a = text();
    const b = text();
    const n = D.splitLines(b).length + 2;
    assert.equal(D.applySelection(a, b, [{ start: 0, end: n }], 'changes'), b, JSON.stringify({ a, b }));
    assert.equal(D.revertSelection(a, b, [{ start: 0, end: n }], 'changes'), a, JSON.stringify({ a, b }));
  }
});
