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
  const press = (key, mods = {}) => {
    const e = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, altKey: !!mods.alt, prevented: false, preventDefault() { this.prevented = true; } };
    listeners.keydown(e);
    return e;
  };
  return { keys, press, blur: () => listeners.blur(), wait: (ms) => (clock += ms) };
}

test("the key after Ctrl+Alt+G (Cmd+Alt+G) is VS Code's: marked for the page, no character typed", () => {
  const { keys, press } = load();
  assert.ok(!keys.has(press('g', { ctrl: true, alt: true })), 'the chord itself goes on');
  press('Shift'); // a modifier on its way to Shift+W is not the second key
  const w = press('W');
  assert.ok(keys.has(w) && w.prevented);
  const s = press('s');
  assert.ok(!keys.has(s) && !s.prevented, 'the chord has ended: an ordinary key again');
  press('g', { meta: true, alt: true });
  assert.ok(keys.has(press('s')), 'macOS');
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
