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
  'commitCorner.graph', 'commitCorner.worktreesOverview', 'commitCorner.activity', 'commitCorner.summary', 'commitCorner.graphView', 'commitCorner.rebase', 'commitCorner.rebaseTodo', 'commitCorner.branch', 'commitCorner.sync', 'commitCorner.operation', 'commitCorner.blame', 'commitCorner.busy',
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
