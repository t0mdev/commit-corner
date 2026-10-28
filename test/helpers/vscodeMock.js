'use strict';

/**
 * A small in-memory stand-in for the `vscode` module. It implements the
 * value types the extension constructs (Uri, Range, TreeItem, EventEmitter…)
 * faithfully enough to run real code paths, records registrations (commands,
 * views, providers), and lets tests script UI answers (quick picks, input
 * boxes, confirmations). Anything not modelled resolves to a harmless no-op.
 */

const path = require('path');
const Module = require('module');

class Disposable {
  constructor(fn) {
    this.fn = fn;
  }
  static from(...ds) {
    return new Disposable(() => ds.forEach((d) => d && d.dispose && d.dispose()));
  }
  dispose() {
    if (this.fn) this.fn();
    this.fn = undefined;
  }
}

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (fn) => {
      this.listeners.add(fn);
      return new Disposable(() => this.listeners.delete(fn));
    };
  }
  fire(e) {
    for (const l of [...this.listeners]) l(e);
  }
  dispose() {
    this.listeners.clear();
  }
}

class CancellationTokenSource {
  constructor() {
    const emitter = new EventEmitter();
    this.token = { isCancellationRequested: false, onCancellationRequested: emitter.event };
    this.emitter = emitter;
  }
  cancel() {
    if (this.token.isCancellationRequested) return;
    this.token.isCancellationRequested = true;
    this.emitter.fire();
  }
  dispose() {}
}

class LanguageModelError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
  static NoPermissions(m) { return new LanguageModelError(m || 'no permissions', 'NoPermissions'); }
  static Blocked(m) { return new LanguageModelError(m || 'blocked', 'Blocked'); }
  static NotFound(m) { return new LanguageModelError(m || 'not found', 'NotFound'); }
}

/**
 * A language model for tests: answers with `reply` (string, or a function of the prompt) in a
 * few chunks, and records every prompt in `prompts`.
 */
function fakeModel(reply, o = {}) {
  const model = {
    id: o.id || 'fake', vendor: o.vendor || 'copilot', family: o.family || 'fake-family', name: o.name || 'Fake Model',
    maxInputTokens: o.maxInputTokens || 8000,
    prompts: [],
    async sendRequest(messages, options, token) {
      const prompt = messages.map((m) => m.content).join('\n');
      model.prompts.push(prompt);
      if (o.error) throw o.error;
      const text = typeof reply === 'function' ? reply(prompt) : reply;
      const chunks = text.match(/[\s\S]{1,7}/g) || [];
      // As VS Code's: `stream` has every part (o.parts: others before the text), `text` only the text.
      const parts = [...(o.parts || []), ...chunks.map((c) => new LanguageModelTextPart(c))];
      async function* gen(asText) {
        for (const p of parts) {
          if (token && token.isCancellationRequested) return;
          if (o.breakAfter !== undefined && p === parts[o.breakAfter]) throw o.breakWith;
          if (!asText) yield p;
          else if (p instanceof LanguageModelTextPart) yield p.value;
        }
      }
      return o.textOnly ? { text: gen(true) } : { stream: gen(false), text: gen(true) };
    },
  };
  return model;
}

class LanguageModelTextPart {
  constructor(value) {
    this.value = value;
  }
}

class Uri {
  constructor(scheme, p, query = '', fragment = '') {
    this.scheme = scheme;
    this.path = p;
    this.query = query;
    this.fragment = fragment;
  }
  static file(p) {
    return new Uri('file', path.resolve(p));
  }
  static parse(s) {
    const m = /^([a-z][\w+.-]*):(?:\/\/[^/]*)?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(s);
    return m ? new Uri(m[1], m[2], m[3] || '', m[4] || '') : new Uri('file', s);
  }
  static joinPath(base, ...parts) {
    return new Uri(base.scheme, path.posix.join(base.path, ...parts), base.query);
  }
  static from(c) {
    return new Uri(c.scheme, c.path || '', c.query || '', c.fragment || '');
  }
  get fsPath() {
    return this.path;
  }
  with(c) {
    return new Uri(c.scheme ?? this.scheme, c.path ?? this.path, c.query ?? this.query, c.fragment ?? this.fragment);
  }
  toString() {
    return `${this.scheme}://${this.path}${this.query ? `?${this.query}` : ''}`;
  }
  toJSON() {
    return this.toString();
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    } else {
      this.start = a;
      this.end = b;
    }
  }
}

