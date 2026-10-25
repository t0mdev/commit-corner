'use strict';

/**
 * The webviews' DOM in a real VS Code, over the Chrome DevTools Protocol (VS Code is started with
 * --remote-debugging-port, see .vscode-test.mjs "ui"). Node's built-in WebSocket and http only.
 */
const http = require('http');

const port = () => Number(process.env.CC_UI_CDP_PORT);

function targets() {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: port(), path: '/json/list' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

/** Evaluate `expr` in a webview's page (the inner frame that holds the extension's document). */
async function evaluate(target, expr) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('the page is gone (re-created or closed)'));
  });
  try {
    const reply = new Promise((resolve) => {
      ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.id === 1) resolve(d);
      };
    });
    const wrapped = `(() => { const fr = document.querySelector('iframe'); const w = fr ? fr.contentWindow : window; return (function (window, document) { return (${expr}); })(w, w.document); })()`;
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: wrapped, returnByValue: true, awaitPromise: true } }));
    // A frame that went away never answers: give up after 5 s instead of hanging the suite.
    const d = await Promise.race([reply, new Promise((resolve, reject) => setTimeout(() => reject(new Error('the page did not answer')), 5000))]);
    if (d.result && d.result.exceptionDetails) throw new Error(`in the page: ${d.result.exceptionDetails.exception && d.result.exceptionDetails.exception.description}`);
    return d.result && d.result.result ? d.result.result.value : undefined;
  } finally {
    ws.close();
  }
}

/** Send DevTools commands to a target, in order; resolves with the last result. */
async function send(target, commands) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  try {
    let last;
    for (let id = 1; id <= commands.length; id++) {
      const [method, params] = commands[id - 1];
      last = await new Promise((resolve) => {
        ws.onmessage = (m) => {
          const d = JSON.parse(m.data);
          if (d.id === id) resolve(d);
        };
        ws.send(JSON.stringify({ id, method, params }));
      });
    }
    return last;
  } finally {
    ws.close();
  }
}

const KEYS = { Enter: [13, 'Enter', '\r'], Escape: [27, 'Escape'], ArrowDown: [40, 'ArrowDown'], ArrowUp: [38, 'ArrowUp'], ArrowRight: [39, 'ArrowRight'], ArrowLeft: [37, 'ArrowLeft'], Home: [36, 'Home'], Space: [32, 'Space', ' '] };

/**
 * A real key press in a webview (through the browser's input pipeline and VS Code's handling of
 * webview keys — not a synthetic DOM event). `mods`: { ctrl, shift, alt }.
 */
function press(target, key, mods = {}) {
  const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0);
  const [code, name, text] = KEYS[key] || [key.toUpperCase().charCodeAt(0), `Key${key.toUpperCase()}`, mods.ctrl ? undefined : key];
  const base = { modifiers, windowsVirtualKeyCode: code, code: name, key: key === 'Space' ? ' ' : key };
  return send(target, [
    ['Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) }],
    ['Input.dispatchKeyEvent', { type: 'keyUp', ...base }],
  ]);
}

/** The webview whose page loads `script` (and for which `cond` holds), once it is there. */
async function webview(script, cond = 'true', ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    for (const t of (await targets()).filter((x) => x.type === 'iframe' && x.url.startsWith('vscode-webview://'))) {
      try {
        if (await evaluate(t, `!!document.querySelector('script[src*="${script}"]') && (${cond})`)) return t;
      } catch { /* a frame that went away */ }
    }
    if (Date.now() > end) throw new Error(`No webview with ${script}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

module.exports = { evaluate, webview, targets, press };
