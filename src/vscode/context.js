'use strict';

const vscode = require('vscode');
const { safe } = require('./util');

/**
 * Shared state handed to every feature module: the repository manager, SCM
 * providers, views, and a `command()` helper that registers a command with
 * uniform error handling.
 */
class Context {
  /**
   * @param {vscode.ExtensionContext} extContext
   * @param {import('./model').RepositoryManager} manager
   */
  constructor(extContext, manager) {
    this.extContext = extContext;
    this.extensionUri = extContext.extensionUri;
    this.manager = manager;
    /** @type {import('./scm').ScmManager} */
    this.scm = undefined;
    /** @type {import('./views/compareView').CompareView} */
    this.compare = undefined;
    /** Ref picked with "Select for Compare". */
    this.pendingCompare = undefined;
    /** Every command id registered, for diagnostics and tests. */
    this.registered = new Set();
    // Feature modules destructure `command`; keep `this` bound.
    this.command = this.command.bind(this);
  }

  /** Register a command whose failures are reported to the user instead of thrown. */
  command(id, fn) {
    if (this.registered.has(id)) throw new Error(`Command registered twice: ${id}`);
    this.registered.add(id);
    const d = vscode.commands.registerCommand(id, safe(fn, undefined));
    this.extContext.subscriptions.push(d);
    return d;
  }

  /** Track a disposable for deactivation. */
  own(d) {
    if (d) this.extContext.subscriptions.push(d);
    return d;
  }
}

module.exports = { Context };
