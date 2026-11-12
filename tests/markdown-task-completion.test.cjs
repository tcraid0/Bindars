const test = require('node:test');
const assert = require('node:assert/strict');
const { EditorSelection } = require('@codemirror/state');
const { undo, redo, undoDepth } = require('@codemirror/commands');
const { executeFormattingCommand } = require('../.tmp/workspace-tests/src/components/markdown-formatting-commands.js');
const { useSpec, withView } = require('./_helpers/markdown-command-view.cjs');
const { markdownArticle } = require('./_helpers/markdown-reader.cjs');
const complete = view => executeFormattingCommand(view, 'toggleTask');

for (const prefix of ['- ', '+ ', '* ', '12. ', '12) ', '- parent\n  - ']) {
  for (const marker of ['[ ]', '[x]', '[X]']) {
    test(`completion swaps only the middle character: ${JSON.stringify(prefix)}${marker}`, () => {
      const source = prefix + marker + '  original task\n    child continuation\n\n- [X] neighbour';
      const from = prefix.length + 1;
      withView(source, EditorSelection.cursor(from), {}, view => {
        const selection = view.state.selection;
        assert.equal(complete(view).applied, true);
        const expected = source.slice(0, from) + (marker === '[ ]' ? 'x' : ' ') + source.slice(from + 1);
        assert.equal(view.state.sliceDoc(), expected);
        assert.equal(view.state.selection.main.head, selection.main.head);
        assert.equal(undoDepth(view.state), 1);
        assert.equal(undo(view), true); assert.equal(view.state.sliceDoc(), source);
        assert.equal(redo(view), true); assert.equal(view.state.sliceDoc(), expected);
      });
    });
  }
}
for (const separator of ['\n', '\r\n', '\r']) {
  for (const prefix of ['', '\uFEFF\n\n', '\uFEFF---\ntitle: Test\n---\n\n']) {
    test(`completion preserves ${JSON.stringify(separator)} and ${JSON.stringify(prefix)}`, () => {
      const source = (prefix + '- [ ] target\n  - [X] child\n- [ ] neighbour\n').replaceAll('\n', separator);
      // Positions inside CodeMirror use LF, irrespective of saved line endings.
      const normalized = source.replaceAll(separator, '\n');
      const at = normalized.indexOf('target');
      withView(source, EditorSelection.single(at + 6, at), { lineSeparator: separator }, view => {
        assert.equal(complete(view).applied, true);
        assert.equal(view.state.sliceDoc(), source.replace('[ ]', '[x]'));
        assert.deepEqual([view.state.selection.main.anchor, view.state.selection.main.head], [at + 6, at]);
        const article = markdownArticle(view.state.sliceDoc());
        assert.equal(article.querySelector('input').checked, true);
      });
    });
  }
}

test('completion is isolated between typing, including Undo and Redo of each step', () => {
  useSpec('- [ ] ta|sk', {}, view => {
    view.dispatch({ changes: { from: 10, insert: 'A' }, userEvent: 'input.type' });
    const typed = view.state.sliceDoc();
    assert.equal(complete(view).applied, true);
    const ticked = view.state.sliceDoc();
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'B' }, userEvent: 'input.type' });
    const final = view.state.sliceDoc();
    assert.equal(undoDepth(view.state), 3);
    for (const expected of [ticked, typed, '- [ ] task']) { assert.equal(undo(view), true); assert.equal(view.state.sliceDoc(), expected); }
    for (const expected of [typed, ticked, final]) { assert.equal(redo(view), true); assert.equal(view.state.sliceDoc(), expected); }
  });
});

function refuses(view, reason) {
  const before = view.state;
  const result = complete(view);
  assert.equal(result.applied, false); assert.match(result.reason, reason);
  assert.ok(view.state === before); assert.equal(undoDepth(view.state), 0);
}
for (const [source, reason] of [
  ['ordinary |words', /Place the cursor on a checklist item/],
  ['- [ ] first\n  continuation|', /Place the cursor on a checklist item/],
  ['[[- [ ] first\n- [x] second]]', /Select one checklist item/],
  ['---\n- [ ] meta|data\n---\nbody', /document details/],
  ['$$\n- [ ] ma|th\n$$', /math/],
  ['- [ ] task $$ma|th$$', /math/],
  ['```\n- [ ] co|de\n```', /code/],
  ['    - [ ] co|de', /code/],
  ['- [ ] task `co|de`', /code/],
  ['<div>\n- [ ] ht|ml\n</div>', /HTML/],
  ['- [ ] task <b|>html</b>', /HTML/],
]) test(`completion refuses ${JSON.stringify(source)}`, () => useSpec(source, {}, view => refuses(view, reason)));

test('completion refuses a table and an unparsed BOM-leading marker safely', () => {
  const source = '| task | value |\n| --- | --- |\n| - [ ] task | yes |';
  withView(source, EditorSelection.cursor(source.indexOf('task | yes')), {}, view => refuses(view, /table/));
  useSpec('\uFEFF- [ ] ta|sk', {}, view => refuses(view, /Place the cursor on a checklist item/));
});

test('completion refuses composition, multiple selections, read-only, missing syntax and excessive complexity', t => {
  useSpec('- [ ] ta|sk', {}, view => { view.inputState.composing = 1; refuses(view, /composition/); view.inputState.composing = -1; });
  withView('- [ ] task', EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(8)]), {}, view => refuses(view, /one selection/));
  useSpec('- [ ] ta|sk', { readOnly: true }, view => refuses(view, /cannot be edited/));
  useSpec('- [ ] ta|sk', { markdown: false }, view => refuses(view, /loading/));
  useSpec('- [ ] ta|sk\n\n' + 'a'.repeat(1048576), { parse: false }, view => refuses(view, /too large or complex/));
});

test('completion maps a reversed selection across the marker and Checklist retains its remove meaning', () => {
  withView('- [ ] task', EditorSelection.single(10, 0), {}, view => {
    assert.equal(complete(view).applied, true);
    assert.deepEqual([view.state.selection.main.anchor, view.state.selection.main.head], [10, 0]);
    assert.equal(executeFormattingCommand(view, 'checklist').applied, true);
    assert.equal(view.state.sliceDoc(), 'task');
  });
});

test('Enter after completing a task starts an open task for bullet and ordered lists', () => {
  const { continueMarkdownList } = require('../.tmp/workspace-tests/src/components/markdown-decorations.js');
  for (const prefix of ['- ', '1. ', '1) ']) {
    useSpec(prefix + '[ ] task|', {}, view => {
      assert.equal(complete(view).applied, true);
      assert.equal(continueMarkdownList(view), true);
      assert.equal(view.state.sliceDoc(), prefix + '[x] task\n' + (prefix === '- ' ? '- ' : '2' + prefix.slice(1)) + '[ ] ');
    });
  }
});
