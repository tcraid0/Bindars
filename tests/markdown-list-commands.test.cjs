const test = require('node:test');
const assert = require('node:assert/strict');
const { EditorSelection, EditorState } = require('@codemirror/state');
const { undo, redo, undoDepth } = require('@codemirror/commands');
const { listCommandStatus, applyListCommand } = require('../.tmp/workspace-tests/src/components/markdown-formatting-commands.js');
const { notation, useSpec, withView, selected } = require('./_helpers/markdown-command-view.cjs');
const { markdownArticle } = require('./_helpers/markdown-reader.cjs');

function apply(view, command, expected) {
  const result = applyListCommand(view, command);
  assert.equal(result.applied, true, `${view.state.sliceDoc()}: ${result.reason}`);
  assert.equal(view.state.sliceDoc(), expected);
  return markdownArticle(view.state.sliceDoc());
}
function refuse(view, command, reason) {
  const before = view.state;
  let dispatched = 0;
  const dispatch = view.dispatch;
  view.dispatch = (...args) => { dispatched++; dispatch(...args); };
  try {
    const status = listCommandStatus(view.state, command, view.composing);
    assert.equal(status.available, false);
    const result = applyListCommand(view, command);
    assert.equal(result.applied, false);
    assert.match(result.reason, reason);
    assert.equal(result.reason, status.reason);
    assert.equal(view.state, before);
    assert.equal(dispatched, 0);
  } finally { view.dispatch = dispatch; }
}

test('flat lists start empty, convert ordinary lines, toggle, and preserve loose spacing', () => {
  for (const [command, prefix] of [['bullets', '- '], ['numbered', '1. ']]) {
    useSpec('|', {}, (view) => {
      apply(view, command, prefix);
      assert.equal(view.state.selection.main.head, prefix.length);
    });
  }
  useSpec('[[a\nb]]', {}, (view) => {
    const article = apply(view, 'bullets', '- a\n- b');
    assert.equal(article.querySelectorAll('ul > li').length, 2);
    apply(view, 'bullets', 'a\nb');
    assert.equal(selected(view), 'a\nb');
  });
  useSpec('[[a\n\nb]]', {}, (view) => {
    const article = apply(view, 'bullets', '- a\n\n- b');
    assert.equal(article.querySelectorAll('li > p').length, 2);
  });
  useSpec('[[3. a\n4. b]]', {}, (view) => apply(view, 'bullets', '- a\n- b'));
  useSpec('[[3. a\n4. b]]', {}, (view) => apply(view, 'numbered', 'a\nb'));
});

test('mid-list conversion/removal preserves unrelated siblings, starts and paragraph boundaries', () => {
  for (const [source, command, expected] of [
    ['- a\n- b|\n- c', 'bullets', '- a\n\nb\n\n- c'],
    ['3. a\n4. b|\n5. c', 'numbered', '3. a\n\nb\n\n5. c'],
    ['- a\n- b|\n- c', 'numbered', '- a\n\n1. b\n\n- c'],
  ]) useSpec(source, {}, (view) => {
    const article = apply(view, command, expected);
    assert.equal(article.children.length, 3, article.innerHTML);
    assert.equal(view.state.doc.sliceString(view.state.selection.main.head - 1, view.state.selection.main.head), 'b');
  });
});

test('continuation lines stay with their item, including lazy and loose continuation paragraphs', () => {
  for (const [source, expected] of [
    ['- alpha\n  continuation|', '1. alpha\n   continuation'],
    ['- alpha\nlazy|', '1. alpha\n   lazy'],
    ['- alpha\n\n  paragraph|', '1. alpha\n\n   paragraph'],
  ]) useSpec(source, {}, (view) => {
    const article = apply(view, 'numbered', expected);
    assert.equal(article.querySelectorAll('li').length, 1);
    assert.equal(article.querySelectorAll('pre').length, 0);
  });
});

