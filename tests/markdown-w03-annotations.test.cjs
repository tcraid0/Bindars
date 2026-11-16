const test = require('node:test');
const assert = require('node:assert/strict');
const { EditorSelection } = require('@codemirror/state');
const { undo, redo } = require('@codemirror/commands');
const { applyBlockCommand, beginLinkCommand, applyLinkCommand } = require('../.tmp/workspace-tests/src/components/markdown-formatting-commands.js');
const { createView } = require('./_helpers/markdown-command-view.cjs');
const { markdownArticle } = require('./_helpers/markdown-reader.cjs');
const { collectText, rangeForOffsets } = require('../.tmp/workspace-tests/src/lib/dom-text.js');
const { createPositionedAnchor, prepareAnnotationDocument, resolveAnchor } = require('../.tmp/workspace-tests/src/lib/text-anchoring.js');
const { readAnnotationRecord, storedAnnotationRecord } = require('../.tmp/workspace-tests/src/lib/annotation-record.js');
const owner = { filePath: '/workspace/note.md', session: 1 };

async function locate(anchor, source) {
  const reader = markdownArticle(source);
  const result = resolveAnchor(anchor, reader, await prepareAnnotationDocument(reader, source));
  if (result.range) {
    const index = collectText(reader); const start = index.text.lastIndexOf('quote');
    const intended = rangeForOffsets(index.spans, start, start + 5);
    assert.equal(result.range.startContainer, intended.startContainer, 'original last occurrence, not merely the same quote text');
    assert.equal(result.range.startOffset, intended.startOffset);
    assert.equal(result.range.endContainer, intended.endContainer); assert.equal(result.range.endOffset, intended.endOffset);
  }
  return result.status;
}

test('W03 actual command output distinguishes original occurrence, uncertain/missing and retained records', async t => {
  const paragraph = 'A'.repeat(40) + 'quote' + 'B'.repeat(40);
  for (const command of ['h1','paragraph','divider','quote','link']) for (const duplicate of [false,true]) {
    const prefix = duplicate ? `${paragraph}\n\n` : '';
    const source = prefix + (command === 'paragraph' ? '#### ' : '') + paragraph;
    const before = markdownArticle(source); const index = collectText(before);
    const start = index.text.lastIndexOf('quote');
    const anchor = await createPositionedAnchor(rangeForOffsets(index.spans, start, start + 5), before, source);
    const record = { version: 3, highlights: [{ ...anchor, id: `${command}-${duplicate}`, note: 'retain note', color: 'blue', createdAt: 1, nearestHeadingId: null }], bookmarks: [] };
    const reopened = readAnnotationRecord(JSON.parse(JSON.stringify(record)));
    assert.equal(await locate(anchor, source), 'located');
    const offset = source.lastIndexOf('quote');
    const host = createView(source, EditorSelection.single(offset, offset + 5));
    try {
      const result = command === 'link'
        ? applyLinkCommand(host.view, beginLinkCommand(host.view, owner).intent, { label: 'quote', destination: '#target' }, owner)
        : applyBlockCommand(host.view, command);
      assert.equal(result.applied, true, result.reason);
      const output = host.view.state.sliceDoc();
      const status = await locate(reopened.annotations.highlights[0], output);
      t.diagnostic(JSON.stringify({ command, duplicate, baseline: 'located-original', after: status,
        retained: reopened.annotations.highlights.length, savedRecordReload: 'JSON + actual reader; no filesystem claim', output }));
      assert.equal(status, duplicate ? 'uncertain' : 'located');
      assert.deepEqual(storedAnnotationRecord(reopened), record);
      assert.equal(undo(host.view), true); assert.equal(host.view.state.sliceDoc(), source);
      assert.equal(await locate(anchor, host.view.state.sliceDoc()), 'located');
      assert.equal(redo(host.view), true); assert.equal(await locate(anchor, host.view.state.sliceDoc()), status);
      assert.equal(await locate(anchor, output.replaceAll('quote', 'removed')), 'missing');
    } finally { host.destroy(); }
  }
});

test('unrefreshed evidence after format → unrelated typing → format remains uncertain, with exact-source Undo recovery', async t => {
  const paragraph = 'A'.repeat(40) + 'quote' + 'B'.repeat(40);
  const source = `${paragraph}\n\n${paragraph}`;
  const reader = markdownArticle(source); const index = collectText(reader); const start = index.text.lastIndexOf('quote');
  const anchor = await createPositionedAnchor(rangeForOffsets(index.spans, start, start + 5), reader, source);
  const host = createView(source, EditorSelection.cursor(source.lastIndexOf('quote')));
  try {
    assert.equal(applyBlockCommand(host.view, 'h1').applied, true);
    host.view.dispatch({ changes: { from: host.view.state.doc.length, insert: '\n\nUnrelated typing.' }, userEvent: 'input.type' });
    const offset = host.view.state.sliceDoc().lastIndexOf('quote');
    host.view.dispatch({ selection: EditorSelection.single(offset, offset + 5) });
    const intent = beginLinkCommand(host.view, owner).intent; assert.ok(intent);
    assert.equal(applyLinkCommand(host.view, intent, { label: 'quote', destination: '#target' }, owner).applied, true);
    assert.equal(await locate(anchor, host.view.state.sliceDoc()), 'uncertain');
    undo(host.view); assert.equal(await locate(anchor, host.view.state.sliceDoc()), 'uncertain');
    undo(host.view); assert.equal(await locate(anchor, host.view.state.sliceDoc()), 'uncertain');
    undo(host.view); assert.equal(host.view.state.sliceDoc(), source); assert.equal(await locate(anchor, source), 'located');
    t.diagnostic('Without an R01 Read-boundary refresh the existing resolver stays conservative; exact-source Undo restores its original positioned anchor.');
  } finally { host.destroy(); }
});

test('short-note structural whitespace has separate measured continuity outcomes', async t => {
  const results = [];
  for (const command of ['h1','divider','quote','link']) {
    const source = 'prefix quote suffix'; const reader = markdownArticle(source); const index = collectText(reader);
    const start = index.text.indexOf('quote');
    const anchor = await createPositionedAnchor(rangeForOffsets(index.spans, start, start + 5), reader, source);
    const host = createView(source, EditorSelection.single(7, 12));
    try {
      const result = command === 'link'
        ? applyLinkCommand(host.view, beginLinkCommand(host.view, owner).intent, { label: 'quote', destination: 'https://example.com' }, owner)
        : applyBlockCommand(host.view, command);
      assert.equal(result.applied, true, result.reason);
      const output = host.view.state.sliceDoc(); const status = await locate(anchor, output);
      results.push({ command, status, retained: 1, beforeText: index.text, afterText: collectText(markdownArticle(output)).text });
      t.diagnostic(JSON.stringify(results[results.length - 1]));
      assert.equal(status, 'located', command);
    } finally { host.destroy(); }
  }
  t.diagnostic(JSON.stringify(results));
});
