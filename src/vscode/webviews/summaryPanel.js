'use strict';

const vscode = require('vscode');
const { webviewHtml } = require('./html');
const { showError, closeStaleWebviewTabs, log } = require('../util');
const ai = require('../ai');

const VIEW_TYPE = 'commitCorner.summary';

/**
 * Summary of changes (a worktree's work vs its base, a pull request, selected commits), written
 * by a language model while you watch. One page per subject (Summarize the same worktree again
 * and its page comes back; another subject gets a page of its own). The answer is shown as text
 * with a little Markdown (headings, lists, code), built with DOM calls.
 */
class SummaryPanel {
  /**
   * @param {import('../context').Context} ctx
   * @param {import('../ai').SummarySource} source
   */
  static async show(ctx, source) {
    const key = source.key || source.title; // the repository and the subject
    // One page per subject: a second call while it is being created waits for it.
    if (!SummaryPanel.creating.has(key)) {
      SummaryPanel.creating.set(key, (async () => {
        if (SummaryPanel.panels.has(key)) return SummaryPanel.panels.get(key);
        if (!SummaryPanel.panels.size) await closeStaleWebviewTabs(VIEW_TYPE); // pages left from an earlier session
        const panel = vscode.window.createWebviewPanel(VIEW_TYPE, `Summary: ${source.title}`, vscode.ViewColumn.Active, { enableScripts: true });
        const p = new SummaryPanel(ctx, panel);
        p.key = key;
        SummaryPanel.panels.set(key, p);
        return p;
      })().finally(() => SummaryPanel.creating.delete(key)));
    }
    const p = await SummaryPanel.creating.get(key);
    p.panel.reveal();
    p.panel.webview.postMessage({ type: 'focus' }); // the keyboard on the answer (not nowhere)
    if (!(await p.ready)) return p; // closed before it loaded
    p.run(source);
    return p;
  }

  constructor(ctx, panel) {
    this.ctx = ctx;
    this.panel = panel;
    panel.iconPath = new vscode.ThemeIcon('sparkle');
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] };
    /** Resolves true once the page has loaded, false if it is closed first. */
    this.ready = new Promise((resolve) => (this.resolveReady = resolve));
    /** What the page shows (start, the text so far, done or error): sent again when the page is re-created. */
    this.shown = [];
    panel.webview.html = webviewHtml(panel.webview, ctx.extensionUri, { title: 'Summary', script: 'summary.js', style: 'summary.css' });
    this.disposables = [
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => showError(e, 'Summary'))),
    ];
  }

  /** Summarize `source`; a summary still being written is stopped. */
  async run(source) {
    if (this.cts) this.cts.cancel();
    const cts = (this.cts = new vscode.CancellationTokenSource());
    this.source = source;
    this.text = '';
    this.panel.title = `Summary: ${source.title}`;
    this.current = cts;
    const post = (m) => {
      if (this.current !== cts) return; // a newer summary took over
      // Kept to show the page again: the start, then the latest text, or the end (with its text).
      this.shown = m.type === 'start' ? [m] : [this.shown[0], m];
      this.panel.webview.postMessage(m);
    };
    post({ type: 'start', title: source.title });
    try {
      const r = await ai.summarize(source, {
        token: cts.token,
        onModel: (model) => post({ type: 'model', model }),
        onText: (text) => {
          if (this.current !== cts) return;
          this.text = text;
          post({ type: 'text', text });
        },
      });
      if (this.current !== cts) return; // replaced by a newer summary
      this.text = r.text;
      post({ type: 'done', text: r.text, model: r.model, note: r.note, files: r.files, cut: r.cut, secrets: r.secrets, withheld: r.withheld, stopped: cts.token.isCancellationRequested });
    } catch (e) {
      if (this.current !== cts) return;
      this.text = '';
      // The AI module logs its own reasons; anything else (git, a bug) is logged here.
      if (!(e instanceof ai.AiUnavailable)) log().error(`Summary of ${source.title}: ${e.stack || e.message}`);
      post({ type: 'error', message: e.message || String(e), chooseModel: !!e.chooseModel });
    } finally {
      if (this.cts === cts) this.cts = undefined;
      cts.dispose();
    }
  }

  async onMessage(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'ready':
        // First load, or the page was re-created (hidden and shown again): show it as it was.
        this.resolveReady(true);
        for (const x of this.shown) this.panel.webview.postMessage(x);
        break;
      case 'stop':
        if (this.cts) this.cts.cancel();
        break;
      case 'again':
        if (this.source) this.run(this.source);
        break;
      case 'showLog':
        log().show(true);
        break;
      case 'chooseModel':
        await vscode.commands.executeCommand('commitCorner.ai.chooseModel');
        break;
      case 'copy':
        // The answer the host has, not text from the page.
        if (!this.text) break;
        await vscode.env.clipboard.writeText(this.text);
        vscode.window.setStatusBarMessage('Summary copied', 2000);
        break;
      default:
        break;
    }
  }

  dispose() {
    this.resolveReady(false);
    if (this.cts) this.cts.cancel();
    if (SummaryPanel.panels.get(this.key) === this) SummaryPanel.panels.delete(this.key);
    for (const d of this.disposables) d.dispose();
  }
}

/** @type {Map<string, SummaryPanel>} subject -> its page */
SummaryPanel.panels = new Map();
/** @type {Map<string, Promise<SummaryPanel>>} pages being created */
SummaryPanel.creating = new Map();

module.exports = { SummaryPanel, VIEW_TYPE };
