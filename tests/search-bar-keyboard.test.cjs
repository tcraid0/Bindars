const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderComponent, pressKey } = require('./_helpers/component-view.cjs');
const { SearchBar } = require('../.tmp/workspace-tests/src/components/SearchBar.js');

for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
  test(`SearchBar IME ${Object.keys(composition)[0]} preserves visibility and the current match`, () => {
    let currentIndex = 1, closed = false;
    function Search() {
      const [index, setIndex] = React.useState(currentIndex);
      const [visible, setVisible] = React.useState(true);
      return React.createElement(SearchBar, {
        visible, query: 'word', matchCount: 3, currentIndex: index,
        onQueryChange() {},
        onNext() { currentIndex++; setIndex(currentIndex); },
        onPrevious() { currentIndex--; setIndex(currentIndex); },
        onClose() { closed = true; setVisible(false); },
      });
    }
    const view = renderComponent(Search);
    try {
      for (const [key, shiftKey] of [['Enter', false], ['Enter', true], ['Escape', false]]) {
        assert.equal(pressKey(key, { ...composition, shiftKey }).defaultPrevented, false);
        assert.equal(currentIndex, 1);
        assert.equal(closed, false);
        assert.match(view.host.textContent, /2 of 3/);
        assert.equal(view.host.querySelector('input').value, 'word');
      }
      assert.equal(pressKey('Enter').defaultPrevented, true);
      assert.match(view.host.textContent, /3 of 3/);
      assert.equal(pressKey('Enter', { shiftKey: true }).defaultPrevented, true);
      assert.match(view.host.textContent, /2 of 3/);
      assert.equal(pressKey('Escape').defaultPrevented, true);
      assert.equal(closed, true);
      assert.ok(!view.host.querySelector('input'));
    } finally { view.cleanup(); }
  });
}
