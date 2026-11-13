const test = require('node:test');
const assert = require('node:assert/strict');
const { EditorSelection, EditorState } = require('@codemirror/state');
const { undo, redo, undoDepth } = require('@codemirror/commands');
const { blockCommandStatus, applyBlockCommand } = require('../.tmp/workspace-tests/src/components/markdown-formatting-commands.js');
const { useSpec, withView, selected } = require('./_helpers/markdown-command-view.cjs');
const { markdownArticle } = require('./_helpers/markdown-reader.cjs');
const { parseSlides } = require('../.tmp/workspace-tests/src/lib/slide-parser.js');
function apply(view, command, expected) {
  const result = applyBlockCommand(view, command);
  assert.equal(result.applied, true, `${view.state.sliceDoc()}: ${result.reason}`);
  assert.equal(view.state.sliceDoc(), expected);
  return markdownArticle(expected);
}
function refuse(view, command, reason) {
  const before = view.state;
  const result = applyBlockCommand(view, command);
  assert.equal(result.applied, false); assert.match(result.reason, reason);
  assert.equal(view.state, before); assert.equal(undoDepth(view.state), 0);
}

test('styles set Paragraph/H1–H3 with logical caret and accurate H4–H6 detection', () => {
  for (const level of [1,2,3]) useSpec('Ti|tle', {}, view => {
    const article = apply(view, `h${level}`, '#'.repeat(level) + ' Title');
    assert.equal(article.querySelector(`h${level}`).textContent, 'Title');
    assert.equal(view.state.selection.main.head, level + 3);
    assert.equal(blockCommandStatus(view.state, `h${level}`).headingLevel, level);
    const before = view.state; assert.equal(applyBlockCommand(view, `h${level}`).applied, false); assert.equal(view.state, before);
    apply(view, 'paragraph', 'Title');
  });
  for (const level of [4,5,6]) useSpec('#'.repeat(level) + ' Ti|tle ###', {}, view => {
    const before = view.state; const status = blockCommandStatus(view.state, 'paragraph');
    assert.equal(status.headingLevel, level); assert.equal(view.state, before);
    apply(view, 'h2', '## Title'); assert.equal(view.state.selection.main.head, 5);
    assert.equal(undo(view), true); assert.equal(view.state.sliceDoc(), '#'.repeat(level) + ' Title ###');
    apply(view, 'paragraph', 'Title');
  });
  useSpec('plain|', {}, view => {
    const before = view.state; assert.equal(applyBlockCommand(view, 'paragraph').applied, false);
    assert.equal(view.state, before); assert.equal(undoDepth(view.state), 0);
  });
  useSpec('|', {}, view => { apply(view, 'h1', '# '); assert.equal(view.state.selection.main.head, 2); });
});

test('styles preserve reversed content selections, metadata/CRLF and isolated history', () => {
  withView('Title', EditorSelection.single(4, 1), {}, view => {
    apply(view, 'h3', '### Title'); assert.equal(selected(view), 'itl');
    assert.ok(view.state.selection.main.anchor > view.state.selection.main.head);
    assert.equal(undoDepth(view.state), 1); undo(view); assert.equal(view.state.sliceDoc(), 'Title');
    redo(view); assert.equal(view.state.sliceDoc(), '### Title');
  });
  withView('---\r\ntitle: Kept\r\n---\r\n\r\nBody', EditorSelection.cursor('---\ntitle: Kept\n---\n\nBo'.length), { lineSeparator: '\r\n' }, view => {
    const before = view.state.sliceDoc(); apply(view, 'h1', before.replace('Body', '# Body'));
    assert.equal(view.state.lineBreak, '\r\n');
  });
  useSpec('one\n\n[[two\n]]three', {}, view => {
    const result = applyBlockCommand(view, 'h1');
    assert.equal(result.applied, false, 'two belongs to a multiline paragraph, even with half-open selection');
  });
});

test('styles refuse Setext, multiline paragraphs, containers and exposed syntax atomically', () => {
  for (const source of ['Ti|tle\n---', 'Ti|tle\n===']) for (const command of ['paragraph','h1','h2','h3']) {
    useSpec(source, {}, view => refuse(view, command, /Setext/));
  }
  for (const source of ['al|pha\nbeta', '[[one\n\ntwo]]', '- # Ti|tle', '> Ti|tle', '# - it|em', '# $$ma|th$$', '```\nco|de\n```', '---\nke|y: value\n---\n\nbody']) {
    useSpec(source, {}, view => refuse(view, 'paragraph', /ordinary lines|paragraph|heading|math|code|details/i));
  }
});

