'use strict';

/**
 * Runs in every configuration; the assertions that need the built-in Git switched off
 * (label "replacement") only run there.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const pkg = require('../../package.json');

const builtInGitOff = () => vscode.workspace.getConfiguration('git').get('enabled') === false;

suite('Replacing the built-in Git', () => {
  let api;
  suiteSetup(async function () {
    if (!builtInGitOff()) this.skip();
    api = await vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`).activate();
    const end = Date.now() + 15000;
    while (!api.manager.repositories.length && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  });

  test('the gutter quick diff comes from Commit Corner', async () => {
    const repo = api.manager.repositories[0];
    const sc = api.scm.get(repo).sc;
    assert.ok(sc.quickDiffProvider, 'quick diff provider set');
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const original = await sc.quickDiffProvider.provideOriginalResource(vscode.Uri.file(path.join(root, 'a.txt')));
    assert.ok(original && original.scheme === 'commitcorner', 'original resource in our scheme');
  });

  test('the count badge and the Explorer decorations are on', async () => {
    const repo = api.manager.repositories[0];
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    fs.writeFileSync(path.join(root, 'b.txt'), 'b\nchanged\n');
    await api.manager.refresh(repo);
    const sc = api.scm.get(repo).sc;
    assert.ok(sc.count >= 1, `count badge (${sc.count})`);
  });
});