test('half-open and reversed selections leave adjacent prose outside the list', () => {
  for (const reversed of [false, true]) {
    withView('before\na\nb\nc', EditorSelection.single(reversed ? 11 : 7, reversed ? 7 : 11), {}, (view) => {
      const article = apply(view, 'bullets', 'before\n\n- a\n- b\n\nc');
      assert.equal(article.children[0].tagName, 'P');
      assert.equal(article.children[2].tagName, 'P');
      assert.equal(article.children[2].textContent, 'c');
      assert.equal(view.state.selection.main.anchor > view.state.selection.main.head, reversed);
    });
  }
});

test('glyphs are converted only by explicit Bullets and do not imply hierarchy', () => {
  useSpec('[[• a\n◦ b\n▪ c\n– d]]', {}, (view) => {
    const article = apply(view, 'bullets', '- a\n- b\n- c\n- – d');
    assert.equal(article.querySelectorAll('ul').length, 1);
    assert.equal(article.querySelectorAll('li').length, 4);
  });
  useSpec('[[• a\n◦ b]]', {}, (view) => apply(view, 'numbered', '1. • a\n2. ◦ b'));
});

test('new empty items retain the compatible list marker, delimiter and intentional numbering', () => {
  for (const [source, command, expected] of [
    ['+ a\n|', 'bullets', '+ a\n+ '],
    ['10) a\n|', 'numbered', '10) a\n11) '],
  ]) useSpec(source, {}, (view) => apply(view, command, expected));
});

test('inline formatting survives conversion and a formatting action has isolated Undo/Redo', () => {
  useSpec('[[**bold** and *italic*\nnext]]', {}, (view) => {
    const before = view.state.sliceDoc();
    const article = apply(view, 'bullets', '- **bold** and *italic*\n- next');
    assert.equal(article.querySelector('strong').textContent, 'bold');
    assert.equal(article.querySelector('em').textContent, 'italic');
    assert.equal(undoDepth(view.state), 1);
    assert.equal(undo(view), true);
    assert.equal(view.state.sliceDoc(), before);
    assert.equal(redo(view), true);
    assert.equal(view.state.sliceDoc(), '- **bold** and *italic*\n- next');
  });
});

test('list edits refuse inline syntax that would split or join across the changed lines', () => {
  for (const [source, command] of [
    ['[[**alpha\nbeta**]]', 'bullets'],
    ['[[[alpha\nbeta](https://example.com)]]', 'numbered'],
    ['**alpha\nbeta|\ngamma**', 'bullets'],
    ['[[**alpha]]\nbeta**', 'checklist'],
    ['intro ![alpha\n[[beta](a.png) end]]', 'bullets'],
    ['[[- *alpha\n- beta*]]', 'bullets'],
    ['[[- [ ] [alpha\n- [x] beta](https://example.com)]]', 'checklist'],
    ['- a\n[[1. ~~b\n2. c~~]]', 'numbered'],
    ['[[~alpha\nbeta~]]', 'bullets'],
    ['[[- ~alpha\n- beta~]]', 'bullets'],
    ['[[alpha\\\nbeta]]', 'bullets'],
    ['[[- path C:\\\n- next]]', 'bullets'],
  ]) useSpec(source, {}, (view) => refuse(view, command, /^Formatting or a link runs across these lines, so nothing was changed\.$/));
});

