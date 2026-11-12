const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { forceParsing } = require('@codemirror/language');
const { findEditorView } = require('./_helpers/codemirror.cjs');
const { scenarios, E, BASE, occurrences } = require('./_fixtures/highlight-continuity.cjs');
const { CodeMirrorEditor } = require('../.tmp/workspace-tests/src/components/CodeMirrorEditor.js');
const { MarkdownRenderer } = require('../.tmp/workspace-tests/src/components/MarkdownRenderer.js');
const { ToastProvider } = require('../.tmp/workspace-tests/src/components/ToastProvider.js');
const { useAnnotations } = require('../.tmp/workspace-tests/src/hooks/useAnnotations.js');
const storage = require('../.tmp/workspace-tests/src/lib/annotation-storage.js');
const { collectText, rangeForOffsets } = require('../.tmp/workspace-tests/src/lib/dom-text.js');
const { createPositionedAnchor, prepareAnnotationDocument, resolveAnchor } = require('../.tmp/workspace-tests/src/lib/text-anchoring.js');
const { captureHighlightBlocks, refreshHighlightBlocks, joinObservedChanges, departureClaims, refreshDepartureClaims } = require('../.tmp/workspace-tests/src/lib/highlight-continuity.js');
const settings = { fontSize: 18, contentWidth: 72, lineHeight: 1.6, fontFamily: 'newsreader', paragraphSpacing: 'comfortable', sceneLensEnabled: true, reducedEffects: false };

async function mounted(t, source) {
  const disk = new Map(); const writes = [];
  t.mock.method(storage, 'loadAnnotations', async path => structuredClone(disk.get(path) ?? null));
  t.mock.method(storage, 'saveAnnotations', async (path, value) => { writes.push(structuredClone(value)); disk.set(path, structuredClone(value)); });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host), editor = React.createRef(), reader = React.createRef();
  let api, linkForm;
  function Surface({ editing, source, path }) {
    api = useAnnotations(path);
    return React.createElement(ToastProvider, null, editing
      ? React.createElement(CodeMirrorEditor, { key: source, ref: editor, initialDocument: source, filePath: path,
        fileType: 'markdown', markdownFormattingEnabled: true, onBufferChange: () => false, onLinkFormChange: value => linkForm = value })
      : React.createElement(MarkdownRenderer, { key: source, content: source, filePath: path, settings, contentRef: reader,
        imagesAuthorized: true, onOpenFragment: () => false }));
  }
  async function render(editing, content = source, path = '/r01.md') {
    await act(async () => root.render(React.createElement(Surface, { editing, source: content, path })));
    if (editing) {
      const view = findEditorView(host); view.bindarsHandle = editor.current; view.bindarsLinkForm = () => linkForm;
      forceParsing(view, view.state.doc.length, 2000);
      return view;
    }
    return reader.current;
  }
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  return { render, disk, writes, api: () => api, editor, reader };
}

function assertOccurrence(anchor, reader, evidence, expected, exact) {
  const result = resolveAnchor(anchor, reader, evidence);
  if (expected === null) { assert.equal(result.range, null, 'must never paint another or retyped occurrence'); return result.status; }
  assert.equal(result.status, 'located');
  const index = collectText(reader), start = occurrences(index.text, exact)[expected];
  const intended = rangeForOffsets(index.spans, start, start + exact.length);
  assert.ok(intended, 'expected original occurrence exists');
  assert.ok(result.range.startContainer === intended.startContainer, 'start belongs to the original occurrence');
  assert.equal(result.range.startOffset, intended.startOffset);
  assert.ok(result.range.endContainer === intended.endContainer, 'end belongs to the original occurrence');
  assert.equal(result.range.endOffset, intended.endOffset);
  return 'correct original occurrence';
}

const supported = new Set(['S01','S02','S03','S04','S05','S07','S08','S13','S15','S16','S17','S18','S19','S21','S33']);

test('R01 reader source columns identify the first body character after BOM or frontmatter', async t => {
  const sources = [
    'Body\n\nLater.', '\uFEFFBody\n\nLater.', '\uFEFF# Body\n\nLater.',
    '---\ntitle: T\n---Body\n\nLater.',
    '---\r\ntitle: T\r\n---  Body\r\n\r\nLater.',
    '\uFEFF---\ntitle: T\n---\nBody\n\nLater.',
    '---\ntitle: T\n---\n\uFEFFBody\n\nLater.',
    '---\ntitle: T\n---\uFEFFBody\n\nLater.',
  ];
  const surface = await mounted(t, sources[0]);
  for (const source of sources) {
    const reader = await surface.render(false, source);
    const block = reader.querySelector('[data-bindars-source-line][data-bindars-source-column]');
    assert.ok(block);
    const line = Number(block.dataset.bindarsSourceLine), column = Number(block.dataset.bindarsSourceColumn);
    assert.equal(source.split(/\r\n|\r|\n/)[line - 1].slice(column - 1, column + 3), 'Body', JSON.stringify(source));
  }
});

