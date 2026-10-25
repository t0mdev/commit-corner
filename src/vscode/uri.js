'use strict';

const vscode = require('vscode');
const path = require('path');

/**
 * URIs for file contents at a git revision, served by GitFileSystemProvider.
 *
 * The URI path is the file's real absolute path so VS Code picks the right
 * language (syntax highlighting, language features) and a sensible tab label.
 * The query carries the repository, repo-relative path and ref.
 */
const SCHEME = 'commitcorner';

/**
 * @param {string} repoRoot absolute repository root
 * @param {string} relPath repository-relative path (forward slashes)
 * @param {string|null} ref commit-ish, ':' for the index, ':1'..':3' for conflict stages; null = empty document
 */
function toGitUri(repoRoot, relPath, ref, extra) {
  // `extra.root`: show the file under another folder (a linked worktree's), so a diff against
  // that worktree's file pairs one resource, not a rename.
  const abs = path.join((extra && extra.root) || repoRoot, ...relPath.split('/'));
  const query = ref === null ? { repo: repoRoot, path: relPath, ref: '', empty: true } : { repo: repoRoot, path: relPath, ref };
  // Shown in the tab ("engine.js (6861c1c)") by the resourceLabelFormatter in package.json.
  query.rev = (extra && extra.label) || revLabel(ref);
  // `anchor`: the file's current path, so history navigation can follow it across renames.
  if (extra && extra.anchor) query.anchor = extra.anchor;
  return vscode.Uri.file(abs).with({ scheme: SCHEME, query: JSON.stringify(query) });
}

/** Short name of a revision for labels: 7-character SHAs, "index", "ours", … */
function revLabel(ref) {
  if (ref === null || ref === '') return 'none';
  if (ref === ':' || ref === ':0') return 'index';
  if (ref === '~worktree~') return 'working tree';
  if (/^:[1-3]$/.test(ref)) return ['', 'base', 'ours', 'theirs'][+ref[1]];
  const m = /^([0-9a-f]{40,64})(.*)$/.exec(ref);
  // "/" would split the label (the tab shows the part after the last one).
  return (m ? m[1].slice(0, 7) + m[2] : ref).replace(/\//g, '\u2215');
}

/** @returns {{repo:string, path:string, ref:string, empty?:boolean}} */
function fromGitUri(uri) {
  try {
    return JSON.parse(uri.query);
  } catch {
    throw new Error(`Malformed ${SCHEME} URI: ${uri.toString()}`);
  }
}

/** A document for "the file did not exist here" (left side of an added file, etc.). */
function emptyUri(repoRoot, relPath) {
  return toGitUri(repoRoot, relPath, null);
}

/**
 * Refs whose content can never change: full SHAs, optionally with ^/~
 * suffixes. (Short hex strings could be branch names such as "cafebabe".)
 */
function isImmutableRef(ref) {
  return /^([0-9a-f]{40}|[0-9a-f]{64})([~^]\d*)*$/.test(ref);
}

module.exports = { SCHEME, toGitUri, fromGitUri, emptyUri, isImmutableRef, revLabel };