test('multiline inline syntax within one item or paragraph converts with its reader meaning intact', () => {
  useSpec('- **alpha\n  beta**\n- [gamma\ndelta](https://example.com)|', {}, (view) => {
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    const article = apply(view, 'numbered', '1. **alpha\n   beta**\n2. [gamma\n   delta](https://example.com)');
    assert.equal(article.querySelector('li > strong').textContent, 'alpha\nbeta');
    assert.equal(article.querySelector('li > a[href="https://example.com"]').textContent, 'gamma\ndelta');
    assert.doesNotMatch(article.textContent, /\*\*|\]\(/);
    const removed = apply(view, 'numbered', '**alpha\nbeta**\n[gamma\ndelta](https://example.com)');
    assert.equal(removed.querySelector('p > strong').textContent, 'alpha\nbeta');
    assert.equal(removed.querySelector('p > a[href="https://example.com"]').textContent, 'gamma\ndelta');
    assert.equal(undo(view), true);
    assert.equal(view.state.sliceDoc(), '1. **alpha\n   beta**\n2. [gamma\n   delta](https://example.com)');
  });
  useSpec('**intro\ntext** more\n[[**a**\n*b*]]\n\n*after\nwords*', {}, (view) => {
    const article = apply(view, 'bullets', '**intro\ntext** more\n\n- **a**\n- *b*\n\n*after\nwords*');
    assert.equal(article.querySelector('p > strong').textContent, 'intro\ntext');
    assert.deepEqual([...article.querySelectorAll('li > *')].map((node) => node.textContent), ['a', 'b']);
    assert.equal(article.lastElementChild.textContent, 'after\nwords');
    assert.equal(article.lastElementChild.firstElementChild.tagName, 'EM');
  });
  for (const [source, expected, selector, text] of [
    ['- ~alpha\n  beta~|', '1. ~alpha\n   beta~', 'li > del', 'alpha\nbeta'],
    ['- alpha\\\n  beta|', '1. alpha\\\n   beta', 'li > br', ''],
  ]) useSpec(source, {}, (view) => {
    assert.equal(apply(view, 'numbered', expected).querySelector(selector).textContent, text);
  });
});

test('tildes and backslashes the reader keeps literal still convert in both directions', () => {
  assert.equal(markdownArticle('~alpha\nbeta~').querySelector('del').textContent, 'alpha\nbeta');
  assert.equal(markdownArticle('alpha\\\nbeta').querySelectorAll('br').length, 1);
  for (const [source, expected, items] of [
    ['[[~5 min\n~10 min]]', '- ~5 min\n- ~10 min', ['~5 min', '~10 min']],
    ['[[\\~alpha\nbeta~]]', '- \\~alpha\n- beta~', ['~alpha', 'beta~']],
    ['[[alpha  \nbeta]]', '- alpha  \n- beta', ['alpha', 'beta']],
    ['[[C:\\\\\nnext]]', '- C:\\\\\n- next', ['C:\\', 'next']],
  ]) useSpec(source, {}, (view) => {
    const article = apply(view, 'bullets', expected);
    assert.deepEqual([...article.querySelectorAll('li')].map((node) => node.textContent), items);
    assert.equal(article.querySelectorAll('del').length, 0);
    const removed = apply(view, 'bullets', notation(source).doc);
    assert.equal(removed.querySelectorAll('del').length, 0);
  });
});

test('protected content and unsupported containers refuse the whole operation', () => {
  for (const [sources, reason] of [
    [['[[plain\n\n- item]]', '[[plain\n\n1. item\n\n- other]]'], /^Select items from one list, or ordinary lines, but not both\.$/],
    [['[[plain\n\n```\ncode\n```]]', '[[plain `code`]]'], /^Move out of code to format text\.$/],
    [['[[plain $$x$$]]'], /^Move out of math to format text\.$/],
    [['[[---\ntitle: a\n---\ntext]]'], /^Move out of the document details to format text\.$/],
    [['[[plain\n\n<div>html</div>]]'], /^Move out of HTML to format text\.$/],
    [['[[plain\n\n> quote]]', '[[# heading]]'], /^This works on ordinary lines and lists only\.$/],
    [['[[- a\n  - child]]'], /^Move the sub-items out first with Indent less, then try again\.$/],
  ]) for (const source of sources) useSpec(source, {}, (view) => refuse(view, 'bullets', reason));
});

