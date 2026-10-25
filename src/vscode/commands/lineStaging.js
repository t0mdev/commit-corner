'use strict';

const vscode = require('vscode');
const notify = require('../notify');
const { INDEX } = require('../../git/repository');
const { applySelection, revertSelection, mapRangesToFrom, eolOf, withEol, DiffTooLargeError } = require('../../git/lineDiff');
const { SCHEME, fromGitUri } = require('../uri');

/**
 * Stage / unstage / discard individual lines or changes from any editor:
 * the plain file editor, either side of a diff editor, or the quick-diff
 * peek in the gutter.
 */

/** Editor selections -> inclusive 0-based line ranges. A selection ending at column 0 excludes that line. */
function selectionRanges(editor) {
  return editor.selections.map((s) => {
    let end = s.end.line;
    if (s.end.character === 0 && end > s.start.line) end--;
    return { start: s.start.line, end };
  });
}

/** Ranges from quick-diff peek arguments (uri, LineChange[], index). */
function peekRanges(changes, index) {
  const c = changes[index];
  if (!c) return undefined;
  const start = Math.max(0, c.modifiedStartLineNumber - 1);
  // modifiedEndLineNumber is 0 for pure deletions
  const end = c.modifiedEndLineNumber > 0 ? c.modifiedEndLineNumber - 1 : start;
  return [{ start, end }];
}

const BOM = '\ufeff';

/**
 * Texts from git (index/HEAD blobs) and from the editor can differ in ways
 * that are not changes: line endings (core.autocrlf, eol=crlf) and a UTF-8
 * BOM. Compare like with like, then write back in the destination's form.
 */
function blobText(buf) {
  const text = buf === null ? '' : buf;
  return text.startsWith(BOM) ? { text: text.slice(1), bom: true } : { text, bom: false };
}

/** Refuse documents whose text cannot be round-tripped through UTF-8 blobs. */
function checkEncoding(document) {
  const enc = document.encoding;
  if (enc && !/^utf-?8(bom)?$/i.test(enc)) {
    throw new Error(`Line staging supports UTF-8 files only (this file is ${enc}). Stage the whole file instead.`);
  }
}

function guard(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof DiffTooLargeError) {
        notify.warn(e.message);
        return undefined;
      }
      throw e;
    }
  };
}