test('divider preserves words and authored separators, uses blank boundaries and creates no slide', () => {
  for (const [source, expected, tail] of [
    ['al|pha', 'alpha\n\n* * *\n\n', ''],
    ['alpha|\n\nbeta', 'alpha\n\n* * *\n\nbeta', 'beta'],
    ['|', '* * *\n\n', ''],
    ['- parent\n  - child|', '- parent\n  - child\n\n* * *\n\n', ''],
    ['- parent|\n  - child\n- next', '- parent\n  - child\n- next\n\n* * *\n\n', ''],
    ['[[alpha\n\n]]beta', 'alpha\n\n* * *\n\nbeta', 'beta'],
    ['---\ntitle: Kept\n---\n\nBody|', '---\ntitle: Kept\n---\n\nBody\n\n* * *\n\n', ''],
    ['alpha|\n\n***\n\nomega', 'alpha\n\n* * *\n\n\n\n***\n\nomega', '\n\n***\n\nomega'],
  ]) useSpec(source, {}, view => {
    const before = view.state.sliceDoc(); const slides = parseSlides(before).length;
    const article = apply(view, 'divider', expected);
    assert.ok(article.querySelector('hr'));
    assert.equal(view.state.sliceDoc(view.state.selection.main.head), tail);
    if (before) assert.equal(parseSlides(expected).length, slides);
    assert.equal(undoDepth(view.state), 1); undo(view); assert.equal(view.state.sliceDoc(), before);
    redo(view); assert.equal(view.state.sliceDoc(), expected);
  });
  for (const source of ['> - item|', '```\na|\n```', '[[plain\n\n`code`]]', '---\nkey: val|ue\n---\n\nbody']) {
    useSpec(source, {}, view => refuse(view, 'divider', /ordinary lines|paragraph|heading|code|details/i));
  }
});

test('quote/unquote preserves paragraphs, inline structures, blank lines and half-open selection', () => {
  for (const [source, expected] of [
    ['[[a\nb\n\nc]]', '> a\n> b\n>\n> c'],
    ['|', '> '],
    ['[[**a**\nb]]', '> **a**\n> b'],
    ['before\n[[a\nb\n]]after', 'before\n\n> a\n> b\n\nafter'],
  ]) useSpec(source, {}, view => {
    const article = apply(view, 'quote', expected); assert.equal(article.querySelectorAll('blockquote').length, 1);
    const beforeUndo = view.state.sliceDoc(); undo(view); redo(view); assert.equal(view.state.sliceDoc(), beforeUndo);
  });
  useSpec('[[> a\n> b\n>\n> c]]', {}, view => {
    const article = apply(view, 'quote', 'a\nb\n\nc'); assert.equal(article.querySelectorAll('p').length, 2);
    assert.equal(article.querySelectorAll('blockquote').length, 0);
  });
  useSpec('[[> alpha\nlazy]]', {}, view => apply(view, 'quote', 'alpha\nlazy'));
  useSpec('> a|\n> b', {}, view => refuse(view, 'quote', /whole quote/));
  for (const source of ['[[> a\n\nb]]', '> > a|', '> - a|', '> `a|`', '> $$a|$$', '> # a|', '<div>\na|\n</div>']) {
    useSpec(source, {}, view => refuse(view, 'quote', /quote|code|math|HTML/i));
  }
});

test('quote paragraph splits and joins use D30 inline boundaries, including reader single-tilde strike', () => {
  for (const source of ['**before\nmid|dle\nafter**', '*before\nmid|dle\nafter*', '~before\nmid|dle\nafter~', '[before\nmid|dle\nafter](https://example.com)', 'before\\\nmid|dle']) {
    useSpec(source, {}, view => refuse(view, 'quote', /formatting|link|line break/));
  }
  useSpec('[[**before\nafter**]]', {}, view => {
    const article = apply(view, 'quote', '> **before\n> after**');
    assert.equal(article.querySelector('strong').textContent, 'before\nafter');
  });
  useSpec('[[> *alpha\n> omega*]]', {}, view => {
    const article = apply(view, 'quote', '*alpha\nomega*');
    assert.equal(article.querySelector('em').textContent, 'alpha\nomega');
  });
});

for (const command of ['paragraph','h1','divider','quote']) test(`${command} respects shared selection, IME and read-only guards`, () => {
  useSpec('text|', { readOnly: true }, view => refuse(view, command, /cannot be edited/));
  useSpec('text|', {}, view => {
    Object.defineProperty(view, 'composing', { value: true }); refuse(view, command, /Finish typing first/);
  });
  withView('alpha beta', EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(8)]), {}, view => refuse(view, command, /one cursor/));
  useSpec('text|', { markdown: false }, view => refuse(view, command, /Still reading the document/));
});

test('headings retain literal words and divider refuses unsupported containers inside lists', () => {
  useSpec('alpha #|##', {}, view => refuse(view, 'h1', /nearby formatting/));
  useSpec('- parent\n  > child|', {}, view => refuse(view, 'divider', /list/));
  useSpec('alpha|\n\n# next', {}, view => {
    apply(view, 'divider', 'alpha\n\n* * *\n\n\n\n# next');
    view.dispatch({ changes: { from: view.state.selection.main.head, insert: 'prose' } });
    const article = markdownArticle(view.state.sliceDoc());
    assert.equal(article.querySelectorAll('p')[1].textContent, 'prose');
    assert.equal(article.querySelector('h1').textContent, 'next');
  });
});
