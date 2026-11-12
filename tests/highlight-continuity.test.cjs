const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { forceParsing } = require('@codemirror/language');
const { findEditorView } = require('./_helpers/codemirror.cjs');
const { scenarios, E, BASE, OUTLINE, occurrences } = require('./_fixtures/highlight-continuity.cjs');
const { CodeMirrorEditor } = require('../.tmp/workspace-tests/src/components/CodeMirrorEditor.js');
const { MarkdownRenderer } = require('../.tmp/workspace-tests/src/components/MarkdownRenderer.js');
const { ToastProvider } = require('../.tmp/workspace-tests/src/components/ToastProvider.js');
const { useAnnotations } = require('../.tmp/workspace-tests/src/hooks/useAnnotations.js');
const storage = require('../.tmp/workspace-tests/src/lib/annotation-storage.js');
const { collectText, rangeForOffsets } = require('../.tmp/workspace-tests/src/lib/dom-text.js');
const { createPositionedAnchor, prepareAnnotationDocument, resolveAnchor } = require('../.tmp/workspace-tests/src/lib/text-anchoring.js');
const { captureHighlightBlocks, refreshHighlightBlocks, joinObservedChanges, departureClaims, refreshDepartureClaims, validDepartureClaim } = require('../.tmp/workspace-tests/src/lib/highlight-continuity.js');
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
  // Never assert.equal on a Range: Happy DOM takes many seconds to print one.
  if (expected === null) { assert.ok(result.range === null, 'must never paint another or retyped occurrence'); return result.status; }
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

// Unchanged blocks, plus in-block edits that leave the passage's own plain-text characters untouched.
const supported = new Set(['S01','S02','S03','S04','S05','S07','S08','S13','S15','S16','S17','S18','S19','S21','S33',
  'S09','S10','S20','S22','S24','S26','S27','P01','P02','P03','P04','P05','P06','P07','P08','P09']);

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
    const persistedUpdates = await refreshDepartureClaims(claimed, reader, output, currentEvidence);
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
    const persistedUpdates = await refreshDepartureClaims(claimed, reader, output, evidence);
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
    if (expected === null) assert.equal(updates.length, 0, 'removed, retyped or not provably plain passages are never refreshed');
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

// The passage is in the middle bullet. Its own bullet may be reworded when the bullet is plain text up to the passage.
for (const [mode, located] of [['above', true], ['insert', true], ['same', true], ['markup', false]]) {
  test(`departure claims verify outline ${mode}: ${located ? 'located' : 'formatting before the passage refuses'}`, async t => {
    const source = mode === 'markup' ? OUTLINE.replace('- unique', '- *unique*') : OUTLINE;
    const surface = await mounted(t, source);
    let reader = await surface.render(false);
    const index = collectText(reader), start = index.text.indexOf('amber');
    const anchor = await createPositionedAnchor(rangeForOffsets(index.spans, start, start + 5), reader, source);
    await act(async () => surface.api().addHighlight(anchor, 'blue', null));
    const highlights = surface.api().highlights;
    const capture = captureHighlightBlocks(reader, source, await prepareAnnotationDocument(reader, source), highlights);
    const view = await surface.render(true);
    await act(async () => mode === 'insert' ? E.insertAt(view, view.state.sliceDoc().indexOf('- unique'), '- added bullet\n') : E.typeAfter(view, mode === 'above' ? 'first' : 'after', 0, ' revised'));
    const output = view.state.sliceDoc(), changes = surface.editor.current.captureChanges();
    const claims = await departureClaims(capture, changes);
    assert.equal(claims.length, 1); assert.ok(validDepartureClaim(claims[0].claim));
    assert.equal('run' in claims[0].claim, mode !== 'markup', 'only a plain-text run is recorded');
    const claimed = [{ ...highlights[0], continuity: claims[0].claim }];
    reader = await surface.render(false, output);
    const evidence = await prepareAnnotationDocument(reader, output);
    const updates = await refreshDepartureClaims(claimed, reader, output, evidence);
    assert.equal(updates.length, located ? 1 : 0);
    if (located) assertOccurrence(updates[0].anchor, reader, evidence, 0, 'amber');
    assert.deepEqual(refreshHighlightBlocks(capture, changes, reader, output, evidence).map(u => u.anchor), updates.map(u => u.anchor));
    assert.deepEqual(await refreshDepartureClaims(claimed, reader, output, { ...evidence, sourceHash: 'e'.repeat(64) }), []);
  });
}

