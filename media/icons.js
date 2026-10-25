// @ts-check
/* Commit Corner — small inline SVG icon set and initials avatars shared by the webviews.
 * Drawn here (16×16, currentColor) so the extension ships no font or icon library. */
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** name -> list of [element, attributes]; strokes use currentColor. */
  const ICONS = {
    branch: [['circle', { cx: 5, cy: 3.5, r: 1.7 }], ['circle', { cx: 5, cy: 12.5, r: 1.7 }], ['circle', { cx: 11, cy: 4.5, r: 1.7 }], ['path', { d: 'M5 5.2v5.6M11 6.2c0 3-6 2.2-6 4.6' }]],
    pr: [['circle', { cx: 4.5, cy: 3.5, r: 1.7 }], ['circle', { cx: 4.5, cy: 12.5, r: 1.7 }], ['circle', { cx: 11.5, cy: 12.5, r: 1.7 }], ['path', { d: 'M4.5 5.2v5.6M11.5 10.8V6.5a2 2 0 0 0-2-2H7.5M9 3l-1.5 1.5L9 6' }]],
    cloud: [['path', { d: 'M4.6 12.5h6.9a2.7 2.7 0 0 0 .3-5.4A4 4 0 0 0 4.2 6 3.3 3.3 0 0 0 4.6 12.5z' }]],
    minus: [['path', { d: 'M3.5 8h9' }]],
    sparkle: [['path', { d: 'M7 1.5 8.3 5.7 12.5 7 8.3 8.3 7 12.5 5.7 8.3 1.5 7 5.7 5.7z' }], ['path', { d: 'M12.5 10.5v4M10.5 12.5h4' }]],
    stop: [['rect', { x: 3.5, y: 3.5, width: 9, height: 9, rx: 1 }]],
    undo: [['path', { d: 'M3.5 8.5a4.5 4.5 0 1 0 1.4-3.3' }], ['path', { d: 'M4.7 2.4v2.9h2.9' }]],
    discard: [['path', { d: 'M5.5 4.5 3 7l2.5 2.5' }], ['path', { d: 'M3 7h6.5a3.5 3.5 0 0 1 0 7H7' }]],
    tag: [['path', { d: 'M2.5 2.5h5.3l5.9 5.9-5.3 5.3-5.9-5.9z' }], ['circle', { cx: 5.3, cy: 5.3, r: 0.9 }]],
    commit: [['circle', { cx: 8, cy: 8, r: 2.6 }], ['path', { d: 'M1 8h4.4M10.6 8H15' }]],
    clock: [['circle', { cx: 8, cy: 8, r: 6 }], ['path', { d: 'M8 4.6V8l2.4 1.6' }]],
    files: [['path', { d: 'M4 1.5h5l3 3v10H4z' }], ['path', { d: 'M9 1.5v3h3' }]],
    person: [['circle', { cx: 8, cy: 5.3, r: 2.6 }], ['path', { d: 'M3 14c.5-3 2.6-4.6 5-4.6s4.5 1.6 5 4.6' }]],
    up: [['path', { d: 'M8 13.5V3M4 7l4-4 4 4' }]],
    down: [['path', { d: 'M8 2.5V13M4 9l4 4 4-4' }]],
    sync: [['path', { d: 'M13 8a5 5 0 0 1-9.2 2.7M3 8a5 5 0 0 1 9.2-2.7M12.6 2.2v3.2H9.4M3.4 13.8v-3.2h3.2' }]],
    refresh: [['path', { d: 'M13.2 8.3A5.2 5.2 0 1 1 11.6 4M12.4 1.6v3h-3' }]],
    search: [['circle', { cx: 7, cy: 7, r: 4.5 }], ['path', { d: 'M10.4 10.4 14 14' }]],
    check: [['path', { d: 'M3 8.5l3.2 3.2L13 4.8' }]],
    edit: [['path', { d: 'M10.5 2.5l3 3-8 8H2.5v-3z' }]],
    plus: [['path', { d: 'M8 3v10M3 8h10' }]],
    warning: [['path', { d: 'M8 2 14.5 13.5h-13z' }], ['path', { d: 'M8 6.5v3.5M8 11.6v.4' }]],
    folder: [['path', { d: 'M1.5 3.5h4.6L7.6 5h6.9v8.5h-13z' }]],
    worktree: [['rect', { x: 1.5, y: 2, width: 5, height: 4, rx: 0.8 }], ['rect', { x: 9.5, y: 10, width: 5, height: 4, rx: 0.8 }], ['path', { d: 'M4 6v3.5a2.5 2.5 0 0 0 2.5 2.5h3' }]],
    target: [['circle', { cx: 8, cy: 8, r: 5.5 }], ['circle', { cx: 8, cy: 8, r: 2 }]],
    copy: [['rect', { x: 5, y: 5, width: 8.5, height: 9, rx: 1 }], ['path', { d: 'M3 10.5V2.5h7.5' }]],
    filter: [['path', { d: 'M2 3h12L9.5 8.5V13l-3 1.5v-6z' }]],
    open: [['path', { d: 'M9 2h5v5M14 2 7.5 8.5M12 9.5V14H2V4h4.5' }]],
    window: [['rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1 }], ['path', { d: 'M1.5 5.5h13' }]],
    graph: [['circle', { cx: 4, cy: 3.5, r: 1.6 }], ['circle', { cx: 4, cy: 12.5, r: 1.6 }], ['circle', { cx: 12, cy: 8, r: 1.6 }], ['path', { d: 'M4 5.1v5.8M5.5 4.2c3.5.6 5 1.6 5.4 2.4' }]],
    trash: [['path', { d: 'M2.5 4h11M6 4V2.5h4V4M4 4l.8 10h6.4L12 4' }]],
    lock: [['rect', { x: 3, y: 7, width: 10, height: 7, rx: 1 }], ['path', { d: 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2' }]],
    stash: [['rect', { x: 1.5, y: 2.5, width: 13, height: 3, rx: 0.6 }], ['path', { d: 'M2.5 5.5v8h11v-8M6 8.5h4' }]],
    diff: [['path', { d: 'M5 2v6M2 5h6M2 12h6M10 3.5h3.5v10H10' }]],
    terminal: [['rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1 }], ['path', { d: 'M4 6l2.5 2L4 10M8 10.5h4' }]],
    chevron: [['path', { d: 'M6 3.5 10.5 8 6 12.5' }]],
    close: [['path', { d: 'M4 4l8 8M12 4l-8 8' }]],
    cloudDown: [['path', { d: 'M4.6 11.5H4.4A3.2 3.2 0 0 1 4.2 5.2 4 4 0 0 1 11.8 6.3a2.6 2.6 0 0 1 .2 5.2h-.4' }], ['path', { d: 'M8 7.5v6.5M5.8 11.8 8 14l2.2-2.2' }]],
    help: [['circle', { cx: 8, cy: 8, r: 6 }], ['path', { d: 'M6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.6.3-.8.7-.8 1.3M8 11.4v.4' }]],
  };

  /**
   * An icon element. Decorative by default (aria-hidden); pass a label for a meaningful one.
   * @param {string} name
   * @param {{cls?: string, label?: string, size?: number}} [o]
   */
  function icon(name, o = {}) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const size = String(o.size || 14);
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('class', `icon icon-${name}${o.cls ? ` ${o.cls}` : ''}`);
    if (o.label) {
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', o.label);
    } else svg.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of ICONS[name] || []) {
      const e = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      svg.appendChild(e);
    }
    return svg;
  }

  /**
   * Twelve clearly different avatar colours (all readable with white initials), picked by a
   * well-mixed hash (FNV-1a) of the e-mail, so similar addresses still look different.
   */
  const AVATAR_COLORS = ['#1f6fa8', '#c0392b', '#23802b', '#7b52ab', '#b9440a', '#0d7684', '#8c564b', '#a83f8f', '#3a7d44', '#5254a3', '#94520f', '#5a6e33'];
  function hue(key) {
    let h = 0x811c9dc5;
    for (const ch of String(key || '').toLowerCase()) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % AVATAR_COLORS.length;
  }

  /** Up to two initials: "Ada Lovelace" -> "AL", "t0mdev" -> "T". */
  function initials(name) {
    const words = String(name || '?').replace(/[<>()[\]"']/g, '').split(/[\s._-]+/).filter(Boolean);
    if (!words.length) return '?';
    const first = [...words[0]][0] || '?';
    const last = words.length > 1 ? [...words[words.length - 1]][0] || '' : '';
    return (first + last).toUpperCase();
  }

  /**
   * A round initials avatar, coloured per person (no network: nothing is fetched).
   * @param {string} name
   * @param {string} email
   * @param {number} [size]
   */
  function avatar(name, email, size = 16) {
    const a = document.createElement('span');
    a.className = 'avatar';
    a.textContent = initials(name);
    a.setAttribute('aria-hidden', 'true');
    a.style.width = `${size}px`;
    a.style.height = `${size}px`;
    a.style.lineHeight = `${size}px`;
    a.style.fontSize = `${Math.max(7, Math.round(size * 0.45))}px`;
    a.style.backgroundColor = AVATAR_COLORS[hue(email || name)];
    return a;
  }

  /** Compact number: 1234 -> "1.2k". */
  function compact(n) {
    if (n < 1000) return String(n);
    if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return `${Math.round(n / 1000)}k`;
  }

  /** Short relative time: "now", "5m", "7h", "3d", "5w", then "Oct 2" / "Oct 2024". */
  function shortAge(ms, now = Date.now()) {
    const s = Math.max(0, (now - ms) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
    if (s < 86400 * 49) return `${Math.floor(s / 86400 / 7)}w`;
    const d = new Date(ms);
    const month = d.toLocaleString('en-US', { month: 'short' });
    return d.getFullYear() === new Date(now).getFullYear() ? `${month} ${d.getDate()}` : `${month} ${d.getFullYear()}`;
  }

  /** At most three characters, for narrow columns: "now", "5m", "7h", "3d", "5w", "4mo", "2y". */
  function tinyAge(ms, now = Date.now()) {
    const s = Math.max(0, (now - ms) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
    if (s < 86400 * 56) return `${Math.floor(s / 86400 / 7)}w`;
    if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30.4)}mo`;
    return `${Math.floor(s / 86400 / 365)}y`;
  }

  /** "10/16" this year, "10/16/24" before: for date columns when relative ages are turned off. */
  function shortDate(ms, now = Date.now()) {
    const d = new Date(ms);
    const md = `${d.getMonth() + 1}/${d.getDate()}`;
    return d.getFullYear() === new Date(now).getFullYear() ? md : `${md}/${String(d.getFullYear()).slice(2)}`;
  }

  /** "7 hours ago" */
  function longAge(ms, now = Date.now()) {
    const diff = now - ms;
    const units = [['year', 31536e6], ['month', 2592e6], ['week', 6048e5], ['day', 864e5], ['hour', 36e5], ['minute', 6e4]];
    for (const [u, s] of units) {
      const n = Math.floor(diff / /** @type {number} */ (s));
      if (n >= 1) return `${n} ${u}${n === 1 ? '' : 's'} ago`;
    }
    return 'just now';
  }

  /** "October 16, 2026, 1:38 PM" */
  function fullDate(ms) {
    return new Date(ms).toLocaleString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  /**
   * A small added/deleted bar: green and red parts in proportion, the total length growing
   * logarithmically with the size of the change.
   */
  function statBar(added, deleted, width = 44) {
    const bar = document.createElement('span');
    bar.className = 'stat-bar';
    bar.setAttribute('aria-hidden', 'true');
    const total = added + deleted;
    // Log scale up to ~1000 lines, at least 6px: small and medium commits still look different.
    const len = total ? Math.max(6, Math.min(width, Math.round((Math.log10(total + 1) / 3) * width))) : 0;
    const add = document.createElement('span');
    add.className = 'bar-add';
    const del = document.createElement('span');
    del.className = 'bar-del';
    add.style.width = `${total ? Math.round((len * added) / total) : 0}px`;
    del.style.width = `${total ? len - Math.round((len * added) / total) : 0}px`;
    bar.style.width = `${width}px`;
    bar.append(add, del);
    return bar;
  }

  // @ts-ignore
  window.gaUi = { icon, avatar, initials, hue, compact, shortAge, tinyAge, shortDate, longAge, fullDate, statBar };
})();