for (const prefix of ['\uFEFF', '\uFEFF# ', '---\ntitle: T\n---', '---\ntitle: T\n---\uFEFF']) {
  test(`R01 first-body highlight follows its original copy when another is inserted (${JSON.stringify(prefix)})`, async t => {
    const { P } = require('./_fixtures/highlight-continuity.cjs');
    const source = prefix + P + '\n\nMiddle paragraph.\n';
    const surface = await mounted(t, source);
    let reader = await surface.render(false);
    const evidence = await prepareAnnotationDocument(reader, source), index = collectText(reader), start = index.text.indexOf('amber');
    const anchor = await createPositionedAnchor(rangeForOffsets(index.spans, start, start + 5), reader, source);
    await act(async () => surface.api().addHighlight(anchor, 'blue', null));
    const capture = captureHighlightBlocks(reader, source, evidence, surface.api().highlights);
    assert.equal(capture.blocks.length, 1);
    const view = await surface.render(true);
    await act(async () => E.insertAt(view, prefix.length, P + '\n\n'));
    const output = view.state.sliceDoc(), changes = surface.editor.current.captureChanges();
    reader = await surface.render(false, output);
    const currentEvidence = await prepareAnnotationDocument(reader, output);
    const claims = await departureClaims(capture, changes);
    const claimed = capture.blocks.map(item => ({ ...item.basis, id: item.id, continuity: claims.find(c => c.id === item.id)?.claim }));
    const persistedUpdates = await refreshDepartureClaims(claimed, reader, currentEvidence);
    assert.equal(persistedUpdates.length, 1);
    assertOccurrence(persistedUpdates[0].anchor, reader, currentEvidence, 1, 'amber');
    const updates = refreshHighlightBlocks(capture, changes, reader, output, currentEvidence);
    assert.equal(updates.length, 1);
    await act(async () => surface.api().refreshPassages(updates));
    await surface.api().waitForSaves();
    const saved = surface.disk.get('/r01.md').highlights[0];
    assertOccurrence(saved, reader, currentEvidence, 1, 'amber');
    reader = await surface.render(false, output, '/reopened.md');
    assertOccurrence(saved, reader, await prepareAnnotationDocument(reader, output), 1, 'amber');
  });
}