test('departure claims carry a block part, a run part or both; every other shape is inert', async t => {
  const surface = await mounted(t, OUTLINE);
  let reader = await surface.render(false);
  const index = collectText(reader), start = index.text.indexOf('amber');
  const highlight = { ...await createPositionedAnchor(rangeForOffsets(index.spans, start, start + 5), reader, OUTLINE), id: 'h' };
  const capture = captureHighlightBlocks(reader, OUTLINE, await prepareAnnotationDocument(reader, OUTLINE), [highlight]);
  const view = await surface.render(true);
  await act(async () => E.typeAfter(view, 'unique', 0, ' and rare'));
  const output = view.state.sliceDoc();
  const [{ claim }] = await departureClaims(capture, surface.editor.current.captureChanges());
  assert.deepEqual(Object.keys(claim), ['format', 'sourceHash', 'block', 'run', 'basis']);
  assert.deepEqual(Object.keys(claim.block), ['line', 'column', 'blockHash', 'start', 'end']);
  assert.deepEqual(claim.run, { line: 4, column: 19 }, 'the passage start in the saved source');
  reader = await surface.render(false, output);
  const evidence = await prepareAnnotationDocument(reader, output);
  const refresh = continuity => refreshDepartureClaims([{ ...highlight, continuity }], reader, output, evidence);
  const { block, run, ...neither } = claim;
  for (const [valid, located] of [[claim, 1], [{ ...neither, run }, 1], [{ ...neither, block }, 0]]) {
    assert.equal(validDepartureClaim(valid), true);
    const updates = await refresh(valid);
    assert.equal(updates.length, located, 'the reworded bullet is found by its run, never by its changed block');
    if (located) assertOccurrence(updates[0].anchor, reader, evidence, 0, 'amber');
  }
  const flat = { ...neither, ...block };   // the unreleased first shape
  for (const malformed of [null, {}, 'claim', neither, flat, { ...claim, format: 2 }, { ...claim, basis: [] }, { ...claim, sourceHash: 'x' },
    { ...claim, block: null }, { ...claim, block: { ...block, start: -1 } }, { ...claim, block: { ...block, end: block.start } }, { ...claim, block: { ...block, blockHash: 'x' } },
    { ...claim, run: null }, { ...claim, run: [] }, { ...claim, run: 'x' }, { ...claim, run: { line: 0, column: 1 } }, { ...claim, run: { line: 4 } }, { ...claim, run: { line: 4, column: 1.5 } }]) {
    assert.equal(validDepartureClaim(malformed), false, JSON.stringify(malformed));
    assert.deepEqual(await refresh(malformed), []);
  }
});

test('a departure from an unchanged document writes no claim', async t => {
  const surface = await mounted(t, OUTLINE);
  const reader = await surface.render(false);
  const index = collectText(reader), start = index.text.indexOf('amber');
  const highlight = { ...await createPositionedAnchor(rangeForOffsets(index.spans, start, start + 5), reader, OUTLINE), id: 'h' };
  const capture = captureHighlightBlocks(reader, OUTLINE, await prepareAnnotationDocument(reader, OUTLINE), [highlight]);
  assert.equal(capture.blocks.length, 1);
  const view = await surface.render(true);
  await act(async () => E.typeAfter(view, 'unique', 0, ' and rare'));
  const typed = view.state.sliceDoc().indexOf(' and rare');
  await act(async () => view.dispatch({ changes: { from: typed, to: typed + ' and rare'.length } }));
  assert.equal(view.state.sliceDoc(), OUTLINE, 'typed and removed again: an unchanged document');
  assert.deepEqual(await departureClaims(capture, surface.editor.current.captureChanges()), []);
});

