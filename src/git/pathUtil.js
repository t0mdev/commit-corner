'use strict';

const path = require('path');

/**
 * Paths compared across git and VS Code. git for Windows prints "C:/Users/…" (forward slashes,
 * upper-case drive), VS Code's fsPath is "c:\Users\…"; Windows and macOS file systems are
 * usually case-insensitive. `platform` is for tests.
 */

const api = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const caseless = (platform) => platform === 'win32' || platform === 'darwin';

/** Resolved, in this platform's separators; on Windows with a lower-case drive letter (as fsPath). */
function normalizePath(p, platform = process.platform) {
  const r = api(platform).resolve(p);
  return platform === 'win32' ? r.replace(/^[A-Z]:/, (d) => d.toLowerCase()) : r;
}

function samePath(a, b, platform = process.platform) {
  const x = normalizePath(a, platform);
  const y = normalizePath(b, platform);
  return caseless(platform) ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** Whether `child` lies strictly inside the folder `parent`. */
function isInside(parent, child, platform = process.platform) {
  let p = normalizePath(parent, platform);
  let c = normalizePath(child, platform);
  if (caseless(platform)) {
    p = p.toLowerCase();
    c = c.toLowerCase();
  }
  const rel = api(platform).relative(p, c);
  return !!rel && !rel.startsWith('..') && !api(platform).isAbsolute(rel);
}

/** samePath or isInside. */
function isSameOrInside(parent, child, platform = process.platform) {
  return samePath(parent, child, platform) || isInside(parent, child, platform);
}

module.exports = { normalizePath, samePath, isInside, isSameOrInside };