for (const scenario of scenarios) {
  test(`R01 mounted command/reader/persistence ${scenario.id}`, async t => {
    const surface = await mounted(t, scenario.source);
    let reader = await surface.render(false);
    const original = await prepareAnnotationDocument(reader, scenario.source);
    const index = collectText(reader), start = occurrences(index.text, scenario.exact)[scenario.nth];
    const anchor = await createPositionedAnchor(rangeForOffsets(index.spans, start, start + scenario.exact.length), reader, scenario.source);
    let id;
    await act(async () => { id = surface.api().addHighlight(anchor, 'blue', 'notes'); });
    // Seed forward-compatible fields through the real record reader/writer.
    await act(async () => surface.api().restoreRecord({ version: 3, highlights: [{ ...surface.api().highlights[0], note: 'SECOND occurrence note',
      originalExcerpt: 'earlier excerpt', future: { keep: true } }], bookmarks: [], futureRecord: 42 }));
    const before = structuredClone(surface.api().highlights[0]);
    const capture = captureHighlightBlocks(reader, scenario.source, original, surface.api().highlights);
    assert.equal(capture.blocks.length, 1);
    const view = await surface.render(true);
    await act(async () => scenario.edits(view, E));
    const output = view.state.sliceDoc(), changes = surface.editor.current.captureChanges();
    assert.equal(changes.initialDocument, scenario.source);
    assert.equal(changes.finalDocument, output);
    if (scenario.id.startsWith('S17')) assert.equal(output.replaceAll('\r\n', '').includes('\n'), false, 'uniform CRLF remains exact');
    reader = await surface.render(false, output);
    const evidence = await prepareAnnotationDocument(reader, output);
    const claims = await departureClaims(capture, changes);
    const claimed = capture.blocks.map(item => ({ ...item.basis, id: item.id, continuity: claims.find(c => c.id === item.id)?.claim }));
    const persistedUpdates = await refreshDepartureClaims(claimed, reader, evidence);
    const updates = refreshHighlightBlocks(capture, changes, reader, output, evidence);
    assert.deepEqual(persistedUpdates.map(({id, anchor}) => ({id, anchor})), updates.map(({id, anchor}) => ({id, anchor})), 'hash claims and in-memory verification agree');
    await act(async () => surface.api().refreshPassages(updates));
    const current = surface.api().highlights[0];
    const expected = supported.has(scenario.id.slice(0, 3)) ? scenario.expected : scenario.id.startsWith('S31') ? 1 : null;
    const located = assertOccurrence(current, reader, evidence, expected, scenario.exact);
    const outcome = scenario.id.startsWith('S31') ? 'existing byte-identical snapshot convention; not character provenance' : located;
    assert.deepEqual({ ...current, prefix: before.prefix, suffix: before.suffix, position: before.position }, before, 'retain all non-attachment fields');
    assert.equal(current.id, id);
    if (expected !== null && !scenario.id.startsWith('S31')) assert.equal(updates.length, 1);
    if (expected === null) assert.equal(updates.length, 0, 'strict Tier 2 must refuse rejected in-block extensions');
    // Reopen through the existing hook and stored record, not merely JSON retention.
    await surface.render(false, '# Other', '/other.md');
    reader = await surface.render(false, output);
    assertOccurrence(surface.api().highlights[0], reader, await prepareAnnotationDocument(reader, output), expected, scenario.exact);
    assert.equal(surface.disk.get('/r01.md').futureRecord, 42);
    t.diagnostic(JSON.stringify({ scenario: scenario.id.slice(0,3), outcome, persistedReopen: outcome, retained: true,
      environment: 'Node/Happy DOM mounted React; not native' }));
    if (['S01','S02'].includes(scenario.id.slice(0,3))) {
      const fresh = await prepareAnnotationDocument(reader, output);
      const again = captureHighlightBlocks(reader, output, fresh, surface.api().highlights);
      const second = await surface.render(true, output);
      await act(async () => { E.typeBefore(second, second.state.doc.line(1).text, 0, 'New paragraph.\n\n'); E.select(second, scenario.exact === 'quote' ? 'quote' : 'amber', 0); E.cmd(second, 'italic'); });
      const final = second.state.sliceDoc(), next = surface.editor.current.captureChanges();
      reader = await surface.render(false, final);
      const ev = await prepareAnnotationDocument(reader, final);
      await act(async () => surface.api().refreshPassages(refreshHighlightBlocks(again, next, reader, final, ev)));
      assertOccurrence(surface.api().highlights[0], reader, ev, 1, scenario.exact);
    }
  });
}

test('external adoption invalidates continuity; stale snapshots remain immutable and exact source ownership is required', async t => {
  const s = await mounted(t, BASE); const view = await s.render(true);
  const point = { line: 5, column: 1 };
  await act(async () => E.typeEnd(view, 'Elsewhere.'));
  const captured = s.editor.current.captureChanges();
  assert.deepEqual(captured.mapTextPoint(point), point);
  await act(async () => assert.equal(s.editor.current.adoptExternalDocument(view.state.sliceDoc(), BASE + 'External.'), true));
  assert.equal(s.editor.current.captureChanges(), null);
  assert.equal(captured.finalDocument, BASE + 'Elsewhere.');
  await act(async () => E.typeEnd(view, ' typing'));
  assert.equal(s.editor.current.captureChanges(), null);
  assert.equal(joinObservedChanges(captured, { ...captured, initialDocument: 'unknown' }), null);
});

test('source adoption, legacy/context-only bases and multi-block selections cannot gain exact evidence', async t => {
  const s = await mounted(t, BASE), reader = await s.render(false);
  const evidence = await prepareAnnotationDocument(reader, BASE);
  const legacy = { id: 'legacy', exact: 'amber', prefix: '', suffix: '' };
  assert.equal(captureHighlightBlocks(reader, BASE, evidence, [legacy]).blocks.length, 0);
  const { positionedHighlight } = require('./_helpers/markdown-reader.cjs');
  const old = await positionedHighlight('Original unique words.', { id: 'context', exact: 'unique' });
  const altered = 'Original unique words.\n\nElsewhere.';
  const other = await s.render(false, altered), ev = await prepareAnnotationDocument(other, altered);
  assert.equal(resolveAnchor(old, other, ev).basis, 'context');
  assert.equal(captureHighlightBlocks(other, altered, ev, [old]).blocks.length, 0);
  const whole = collectText(reader), first = whole.text.indexOf('amber'), last = whole.text.lastIndexOf('amber') + 5;
  const spanning = await createPositionedAnchor(rangeForOffsets(whole.spans, first, last), reader, BASE);
  assert.equal(captureHighlightBlocks(reader, BASE, evidence, [{ ...spanning, id: 'multi' }]).blocks.length, 0);
});

