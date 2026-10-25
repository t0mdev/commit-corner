'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Initials avatars for tree views: small coloured SVG files in the extension's
 * storage folder, one per person. Nothing is fetched from the network; the
 * colour and initials match the webviews' avatars (media/icons.js).
 */

let dir;
const written = new Set();
const MAX_FILES = 5000;

/** @param {vscode.Uri} storageUri the extension's globalStorageUri */
function init(storageUri) {
  if (!storageUri) return;
  dir = path.join(storageUri.fsPath, 'avatars');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    dir = undefined;
  }
}

/** Same colours and hash as media/icons.js (AVATAR_COLORS, hue()). */
const AVATAR_COLORS = ['#1f6fa8', '#c0392b', '#23802b', '#7b52ab', '#b9440a', '#0d7684', '#8c564b', '#a83f8f', '#3a7d44', '#5254a3', '#94520f', '#5a6e33'];
function hue(key) {
  let h = 0x811c9dc5;
  for (const ch of String(key || '').toLowerCase()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % AVATAR_COLORS.length;
}

/** Same initials as media/icons.js initials(). */
function initials(name) {
  const words = String(name || '?').replace(/[<>()[\]"']/g, '').split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  const first = [...words[0]][0] || '?';
  const last = words.length > 1 ? [...words[words.length - 1]][0] || '' : '';
  return (first + last).toUpperCase();
}

const xml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function svg(name, email) {
  const text = xml(initials(name));
  const size = text.length > 1 ? 6.6 : 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7.5" fill="${AVATAR_COLORS[hue(email || name)]}"/><text x="8" y="8" dy="0.35em" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="${size}" font-weight="600" fill="#fff">${text}</text></svg>`;
}

/**
 * Icon URI of a person's avatar, or undefined when avatars are off or storage is unavailable.
 * @returns {vscode.Uri|undefined}
 */
function avatarUri(name, email) {
  if (!dir || !vscode.workspace.getConfiguration('commitCorner').get('avatars', true)) return undefined;
  // Named by content: people with the same initials and colour share a file, so a repository
  // with countless made-up authors cannot fill the disk (and at most MAX_FILES are written).
  const content = svg(name, email);
  const key = crypto.createHash('sha1').update(content).digest('hex').slice(0, 16);
  const file = path.join(dir, `${key}.svg`);
  if (!written.has(file)) {
    if (written.size >= MAX_FILES) return undefined;
    try {
      if (!fs.existsSync(file)) fs.writeFileSync(file, content);
      written.add(file);
    } catch {
      return undefined;
    }
  }
  return vscode.Uri.file(file);
}

module.exports = { init, avatarUri, initials, hue, svg };