test('lists retain uniform separators and refuse composition, readonly and multiple selections', () => {
  for (const lineSeparator of ['\r\n', '\r']) {
    const source = `a${lineSeparator}b`;
    withView(source, EditorSelection.single(0, 3), { lineSeparator }, (view) => {
      apply(view, 'bullets', `- a${lineSeparator}- b`);
      assert.equal(undo(view), true);
      assert.equal(view.state.sliceDoc(), source);
    });
  }
  useSpec('a|', { readOnly: true }, (view) => refuse(view, 'bullets', /cannot be edited/));
  useSpec('a|', {}, (view) => {
    Object.defineProperty(view, 'composing', { configurable: true, value: true });
    refuse(view, 'bullets', /Finish typing first/);
  });
  withView('a b', EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(2)]), {},
    (view) => refuse(view, 'bullets', /one cursor/));
});


test('checklist creates unchecked tasks, preserves mixed completion, and toggles all tasks off', () => {
  useSpec('[[a\nb]]', {}, (view) => {
    const article = apply(view, 'checklist', '- [ ] a\n- [ ] b');
    assert.equal(article.querySelectorAll('input[type=checkbox]').length, 2);
    assert.equal(article.querySelectorAll('input[checked]').length, 0);
    apply(view, 'checklist', 'a\nb');
    assert.equal(undo(view), true);
    assert.equal(view.state.sliceDoc(), '- [ ] a\n- [ ] b');
  });
  useSpec('[[- [X] a\n- b]]', {}, (view) => {
    const article = apply(view, 'checklist', '- [X] a\n- [ ] b');
    assert.equal(article.querySelectorAll('input[checked]').length, 1);
    apply(view, 'checklist', 'a\nb');
  });
  useSpec('|', {}, (view) => {
    apply(view, 'checklist', '- [ ] ');
    assert.equal(view.state.selection.main.head, 6);
  });
});

test('explicit task conversion removes only checkboxes, retaining words, style and continuations', () => {
  useSpec('[[- [x] **a**\n  continued\n- [ ] b]]', {}, (view) => {
    const article = apply(view, 'numbered', '1. **a**\n   continued\n2. b');
    assert.equal(article.querySelectorAll('input').length, 0);
    assert.equal(article.querySelectorAll('li').length, 2);
    assert.equal(article.querySelector('strong').textContent, 'a');
  });
  useSpec('[[+ [x] a\n+ [ ] b]]', {}, (view) => apply(view, 'bullets', '+ a\n+ b'));
  useSpec('[[10) [x] a\n11) b]]', {}, (view) => {
    apply(view, 'checklist', '10) [x] a\n11) [ ] b');
    apply(view, 'numbered', '10) a\n11) b');
  });
  useSpec('- a\n- [x] b|\n- c', {}, (view) => apply(view, 'bullets', '- a\n- b\n- c'));
});

test('indent and outdent move a complete subtree with continuation and preserve descendants', () => {
  const before = '- parent\n- child\n  continued\n  - grand\n- next';
  withView(before, EditorSelection.cursor(before.indexOf('child') + 5), {}, (view) => {
    const article = apply(view, 'indent', '- parent\n  - child\n    continued\n    - grand\n- next');
    assert.equal(article.querySelectorAll('ul > li > ul > li > ul > li').length, 1);
    assert.equal(article.querySelectorAll('pre').length, 0);
    assert.equal(view.state.doc.lineAt(view.state.selection.main.head).text, '  - child');
    apply(view, 'outdent', before);
    assert.equal(undo(view), true);
    assert.equal(view.state.sliceDoc(), '- parent\n  - child\n    continued\n    - grand\n- next');
  });
});

test('multi-digit ordered parent columns, fresh starts and rejoins are structural', () => {
  useSpec('10. parent\n11. child|', {}, (view) => {
    const article = apply(view, 'indent', '10. parent\n    1. child');
    assert.equal(article.querySelectorAll('ol > li > ol > li').length, 1);
    assert.equal(article.querySelector('ol').getAttribute('start'), '10');
    apply(view, 'outdent', '10. parent\n11. child');
  });
  useSpec('8) parent\n9) child|\n   - grand\n10) next\n    continued\n40) restart', {}, (view) => {
    apply(view, 'indent', '8) parent\n   1) child\n      - grand\n9) next\n   continued\n40) restart');
    apply(view, 'outdent', '8) parent\n9) child\n   - grand\n10) next\n    continued\n40) restart');
  });
});

