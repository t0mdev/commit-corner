// @ts-check
/* Commit Corner — Repository Activity webview. DOM APIs only; repository data is never parsed as HTML. */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  // @ts-ignore shared helpers from icons.js
  const ui = window.gaUi;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  };
  const svg = (tag, attrs = {}) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  };
  const plural = (n, word, many = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`;

  function button(label, title, onClick, iconName, cls) {
    const b = el('button', `btn${cls ? ` ${cls}` : ''}`);
    if (iconName) b.appendChild(ui.icon(iconName));
    if (label) b.appendChild(el('span', '', label));
    b.title = title;
    if (!label) b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
  }

  // ---------------------------------------------------------------- frame

  const app = el('div', 'app');
  const header = el('div', 'header');
  const h1 = el('h1');
  h1.append(ui.icon('graph', { size: 18 }), el('span', '', 'Repository Activity'));
  const repoName = el('span', 'repo');
  header.append(h1, repoName);

  // One row of filters above everything they scope: the period first, then the branches.
  const filters = el('div', 'filters');
  const periods = el('div', 'segmented');
  periods.setAttribute('role', 'radiogroup');
  periods.setAttribute('aria-label', 'Period');
  const PERIODS = [[7, 'Last 7 days'], [30, 'Last 30 days'], [365, 'Last 12 months']];
  const periodButtons = PERIODS.map(([days, label]) => {
    const b = el('button', 'seg', label);
    b.setAttribute('role', 'radio');
    b.dataset.days = String(days);
    b.addEventListener('click', () => setPeriod(days));
    b.addEventListener('keydown', (e) => {
      const i = PERIODS.findIndex(([d]) => d === days);
      const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      const next = PERIODS[(to + PERIODS.length) % PERIODS.length][0];
      setPeriod(next);
      periodButtons.find((x) => x.dataset.days === String(next)).focus();
    });
    periods.appendChild(b);
    return b;
  });
  const scopeSelect = /** @type {HTMLSelectElement} */ (el('select', 'scope'));
  scopeSelect.setAttribute('aria-label', 'Branches');
  scopeSelect.addEventListener('change', () => send({ type: 'period', days: state.days, scope: scopeSelect.value }));
  // Arrowing through a closed <select> fires "change" per option; "Other branch…" asks only on Enter/click.
  const refresh = button('', 'Refresh', () => send({ type: 'refresh' }), 'refresh');
  filters.append(periods, scopeSelect, el('span', 'spacer'), refresh);

  const content = el('div', 'content');
  const announcer = el('div', 'sr-only');
  announcer.setAttribute('aria-live', 'polite');
  app.append(header, filters, content, announcer);
  document.body.appendChild(app);

  const state = Object.assign({ days: 30, scope: 'all' }, vscode.getState() || {});
  let data = null;

  function send(m) {
    vscode.postMessage(m);
  }

  function setPeriod(days) {
    if (days === state.days) return;
    state.days = days;
    updateFilters();
    send({ type: 'period', days, scope: scopeSelect.value });
  }

  function updateFilters() {
    for (const b of periodButtons) {
      const on = b.dataset.days === String(state.days);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1; // one tab stop; arrows move inside the group
      b.classList.toggle('on', on);
    }
  }

  // ---------------------------------------------------------------- pieces

  function section(title, iconName, extra) {
    const s = el('section', 'card');
    const h = el('h2');
    h.append(ui.icon(iconName), el('span', '', title));
    if (extra) h.appendChild(extra);
    s.appendChild(h);
    return s;
  }

  function tile(label, value, sub) {
    const t = el('div', 'tile');
    t.append(el('div', 'tile-label', label), el('div', 'tile-value', value));
    if (sub) t.appendChild(sub);
    return t;
  }

  /** A clickable row inside a list card. */
  function rowButton(onClick, label) {
    const b = el('button', 'row');
    b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  }

  const isMe = (email) => !!data && !!data.me && email === data.me;

  /** Commits per day (7 / 30 days) or per week (12 months), oldest first. */
  function buckets() {
    const weekly = data.days > 60;
    const DAY = 864e5;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const count = weekly ? Math.ceil(data.days / 7) : data.days;
    const size = weekly ? 7 * DAY : DAY;
    const start = today + DAY - count * size;
    const list = Array.from({ length: count }, (_, i) => ({ from: start + i * size, to: start + (i + 1) * size, commits: 0, added: 0, deleted: 0 }));
    for (const c of data.commits) {
      const i = Math.floor((c.date - start) / size);
      if (i < 0 || i >= count) continue;
      list[i].commits++;
      list[i].added += c.added;
      list[i].deleted += c.deleted;
    }
    return { list, weekly };
  }

  function bucketLabel(b, weekly) {
    const f = (ms, o) => new Date(ms).toLocaleDateString('en-US', o);
    if (!weekly) return f(b.from, { weekday: 'short', month: 'short', day: 'numeric' });
    return `${f(b.from, { month: 'short', day: 'numeric' })} – ${f(b.to - 864e5, { month: 'short', day: 'numeric' })}`;
  }

  /** Round the axis maximum up to a clean number. */
  function niceMax(v) {
    if (v <= 4) return Math.max(1, v);
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
    return 10 * p;
  }

  /**
   * Column chart, one series (commits). Bars are focusable through the chart with ←/→;
   * hovering or focusing a bar shows its tooltip; a table view holds the same numbers.
   */
  function timeline() {
    const { list, weekly } = buckets();
    const card = section(weekly ? 'Commits per week' : 'Commits per day', 'graph');
    const toggle = button('Table', 'Show the numbers as a table', () => {
      tableView = !tableView;
      render();
    }, 'files', 'small');
    toggle.setAttribute('aria-pressed', tableView ? 'true' : 'false');
    card.querySelector('h2').appendChild(toggle);
    if (tableView) {
      const table = el('table', 'data-table');
      const head = el('tr');
      for (const t of [weekly ? 'Week' : 'Day', 'Commits', 'Added', 'Deleted']) head.appendChild(el('th', '', t));
      table.appendChild(head);
      for (const b of list.slice().reverse()) {
        const tr = el('tr');
        tr.append(el('td', '', bucketLabel(b, weekly)), el('td', 'num', b.commits), el('td', 'num add', `+${b.added}`), el('td', 'num del', `−${b.deleted}`));
        if (b.commits) {
          tr.tabIndex = 0;
          tr.className = 'clickable';
          const open = () => send({ type: 'commits', shas: data.commits.filter((c) => c.date >= b.from && c.date < b.to).map((c) => c.sha), label: `${bucketLabel(b, weekly)}: ${plural(b.commits, 'commit')}` });
          tr.addEventListener('click', open);
          tr.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') open();
          });
        }
        table.appendChild(tr);
      }
      card.appendChild(table);
      return card;
    }
    const wrap = el('div', 'chart');
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', `${weekly ? 'Commits per week' : 'Commits per day'}, ${list.length} ${weekly ? 'weeks' : 'days'}. Left and right arrow keys read each one, Enter shows its commits.`);
    wrap.style.cursor = 'pointer';
    const tip = el('div', 'tooltip');
    tip.setAttribute('role', 'status');
    card.append(wrap);
    const H = 150;
    const PAD_L = 30;
    const PAD_B = 22;
    const W = Math.max(280, (content.clientWidth || 800) - 48);
    const max = niceMax(Math.max(...list.map((b) => b.commits), 1));
    const slot = (W - PAD_L - 8) / list.length;
    const barW = Math.max(2, Math.min(24, slot - 2)); // thin marks; the gap is surface
    const y = (v) => H - PAD_B - (v / max) * (H - PAD_B - 10);
    const chart = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true', class: 'chart-svg' });
    // Recessive axis: a baseline and one gridline at the maximum.
    for (const v of [0, max]) {
      chart.appendChild(svg('line', { x1: PAD_L, x2: W - 4, y1: y(v), y2: y(v), class: v ? 'grid' : 'axis' }));
      const t = svg('text', { x: PAD_L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' });
      t.textContent = ui.compact(v);
      chart.appendChild(t);
    }
    const bars = list.map((b, i) => {
      const x = PAD_L + i * slot + (slot - barW) / 2;
      const top = y(b.commits);
      const h = H - PAD_B - top;
      const r = Math.min(4, barW / 2, h);
      // 4px rounded data-end, square at the baseline.
      const d = b.commits
        ? `M${x} ${H - PAD_B}V${top + r}Q${x} ${top} ${x + r} ${top}H${x + barW - r}Q${x + barW} ${top} ${x + barW} ${top + r}V${H - PAD_B}Z`
        : '';
      const p = svg('path', { d, class: 'bar' });
      chart.appendChild(p);
      return p;
    });
    // A few x labels: first, middle, last.
    for (const i of [...new Set([0, Math.floor((list.length - 1) / 2), list.length - 1])]) {
      const t = svg('text', { x: PAD_L + i * slot + slot / 2, y: H - 6, 'text-anchor': i === 0 ? 'start' : i === list.length - 1 ? 'end' : 'middle', class: 'tick' });
      t.textContent = new Date(list[i].from).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      chart.appendChild(t);
    }
    wrap.append(chart, tip);
    let active = -1;
    const show = (i, announce) => {
      active = i;
      bars.forEach((p, k) => p.classList.toggle('active', k === i));
      if (i < 0) {
        tip.classList.remove('visible');
        return;
      }
      const b = list[i];
      tip.replaceChildren(el('strong', '', plural(b.commits, 'commit')), el('span', 'dim', bucketLabel(b, weekly)));
      if (b.commits) tip.append(el('span', 'add', `+${ui.compact(b.added)}`), el('span', 'del', `−${ui.compact(b.deleted)}`));
      tip.classList.add('visible');
      const x = PAD_L + i * slot + slot / 2;
      tip.style.left = `${Math.max(0, Math.min(W - 180, x - 90))}px`;
      if (announce) announcer.textContent = `${bucketLabel(b, weekly)}: ${plural(b.commits, 'commit')}${b.commits ? `, ${b.added} lines added, ${b.deleted} deleted` : ''}`;
    };
    // The whole slot is the hit target, not just the painted bar.
    wrap.addEventListener('pointermove', (e) => {
      const rect = chart.getBoundingClientRect();
      const i = Math.floor((e.clientX - rect.left - PAD_L) / slot);
      show(i >= 0 && i < list.length ? i : -1, false);
    });
    wrap.addEventListener('pointerleave', () => show(-1));
    wrap.addEventListener('focus', () => show(active >= 0 ? active : list.length - 1, true));
    wrap.addEventListener('blur', () => show(-1));
    /** Open a bar: the commits of that day or week (one opens directly, several to choose from). */
    const openBucket = (i) => {
      const b = list[i];
      if (!b || !b.commits) return;
      const shas = data.commits.filter((c) => c.date >= b.from && c.date < b.to).map((c) => c.sha);
      send({ type: 'commits', shas, label: `${bucketLabel(b, weekly)}: ${plural(b.commits, 'commit')}` });
    };
    wrap.addEventListener('click', () => {
      if (active >= 0) openBucket(active);
    });
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openBucket(active);
        return;
      }
      const to = { ArrowLeft: active - 1, ArrowRight: active + 1, Home: 0, End: list.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      show(Math.max(0, Math.min(list.length - 1, to)), true);
    });
    return card;
  }

  function people() {
    const card = section('People', 'person');
    const top = data.people.slice(0, 10);
    const max = Math.max(...top.map((p) => p.commits), 1);
    for (const p of top) {
      const b = rowButton(() => send({ type: 'author', name: p.name, email: p.email }), `${p.name}: ${plural(p.commits, 'commit')}, ${p.added} added, ${p.deleted} deleted. Show their commits in the graph.`);
      const name = el('span', 'name', `${p.name}${isMe(p.email) ? ' (you)' : ''}`);
      const bar = el('span', 'hbar');
      const fill = el('span', 'hbar-fill');
      fill.style.width = `${Math.max(3, Math.round((p.commits / max) * 100))}%`;
      bar.appendChild(fill);
      const stats = el('span', 'stats');
      stats.append(el('span', 'strong', plural(p.commits, 'commit')), el('span', 'add', `+${ui.compact(p.added)}`), el('span', 'del', `−${ui.compact(p.deleted)}`));
      b.append(ui.avatar(p.name, p.email, 22), name, bar, stats);
      b.title = `${p.name} <${p.email}> — last commit ${ui.longAge(p.last)}`;
      card.appendChild(b);
    }
    if (data.people.length > top.length) card.appendChild(el('div', 'note', `and ${plural(data.people.length - top.length, 'more person', 'more people')}`));
    return card;
  }

  function files() {
    const card = section('Busiest files', 'files');
    for (const f of data.files) {
      const name = f.path.split('/').pop();
      const dir = f.path.slice(0, f.path.length - name.length);
      const b = rowButton(() => send({ type: 'file', path: f.path }), `${f.path}: changed in ${plural(f.commits, 'commit')}. Open its history.`);
      const label = el('span', 'name');
      label.append(el('span', '', name), el('span', 'dim', ` ${dir}`));
      const stats = el('span', 'stats');
      stats.append(ui.statBar(f.added, f.deleted, 34), el('span', 'strong', plural(f.commits, 'commit')), el('span', 'add', `+${ui.compact(f.added)}`), el('span', 'del', `−${ui.compact(f.deleted)}`));
      b.append(ui.icon('files'), label, stats);
      b.title = f.path;
      card.appendChild(b);
    }
    return card;
  }

  function pulls() {
    const card = section('Merged pull requests', 'branch');
    for (const p of data.pulls) {
      // The changes open here, in VS Code; GitHub is one Tab further.
      const line = el('div', 'row-line');
      const b = rowButton(() => send({ type: 'openCommit', sha: p.sha }), `Pull request ${p.number}: ${p.title}, merged by ${p.author} ${ui.longAge(p.date)}. Show its changes.`);
      const age = el('span', 'age', ui.shortAge(p.date));
      age.title = ui.fullDate(p.date);
      b.append(el('span', 'pr-number', `#${p.number}`), el('span', 'name', p.title), ui.avatar(p.author, p.email, 18), age);
      line.appendChild(b);
      if (data.hasGitHub) line.appendChild(button('', `Open pull request #${p.number} on GitHub`, () => send({ type: 'pull', number: p.number }), 'open', 'icon-only'));
      card.appendChild(line);
    }
    return card;
  }

  function branches() {
    const card = section('Active branches', 'branch');
    for (const br of data.branches) {
      const b = rowButton(() => send({ type: 'branch', rev: br.rev }), `${br.name}: last commit ${ui.longAge(br.date)} by ${br.author}, ${br.subject}. Show it in the graph.`);
      const age = el('span', 'age', ui.shortAge(br.date));
      age.title = ui.fullDate(br.date);
      const label = el('span', 'name');
      label.append(el('span', 'strong', br.name), el('span', 'dim', ` ${br.subject}`));
      b.append(ui.icon(br.type === 'remote' ? 'cloud' : 'branch'), label, ui.avatar(br.author, br.email, 18), age);
      card.appendChild(b);
    }
    return card;
  }

  function tags() {
    const card = section('New tags', 'tag');
    for (const t of data.tags) {
      const b = rowButton(() => send({ type: 'branch', rev: t.rev }), `Tag ${t.name}, ${ui.longAge(t.date)}. Show it in the graph.`);
      const age = el('span', 'age', ui.shortAge(t.date));
      age.title = ui.fullDate(t.date);
      b.append(ui.icon('tag'), el('span', 'name strong', t.name), age);
      card.appendChild(b);
    }
    return card;
  }

  // ---------------------------------------------------------------- render

  let tableView = false;

  function render() {
    if (!data) return;
    const active = /** @type {HTMLElement|null} */ (document.activeElement);
    const focused = active && active.closest('section') ? [...content.querySelectorAll('section')].indexOf(active.closest('section')) : -1;
    // The same control after re-rendering: same kind, class and title (the chart, a button, …).
    const same = active ? `${active.tagName}|${active.className}|${active.title || ''}` : '';
    const span = PERIODS.find(([d]) => d === data.days)[1].toLowerCase();
    const added = data.commits.reduce((n, c) => n + c.added, 0);
    const deleted = data.commits.reduce((n, c) => n + c.deleted, 0);
    const changes = data.commits.reduce((n, c) => n + c.files, 0);
    const kpis = el('div', 'kpis');
    const lines = el('div', 'tile-sub');
    lines.append(el('span', 'add', `+${ui.compact(added)}`), el('span', 'del', `−${ui.compact(deleted)}`));
    kpis.append(
      tile('Commits', ui.compact(data.commits.length)),
      tile('People', String(data.people.length)),
      tile('Lines changed', ui.compact(added + deleted), lines),
      tile('File changes', ui.compact(changes)),
      tile('Merged pull requests', String(data.pulls.length)),
    );
    const parts = [kpis];
    if (data.truncated) parts.push(el('div', 'note', `Only the newest ${data.commits.length.toLocaleString('en-US')} commits are counted.`));
    if (!data.commits.length) {
      parts.push(el('div', 'empty', `No commits in the ${span} on ${data.scope === 'current' ? 'the current branch' : 'any branch'}.`));
    } else {
      parts.push(timeline());
      const grid = el('div', 'grid');
      grid.append(people(), files());
      if (data.pulls.length) grid.appendChild(pulls());
      if (data.branches.length) grid.appendChild(branches());
      if (data.tags.length) grid.appendChild(tags());
      parts.push(grid);
    }
    content.replaceChildren(...parts);
    content.classList.remove('loading');
    if (focused >= 0) {
      const s = content.querySelectorAll('section')[focused];
      const candidates = s ? /** @type {HTMLElement[]} */ ([...s.querySelectorAll('button, [tabindex="0"]')]) : [];
      const f = candidates.find((e) => `${e.tagName}|${e.className}|${e.title || ''}` === same) || candidates[0];
      if (f) f.focus();
    }
  }

  /**
   * When VS Code opens or focuses the tab (Ctrl+Alt+G T), the keyboard lands on the chart (or
   * the period when there is none), not on <body> where Tab would have to find a start.
   */
  function focusStart() {
    if (document.activeElement && document.activeElement !== document.body) return;
    const target = /** @type {HTMLElement|null} */ (content.querySelector('.chart[tabindex="0"]'))
      || periodButtons.find((b) => b.tabIndex === 0) || null;
    if (target) target.focus();
  }
  window.addEventListener('focus', focusStart);
  let focusedOnce = false;

  window.addEventListener('message', (event) => {
    const m = event.data;
    if (m.type === 'focus') {
      focusStart();
      return;
    }
    if (m.type === 'loading') {
      // Refetch keeps the frame: the old numbers stay, dimmed, until the new ones arrive.
      content.classList.add('loading');
      return;
    }
    if (m.type === 'error') {
      content.classList.remove('loading');
      content.replaceChildren(el('div', 'error', m.message));
      return;
    }
    if (m.type !== 'data') return;
    data = m;
    state.days = m.days;
    state.scope = m.scope;
    state.repoRoot = m.repoRoot;
    vscode.setState({ days: m.days, scope: m.scope, repoRoot: m.repoRoot });
    repoName.textContent = m.repoName;
    scopeSelect.replaceChildren();
    const scopes = [['all', 'All branches'], ['current', m.branch ? `Current branch (${m.branch})` : 'Current branch']];
    if (m.scope.startsWith('ref:')) scopes.push([m.scope, `Branch ${m.scope.slice(4)}`]);
    scopes.push(['pick', 'Other branch…']);
    for (const [v, l] of scopes) {
      const o = el('option', '', l);
      o.setAttribute('value', v);
      scopeSelect.appendChild(o);
    }
    scopeSelect.value = m.scope;
    updateFilters();
    render();
    if (!focusedOnce) {
      // Like the graph: the start element is focused inside the page, so the keyboard is there
      // as soon as VS Code focuses the tab.
      focusedOnce = true;
      focusStart();
    }
    announcer.textContent = `${plural(m.commits.length, 'commit')} by ${plural(m.people.length, 'person', 'people')} in the ${PERIODS.find(([d]) => d === m.days)[1].toLowerCase()}.`;
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 150);
  });

  updateFilters();
  send({ type: 'ready' });
})();
