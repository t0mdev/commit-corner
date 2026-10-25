#!/usr/bin/env node
'use strict';
/*
 * GIT_SEQUENCE_EDITOR for interactive rebases started by Commit Corner.
 *
 *   sequence-editor.js <prepared-todo> <git-todo>
 *
 * The prepared todo is the plan from the UI (order, actions, exec lines for
 * new messages). Rather than overwriting git's todo blindly, we keep git in
 * charge of *which* commits are in the rebase: commits git left out (already
 * upstream) are dropped from the plan, and git's `update-ref` lines are kept
 * after the commit they followed.
 */
const fs = require('fs');

const [prepared, target] = process.argv.slice(2);
if (!prepared || !target) {
  process.stderr.write('usage: sequence-editor.js <prepared-todo> <git-todo>\n');
  process.exit(2);
}

const COMMIT = /^(pick|p|reword|r|edit|e|squash|s|fixup|f|drop|d)\s+(?:-[cC]\s+)?([0-9a-f]{4,64})\b/;
const gitLines = fs.readFileSync(target, 'utf8').split('\n').map((l) => l.replace(/\r$/, ''));
const gitShas = [];
const updateRefsAfter = new Map(); // sha prefix -> [update-ref lines]
let lastSha = null;
for (const line of gitLines) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const m = COMMIT.exec(t);
  if (m) {
    gitShas.push(m[2]);
    lastSha = m[2];
  } else if (/^(update-ref|u)\s/.test(t) && lastSha) {
    if (!updateRefsAfter.has(lastSha)) updateRefsAfter.set(lastSha, []);
    updateRefsAfter.get(lastSha).push(t);
  }
}
const known = (sha) => gitShas.find((g) => sha.startsWith(g) || g.startsWith(sha));

// Fail closed: a commit git wants to rebase but the plan does not mention would be lost.
// Exiting non-zero makes git abort the rebase without touching anything.
const planShas = [];
for (const line of fs.readFileSync(prepared, 'utf8').split('\n')) {
  const m = COMMIT.exec(line.trim());
  if (m) planShas.push(m[2]);
}
const missing = gitShas.filter((g) => !planShas.some((p) => p.startsWith(g) || g.startsWith(p)));
if (missing.length) {
  process.stderr.write(`Commit Corner: the rebase plan does not cover ${missing.length} commit(s) git would rebase (${missing.slice(0, 5).join(', ')}); aborting so nothing is lost.\n`);
  process.exit(1);
}

const out = [];
let skipExecs = false;
for (const line of fs.readFileSync(prepared, 'utf8').split('\n')) {
  const t = line.trim();
  if (!t) continue;
  const m = COMMIT.exec(t);
  if (m) {
    const g = known(m[2]);
    // git decided this commit is not part of the rebase (e.g. already upstream): leave it out,
    // together with the exec lines that belong to it.
    skipExecs = !g;
    if (!g) continue;
    out.push(t);
    for (const u of updateRefsAfter.get(g) || []) out.push(u);
  } else if (/^(exec|x)\s/.test(t)) {
    if (!skipExecs) out.push(t);
  } else out.push(t);
}
fs.writeFileSync(target, out.length ? `${out.join('\n')}\n` : 'noop\n');