test('adjacent selected sibling roots move once, retain direction and join existing child style/start', () => {
  const source = '10. parent\n\n    4) old\n11. a\n     - descendant\n12. b\n13. next';
  const from = source.indexOf('11. a'), to = source.indexOf('\n13. next');
  for (const reversed of [false, true]) withView(source, EditorSelection.single(reversed ? to : from, reversed ? from : to), {}, (view) => {
    const article = apply(view, 'indent', '10. parent\n\n    4) old\n    5) a\n        - descendant\n    6) b\n11. next');
    assert.equal(article.querySelectorAll('ol > li > ol > li').length, 3);
    assert.equal(view.state.selection.main.anchor > view.state.selection.main.head, reversed);
    apply(view, 'outdent', '10. parent\n\n    4) old\n11. a\n     - descendant\n12. b\n13. next');
  });
});

test('kind conversion changes selected roots, shifts columns, and preserves child kinds', () => {
  useSpec('[[- parent\n  - child\n- next]]', {}, (view) => {
    const article = apply(view, 'numbered', '1. parent\n   - child\n2. next');
    assert.equal(article.querySelectorAll('ol > li').length, 2);
    assert.equal(article.querySelectorAll('ol > li > ul > li').length, 1);
    apply(view, 'bullets', '- parent\n  - child\n- next');
    refuse(view, 'bullets', /Indent less/);
  });
  useSpec('- parent\n  - child|\n- next', {}, (view) => {
    apply(view, 'numbered', '- parent\n  1. child\n- next');
    refuse(view, 'numbered', /Indent less/);
  });
});

test('nested tasks retain completion during level changes and parent conversion', () => {
  useSpec('10) [X] parent\n11) [x] child|\n    - [ ] grand\n12) next', {}, (view) => {
    const article = apply(view, 'indent', '10) [X] parent\n    1) [x] child\n       - [ ] grand\n11) next');
    assert.equal(article.querySelectorAll('input[checked]').length, 2);
    apply(view, 'outdent', '10) [X] parent\n11) [x] child\n    - [ ] grand\n12) next');
    refuse(view, 'checklist', /Indent less/);
  });
  useSpec('[[- [X] parent\n  - [x] child\n- plain]]', {}, (view) => {
    apply(view, 'checklist', '- [X] parent\n  - [x] child\n- [ ] plain');
    apply(view, 'numbered', '1. parent\n   - [x] child\n2. plain');
    assert.equal(markdownArticle(view.state.sliceDoc()).querySelectorAll('input[checked]').length, 1);
  });
  useSpec('- parent\n  [[- [x] child\n  - plain]]', {}, (view) => {
    apply(view, 'checklist', '- parent\n  - [x] child\n  - [ ] plain');
    refuse(view, 'checklist', /Indent less/);
  });
});

test('hierarchy refuses first-item indent, mixed depths, unsafe removal and nontrailing outdent atomically', () => {
  for (const [source, command, reason] of [
    ['- first|\n- next', 'indent', /second item/],
    ['- first|', 'outdent', /as far left/],
    ['- parent\n  [[- child\n- next]]', 'indent', /one list/],
    ['- parent|\n  - child', 'bullets', /Indent less/],
    ['- parent\n  - child|', 'bullets', /Indent less/],
    ['- parent\n  - child|\n  - sibling', 'outdent', /items below/],
    ['- parent\n- child|\n  ```\n  code\n  ```', 'indent', /code/],
    ['> - parent\n> - child|', 'indent', /ordinary lines and lists/],
  ]) useSpec(source, {}, (view) => refuse(view, command, reason));
});

