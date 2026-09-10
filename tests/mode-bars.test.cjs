const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { flushSync } = require('react-dom');
const { createRoot } = require('react-dom/client');
const { installDom } = require('./_helpers/dom.cjs');
const { FocusBar } = require('../.tmp/workspace-tests/src/components/FocusBar.js');
const { PresentationBar } = require('../.tmp/workspace-tests/src/components/PresentationBar.js');

for (const mode of ['focus', 'presentation']) {
  test(`mode bars: ${mode} pointer visibility resets without disturbing focus through mouse departure and touch expiry`, async t => {
    await installDom();
    const originalMedia = globalThis.matchMedia;
    globalThis.matchMedia = () => ({ matches: false });
    t.after(() => { globalThis.matchMedia = originalMedia; });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let frame;
    t.mock.method(globalThis, 'requestAnimationFrame', callback => { frame = callback; return 1; });
    t.mock.method(globalThis, 'cancelAnimationFrame', () => {});
    const style = document.createElement('style');
    style.textContent = fs.readFileSync(path.join(__dirname, '../src/app.css'), 'utf8');
    document.head.append(style);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    const props = mode === 'focus' ? {
      fileName: 'Synthetic.md', isDirty: false, isSavedFlash: false, saveWarning: null,
      onExit() {}, statsSummary: null, progressTextRef: { current: null }, reducedEffects: true,
      showMarkdownFormatting: false, markdownFormattingEnabled: true, onToggleMarkdownFormatting() {},
    } : { currentSlide: 0, totalSlides: 2, onExit() {} };
    try {
      flushSync(() => root.render(React.createElement(mode === 'focus' ? FocusBar : PresentationBar, props)));
      const exit = host.querySelector('button');
      const bar = exit.parentElement;
      assert.equal(window.getComputedStyle(bar).opacity, '0');
      flushSync(() => {
        window.dispatchEvent(new window.MouseEvent('mousemove', { clientY: mode === 'focus' ? 0 : window.innerHeight }));
        frame();
      });
      assert.equal(window.getComputedStyle(bar).opacity, '1');
      exit.focus();
      flushSync(() => document.dispatchEvent(new window.Event('mouseleave')));
      // happy-dom does not implement :focus-within. Verify the pointer state
      // and absence of inline overrides here; native acceptance checks pixels.
      assert.equal(bar.dataset.visible, 'false');
      assert.ok(document.activeElement === exit);
      assert.equal(bar.style.opacity, '');
      assert.equal(bar.style.pointerEvents, '');
      if (mode === 'presentation') {
        flushSync(() => window.dispatchEvent(new window.Event('touchstart')));
        flushSync(() => t.mock.timers.tick(3000));
        assert.equal(bar.dataset.visible, 'false');
        assert.ok(document.activeElement === exit);
      } else assert.equal(bar.style.transition, 'none');
      exit.blur();
      assert.equal(window.getComputedStyle(bar).opacity, '0');
      assert.equal(window.getComputedStyle(bar).pointerEvents, 'none');
    } finally { flushSync(() => root.unmount()); host.remove(); style.remove(); }
  });
}

test('mode bars: coarse-pointer presentation remains visible without hover or focus', async t => {
  await installDom();
  const original = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  t.after(() => { globalThis.matchMedia = original; });
  const style = document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '../src/app.css'), 'utf8');
  document.head.append(style);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(React.createElement(PresentationBar, { currentSlide: 0, totalSlides: 1, onExit() {} })));
    const bar = host.querySelector('button').parentElement;
    flushSync(() => document.dispatchEvent(new window.Event('mouseleave')));
    assert.equal(window.getComputedStyle(bar).opacity, '1');
    assert.equal(window.getComputedStyle(bar).pointerEvents, 'auto');
  } finally { flushSync(() => root.unmount()); host.remove(); style.remove(); }
});
