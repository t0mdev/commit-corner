'use strict';

const vscode = require('vscode');

/**
 * Notifications. VS Code turns "[label](command:…)" (and https:, file: links) in a
 * notification's message into a clickable link that runs with the command's arguments, and
 * our messages quote repository text (file names, commit subjects, branch names, git's and
 * the server's own output) that whoever made the repository chose. No message of ours is meant
 * to contain a link, so link syntax is broken up (a zero-width space between "]" and "(")
 * before anything is shown: the text reads the same, nothing is clickable.
 */

const ZWSP = '​';

/** `text` with markdown-style link syntax made inert. */
function noLinks(text) {
  return String(text).replace(/\]\s*\(/g, (m) => `]${ZWSP}${m.slice(1)}`);
}

/**
 * Someone else's text (git's or a server's prompt) for a label that renders links and
 * $(icons): one line, inert links, inert icons.
 */
function plainText(text) {
  return noLinks(String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ')).replace(/\$\(/g, `$${ZWSP}(`);
}

const info = (message, ...rest) => vscode.window.showInformationMessage(noLinks(message), ...rest);
const warn = (message, ...rest) => vscode.window.showWarningMessage(noLinks(message), ...rest);
const error = (message, ...rest) => vscode.window.showErrorMessage(noLinks(message), ...rest);

module.exports = { noLinks, plainText, info, warn, error };