class Selection extends Range {
  get active() {
    return this.end;
  }
}

class TreeItem {
  constructor(label, collapsibleState = 0) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}
ThemeIcon.Folder = new ThemeIcon('folder');
ThemeIcon.File = new ThemeIcon('file');

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class MarkdownString {
  constructor(value = '', supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }
  appendMarkdown(s) {
    this.value += s;
    return this;
  }
  appendText(s) {
    // Like VS Code: plain text is escaped, so it never becomes markdown (or HTML).
    this.value += String(s).replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
    return this;
  }
}

class FileDecoration {
  constructor(badge, tooltip, color) {
    this.badge = badge;
    this.tooltip = tooltip;
    this.color = color;
  }
}

class RelativePattern {
  constructor(base, pattern) {
    this.base = base;
    this.pattern = pattern;
  }
}

class WorkspaceEdit {
  constructor() {
    this.edits = [];
  }
  replace(uri, range, text) {
    this.edits.push({ uri, range, text });
  }
}

class FileSystemError extends Error {
  static NoPermissions(m) {
    return new FileSystemError(m || 'NoPermissions');
  }
  static Unavailable(m) {
    return new FileSystemError(m || 'Unavailable');
  }
  static FileNotFound(m) {
    return new FileSystemError(m || 'FileNotFound');
  }
}

/** Generic no-op object: any property is a function returning a disposable. */
function noop(name) {
  const fn = () => new Disposable();
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === 'dispose') return () => {};
      if (prop === 'then') return undefined;
      if (prop in target) return target[prop];
      return noop(`${name}.${String(prop)}`);
    },
  });
}

