const test = require('node:test');
const assert = require('node:assert/strict');
const { EditorSelection, StateEffect } = require('@codemirror/state');
const { undo, redo, undoDepth } = require('@codemirror/commands');
const { beginLinkCommand, applyLinkCommand, cancelLinkCommand } = require('../.tmp/workspace-tests/src/components/markdown-formatting-commands.js');
const { useSpec, withView } = require('./_helpers/markdown-command-view.cjs');
const { markdownArticle } = require('./_helpers/markdown-reader.cjs');
const context = { filePath: '/workspace/note.md', session: 1 };
function submit(view, input, owner = context) {
  const { intent, reason } = beginLinkCommand(view, owner); assert.ok(intent, reason);
  return applyLinkCommand(view, intent, input, owner);
}

test('link submission wraps or inserts a literal escaped label and destination through one history action', () => {
  useSpec('before [[label]] after', {}, view => {
    const { intent } = beginLinkCommand(view, context); assert.equal(intent.label, 'label');
    assert.equal(applyLinkCommand(view, intent, { label: 'label', destination: 'https://example.com/a(b)' }, context).applied, true);
    assert.equal(view.state.sliceDoc(), 'before [label](<https://example.com/a(b)>) after');
    assert.equal(view.state.sliceDoc(view.state.selection.main.head), ' after');
    assert.equal(undoDepth(view.state), 1); undo(view); assert.equal(view.state.sliceDoc(), 'before label after');
    redo(view); assert.equal(markdownArticle(view.state.sliceDoc()).querySelector('a').textContent, 'label');
  });
  useSpec('|', {}, view => {
    const label = 'a[b] *literal* _word_ ~strike~ `code` \\ <tag> &copy;';
    const destination = 'https://example.com/a(b) x<y>?a=1&copy;=2';
    const result = submit(view, { label, destination }); assert.equal(result.applied, true, result.reason);
    const article = markdownArticle(view.state.sliceDoc()); const link = article.querySelector('a');
    assert.equal(link.textContent, label);
    assert.equal(link.getAttribute('href'), 'https://example.com/a(b)%20x%3Cy%3E?a=1&copy;=2');
    assert.equal(article.querySelectorAll('em,strong,del,code').length, 0);
  });
});

test('link validation reuses the reader destination policy including relative Fountain and Markdown files', () => {
  for (const destination of ['HTTP://example.com', 'https://example.com', 'mailto:person@example.com?subject=a&body=b', '#heading', '../other.md#part', 'folder/my note.markdown', 'scene.fountain']) {
    useSpec('[[label]]', {}, view => {
      const result = submit(view, { label: 'label', destination }); assert.equal(result.applied, true, `${destination}: ${result.reason}`);
      assert.ok(markdownArticle(view.state.sliceDoc()).querySelector('a').getAttribute('href'));
    });
  }
  for (const destination of ['', ' ', 'https:', 'https://', 'mailto:', '#', 'javascript:alert(1)', 'data:text/plain,x', 'file:///a.md', '/a.md', '//host/a.md', 'C:\\a.md', '\\\\host\\a.md', '%2Fa.md', 'notes.pdf', 'a.md\nnext', 'a.md%0a', 'https://exa\tmple.com']) {
    useSpec('[[label]]', {}, view => {
      const before = view.state; const result = submit(view, { label: 'label', destination });
      assert.equal(result.applied, false, destination); assert.ok(result.reason); assert.equal(view.state, before);
    });
  }
  for (const label of ['', ' ', 'line\nbreak', 'x\0y']) useSpec('|', {}, view => {
    const before = view.state; assert.equal(submit(view, { label, destination: 'https://example.com' }).applied, false);
    assert.equal(view.state, before);
  });
  useSpec('|', {}, view => assert.equal(submit(view, { label: 'label', destination: 'other.md' }, { filePath: null, session: 1 }).applied, false));
});

test('unsupported inline/link/code/container contexts and generated image boundaries refuse atomically', () => {
  for (const source of ['[la|bel](https://example.com)', '![la|bel](a.png)', 'https://exa|mple.com', '**bo|ld**', '[[one\ntwo]]', '`co|de`', '---\nkey: val|ue\n---\n\nbody', '$$ma|th$$', '<div>\na|\n</div>']) {
    useSpec(source, {}, view => { const before = view.state; assert.equal(beginLinkCommand(view, context).intent, null, source); assert.equal(view.state, before); });
  }
  useSpec('!|', {}, view => {
    const before = view.state; const result = submit(view, { label: 'label', destination: 'https://example.com' });
    assert.equal(result.applied, false); assert.equal(view.state, before);
  });
});