test('R01 typing observes changes without reader DOM collection, hashing or reader parsing', async t => {
  const surface = await mounted(t, BASE), view = await surface.render(true);
  const dom = require('../.tmp/workspace-tests/src/lib/dom-text.js');
  const anchoring = require('../.tmp/workspace-tests/src/lib/text-anchoring.js');
  const processing = require('../.tmp/workspace-tests/src/lib/document-processing.js');
  const collect = t.mock.method(dom, 'collectText');
  const prepare = t.mock.method(anchoring, 'prepareAnnotationDocument');
  const parse = t.mock.method(processing, 'prepareReaderDocument');
  await act(async () => { for (let i = 0; i < 200; i++) E.typeEnd(view, 'x'); });
  assert.equal(collect.mock.callCount(), 0); assert.equal(prepare.mock.callCount(), 0); assert.equal(parse.mock.callCount(), 0);
  const observed = surface.editor.current.captureChanges();
  assert.equal(observed.finalDocument, BASE + 'x'.repeat(200));
  assert.deepEqual(observed.mapTextPoint({ line: 5, column: 1 }), { line: 5, column: 1 });
});

test('R01 exact-source Undo uses existing snapshot evidence without refresh; total deletion is missing', async t => {
  const surface = await mounted(t, BASE), reader = await surface.render(false);
  const evidence = await prepareAnnotationDocument(reader, BASE), index = collectText(reader), start = index.text.lastIndexOf('amber');
  const anchor = await createPositionedAnchor(rangeForOffsets(index.spans, start, start + 5), reader, BASE);
  const capture = captureHighlightBlocks(reader, BASE, evidence, [{ ...anchor, id: 'h' }]);
  const view = await surface.render(true);
  await act(async () => { E.select(view, 'amber', 1); E.cmd(view, 'bold'); E.undo(view); });
  const changes = surface.editor.current.captureChanges();
  assert.equal(changes.finalDocument, BASE);
  const reopened = await surface.render(false);
  const ev = await prepareAnnotationDocument(reopened, BASE);
  assert.equal(refreshHighlightBlocks(capture, changes, reopened, BASE, ev).length, 0);
  assertOccurrence(anchor, reopened, ev, 1, 'amber');
  const deleted = BASE.replaceAll('amber', 'removed');
  const gone = await surface.render(false, deleted);
  assert.equal(resolveAnchor(anchor, gone, await prepareAnnotationDocument(gone, deleted)).status, 'missing');
  assert.equal(refreshHighlightBlocks(capture, changes, gone, deleted, await prepareAnnotationDocument(gone, deleted)).length, 0);
});

for (const mode of ['above', 'insert', 'same']) {
  const sameBullet = mode === 'same';
  test(`departure claims verify outline ${mode}: ${sameBullet ? 'same-bullet refusal' : 'adjacent-bullet edit'}`, async t => {
    const { departureClaims, refreshDepartureClaims, validDepartureClaim } = require('../.tmp/workspace-tests/src/lib/highlight-continuity.js');
    const { OUTLINE: source } = require('./_fixtures/highlight-continuity.cjs');
    const surface = await mounted(t, source);
    let reader = await surface.render(false);
    const index = collectText(reader), start = index.text.indexOf('amber');
    const anchor = await createPositionedAnchor(rangeForOffsets(index.spans, start, start + 5), reader, source);
    await act(async () => surface.api().addHighlight(anchor, 'blue', null));
    const highlights = surface.api().highlights;
    const capture = captureHighlightBlocks(reader, source, await prepareAnnotationDocument(reader, source), highlights);
    const view = await surface.render(true);
    await act(async () => mode === 'insert' ? E.insertAt(view, view.state.sliceDoc().indexOf('- unique'), '- added bullet\n') : E.typeAfter(view, sameBullet ? 'after' : 'first', 0, ' revised'));
    const output = view.state.sliceDoc();
    const claims = await departureClaims(capture, surface.editor.current.captureChanges());
    assert.equal(claims.length, 1); assert.ok(validDepartureClaim(claims[0].claim));
    const claimed = [{ ...highlights[0], continuity: claims[0].claim }];
    reader = await surface.render(false, output);
    const evidence = await prepareAnnotationDocument(reader, output);
    const updates = await refreshDepartureClaims(claimed, reader, evidence);
    assert.equal(updates.length, sameBullet ? 0 : 1);
    if (!sameBullet) assertOccurrence(updates[0].anchor, reader, evidence, 0, 'amber');
    assert.deepEqual(await refreshDepartureClaims(claimed, reader, { ...evidence, sourceHash: 'e'.repeat(64) }), []);
    for (const malformed of [null, {}, { ...claims[0].claim, start: -1 }, { ...claims[0].claim, basis: [] }]) {
      assert.equal(validDepartureClaim(malformed), false);
      assert.deepEqual(await refreshDepartureClaims([{ ...highlights[0], continuity: malformed }], reader, evidence), []);
    }
  });
}