/** @param {import('../context').Context} ctx */
function register(ctx) {
  const { manager } = ctx;
  const cmd = ctx.command;

  /**
   * Resolve the target of a line command.
   * @returns {Promise<{repo, rel:string, editor?:vscode.TextEditor, document:vscode.TextDocument, side:'worktree'|'index', ranges:{start:number,end:number}[]}|undefined>}
   */
  /** Line staging writes stage 0, which would silently resolve a conflict with partial content. */
  async function refuseConflict(t) {
    const s = t.repo.state || (await t.repo.refreshState());
    if (s.conflicts.some((e) => e.path === t.rel)) {
      notify.warn(`"${t.rel}" has merge conflicts. Resolve them (merge editor or accept ours/theirs) before staging lines.`);
      return true;
    }
    return false;
  }

  async function target(args) {
    let uri;
    let ranges;
    let fromPeek = false;
    if (args[0] instanceof vscode.Uri && Array.isArray(args[1])) {
      uri = args[0];
      ranges = peekRanges(args[1], args[2]);
      fromPeek = true;
    }
    const editor = vscode.window.activeTextEditor;
    if (!uri) {
      if (!editor) return undefined;
      uri = editor.document.uri;
      ranges = selectionRanges(editor);
    }
    let document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (!document) document = await vscode.workspace.openTextDocument(uri);
    if (uri.scheme === 'file') {
      const repo = manager.getRepositoryForUri(uri);
      if (!repo) return undefined;
      return { repo, rel: repo.relative(uri.fsPath), document, side: 'worktree', ranges, fromPeek };
    }
    if (uri.scheme === SCHEME) {
      const q = fromGitUri(uri);
      const repo = manager.getRepository(q.repo);
      if (!repo || q.ref !== INDEX) {
        notify.info('Select lines in the working file or in the staged (Index) side of a diff.');
        return undefined;
      }
      return { repo, rel: q.path, document, side: 'index', ranges, fromPeek };
    }
    return undefined;
  }

  /** git-lfs, git-crypt & co. store something else in the index than the working tree shows. */
  async function refuseFiltered(t) {
    if (!(await t.repo.hasFilter(t.rel))) return false;
    notify.warn(`"${t.rel}" is handled by a git filter (e.g. Git LFS), so its staged form differs from what you see. Stage the whole file instead.`);
    return true;
  }

  async function stage(args, granularity) {
    const t = await target(args);
    if (!t || (await refuseConflict(t)) || (await refuseFiltered(t))) return;
    if (t.side !== 'worktree') {
      notify.info('Staging works from the working tree file. To edit staged content directly, edit the Index side and save.');
      return;
    }
    checkEncoding(t.document);
    // Read, combine and write inside the write queue, so quick successive stages never lose lines.
    await t.repo.locked(() => stageLocked(t, granularity));
  }

  async function stageLocked(t, granularity) {
    const rawIndex = await t.repo.showText(INDEX, t.rel);
    const exists = rawIndex !== null;
    const index = blobText(rawIndex);
    // Compare in the index's line-ending convention (a new file keeps the editor's).
    const workText = exists ? withEol(t.document.getText(), eolOf(index.text, eolOf(t.document.getText()))) : t.document.getText();
    const next = applySelection(index.text, workText, t.ranges, t.fromPeek ? 'changes' : granularity);
    if (next === index.text && exists) {
      vscode.window.setStatusBarMessage('Commit Corner: no unstaged changes in the selection', 3000);
      return;
    }
    // Derived from the staged blob: store as is (filters would rewrite e.g. CRLF lines the user never touched).
    await t.repo.writeIndexContent(t.rel, (index.bom ? BOM : '') + next, undefined, { inQueue: true, asIs: exists });
  }

  async function unstage(args, granularity) {
    const t = await target(args);
    if (!t || (await refuseConflict(t)) || (await refuseFiltered(t))) return;
    checkEncoding(t.document);
    await t.repo.locked(() => unstageLocked(t, granularity));
  }

  async function unstageLocked(t, granularity) {
    // For a staged rename, HEAD has the file under its old name.
    const st = t.repo.state && t.repo.state.staged.find((e) => e.path === t.rel);
    const rawHead = await t.repo.showText('HEAD', (st && st.origPath) || t.rel);
    const head = blobText(rawHead);
    const rawIndex = await t.repo.showText(INDEX, t.rel);
    if (rawIndex === null) return;
    const index = blobText(rawIndex);
    let ranges = t.ranges;
    if (t.side === 'worktree') {
      // Selection is in working-tree coordinates; translate into index coordinates.
      const work = withEol(t.document.getText(), eolOf(index.text));
      ranges = mapRangesToFrom(index.text, work, ranges);
    }
    const next = revertSelection(withEol(head.text, eolOf(index.text, eolOf(head.text))), index.text, ranges, t.fromPeek ? 'changes' : granularity);
    if (next === index.text) {
      vscode.window.setStatusBarMessage('Commit Corner: no staged changes in the selection', 3000);
      return;
    }
    if (rawHead === null && next === '') {
      // Everything of a newly added file unstaged: the file is no longer staged at all.
      await t.repo.exec(['rm', '--cached', '-q', '--', `:(literal)${t.rel}`], { writes: true });
      return;
    }
    await t.repo.writeIndexContent(t.rel, (index.bom ? BOM : '') + next, undefined, { inQueue: true, asIs: true });
  }

  async function revert(args, granularity) {
    const t = await target(args);
    // Like staging: a conflicted file has no single index version, and a filtered one (LFS,
    // git-crypt) stores something else there than the text in the editor.
    if (!t || (await refuseConflict(t)) || (await refuseFiltered(t))) return;
    if (t.side !== 'worktree') return;
    checkEncoding(t.document);
    const rawIndex = await t.repo.showText(INDEX, t.rel);
    if (rawIndex === null) {
      notify.info('The file is untracked; there is no staged version to revert to.');
      return;
    }
    const doc = t.document;
    const workText = doc.getText();
    // Bring the index text into the editor's line-ending convention; the result goes into the editor.
    const indexText = withEol(blobText(rawIndex).text, eolOf(workText, eolOf(rawIndex)));
    const next = revertSelection(indexText, workText, t.ranges, t.fromPeek ? 'changes' : granularity);
    if (next === workText) return;
    const wasDirty = doc.isDirty;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(workText.length)), next);
    await vscode.workspace.applyEdit(edit);
    if (!wasDirty) await doc.save();
  }

  cmd('commitCorner.stageSelectedRanges', guard((...a) => stage(a, 'lines')));
  cmd('commitCorner.stageChange', guard((...a) => stage(a, 'changes')));
  cmd('commitCorner.unstageSelectedRanges', guard((...a) => unstage(a, 'lines')));
  cmd('commitCorner.unstageChange', guard((...a) => unstage(a, 'changes')));
  cmd('commitCorner.revertSelectedRanges', guard((...a) => revert(a, 'lines')));
  cmd('commitCorner.revertChange', guard((...a) => revert(a, 'changes')));
}

module.exports = { register, selectionRanges, peekRanges };