test('R01 mapTextPoint follows a run only while every one of its characters is untouched', async t => {
  const source = 'Intro.\n\nThe team found the cobalt ledger today.\nSecond line.\n';
  const surface = await mounted(t, source);
  const at = source.indexOf('cobalt'), length = 'cobalt ledger'.length, line = source.split('\n')[2];
  const run = { line: 3, column: line.indexOf('cobalt') + 1 }, moved = by => ({ line: 3, column: run.column + by });
  // Each case is one change in a fresh editor session of `content`.
  const after = async (change, content = source) => {
    await surface.render(false, content); const view = await surface.render(true, content);
    if (change) await act(async () => view.dispatch({ changes: change, userEvent: 'input.type' }));
    return surface.editor.current.captureChanges();
  };
  assert.deepEqual((await after(null)).mapTextPoint(run, length), run);
  assert.deepEqual((await after({ from: at, insert: 'blue ' })).mapTextPoint(run, length), moved(5), 'typing against the start edge');
  assert.deepEqual((await after({ from: at + length, insert: 's' })).mapTextPoint(run, length), run, 'typing against the end edge');
  assert.deepEqual((await after({ from: at - 1, to: at })).mapTextPoint(run, length), moved(-1), 'deleting the character before');
  assert.deepEqual((await after({ from: at + length, to: at + length + 1 })).mapTextPoint(run, length), run, 'deleting the character after');
  for (const [label, change] of [['typing inside', { from: at + 1, insert: 'x' }], ['typing before the last character', { from: at + length - 1, insert: 'x' }],
    ['deleting the first character', { from: at, to: at + 1 }], ['deleting the last character', { from: at + length - 1, to: at + length }],
    ['retyping the run identically', { from: at, to: at + length, insert: 'cobalt ledger' }], ['retyping one inner letter identically', { from: at + 3, to: at + 4, insert: 'a' }],
    ['replacing a phrase that contains the run', { from: at - 4, to: at + length + 1, insert: 'the cobalt ledger ' }]]) {
    assert.ok((await after(change)).mapTextPoint(run, length) === null, label);
  }
  // A single character, the block-start case, obeys the same contract.
  assert.deepEqual((await after({ from: at, insert: 'x' })).mapTextPoint(run), moved(1));
  assert.deepEqual((await after({ from: at + 1, insert: 'x' })).mapTextPoint(run), run);
  assert.ok((await after({ from: at, to: at + 1, insert: 'c' })).mapTextPoint(run) === null, 'an identical retype is still a replacement');
  // A run never continues past its own line, and bad lengths are refused.
  const untouched = await after(null);
  assert.deepEqual(untouched.mapTextPoint({ line: 3, column: line.length }, 1), { line: 3, column: line.length });
  for (const [column, size] of [[line.length, 2], [run.column, 0], [run.column, 1.5]]) assert.ok(untouched.mapTextPoint({ line: 3, column }, size) === null);
  // Rapid Read→Edit: a joined chain follows the run through both sessions, or refuses with either.
  const first = await after({ from: at, insert: 'blue ' });
  const later = await after({ from: 0, insert: 'Above.\n\n' }, first.finalDocument);
  assert.deepEqual(joinObservedChanges(first, later).mapTextPoint(run, length), { line: 5, column: run.column + 5 });
  const touching = await after({ from: at + 5 + 2, insert: 'x' }, first.finalDocument);
  assert.ok(joinObservedChanges(first, touching).mapTextPoint(run, length) === null);
});

