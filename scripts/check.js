#!/usr/bin/env node
'use strict';

/**
 * Static checks without third-party tools:
 *   - every .js file parses (node --check)
 *   - package.json menus/keybindings reference declared commands and submenus
 *   - every command id used in source code is declared
 *   - media files referenced by the code exist
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const problems = [];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name.startsWith('.') ? [] : walk(p);
    return [p];
  });
}

const jsFiles = walk(root).filter((f) => f.endsWith('.js'));
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    problems.push(`syntax: ${path.relative(root, f)}: ${e.stderr.toString().trim()}`);
  }
}

const declared = new Set(pkg.contributes.commands.map((c) => c.command));
const submenus = new Set(pkg.contributes.submenus.map((s) => s.id));
for (const [menu, items] of Object.entries(pkg.contributes.menus)) {
  // VS Code keeps only the first contribution of a submenu to a menu (and logs the others).
  const seen = new Set();
  for (const item of items) {
    if (item.submenu && seen.has(item.submenu)) problems.push(`menu ${menu}: submenu ${item.submenu} contributed twice (only the first counts; combine the when clauses)`);
    if (item.submenu) seen.add(item.submenu);
    if (item.submenu && !submenus.has(item.submenu)) problems.push(`menu ${menu}: unknown submenu ${item.submenu}`);
    if (item.command && !declared.has(item.command)) problems.push(`menu ${menu}: unknown command ${item.command}`);
  }
}
// VS Code adds a "<view id>.focus" command for every contributed view.
const viewFocus = new Set(Object.values(pkg.contributes.views).flat().map((v) => `${v.id}.focus`));
for (const kb of pkg.contributes.keybindings || []) if (!declared.has(kb.command) && !viewFocus.has(kb.command)) problems.push(`keybinding: unknown command ${kb.command}`);
// The chords are Cmd+Alt+G on macOS (README): every Ctrl+Alt+G binding needs its mac variant.
for (const kb of pkg.contributes.keybindings || []) {
  if (/^ctrl\+alt\+g\b/i.test(kb.key) && !(kb.mac && /^cmd\+alt\+g\b/i.test(kb.mac))) problems.push(`keybinding ${kb.key} (${kb.command}): no "mac" variant with cmd+alt+g`);
}
// One key, one meaning: no key bound twice under the same when clause; and the chord's second key
// also works with Ctrl+Alt still held (README), for the same command.
const kbs = pkg.contributes.keybindings || [];
for (const prop of ['key', 'mac']) {
  const byKey = new Map();
  for (const kb of kbs.filter((x) => x[prop])) {
    const same = byKey.get(kb[prop]) || [];
    // Two commands on one key clash when their when clauses can hold together: the same, or one always.
    for (const o of same) if (o.command !== kb.command && (!o.when || !kb.when || o.when === kb.when)) problems.push(`keybinding ${kb[prop]}: both ${o.command} [${o.when || ''}] and ${kb.command} [${kb.when || ''}]`);
    byKey.set(kb[prop], [...same, kb]);
  }
  const g = prop === 'key' ? 'ctrl' : 'cmd';
  for (const kb of kbs) {
    // Both ways: "G S" has its "G Ctrl+Alt+S", and "G Ctrl+Alt+S" its "G S" (same command, same when).
    const plainKey = new RegExp(`^${g}\\+alt\\+g (?!${g}\\+alt\\+)(.+)$`).exec(kb[prop] || '');
    const held = new RegExp(`^${g}\\+alt\\+g ${g}\\+alt\\+(?!g$)(.+)$`).exec(kb[prop] || '');
    const twin = plainKey ? `${g}+alt+g ${g}+alt+${plainKey[1]}` : held ? `${g}+alt+g ${held[1]}` : undefined;
    if (twin && !kbs.some((o) => o[prop] === twin && o.command === kb.command && (o.when || '') === (kb.when || ''))) problems.push(`keybinding ${kb[prop]} (${kb.command}): no twin "${twin}"`);
  }
}
// macOS: the same keys with Cmd for Ctrl.
for (const kb of kbs) if (/^ctrl\+alt\+g\b/.test(kb.key) && kb.mac !== kb.key.replace(/ctrl/g, 'cmd')) problems.push(`keybinding ${kb.key} (${kb.command}): mac is "${kb.mac}", not "${kb.key.replace(/ctrl/g, 'cmd')}"`);
// Deleting every review comment is never a one-click icon on a comment (it sits in the … menu, as
// do Copy and Save), nor a button of a comment being edited (comments/comment/context).
for (const menu of ['comments/comment/title', 'comments/commentThread/title', 'comments/commentThread/context']) {
  for (const item of pkg.contributes.menus[menu] || []) if (item.command === 'commitCorner.review.clear' && /^inline/.test(item.group || '')) problems.push(`menu ${menu}: Delete All Review Comments must not be inline`);
}
if ((pkg.contributes.menus['comments/comment/context'] || []).some((i) => i.command === 'commitCorner.review.clear')) problems.push('menu comments/comment/context: no Delete All Review Comments next to Save/Cancel');
for (const id of ['commitCorner.review.copy', 'commitCorner.review.save', 'commitCorner.review.clear']) {
  const item = (pkg.contributes.menus['comments/comment/title'] || []).find((i) => i.command === id && !/^inline/.test(i.group || ''));
  if (!item || !/comment == reviewComment/.test(item.when || '')) problems.push(`menu comments/comment/title: ${id} belongs in each review comment's … menu`);
}

// Shortcuts named in the docs run what the text around them says: one word of the bound
// command's title nearby (a swapped key left in a sentence would name another action).
{
  const titleOf = new Map(pkg.contributes.commands.map((c) => [c.command, c.title]));
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'open', 'show', 'file', 'files', 'commit', 'corner', 'current', 'selected']);
  const words = (s) => s.toLowerCase().replace(/[^a-z]+/g, ' ').split(' ').filter((w) => w.length > 2 && !stop.has(w));
  // Alike: the same first 5 letters, or a whole short word ("checks" / "checkout", "push" /
  // "pushes"; not "commits" / "comment").
  const alike = (a, b) => {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return i >= Math.min(5, a.length, b.length);
  };
  for (const doc of ['README.md', 'media/walkthrough/keyboard.md', 'media/walkthrough/review.md', 'docs/intro/index.html', 'docs/SMOKE_TEST.md']) {
    const text = fs.readFileSync(path.join(root, doc), 'utf8').replace(/<\/?kbd>/g, '');
    for (const m of text.matchAll(/Ctrl\+Alt\+G`? `?((?:Shift\+)?[A-Z])\b/g)) {
      const key = `ctrl+alt+g ${m[1].toLowerCase()}`;
      const cmds = kbs.filter((k) => k.key === key).map((k) => k.command);
      const near = words(text.slice(Math.max(0, m.index - 160), m.index + 100));
      if (!cmds.length) problems.push(`${doc}: Ctrl+Alt+G ${m[1]} is not bound`);
      else if (!cmds.some((c) => words(titleOf.get(c) || '').some((w) => near.some((n) => alike(n, w))))) problems.push(`${doc}: Ctrl+Alt+G ${m[1]} runs "${cmds.map((c) => titleOf.get(c)).join('" / "')}", which the text around it does not name`);
    }
  }
}

// The same property twice in a row (an edit applied twice): legal JavaScript, never meant.
for (const f of jsFiles.filter((p) => p.includes(`${path.sep}src${path.sep}`) || p.includes(`${path.sep}media${path.sep}`))) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const key = (l) => (/^(\s*)([A-Za-z_$][\w$]*)\s*:(?!:)/.exec(l) || [])[0];
  for (let i = 1; i < lines.length; i++) {
    const k = key(lines[i]);
    if (k && !/^\s*(case|default)\b/.test(lines[i]) && k === key(lines[i - 1])) problems.push(`${path.relative(process.cwd(), f)}:${i + 1}: property "${k.trim().slice(0, -1).trim()}" twice in a row`);
  }
}

const used = new Set();
const contextKeys = new Set();
for (const f of jsFiles.filter((p) => p.includes(`${path.sep}src${path.sep}`) || p.includes(`${path.sep}media${path.sep}`))) {
  const text = fs.readFileSync(f, 'utf8');
  for (const m of text.matchAll(/['"`](commitCorner\.[A-Za-z]+(?:\.[A-Za-z]+)?)['"`]/g)) used.add(m[1]);
  for (const m of text.matchAll(/'setContext', '(commitCorner\.[A-Za-z]+)'/g)) contextKeys.add(m[1]);
}
const notCommands = new Set([
  ...pkg.contributes.views.commitCorner.map((v) => v.id),
  // VS Code's own per-view commands (focus, open, hide).
  ...[...pkg.contributes.views.commitCorner].flatMap((v) => ['focus', 'open', 'removeView', 'toggleVisibility'].map((c) => `${v.id}.${c}`)),
  'commitCorner.graph', 'commitCorner.worktreesOverview', 'commitCorner.activity', 'commitCorner.summary', 'commitCorner.graphView', 'commitCorner.rebase', 'commitCorner.rebaseTodo', 'commitCorner.branch', 'commitCorner.sync', 'commitCorner.operation', 'commitCorner.blame', 'commitCorner.busy', 'commitCorner.review',
  ...[].concat(pkg.contributes.configuration).flatMap((c) => Object.keys(c.properties)),
  ...contextKeys,
]);
for (const id of used) {
  if (!declared.has(id) && !notCommands.has(id) && !id.startsWith('commitCorner.blame.') && !id.startsWith('commitCorner.graph.')) problems.push(`code references undeclared command ${id}`);
}
for (const icon of [pkg.icon, ...pkg.contributes.viewsContainers.activitybar.map((a) => a.icon)].filter(Boolean)) {
  if (!fs.existsSync(path.join(root, icon))) problems.push(`missing file ${icon}`);
}

if (problems.length) {
  process.stderr.write(problems.map((p) => `✗ ${p}`).join('\n') + '\n');
  process.exit(1);
}
process.stdout.write(`✓ ${jsFiles.length} files parse, ${declared.size} commands consistent\n`);
