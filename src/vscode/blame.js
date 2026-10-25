'use strict';

const vscode = require('vscode');
const { SCHEME, fromGitUri } = require('./uri');
const { builtInGitEnabled } = require('./scm');
const { tinyAge } = require('./util');
const { config, debounce, formatDate, absoluteDate, shortSha, escapeMarkdown, commandLink, log, escapeIcons } = require('./util');

const TRUSTED_COMMANDS = ['commitCorner.showCommit', 'commitCorner.openCommitFile', 'commitCorner.copySha', 'commitCorner.showGraph', 'commitCorner.openCommitOnGitHub', 'commitCorner.blamePrevious', 'commitCorner.openPullRequestOnGitHub'];
const { pullRequestOfSubject } = require('../git/remoteUrl');
const HEAT_LEVELS = 10;
const { openAtRevision } = require('./diffs');

/**
 * Blame annotations:
 *  - current line: author, date and subject after the end of the cursor line,
 *    with a rich hover (also in the status bar);
 *  - file blame: toggled per editor, a gutter column with commit, author and
 *    date for every block of lines, coloured by age (heatmap).
 * Unsaved edits are blamed as "uncommitted" via `git blame --contents -`.
 */
class BlameController {
  /** @param {import('./model').RepositoryManager} manager */
  constructor(manager) {
    this.manager = manager;
    /** uri -> {version, promise} */
    this.cache = new Map();
    /** repo root -> HEAD sha the cache was built for */
    this.heads = new Map();
    /** uris with file blame on */
    this.fileBlame = new Set();
    this.lineDecoration = vscode.window.createTextEditorDecorationType({
      after: { margin: '0 0 0 3em', color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'normal' },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
    });
    this.gutterTypes = [];
    for (let i = 0; i < HEAT_LEVELS; i++) {
      // Newest = warm and opaque, oldest = cool and faint. rgba works in light and dark themes.
      const t = i / (HEAT_LEVELS - 1);
      const r = Math.round(255 * (1 - t) + 70 * t);
      const g = Math.round(140 * (1 - t) + 130 * t);
      const b = Math.round(0 * (1 - t) + 220 * t);
      const alpha = (0.9 - 0.6 * t).toFixed(2);
      this.gutterTypes.push(vscode.window.createTextEditorDecorationType({
        before: {
          color: new vscode.ThemeColor('editorLineNumber.foreground'),
          margin: '0 1.5em 0 0',
          border: `0 solid rgba(${r},${g},${b},${alpha})`,
          textDecoration: 'none; border-left-width: 3px; padding-left: 4px; white-space: pre; font-style: normal',
        },
      }));
    }
    this.statusItem = vscode.window.createStatusBarItem('commitCorner.blame', vscode.StatusBarAlignment.Right, 200);
    this.statusItem.name = 'Commit Corner Blame';
    const update = debounce(() => this.updateCurrentLine(), 120);
    // While typing, wait for a pause before re-blaming the unsaved text.
    const updateAfterEdit = debounce(() => this.updateCurrentLine(), config().get('blame.delayAfterEdit', 1000));
    this.disposables = [
      this.lineDecoration,
      ...this.gutterTypes,
      this.statusItem,
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) update();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        update();
        this.updateContext();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!e.contentChanges.length) return;
        const key = e.document.uri.toString();
        // Stop work on the outdated text right away.
        const pending = this.cache.get(key);
        if (pending && pending.controller) pending.controller.abort();
        this.cache.delete(key);
        if (this.fileBlame.has(key)) this.scheduleFileBlame(e.document);
        const ed = vscode.window.activeTextEditor;
        if (ed && ed.document === e.document) ed.setDecorations(this.lineDecoration, []);
        updateAfterEdit();
      }),
      vscode.workspace.onDidCloseTextDocument((d) => {
        this.cache.delete(d.uri.toString());
        this.fileBlame.delete(d.uri.toString());
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderFileBlames()),
      manager.onDidChangeState((repo) => {
        // Only a moved HEAD (commit, checkout, reset…) invalidates blame of unchanged documents.
        const head = repo.state && repo.state.head.sha;
        if (this.heads.get(repo.root) === head) return;
        this.heads.set(repo.root, head);
        this.cache.clear();
        update();
        this.renderFileBlames();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('commitCorner.blame')) update();
      }),
    ];
    this.fileBlameTimers = new Map();
    update();
  }

  /**
   * Blame for a document, cached per document version. Works for working
   * files (unsaved text included) and for files opened at a revision.
   */
  getBlame(document) {
    const key = document.uri.toString();
    const hit = this.cache.get(key);
    if (hit && hit.version === document.version) return hit.promise;
    if (hit && hit.controller) hit.controller.abort();
    const target = this.target(document);
    if (!target) return Promise.resolve(undefined);
    if (document.lineCount > config().get('blame.maxLines', 20000)) return Promise.resolve(undefined);
    const { repo, rel, rev } = target;
    const controller = new AbortController();
    const promise = repo.blame(rel, !rev && document.isDirty ? document.getText() : undefined, {
      rev,
      signal: controller.signal,
      ignoreWhitespace: config().get('blame.ignoreWhitespace', false),
      detectCopies: config().get('blame.detectMovedLines', false),
    })
      .then((b) => ({ ...b, repo, rel, rev }))
      .catch((e) => {
        log().debug(`blame ${rel}: ${e.message}`);
        return undefined;
      });
    this.cache.set(key, { version: document.version, promise, controller });
    return promise;
  }

  /** What to blame for a document: a working file, or a file at a fixed revision. */
  target(document) {
    const uri = document.uri;
    if (uri.scheme === 'file') {
      const repo = this.manager.getRepositoryForUri(uri);
      if (!repo) return undefined;
      const rel = repo.relative(uri.fsPath);
      if (repo.state && repo.state.untracked.some((e) => e.path === rel)) return undefined;
      return { repo, rel };
    }
    if (uri.scheme === SCHEME) {
      const q = fromGitUri(uri);
      const repo = this.manager.getRepository(q.repo);
      if (!repo || q.empty || !q.ref || q.ref.startsWith(':')) return undefined;
      return { repo, rel: q.path, rev: q.ref };
    }
    return undefined;
  }

  async updateCurrentLine() {
    const editor = vscode.window.activeTextEditor;
    // The built-in Git shows its own blame where it is on: never two of the same.
    const builtIn = builtInGitEnabled() ? vscode.workspace.getConfiguration('git.blame', null) : undefined;
    const inline = config().get('blame.currentLine', true) && !(builtIn && builtIn.get('editorDecoration.enabled', false));
    const inStatus = config().get('blame.statusBar', true) && !(builtIn && builtIn.get('statusBarItem.enabled', false));
    if (!editor || !this.target(editor.document) || (!inline && !inStatus)) {
      if (editor) editor.setDecorations(this.lineDecoration, []);
      this.statusItem.hide();
      return;
    }
    const doc = editor.document;
    if (!editor.selection) return; // not a text editor we can follow (yet)
    const version = doc.version;
    const line = editor.selection.active.line;
    const blame = await this.getBlame(doc);
    if (editor !== vscode.window.activeTextEditor || doc.version !== version || editor.selection.active.line !== line) return;
    if (!blame || !blame.lines[line]) {
      editor.setDecorations(this.lineDecoration, []);
      this.statusItem.hide();
      return;
    }
    const c = blame.commits.get(blame.lines[line]);
    const text = c.uncommitted ? 'You • Uncommitted changes' : `${c.author}, ${formatDate(c.authorTime)} • ${c.summary}`;
    const hover = this.hover(blame, c, line);
    if (inline && !this.fileBlame.has(doc.uri.toString())) {
      const end = doc.lineAt(line).range.end;
      editor.setDecorations(this.lineDecoration, [{
        range: new vscode.Range(end, end),
        hoverMessage: hover,
        renderOptions: { after: { contentText: truncate(text, config().get('blame.maxLength', 90)) } },
      }]);
    } else editor.setDecorations(this.lineDecoration, []);
    if (inStatus) {
      this.statusItem.text = c.uncommitted ? '$(git-commit) Uncommitted' : `$(git-commit) ${escapeIcons(c.author)}, ${formatDate(c.authorTime)}`;
      this.statusItem.tooltip = hover;
      this.statusItem.command = c.uncommitted ? undefined : { command: 'commitCorner.showCommit', title: 'Show Commit', arguments: [{ repoRoot: blame.repo.root, sha: c.sha }] };
      this.statusItem.show();
    } else this.statusItem.hide();
  }

  hover(blame, c, line) {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: TRUSTED_COMMANDS };
    md.supportThemeIcons = true;
    if (c.uncommitted) {
      md.appendMarkdown('$(edit) **Uncommitted changes**');
      return md;
    }
    const node = { repoRoot: blame.repo.root, sha: c.sha };
    md.appendMarkdown(`$(git-commit) \`${shortSha(c.sha)}\` **${escapeMarkdown(c.author)}** ${escapeMarkdown(c.authorMail ? `<${c.authorMail}>` : '')}  \n`);
    md.appendMarkdown(`${escapeMarkdown(absoluteDate(c.authorTime))} (${escapeMarkdown(formatDate(c.authorTime))})\n\n`);
    md.appendMarkdown(`${escapeMarkdown(c.summary)}\n\n---\n\n`);
    const links = [
      commandLink('$(diff) Show commit', 'commitCorner.showCommit', node),
      commandLink('$(file-code) Changes to this file', 'commitCorner.openCommitFile', {
        repoRoot: blame.repo.root, sha: c.sha, parent: c.previous || null, leftRef: c.previous ? c.previous : null, path: c.filename, origPath: c.previousFilename || c.filename, status: c.previous ? 'M' : 'A',
      }),
      commandLink('$(git-merge) Show in graph', 'commitCorner.showGraph', { repoRoot: blame.repo.root, revealSha: c.sha }),
      ...(c.previous ? [commandLink('$(history) Blame before this change', 'commitCorner.blamePrevious', { repoRoot: blame.repo.root, sha: c.previous, path: c.previousFilename || c.filename, line: blame.sourceLines ? blame.sourceLines[line] : line })] : []),
      commandLink('$(copy) Copy SHA', 'commitCorner.copySha', node),
    ];
    // The pull request this line came in with, when the subject names one.
    const pr = pullRequestOfSubject(c.summary);
    if (pr) links.splice(1, 0, commandLink(`$(git-pull-request) Pull request #${pr}`, 'commitCorner.openPullRequestOnGitHub', { repoRoot: blame.repo.root, number: pr }));
    md.appendMarkdown(links.join(' &nbsp;|&nbsp; '));
    return md;
  }

  // ---- file blame (gutter) -------------------------------------------------

  updateContext() {
    const editor = vscode.window.activeTextEditor;
    vscode.commands.executeCommand('setContext', 'commitCorner.fileBlameActive', !!editor && this.fileBlame.has(editor.document.uri.toString()));
  }

  toggleFileBlame(editor) {
    if (!editor) return;
    const key = editor.document.uri.toString();
    if (this.fileBlame.has(key)) {
      this.fileBlame.delete(key);
      for (const t of this.gutterTypes) editor.setDecorations(t, []);
    } else {
      this.fileBlame.add(key);
      this.renderFileBlame(editor);
    }
    this.updateContext();
    this.updateCurrentLine();
  }

  scheduleFileBlame(document) {
    const key = document.uri.toString();
    clearTimeout(this.fileBlameTimers.get(key));
    this.fileBlameTimers.set(key, setTimeout(() => {
      for (const ed of vscode.window.visibleTextEditors) if (ed.document === document) this.renderFileBlame(ed);
    }, 400));
  }

  renderFileBlames() {
    for (const ed of vscode.window.visibleTextEditors) {
      if (this.fileBlame.has(ed.document.uri.toString())) this.renderFileBlame(ed);
    }
  }

  async renderFileBlame(editor) {
    const doc = editor.document;
    const blame = await this.getBlame(doc);
    if (!blame) {
      vscode.window.setStatusBarMessage('Commit Corner: no blame information for this file', 3000);
      return;
    }
    // Age ranking: newest commits are "hot".
    const times = [...new Set([...blame.commits.values()].filter((c) => !c.uncommitted).map((c) => c.authorTime))].sort((a, b) => b - a);
    const rank = new Map(times.map((t, i) => [t, times.length > 1 ? Math.floor((i / (times.length - 1)) * (HEAT_LEVELS - 1)) : 0]));
    const authorWidth = 14;
    const perLevel = this.gutterTypes.map(() => []);
    let prev;
    for (let line = 0; line < doc.lineCount; line++) {
      const sha = blame.lines[line];
      if (!sha) continue;
      const c = blame.commits.get(sha);
      const first = sha !== prev;
      prev = sha;
      // When and who first, like every other history list (the date itself is in the hover).
      const width = 3 + 2 + authorWidth + 2 + 7;
      let text;
      if (!first) text = ' '.repeat(width);
      else if (c.uncommitted) text = pad('Uncommitted', width);
      else text = `${tinyAge(c.authorTime)}  ${pad(truncate(c.author, authorWidth), authorWidth)}  ${shortSha(c.sha)}`;
      const level = c.uncommitted ? 0 : rank.get(c.authorTime) || 0;
      perLevel[level].push({
        range: new vscode.Range(line, 0, line, 0),
        hoverMessage: first ? this.hover(blame, c, line) : undefined,
        renderOptions: { before: { contentText: text.replace(/ /g, ' ') } },
      });
    }
    this.gutterTypes.forEach((t, i) => editor.setDecorations(t, perLevel[i]));
  }

  dispose() {
    for (const t of this.fileBlameTimers.values()) clearTimeout(t);
    this.disposables.forEach((d) => d.dispose());
  }
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function pad(s, n) {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/** @param {import('./context').Context} ctx */
function register(ctx) {
  const blame = new BlameController(ctx.manager);
  ctx.command('commitCorner.toggleFileBlame', () => blame.toggleFileBlame(vscode.window.activeTextEditor));
  // Step back in time: open the file as it was before the blamed commit, with file blame on.
  /** Blame info of the cursor line in the active editor. */
  async function cursorBlame() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const b = await blame.getBlame(editor.document);
    const line = editor.selection.active.line;
    const sha = b && b.lines[line];
    return sha ? { b, line, c: b.commits.get(sha) } : undefined;
  }

  ctx.command('commitCorner.showLineCommit', async () => {
    const hit = await cursorBlame();
    if (!hit || hit.c.uncommitted) {
      // No hit: a line git does not blame (the empty last line after the final newline, or no file).
      vscode.window.setStatusBarMessage(hit ? 'Commit Corner: this line is not committed yet' : 'Commit Corner: no commit for this line', 3000);
      return;
    }
    await vscode.commands.executeCommand('commitCorner.showCommit', { repoRoot: hit.b.repo.root, sha: hit.c.sha });
  });

  ctx.command('commitCorner.blamePrevious', async (arg) => {
    if (!arg || !arg.sha) {
      // From the keyboard: the cursor line's commit, one step back.
      const hit = await cursorBlame();
      if (!hit || hit.c.uncommitted || !hit.c.previous) {
        vscode.window.setStatusBarMessage('Commit Corner: no earlier version of this line', 3000);
        return;
      }
      arg = { repoRoot: hit.b.repo.root, sha: hit.c.previous, path: hit.c.previousFilename || hit.c.filename, line: hit.b.sourceLines ? hit.b.sourceLines[hit.line] : hit.line };
    }
    const repo = ctx.manager.getRepository(arg && arg.repoRoot);
    if (!repo || !arg.sha) return;
    // One preview tab for the whole walk back in time (each step replaces the last), and a line
    // that exists in that version (the change being looked behind may have shortened the file).
    const editor = await openAtRevision(repo, arg.sha, arg.path, { preview: true });
    if (!editor) return;
    const line = Math.min(Math.max(0, arg.line || 0), Math.max(0, editor.document.lineCount - 1));
    editor.selection = new vscode.Selection(line, 0, line, 0);
    editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (!blame.fileBlame.has(editor.document.uri.toString())) blame.toggleFileBlame(editor);
  });
  ctx.command('commitCorner.toggleLineBlame', async () => {
    const c = config();
    await c.update('blame.currentLine', !c.get('blame.currentLine', true), vscode.ConfigurationTarget.Global);
  });
  return blame;
}

module.exports = { register, BlameController };