test('outdent across list kinds preserves the moved kind and splits surrounding runs', () => {
  useSpec('10. parent\n    - [x] child|\n11. next', {}, (view) => {
    const article = apply(view, 'outdent', '10. parent\n\n- [x] child\n\n11. next');
    assert.deepEqual([...article.children].map((node) => node.tagName), ['OL', 'UL', 'OL']);
    assert.equal(article.querySelectorAll('input[checked]').length, 1);
    assert.equal(article.lastElementChild.getAttribute('start'), '11');
  });
});

test('ordered starts that the reader treats as continuation require an explicit blank line', () => {
  useSpec('10. parent\n    4) old\n11. child|', {}, (view) => refuse(view, 'indent', /empty line before this numbered list/));
  useSpec('intro\n3. item|', {}, (view) => refuse(view, 'bullets', /ordinary lines and lists/));
});

test('list edits are isolated from surrounding typing and preserve logical caret offsets', () => {
  useSpec('al|pha', {}, (view) => {
    view.dispatch({ ...view.state.replaceSelection('X'), userEvent: 'input.type' });
    apply(view, 'numbered', '1. alXpha');
    assert.equal(view.state.selection.main.head, 6);
    view.dispatch({ ...view.state.replaceSelection('Y'), userEvent: 'input.type' });
    assert.equal(undo(view), true);
    assert.equal(view.state.sliceDoc(), '1. alXpha');
    assert.equal(undo(view), true);
    assert.equal(view.state.sliceDoc(), 'alXpha');
    assert.equal(undo(view), true);
    assert.equal(view.state.sliceDoc(), 'alpha');
    assert.equal(redo(view), true);
    assert.equal(redo(view), true);
    assert.equal(view.state.sliceDoc(), '1. alXpha');
    assert.equal(view.state.selection.main.head, 6);
  });
});

test('actual list outputs retain annotation records and reproduce S00 location outcomes', async (t) => {
  const { collectText, rangeForOffsets } = require('../.tmp/workspace-tests/src/lib/dom-text.js');
  const { createPositionedAnchor, prepareAnnotationDocument, resolveAnchor } = require('../.tmp/workspace-tests/src/lib/text-anchoring.js');
  const { readAnnotationRecord, storedAnnotationRecord } = require('../.tmp/workspace-tests/src/lib/annotation-record.js');
  const duplicate = 'A'.repeat(40) + 'quote' + 'B'.repeat(40);
  const cases = [
    { name: 'simple unique bullets', source: 'prefix\nquote\nsuffix', command: 'bullets', status: 'located' },
    { name: 'simple unique numbered', source: 'prefix\nquote\nsuffix', command: 'numbered', status: 'located' },
    { name: 'changed context', source: 'intro\n\nprefix\nquote\nsuffix\n\nend', command: 'bullets', from: 7, to: 26, status: 'uncertain' },
    { name: 'duplicate passage', source: `${duplicate}\n\n${duplicate}`, command: 'bullets', from: duplicate.length + 2, status: 'uncertain' },
    { name: 'task controls', source: 'prefix\nquote\nsuffix', command: 'checklist', status: 'uncertain' },
    { name: 'nested outline', source: '- prefix\n- quote\n- suffix', command: 'indent', from: 11, to: 11, status: 'uncertain' },
  ];
  for (const fixture of cases) {
    const before = markdownArticle(fixture.source);
    const { text, spans } = collectText(before);
    const start = text.lastIndexOf('quote');
    const anchor = await createPositionedAnchor(rangeForOffsets(spans, start, start + 5), before, fixture.source);
    const note = { ...anchor, id: fixture.name, note: 'Study question', color: 'yellow', createdAt: 1, nearestHeadingId: null };
    const stored = { version: 3, highlights: [note], bookmarks: [] };
    const baseline = resolveAnchor(note, before, await prepareAnnotationDocument(before, fixture.source));
    assert.equal(baseline.status, 'located');
    const output = withView(fixture.source, EditorSelection.single(fixture.from ?? 0, fixture.to ?? fixture.source.length), {}, (view) => {
      const result = applyListCommand(view, fixture.command);
      assert.equal(result.applied, true, `${fixture.name}: ${result.reason}`);
      return view.state.sliceDoc();
    });
    const after = markdownArticle(output);
    const restored = readAnnotationRecord(JSON.parse(JSON.stringify(stored)));
    const evidence = await prepareAnnotationDocument(after, output);
    const result = resolveAnchor(restored.annotations.highlights[0], after, evidence);
    t.diagnostic(JSON.stringify({ name: fixture.name, baseline: baseline.status, after: result.status,
      retained: restored.annotations.highlights.length, beforeText: text, afterText: collectText(after).text }));
    assert.equal(result.status, fixture.status, fixture.name);
    assert.equal(result.range === null, fixture.status !== 'located');
    if (result.range) assert.equal(result.range.toString(), 'quote');
    assert.deepEqual(storedAnnotationRecord(restored), stored);
    // Explicit deletion remains missing, independently of retained notes.
    const deleted = markdownArticle(output.replaceAll('quote', 'changed'));
    assert.equal(resolveAnchor(note, deleted, await prepareAnnotationDocument(deleted, output.replaceAll('quote', 'changed'))).status, 'missing');
    assert.equal(restored.annotations.highlights[0].note, 'Study question');
  }
});