function createVscode() {
  const commands = new Map();
  const lmModels = [];
  const executed = [];
  const configValues = new Map();
  const workspaceConfigValues = new Map();
  const ui = {
    /** Queued answers consumed by showQuickPick/showInputBox/show*Message, in order. */
    answers: [],
    messages: [],
  };
  const answer = (kind, fallback) => {
    if (!ui.answers.length) return fallback;
    const next = ui.answers.shift();
    return typeof next === 'function' ? next(kind) : next;
  };
  const treeViews = new Map();
  const webviewViews = new Map();
  const sourceControls = [];
  const statusItems = [];
  const workspaceFolders = [];

  const workspaceEvents = {
    onDidChangeWorkspaceFolders: new EventEmitter(),
    onDidChangeTextDocument: new EventEmitter(),
    onDidCloseTextDocument: new EventEmitter(),
    onDidSaveTextDocument: new EventEmitter(),
    onDidChangeConfiguration: new EventEmitter(),
  };
  const windowEvents = {
    onDidChangeActiveTextEditor: new EventEmitter(),
    onDidChangeWindowState: new EventEmitter(),
    onDidChangeTextEditorSelection: new EventEmitter(),
    onDidChangeVisibleTextEditors: new EventEmitter(),
  };

  const vscode = {
    Disposable,
    EventEmitter,
    Uri,
    Position,
    Range,
    Selection,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    MarkdownString,
    RelativePattern,
    FileDecoration,
    WorkspaceEdit,
    FileSystemError,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
    CancellationTokenSource,
    LanguageModelError,
    LanguageModelChatMessage: { User: (content) => ({ role: 'user', content }) },
    LanguageModelTextPart,
    // Language models: tests put fake ones (fakeModel) into `lmModels`.
    lm: {
      async selectChatModels(sel = {}) {
        return lmModels.filter((m) => (!sel.vendor || m.vendor === sel.vendor) && (!sel.family || m.family === sel.family) && (!sel.id || m.id === sel.id));
      },
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    FilePermission: { Readonly: 1 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
    SourceControlInputBoxValidationType: { Error: 0, Warning: 1, Information: 2 },
    ViewColumn: { Active: -1, Beside: -2, One: 1 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    commands: {
      registerCommand(id, fn) {
        if (commands.has(id)) throw new Error(`command '${id}' already exists`);
        commands.set(id, fn);
        return new Disposable(() => commands.delete(id));
      },
      async executeCommand(id, ...args) {
        executed.push({ id, args });
        const fn = commands.get(id);
        return fn ? fn(...args) : undefined;
      },
    },
    // No GitHub account in tests: silent requests find no session, nothing changes.
    authentication: {
      getSession: async () => undefined,
      onDidChangeSessions: () => ({ dispose() {} }),
    },
    window: {
      ...Object.fromEntries(Object.entries(windowEvents).map(([k, e]) => [k, e.event])),
      activeTextEditor: undefined,
      visibleTextEditors: [],
      state: { focused: true },
      createOutputChannel(name) {
        const lines = [];
        const log = (level) => (msg) => lines.push(`[${level}] ${msg}`);
        return { name, lines, info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug'), trace: log('trace'), appendLine: log('line'), show() {}, dispose() {} };
      },
      createTreeView(id, opts) {
        const checkboxes = new EventEmitter();
        const selectionChanged = new EventEmitter();
        const view = { id, provider: opts.treeDataProvider, options: opts, visible: true, selection: [], description: undefined, onDidChangeVisibility: () => new Disposable(), onDidExpandElement: () => new Disposable(), onDidCollapseElement: () => new Disposable(), onDidChangeCheckboxState: checkboxes.event, checkboxes, onDidChangeSelection: selectionChanged.event, selectionChanged, reveal: async () => {}, dispose() {} };
        treeViews.set(id, view);
        return view;
      },
      createStatusBarItem(id) {
        const item = { id, text: '', show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
        statusItems.push(item);
        return item;
      },
      createTextEditorDecorationType() {
        return { dispose() {} };
      },
      createWebviewPanel: noop('createWebviewPanel'),
      registerWebviewPanelSerializer: () => new Disposable(),
      registerWebviewViewProvider(id, provider) {
        webviewViews.set(id, provider);
        return new Disposable();
      },
      registerCustomEditorProvider: () => new Disposable(),
      registerFileDecorationProvider: () => new Disposable(),
      async showQuickPick(items, opts) {
        const list = await items;
        const a = answer('quickPick', undefined);
        if (a === undefined) return undefined;
        if (typeof a === 'number') return list[a];
        if (typeof a === 'string') return list.find((i) => (typeof i === 'string' ? i : i.label) === a || (i.label || '').includes(a));
        void opts;
        return a;
      },
      createQuickPick() {
        const accept = new EventEmitter();
        const hide = new EventEmitter();
        const change = new EventEmitter();
        const qp = {
          items: [],
          selectedItems: [],
          onDidAccept: accept.event,
          onDidHide: hide.event,
          onDidChangeValue: change.event,
          show() {
            // Answer once the items are set (the caller fills them asynchronously).
            setTimeout(function tryAnswer() {
              if (qp.busy) return setTimeout(tryAnswer, 5);
              const a = answer('quickPick', undefined);
              if (a === undefined) return hide.fire();
              const item = typeof a === 'string' ? qp.items.find((i) => i.ref === a || (i.label || '').includes(a)) : a;
              if (!item && typeof a === 'string') {
                change.fire(a);
                qp.selectedItems = [qp.items.find((i) => i.ref === a)];
              } else qp.selectedItems = [item];
              accept.fire();
              return undefined;
            }, 0);
          },
          dispose() {},
        };
        return qp;
      },
      async showInputBox(opts) {
        const a = answer('inputBox', undefined);
        if (a !== undefined && opts && opts.validateInput) {
          const err = opts.validateInput(a);
          if (err) throw new Error(`Input "${a}" rejected: ${err}`);
        }
        return a;
      },
      async showInformationMessage(msg, ...items) {
        ui.messages.push({ level: 'info', msg });
        return pickMessageAnswer(items);
      },
      async showWarningMessage(msg, ...items) {
        ui.messages.push({ level: 'warning', msg });
        return pickMessageAnswer(items);
      },
      async showErrorMessage(msg, ...items) {
        ui.messages.push({ level: 'error', msg });
        return undefined;
      },
      setStatusBarMessage: () => new Disposable(),
      async withProgress(opts, task) {
        return task({ report() {} }, { onCancellationRequested: () => new Disposable(), isCancellationRequested: false });
      },
      async showTextDocument() {
        return {};
      },
      showOpenDialog: async () => undefined,
    },
    workspace: {
      ...Object.fromEntries(Object.entries(workspaceEvents).map(([k, e]) => [k, e.event])),
      workspaceFolders,
      textDocuments: [],
      // configValues: user settings; workspaceConfigValues: a workspace's, which win in get().
      getConfiguration() {
        return {
          get: (key, def) => (workspaceConfigValues.has(key) ? workspaceConfigValues.get(key) : configValues.has(key) ? configValues.get(key) : def),
          update: async (key, value) => configValues.set(key, value),
          inspect: (key) => ({ key, globalValue: configValues.get(key), workspaceValue: workspaceConfigValues.get(key) }),
        };
      },
      createFileSystemWatcher() {
        return { onDidChange: () => new Disposable(), onDidCreate: () => new Disposable(), onDidDelete: () => new Disposable(), dispose() {} };
      },
      registerFileSystemProvider: () => new Disposable(),
      registerTextDocumentContentProvider: () => new Disposable(),
      async openTextDocument(uri) {
        return { uri, getText: () => '', version: 1, isDirty: false, lineCount: 0 };
      },
      async applyEdit() {
        return true;
      },
      updateWorkspaceFolders: () => true,
      fs: {
        async delete(uri) {
          require('fs').rmSync(uri.fsPath, { recursive: true, force: true });
        },
      },
    },
    scm: {
      createSourceControl(id, label, rootUri) {
        const groups = [];
        const sc = {
          id,
          label,
          rootUri,
          count: 0,
          inputBox: { value: '', placeholder: '' },
          createResourceGroup(gid, glabel) {
            const g = { id: gid, label: glabel, resourceStates: [], dispose() {} };
            groups.push(g);
            return g;
          },
          groups,
          dispose() {},
        };
        sourceControls.push(sc);
        return sc;
      },
    },
    extensions: { getExtension: () => undefined },
    env: {
      clipboard: { text: '', async writeText(t) { this.text = t; }, async readText() { return this.text; } },
      openExternal: async () => true,
    },
    languages: new Proxy({}, { get: (_t, p) => noop(`languages.${String(p)}`) }),
  };

  function pickMessageAnswer(items) {
    const choices = items.filter((i) => typeof i === 'string' || (i && i.title));
    if (!choices.length) return undefined;
    const a = answer('message', undefined);
    if (a === undefined) return undefined;
    if (a === true) return choices[0];
    return choices.find((c) => (typeof c === 'string' ? c : c.title) === a);
  }

  return {
    vscode,
    commands,
    executed,
    ui,
    treeViews,
    webviewViews,
    sourceControls,
    statusItems,
    configValues,
    workspaceConfigValues,
    workspaceFolders,
    lmModels,
    events: { ...workspaceEvents, ...windowEvents },
  };
}

/** Make `require('vscode')` resolve to the given mock for the rest of the process. */
function installVscodeMock(mock) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return mock.vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  return () => {
    Module._load = originalLoad;
  };
}

module.exports = { fakeModel, createVscode, installVscodeMock };
