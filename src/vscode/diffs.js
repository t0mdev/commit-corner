'use strict';

const vscode = require('vscode');
const notify = require('./notify');
const path = require('path');
const fs = require('fs');
const { toGitUri, emptyUri } = require('./uri');
const { INDEX, WORKTREE } = require('../git/repository');
const { shortSha, log, escapeIcons } = require('./util');

/**
 * Helpers to open VS Code's native diff editors (single and multi-file) for
 * any two revisions of a file. Using the native editors means syntax
 * highlighting, inline/side-by-side, word diff, and language features all
 * work exactly as they do for regular files.
 */

/** URI for a file at a revision. ref null = file does not exist there. */
function uriAt(repo, ref, relPath, extra) {
  if (ref === null || ref === undefined || relPath === null || relPath === undefined) return emptyUri(repo.root, relPath || '');
  if (ref === WORKTREE) {
    // A submodule's working tree is a folder; diff it as "Subproject commit …" text (the git
    // layer decides whether it really is one of ours). A symlink is shown as a file, never followed.
    const abs = repo.absolute(relPath);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch { /* missing */ }
    if (st && st.isDirectory() && !st.isSymbolicLink()) return toGitUri(repo.root, relPath, WORKTREE);
    return vscode.Uri.file(abs);
  }
  return toGitUri(repo.root, relPath, ref, extra);
}

function refLabel(ref) {
  if (ref === null || ref === undefined) return 'none';
  if (ref === INDEX) return 'Index';
  if (ref === WORKTREE) return 'Working Tree';
  if (/^:[1-3]$/.test(ref)) return ['', 'Base', 'Ours', 'Theirs'][+ref[1]];
  const m = /^([0-9a-f]{40,64})(.*)$/.exec(ref);
  if (m) return shortSha(m[1]) + m[2];
  return ref;
}

/**
 * @param {import('../git/repository').Repository} repo
 * @param {{leftRef:string|null, leftPath?:string|null, rightRef:string|null, rightPath?:string|null, path:string, title?:string, preview?:boolean, selection?:vscode.Range}} o
 */
async function openDiff(repo, o) {
  const leftPath = o.leftPath === undefined ? o.path : o.leftPath;
  const rightPath = o.rightPath === undefined ? o.path : o.rightPath;
  const extra = o.anchor ? { anchor: o.anchor } : undefined;
  const left = uriAt(repo, o.leftRef, leftPath, extra);
  const right = uriAt(repo, o.rightRef, rightPath, extra);
  const name = path.posix.basename(o.path);
  const title = o.title || `${name} (${refLabel(o.leftRef)} ↔ ${refLabel(o.rightRef)})`;
  const options = { preview: o.preview !== false, preserveFocus: !!o.preserveFocus };
  if (o.selection) options.selection = o.selection;
  await vscode.commands.executeCommand('vscode.diff', left, right, title, options);
}

/** Open a file as it was at a revision (read-only). */
async function openAtRevision(repo, ref, relPath, opts = {}) {
  const uri = uriAt(repo, ref, relPath);
  const doc = await vscode.workspace.openTextDocument(uri);
  return vscode.window.showTextDocument(doc, { preview: opts.preview !== false, selection: opts.selection });
}

/**
 * Open many file diffs in VS Code's multi-diff editor.
 * @param {import('../git/repository').Repository} repo
 * @param {string} title
 * @param {{path:string, leftRef:string|null, leftPath?:string|null, rightRef:string|null, rightPath?:string|null}[]} files
 */
async function openMultiDiff(repo, title, files) {
  if (!files.length) {
    notify.info('No changes.');
    return;
  }
  const resources = files.map((f) => {
    const leftPath = f.leftPath === undefined ? f.path : f.leftPath;
    const rightPath = f.rightPath === undefined ? f.path : f.rightPath;
    return [
      vscode.Uri.file(repo.absolute(f.path)),
      f.leftRef === null ? undefined : uriAt(repo, f.leftRef, leftPath, f.leftLabel ? { label: f.leftLabel } : undefined),
      f.rightRef === null ? undefined : uriAt(repo, f.rightRef, rightPath, f.rightLabel ? { label: f.rightLabel } : undefined),
    ];
  });
  try {
    await vscode.commands.executeCommand('vscode.changes', title, resources);
  } catch (e) {
    // Very old VS Code without the multi-diff editor: fall back to a picker.
    log().warn(`vscode.changes unavailable (${e.message}); falling back to a file picker`);
    const pick = await vscode.window.showQuickPick(files.map((f) => ({ label: escapeIcons(f.path), f })), { placeHolder: title });
    if (pick) await openDiff(repo, pick.f);
  }
}

module.exports = { uriAt, refLabel, openDiff, openAtRevision, openMultiDiff };