test('ordinary leading spaces and glyph shapes do not create accidental nested lists', () => {
  useSpec('[[a\n  b\n c]]', {}, (view) => {
    const article = apply(view, 'bullets', '- a\n-   b\n-  c');
    assert.equal(article.querySelectorAll('ul').length, 1);
    assert.equal(article.querySelectorAll('li').length, 3);
  });
  useSpec('[[• a\n  ◦ b\n ▪ c]]', {}, (view) => {
    const article = apply(view, 'bullets', '- a\n-   b\n-  c');
    assert.equal(article.querySelectorAll('ul').length, 1);
  });
});

test('newly exposed structures and protected descendants are rejected atomically', () => {
  for (const [source, command] of [
    ['[[[x] words]]', 'bullets'], ['[[• # title]]', 'bullets'], ['[[• - child]]', 'bullets'],
    ['- [ ] [x] words|', 'bullets'], ['[[• $$]]', 'bullets'],
    ['- parent\n- child|\n  $$x$$', 'indent'],
    ['- parent\n- child|\n  <span>html</span>', 'indent'],
    ['- parent\n- child|\n  ### heading', 'indent'],
    ['[[first\n\n| a | b |\n| - | - |\n| c | d |]]', 'numbered'],
    ['- parent\n- child|\n  [a `code`](url)', 'indent'],
    ['- parent\n- child|\n\tcontinued', 'indent'],
    ['[[\ufeff---\ninvalid: [\n---\nbody]]', 'checklist'],
  ]) useSpec(source, {}, (view) => refuse(view, command, /ordinary lines and lists|Move out of/));
});

test('half-open nested selections and uniform separators retain child structure and checked state', () => {
  for (const lineSeparator of ['\n', '\r\n', '\r']) {
    const source = '- parent\n- [x] a\n  continuation\n- [ ] b\n- next';
    const from = source.indexOf('- [x]'), to = source.indexOf('- next');
    withView(source.replaceAll('\n', lineSeparator), EditorSelection.single(to, from), { lineSeparator }, (view) => {
      const expected = '- parent\n  - [x] a\n    continuation\n  - [ ] b\n- next';
      const article = apply(view, 'indent', expected.replaceAll('\n', lineSeparator));
      assert.equal(article.querySelectorAll('ul > li > ul > li').length, 2);
      assert.equal(article.querySelectorAll('input[checked]').length, 1);
      assert.equal(view.state.selection.main.anchor > view.state.selection.main.head, true);
      assert.equal(undo(view), true);
      assert.equal(view.state.sliceDoc(), source.replaceAll('\n', lineSeparator));
      assert.equal(redo(view), true);
      assert.equal(view.state.sliceDoc(), expected.replaceAll('\n', lineSeparator));
    });
  }
});

