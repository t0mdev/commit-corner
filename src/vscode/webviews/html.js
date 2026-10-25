'use strict';

const vscode = require('vscode');
const crypto = require('crypto');

/**
 * Build a webview HTML shell with a strict Content Security Policy: no remote
 * content, no inline scripts except our nonce'd bundle, styles only from the
 * extension. All content is created with DOM APIs in the webview script, so
 * no repository data is ever interpreted as HTML.
 */
function webviewHtml(webview, extensionUri, { title, script, style, body = '' }) {
  // icons.js (shared icon set, avatars and formatting) loads before the page's own script.
  const scripts = ['icons.js', script];
  const nonce = crypto.randomBytes(16).toString('base64');
  const media = (file) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('common.css')}">
<link rel="stylesheet" href="${media(style)}">
<title>${escapeHtml(title)}</title>
</head>
<body>
${body}
${scripts.map((file) => `<script nonce="${nonce}" src="${media(file)}"></script>`).join('\n')}
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { webviewHtml, escapeHtml };
