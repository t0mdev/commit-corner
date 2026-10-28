// @ts-check
/* Commit Corner — summary of changes, written by a language model. The answer is untrusted
 * text: it is shown with a small Markdown subset (headings, lists, paragraphs, **bold**,
 * `code`, fenced code) built from DOM nodes and textContent, never parsed as HTML. */
(function () {
  'use strict';

  // @ts-ignore acquireVsCodeApi is provided by VS Code
  const vscode = acquireVsCodeApi();
  // A failure in this page goes to the extension's log (otherwise only Developer Tools see it).
  const report = (message, stack) => vscode.postMessage({ type: 'clientError', message: String(message).slice(0, 500), stack: String(stack || '').slice(0, 2000) });
  window.addEventListener('error', (e) => report(e.message, e.error && e.error.stack));
  window.addEventListener('unhandledrejection', (e) => report(e.reason && e.reason.message ? e.reason.message : e.reason, e.reason && e.reason.stack));
  const ui = window.gaUi;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  };

  function button(label, title, onClick, iconName, cls) {
    const b = el('button', `btn${cls ? ` ${cls}` : ''}`);
    if (iconName) b.appendChild(ui.icon(iconName));
    b.appendChild(el('span', '', label));
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  const header = el('header', 'head');
  const title = el('h1', 'title');
  const status = el('div', 'status');
  status.setAttribute('role', 'status');
  const stopBtn = button('Stop', 'Stop writing the summary', () => vscode.postMessage({ type: 'stop' }), 'stop');
  const againBtn = button('Summarize Again', 'Ask for a new summary of the same changes', () => vscode.postMessage({ type: 'again' }), 'refresh');
  const copyBtn = button('Copy', 'Copy the summary (Markdown)', () => vscode.postMessage({ type: 'copy' }), 'copy');
  const actions = el('div', 'actions');
  actions.append(stopBtn, againBtn, copyBtn);
  header.append(title, actions);
  const body = el('article', 'answer');
  body.setAttribute('aria-live', 'polite');
  body.tabIndex = 0;
  const foot = el('footer', 'foot');
  document.body.append(header, status, body, foot);

  /** `code` and **bold** inside a line, as text nodes and elements. */
  function inline(parent, text) {
    const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
    let last = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const t = m[0];
      parent.appendChild(t.startsWith('`') ? el('code', '', t.slice(1, -1)) : el('strong', '', t.slice(2, -2)));
      last = m.index + t.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function render(md) {
    const out = document.createDocumentFragment();
    let list = null;
    let para = null;
    let code = null;
    const end = () => {
      list = null;
      para = null;
    };
    for (const line of md.split('\n')) {
      if (code) {
        if (/^\s*```/.test(line)) code = null;
        else code.textContent += `${code.textContent ? '\n' : ''}${line}`;
        continue;
      }
      if (/^\s*```/.test(line)) {
        end();
        const pre = el('pre');
        code = el('code');
        pre.appendChild(code);
        out.appendChild(pre);
        continue;
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      const li = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (h) {
        end();
        const node = el(`h${Math.min(4, h[1].length + 1)}`);
        inline(node, h[2]);
        out.appendChild(node);
      } else if (li) {
        para = null;
        if (!list) {
          list = el(/^\s*\d/.test(line) ? 'ol' : 'ul');
          out.appendChild(list);
        }
        const item = el('li');
        inline(item, li[1]);
        list.appendChild(item);
      } else if (!line.trim()) end();
      else {
        list = null;
        if (!para) {
          para = el('p');
          out.appendChild(para);
        } else para.appendChild(document.createTextNode(' '));
        inline(para, line.trim());
      }
    }
    body.replaceChildren(out);
  }

  function busy(on) {
    stopBtn.hidden = !on;
    againBtn.hidden = on;
    copyBtn.disabled = on;
    document.body.classList.toggle('busy', on);
  }

  /** The model asked (its name, from the host), while it writes; why it is not the one in the settings. */
  let model = '';
  let note = '';

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'start':
        // The keyboard on the answer (not <body>), when this page has it.
        if (document.hasFocus() && document.activeElement === document.body) body.focus();
        title.textContent = `Summary: ${m.title}`;
        model = '';
        note = '';
        status.textContent = 'Choosing a language model…';
        foot.textContent = '';
        body.replaceChildren();
        busy(true);
        break;
      case 'model':
        model = m.model;
        note = m.note || '';
        status.textContent = `Asking ${m.model}…${note ? ` The language model ${note}.` : ''}`;
        break;
      case 'text':
        if (m.model) model = m.model;
        if (m.note) note = m.note;
        status.textContent = model ? `${model} is writing…` : 'Writing…';
        render(m.text);
        break;
      case 'done':
        render(m.text);
        busy(false);
        status.textContent = m.stopped ? 'Stopped.' : '';
        if (m.stopped && !m.text) break; // nothing was written: no "Written by"
        foot.textContent = `Written by ${m.model} from ${m.files} changed file${m.files === 1 ? '' : 's'}${m.cut ? ` (${m.cut} shortened or left out to fit)` : ''}${m.withheld ? `; ${m.withheld} file${m.withheld === 1 ? '' : 's'} that may hold secrets sent by name only` : ''}${m.secrets ? `; ${m.secrets} value${m.secrets === 1 ? '' : 's'} that looked like secrets removed` : ''}.${m.note ? ` The language model ${m.note}.` : ''} A model can be wrong, and text in the changes can steer it: check what matters in the diff.`;
        break;
      case 'focus':
        body.focus();
        break;
      case 'error': {
        if (m.model) model = m.model;
        if (m.note) note = m.note;
        busy(false);
        status.textContent = '';
        // What went wrong, and the ways on: another model, the log (what was sent and answered).
        const fix = el('div', 'fix');
        if (m.chooseModel) fix.appendChild(button('Choose Model…', 'Choose the language model Commit Corner asks', () => vscode.postMessage({ type: 'chooseModel' }), 'sparkle'));
        fix.appendChild(button('Show Log', 'Show Output → Commit Corner: the model chosen, what was sent and how it answered', () => vscode.postMessage({ type: 'showLog' }), 'terminal'));
        body.replaceChildren(el('p', 'error', m.message), ...(note ? [el('p', 'note', `The language model ${note}; ${model} was asked instead.`)] : []), fix);
        break;
      }
      default:
        break;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !stopBtn.hidden) vscode.postMessage({ type: 'stop' });
  });

  window.addEventListener('focus', () => {
    if (document.activeElement === document.body) body.focus();
  });

  busy(false);
  vscode.postMessage({ type: 'ready' });
})();