// Independent oracle: every original source character carries an id through each edit, kept beside the
// editor. A refresh is correct only when re-rendering the final source with exactly the passage's original
// characters replaced by marker letters shows the markers at the refreshed rendered offsets.
test('R01 seeded stress: a refreshed location is always the passage\'s own original characters', async t => {
  let seed = 20261112;
  const random = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let x = Math.imul(seed ^ seed >>> 15, 1 | seed);
    x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; };
  const pick = list => list[Math.floor(random() * list.length)];
  const WORDS = ['amber', 'signal', 'cobalt', 'ledger', 'the', 'team', 'records', 'a', 'quiet', 'harbor', 'and', 'then', 'amber', 'signal'];
  const SPICE = ["don't", "it's", '"quoted"', '**bold**', '*soft*', '`code`', '[link](https://example.com/a)', 'wait...', 'A&B', '5 < 6'];
  const sentence = (n, spice) => Array.from({ length: n }, () => random() < spice ? pick(SPICE) : pick(WORDS)).join(' ') + '.';
  const paragraph = spice => Array.from({ length: 1 + Math.floor(random() * 3) }, () => sentence(5 + Math.floor(random() * 8), spice)).join(random() < 0.2 ? '\n' : ' ');
  const generate = () => {
    const blocks = [];
    for (let i = 0, n = 4 + Math.floor(random() * 4); i < n; i++) {
      const kind = random(), spice = random() < 0.5 ? 0 : 0.12;
      blocks.push(kind < 0.55 ? paragraph(spice) : kind < 0.7 ? '## ' + sentence(4, spice)
        : kind < 0.85 ? Array.from({ length: 2 + Math.floor(random() * 2) }, () => '- ' + sentence(5, spice)).join('\n') : '> ' + paragraph(spice));
      if (random() < 0.25) blocks.push(pick(blocks));   // identical duplicate block
    }
    return blocks.join('\n\n') + '\n';
  };
  const surface = await mounted(t, '# seed\n');
  const blockTexts = reader => Array.from(reader.querySelectorAll('p, li, h1, h2, h3, pre'), block => collectText(block).text);
  const tally = { tracked: 0, intact: 0, correct: 0, correctAfterInBlockEdit: 0, retypedInPlace: 0 };
  for (let round = 0; round < 200; round++) {
    const source = generate();
    let reader = await surface.render(false, source);
    const evidence0 = await prepareAnnotationDocument(reader, source);
    const block = pick(Array.from(reader.querySelectorAll('p, li, h2')).filter(b => !b.querySelector('p, li')));
    const content = collectText(block), words = [...content.text.matchAll(/[A-Za-z]+/g)];
    if (!words.length) continue;
    const from = Math.floor(random() * words.length), to = Math.min(words.length - 1, from + Math.floor(random() * 3));
    const range = rangeForOffsets(content.spans, words[from].index, words[to].index + words[to][0].length);
    const anchor = range && await createPositionedAnchor(range, reader, source);
    if (!anchor || anchor.exact.includes('\n')) continue;
    const exact = anchor.exact, marker = exact.replace(/\S/g, 'Q'), { start: gs, end: ge } = anchor.position;
    // Establish the passage's source characters by marker re-rendering; skip passages that are not one literal source run.
    const origins = [];
    for (let at = source.indexOf(exact); at >= 0; at = source.indexOf(exact, at + 1)) {
      const text = collectText(await surface.render(false, source.slice(0, at) + marker + source.slice(at + exact.length))).text;
      if (text.length === evidence0.text.length && text.slice(gs, ge) === marker
        && text.slice(0, gs) === evidence0.text.slice(0, gs) && text.slice(ge) === evidence0.text.slice(ge)) origins.push(at);
    }
    if (origins.length !== 1) continue;
    const origin = origins[0], highlight = { ...anchor, id: 'h' };
    reader = await surface.render(false, source);
    const capture = captureHighlightBlocks(reader, source, evidence0, [highlight]);
    if (!capture.blocks.length) continue;
    tally.tracked++;
    const blockText0 = collectText(block).text, view = await surface.render(true, source);
    const ids = Array.from({ length: source.length }, (_, i) => i), log = [];
    const apply = (a, b, insert) => { b = Math.max(a, b); log.push([a, b, insert]);
      view.dispatch({ changes: { from: a, to: b, insert }, userEvent: 'input.type' }); ids.splice(a, b - a, ...Array(insert.length).fill(-1)); };
    await act(async () => {
      for (let step = 0, n = 2 + Math.floor(random() * 6); step < n; step++) {
        const doc = view.state.sliceDoc(), length = doc.length, near = ids.indexOf(origin);
        // Most edits fall near the passage, so its own block is usually edited.
        const at = near >= 0 && random() < 0.6 ? Math.max(0, Math.min(length, near - 90 + Math.floor(random() * (180 + exact.length)))) : Math.floor(random() * (length + 1));
        const kind = random();
        if (near >= 0 && ids[near + exact.length - 1] === origin + exact.length - 1 && random() < 0.3) {
          // Hostile edits aimed at the passage's own characters and at look-alike text beside them.
          const hostile = random(), a = near, b = near + exact.length, lead = Math.max(0, a - Math.floor(random() * 12)), tail = Math.min(length, b + Math.floor(random() * 12));
          if (hostile < 0.25) apply(lead, tail, doc.slice(lead, a).replace(/\w+ $/, 'an ') + exact + doc.slice(b, tail).replace(/[*_`]/g, ''));
          else if (hostile < 0.45) apply(a, b, exact);
          else if (hostile < 0.6) { apply(a, b, ''); const dest = Math.max(0, Math.min(view.state.doc.length, a + Math.floor(random() * 60) - 20)); apply(dest, dest, exact + ' '); }
          else if (hostile < 0.75) { const edge = random() < 0.5 ? a : b; apply(edge, edge, random() < 0.5 ? exact + ' ' : ' ' + exact); }
          else if (hostile < 0.9) { const inside = a + 1 + Math.floor(random() * Math.max(1, exact.length - 1)); apply(inside, inside, pick(['x', ' ', '*'])); }
          else apply(Math.max(0, a - 1), Math.min(length, b + 1), '');
        }
        else if (kind < 0.35) apply(at, at, pick([' ', '']) + pick(random() < 0.2 ? SPICE : WORDS) + pick([' ', '']));
        else if (kind < 0.5) apply(at, Math.min(length, at + 1 + Math.floor(random() * 14)), '');
        else if (kind < 0.65) apply(at, Math.min(length, at + 1 + Math.floor(random() * 14)), pick(WORDS) + ' ' + pick(WORDS));
        else if (kind < 0.72) apply(at, at, '\n\n');
        else if (kind < 0.79) { const gap = doc.indexOf('\n\n', at); if (gap >= 0) apply(gap, gap + 2, ' '); }
        else if (kind < 0.84) apply(at, at, pick(['**', '*', '`', '_', '[', '](x)', '<!--', '-->', '\\']));
        else if (kind < 0.92) { const end = Math.min(length, at + 3 + Math.floor(random() * 30)), cut = doc.slice(at, end);
          apply(at, end, ''); const dest = Math.floor(random() * (view.state.doc.length + 1)); apply(dest, dest, cut); }
        else apply(at, at, '\n\n' + pick(doc.split('\n\n')) + '\n\n');
      }
    });
    const output = view.state.sliceDoc(), changes = surface.editor.current.captureChanges();
    const finalAt = ids.indexOf(origin), intact = finalAt >= 0 && Array.from(exact, (_, j) => ids[finalAt + j] === origin + j).every(Boolean);
    reader = await surface.render(false, output);
    const evidence = await prepareAnnotationDocument(reader, output);
    if (evidence.sourceHash === evidence0.sourceHash) continue;   // byte-identical file: the snapshot path, not continuity
    const updates = refreshHighlightBlocks(capture, changes, reader, output, evidence);
    const claims = await departureClaims(capture, changes);
    const persisted = await refreshDepartureClaims([{ ...highlight, continuity: claims[0]?.claim }], reader, output, evidence);
    const report = () => JSON.stringify({ round, exact, source, log, output });
    assert.deepEqual(persisted.map(u => u.anchor), updates.map(u => u.anchor), 'claims and memory agree: ' + report());
    const blockUnchanged = blockTexts(reader).includes(blockText0);
    if (intact) tally.intact++;
    if (!updates.length) continue;
    if (!intact) {
      // Existing convention: identical text retyped in place leaves the block identical and is the same passage.
      assert.ok(blockUnchanged, 'a refresh after the passage was removed or retyped in a changed block: ' + report());
      tally.retypedInPlace++; continue;
    }
    const { start, end } = updates[0].anchor.position;
    const marked = collectText(await surface.render(false, output.slice(0, finalAt) + marker + output.slice(finalAt + exact.length))).text;
    assert.ok(marked.slice(start, end) === marker, 'refreshed onto other characters: ' + report());
    tally.correct++; if (!blockUnchanged) tally.correctAfterInBlockEdit++;
  }
  t.diagnostic(JSON.stringify(tally));
  assert.ok(tally.tracked > 150 && tally.correct > 20 && tally.correctAfterInBlockEdit > 5, 'the stress run exercised both ways of following a passage: ' + JSON.stringify(tally));
});