test('list commands refuse a genuinely incomplete parse and recover once it advances', () => {
  const { Language, forceParsing, syntaxTreeAvailable } = require('@codemirror/language');
  const { commonmarkLanguage } = require('@codemirror/lang-markdown');
  const { parser, GFM } = require('@lezer/markdown');
  let released = false;
  const partial = parser.configure([GFM, { wrap(inner) {
    let finishing = false;
    return {
      advance() { return released || finishing || inner.parsedPos < 5 ? inner.advance() : null; },
      get parsedPos() { return inner.parsedPos; }, get stoppedAt() { return inner.stoppedAt; },
      stopAt(pos) { inner.stopAt(pos); if (pos <= inner.parsedPos) finishing = true; },
    };
  } }]);
  const source = 'first\n\n' + 'paragraph\n\n'.repeat(400) + '- parent\n- child';
  withView(source, EditorSelection.cursor(source.length), { language: new Language(commonmarkLanguage.data, partial), parse: false }, (view) => {
    assert.equal(syntaxTreeAvailable(view.state, source.length), false);
    refuse(view, 'indent', /Still reading the document/);
    released = true;
    assert.equal(forceParsing(view, source.length, 2000), true);
    assert.equal(applyListCommand(view, 'indent').applied, true);
    assert.ok(view.state.sliceDoc().endsWith('- parent\n  - child'));
  });
});

test('new checklist items extend compatible ordered and bullet styles without resetting completion', () => {
  for (const [source, command, expected] of [
    ['10) [x] a\n|', 'checklist', '10) [x] a\n11) [ ] '],
    ['+ a\n|', 'checklist', '+ a\n+ [ ] '],
    ['+ [x] a\n|', 'bullets', '+ [x] a\n+ '],
    ['10) [x] a\n|', 'numbered', '10) [x] a\n11) '],
  ]) useSpec(source, {}, (view) => apply(view, command, expected));
});

test('task-preserving edits keep authored spacing and numbers; BOM and blank selections refuse safely', () => {
  useSpec('[[10) [X]   a\n20) [ ] b]]', {}, (view) => apply(view, 'numbered', '10) a\n20) b'));
  useSpec('- parent\n- [X]   child|', {}, (view) => {
    apply(view, 'indent', '- parent\n  - [X]   child');
    apply(view, 'outdent', '- parent\n- [X]   child');
  });
  useSpec('\ufeffalpha|', {}, (view) => refuse(view, 'bullets', /byte-order mark/));
  useSpec('[[\n\n]]', {}, (view) => refuse(view, 'bullets', /^Select items from one list, or ordinary lines, but not both\.$/));
});

test('list status reuses document protection without rescanning remote math on every candidate', (t) => {
  const { unified } = require('unified');
  const parse = t.mock.method(Object.getPrototypeOf(unified()), 'parse');
  const source = '- parent\n- child\n\n$$x$$';
  withView(source, EditorSelection.cursor(source.indexOf('child') + 2), {}, (view) => {
    for (const command of ['numbered', 'checklist', 'indent', 'numbered']) {
      assert.equal(listCommandStatus(view.state, command).available, true);
    }
    assert.equal(parse.mock.callCount(), 1, 'one immutable baseline math scan');
    assert.equal(applyListCommand(view, 'indent').applied, true);
    assert.equal(parse.mock.callCount(), 1, 'ordinary item edits do not need another full math parse');
    assert.equal(listCommandStatus(view.state, 'outdent').available, true);
    assert.equal(parse.mock.callCount(), 2, 'an edited document invalidates baseline protection');
  });
});