for (const stale of ['document', 'selection', 'selection away and back', 'file', 'session', 'cancel']) test(`link intent refuses ${stale} and does not publish`, () => {
  useSpec('[[label]] after', {}, view => {
    const selection = view.state.selection; const { intent } = beginLinkCommand(view, context); let owner = context;
    if (stale === 'document') view.dispatch({ changes: { from: view.state.doc.length, insert: 'x' } });
    if (stale.startsWith('selection')) { view.dispatch({ selection: EditorSelection.cursor(0) }); if (stale.includes('back')) view.dispatch({ selection }); }
    if (stale === 'file') owner = { ...context, filePath: '/other.md' };
    if (stale === 'session') owner = { ...context, session: 2 };
    if (stale === 'cancel') { const before = view.state; assert.equal(cancelLinkCommand(view, intent, context), true); assert.equal(view.state, before); }
    const before = view.state;
    const result = applyLinkCommand(view, intent, { label: 'label', destination: 'https://example.com' }, owner);
    assert.equal(result.applied, false); assert.match(result.reason, /changed/); assert.equal(view.state, before);
  });
});

test('link Apply rechecks IME/read-only and keeps uniform CRLF offsets', () => {
  useSpec('[[label]]', {}, view => {
    const { intent } = beginLinkCommand(view, context); Object.defineProperty(view, 'composing', { value: true });
    const before = view.state; const result = applyLinkCommand(view, intent, { label: 'label', destination: '#x' }, context);
    assert.equal(result.applied, false); assert.match(result.reason, /composition/); assert.equal(view.state, before);
  });
  useSpec('label|', { readOnly: true }, view => assert.equal(beginLinkCommand(view, context).intent, null));
  withView('one\r\n\r\nlabel', EditorSelection.single(5, 10), { lineSeparator: '\r\n' }, view => {
    const result = submit(view, { label: 'new label', destination: '#x' }); assert.equal(result.applied, true, result.reason);
    assert.equal(view.state.sliceDoc(), 'one\r\n\r\n[new label](<#x>)');
  });
});

test('reader-only strike, escaped source and GFM email contexts refuse literal-label replacement', () => {
  for (const source of ['~fo|o~', '[[~foo~]]', '[[a\\*b]]', 'foo@exam|ple.com', 'http://host?que|ry']) {
    useSpec(source, {}, view => {
      const before = view.state; assert.equal(beginLinkCommand(view, context).intent, null, source); assert.equal(view.state, before);
    });
  }
});

test('an empty non-Markdown editor cannot capture a link intent', () => {
  useSpec('|', { markdown: false }, view => {
    assert.equal(beginLinkCommand(view, context).intent, null);
    assert.equal(view.state.sliceDoc(), '');
  });
});


test('command intent survives display-only state changes and still validates live source on Apply', () => {
  const {setMarkdownFormatting}=require('../.tmp/workspace-tests/src/components/markdown-decorations.js');
  useSpec('[[label]] after',{},view=>{
    const {intent}=beginLinkCommand(view,context),doc=view.state.doc,selection=view.state.selection;
    view.dispatch({effects:setMarkdownFormatting.of(false)});view.dispatch({effects:StateEffect.define().of(null)});
    assert.ok(view.state.doc === doc);assert.ok(view.state.selection === selection);
    assert.equal(applyLinkCommand(view,intent,{label:'label',destination:'#target'},context).applied,true);
    assert.equal(view.state.sliceDoc(),'[label](<#target>) after');assert.equal(undoDepth(view.state),1);
  });
});

test('an intent rejected for a different file or session stays retired when its owner returns', () => {
  for(const owner of [{...context,filePath:'/other.md'},{...context,session:2}]) useSpec('[[label]]',{},view=>{
    const {intent}=beginLinkCommand(view,context),input={label:'label',destination:'#target'};
    assert.equal(applyLinkCommand(view,intent,input,owner).applied,false);
    assert.equal(applyLinkCommand(view,intent,input,context).applied,false);assert.equal(view.state.sliceDoc(),'label');
  });
});
