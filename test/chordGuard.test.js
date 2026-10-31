'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** media/icons.js in a page without a DOM: its shared helpers, and a window that records listeners. */
function load() {
  const listeners = {};
  const window = { addEventListener: (type, fn) => (listeners[type] = fn) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'media', 'icons.js'), 'utf8'), { window });
  let clock = 1000;
  const keys = window.gaUi.chordGuard(window, () => clock);
  const code = (key) => (key.length === 1 ? `Key${key.toUpperCase()}` : key);
  const press = (key, mods = {}) => {
    const e = { key, code: code(key), ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, altKey: !!mods.alt, repeat: !!mods.repeat, isTrusted: mods.script ? false : true, prevented: false, preventDefault() { this.prevented = true; } };
    listeners.keydown(e);
    return e;
  };
  const release = (key) => listeners.keyup({ key, code: code(key) });
  return { keys, press, release, raw: (e) => listeners.keydown(e), blur: () => listeners.blur(), wait: (ms) => (clock += ms) };
}

test("the key after Ctrl+Alt+G (Cmd+Alt+G) is VS Code's: marked for the page, no character typed", () => {
  const { keys, press, raw } = load();
  assert.ok(!keys.has(press('g', { ctrl: true, alt: true })), 'the chord itself goes on');
  press('Shift'); // a modifier on its way to Shift+W is not the second key
  const w = press('W');
  assert.ok(keys.has(w) && w.prevented);
  const s = press('s');
  assert.ok(!keys.has(s) && !s.prevented, 'the chord has ended: an ordinary key again');
  press('g', { meta: true, alt: true });
  assert.ok(keys.has(press('s')), 'macOS');
  // macOS: Cmd+Alt+G reports "©" as its key; the physical key (code) counts.
  const mac = { key: '©', code: 'KeyG', metaKey: true, altKey: true, ctrlKey: false, isTrusted: true, preventDefault() {} };
  raw(mac);
  assert.ok(keys.has(press('s')), 'Cmd+Alt+G with its © key');
  press('g', { ctrl: true });
  assert.ok(!keys.has(press('s')), 'Ctrl+G alone is no chord');
  press('g', { ctrl: true, alt: true });
  assert.ok(keys.has(press('g', { ctrl: true, alt: true })), 'Ctrl+Alt+G Ctrl+Alt+G: the second is the second key');
  assert.ok(!keys.has(press('p')));
});

test('a chord lasts as long as VS Code waits (5 s) and ends when the window loses focus', () => {
  const { keys, press, wait, blur } = load();
  press('g', { ctrl: true, alt: true });
  wait(4900);
  assert.ok(keys.has(press('s')));
  press('g', { ctrl: true, alt: true });
  wait(5100);
  assert.ok(!keys.has(press('s')), 'VS Code has given up on it');
  press('g', { ctrl: true, alt: true });
  blur();
  assert.ok(!keys.has(press('s')));
});

test("a held second key stays VS Code's while it repeats; a page's own copy of a key is no key press", () => {
  const { keys, press, release, blur } = load();
  press('g', { ctrl: true, alt: true });
  press('Space');
  blur();
  assert.ok(!keys.has(press('Space', { repeat: true })), 'after the window lost focus');
  press('g', { ctrl: true, alt: true });
  assert.ok(keys.has(press('Enter', { ctrl: true, alt: true })));
  assert.ok(keys.has(press('Enter', { ctrl: true, alt: true, repeat: true })), 'its repeats too');
  assert.ok(!keys.has(press('ArrowDown', { repeat: true })), "another key's repeats are the page's");
  release('Enter');
  assert.ok(!keys.has(press('Enter', { ctrl: true, alt: true, repeat: true })), 'once released, keys are the page\'s again');
  // Its keyup went to VS Code (the key opened something else): back here, a held key is the page's.
  press('g', { ctrl: true, alt: true });
  press('ArrowRight');
  assert.ok(!keys.has(press('ArrowRight')), 'a fresh press ends it');
  assert.ok(!keys.has(press('ArrowRight', { repeat: true })));
  // A script's copy of Ctrl+Alt+G (the graph hands keys on to its list) neither starts nor ends a chord.
  press('g', { ctrl: true, alt: true });
  press('g', { ctrl: true, alt: true, script: true });
  assert.ok(keys.has(press('s')));
});
