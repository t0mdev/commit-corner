'use strict';

/**
 * The packaged .vsix, not the source tree, is what users run: build it,
 * unpack it, and check that everything the code loads at runtime is inside.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { unzip } = require('./helpers/unzip');

const root = path.join(__dirname, '..');

const vsce = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');

// Packaged with @vscode/vsce (a dev dependency: `npm ci` first), exactly as `npm run package` does.
test('the .vsix contains every file the extension loads at runtime', { skip: !fs.existsSync(vsce) && 'run npm ci to install @vscode/vsce' }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-vsix-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const vsix = path.join(work, 'x.vsix');
  execFileSync(process.execPath, [vsce, 'package', '--out', vsix], { cwd: root, stdio: 'pipe' });
  const names = unzip(vsix, work);
  assert.ok(names.includes('extension.vsixmanifest'));
  assert.ok(names.includes('[Content_Types].xml'));
  const ext = path.join(work, 'extension');
  const pkg = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
  assert.ok(fs.existsSync(path.join(ext, pkg.main)), 'main entry');
  for (const dir of ['test/', 'docs/', 'node_modules/', '.vscode-test/']) assert.ok(!names.some((n) => n.startsWith(`extension/${dir}`)), `${dir} is not shipped`);
  assert.ok(!names.some((n) => /\.vsix$|\.vscode-test\.mjs$|\.npmrc$/.test(n)), 'no build files');

  const problems = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const file of walk(ext).filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(file, 'utf8');
    // Relative requires resolve inside the package.
    for (const m of text.matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)) {
      try {
        require.resolve(path.resolve(path.dirname(file), m[1]));
      } catch {
        problems.push(`${path.relative(ext, file)} requires missing ${m[1]}`);
      }
    }
    // Helper scripts referenced through path.join(__dirname, ..., 'scripts', '<file>').
    for (const m of text.matchAll(/path\.join\(__dirname, ((?:'[^']+', )*)'([^']+\.js)'\)/g)) {
      const parts = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
      const target = path.resolve(path.dirname(file), ...parts, m[2]);
      if (!fs.existsSync(target)) problems.push(`${path.relative(ext, file)} references missing ${path.relative(ext, target)}`);
    }
    // Webview assets.
    for (const m of text.matchAll(/(?:script|style): '([^']+\.(?:js|css))'/g)) {
      if (!fs.existsSync(path.join(ext, 'media', m[1]))) problems.push(`missing media/${m[1]}`);
    }
  }
  for (const icon of [pkg.icon, ...pkg.contributes.viewsContainers.activitybar.map((a) => a.icon)]) {
    if (!fs.existsSync(path.join(ext, icon))) problems.push(`missing ${icon}`);
  }
  assert.deepEqual(problems, []);

  // The credential helper works from the installed location.
  const { AskpassServer } = require(path.join(ext, 'src', 'git', 'askpass.js'));
  const server = new AskpassServer(async () => 'secret', path.join(work, 'storage'));
  await server.start();
  t.after(() => server.dispose());
  const out = await new Promise((resolve) => execFile(server.script, ['Password: '], { env: { ...process.env, ...server.lease().env } }, (err, stdout) => resolve(err ? `exit ${err.code}` : stdout)));
  assert.equal(out, 'secret\n');
});
