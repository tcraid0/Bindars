const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { HighlightToolbar } = require('../.tmp/workspace-tests/src/components/HighlightToolbar.js');
const { AnnotationsPanel } = require('../.tmp/workspace-tests/src/components/AnnotationsPanel.js');
const { ToastProvider } = require('../.tmp/workspace-tests/src/components/ToastProvider.js');
const { useAnnotations } = require('../.tmp/workspace-tests/src/hooks/useAnnotations.js');
const storage = require('../.tmp/workspace-tests/src/lib/annotation-storage.js');
const anchoring = require('../.tmp/workspace-tests/src/lib/text-anchoring.js');

const anchor = { exact: 'A useful passage', prefix: '', suffix: '' };
const highlight = (id, note) => ({ ...anchor, id, note, color: 'yellow', nearestHeadingId: null, createdAt: 1 });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function findButton(host, label) {
  const button = [...host.querySelectorAll('button')].find(button =>
    button.getAttribute('aria-label') === label || button.textContent.trim() === label);
  assert.ok(button, label);
  return button;
}
async function typeNote(host, text) {
  await act(async () => {
    const input = host.querySelector('textarea');
    assert.ok(input);
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, text);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function mountNotes(t, { strict = false, visible = false, initial = [] } = {}) {
  const disk = new Map([
    ['/a.md', { highlights: initial, bookmarks: [] }],
    ['/b.md', { highlights: [highlight('existing', 'B original')], bookmarks: [] }],
  ]);
  const writes = [];
  t.mock.method(storage, 'loadAnnotations', async path => structuredClone(disk.get(path) ?? null));
  t.mock.method(storage, 'saveAnnotations', async (path, value) => {
    writes.push({ path, value: structuredClone(value) });
    disk.set(path, structuredClone(value));
  });
  const previousMatchMedia = globalThis.matchMedia;
  globalThis.matchMedia = window.matchMedia.bind(window);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const startNoteRef = { current: null };
  const flushNoteRef = { current: null };
  let api, show, changePath, mounted = true;
  function Probe() {
    const [path, setPath] = React.useState('/a.md'); changePath = setPath;
    const [shown, setShown] = React.useState(visible); show = setShown;
    api = useAnnotations(path);
    return React.createElement(ToastProvider, null, React.createElement(AnnotationsPanel, {
      key: path, visible: shown, filePath: path, fileName: path.slice(1),
      annotationStatus: api.status, annotationsReady: api.ready, loadError: api.loadError,
      saveError: api.saveError, canRetrySave: api.canRetrySave,
      highlights: api.highlights, bookmarks: api.bookmarks, headings: [],
      onRetryLoad: api.retryLoad, onRetrySave: api.retrySave,
      onRemoveHighlight: api.removeHighlight, onUpdateHighlight: api.updateHighlight,
      onClickHighlight() {}, onClickBookmark() {}, onClose: () => show(false),
      startNoteRef, flushNoteRef,
    }));
  }
  await act(async () => root.render(strict
    ? React.createElement(React.StrictMode, null, React.createElement(Probe))
    : React.createElement(Probe)));
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
    host.remove();
  };
  t.after(async () => {
    await unmount();
    if (previousMatchMedia) globalThis.matchMedia = previousMatchMedia;
    else delete globalThis.matchMedia;
  });
  return {
    host, disk, writes, startNoteRef, flushNoteRef, unmount, api: () => api,
    async create() {
      let id;
      await act(async () => {
        id = api.addHighlight(anchor, 'yellow', null);
        if (!id) return;
        startNoteRef.current(id);
        show(true);
      });
      return id;
    },
    async start(id) { await act(async () => startNoteRef.current(id)); },
    async switchTo(path) { await act(async () => changePath(path)); },
    async click(label) { await act(async () => findButton(host, label).click()); },
  };
}

for (const strict of [false, true]) {
  test(`accepted Note opens a hidden mounted panel and focuses its new row${strict ? ' in StrictMode' : ''}`, async t => {
    const view = await mountNotes(t, { strict });
    assert.ok(view.host.querySelector('aside') === null);
    assert.equal(typeof view.startNoteRef.current, 'function');
    const id = await view.create();
    const input = view.host.querySelector('textarea');
    assert.ok(input);
    assert.ok(document.activeElement === input);
    assert.equal(view.api().highlights.length, 1);
    assert.equal(view.disk.get('/a.md').highlights[0].id, id);
    assert.equal(view.disk.get('/a.md').highlights[0].color, 'yellow');
    assert.equal(view.writes.length, 1);
    await typeNote(view.host, 'An unfinished thought');
    await view.unmount();
    assert.equal(view.startNoteRef.current, null);
    assert.equal(view.flushNoteRef.current, null);
    assert.equal(view.disk.get('/a.md').highlights[0].note, 'An unfinished thought');
  });
}

test('starting another note without blur saves the first draft and keeps the new textarea editable', async t => {
  const view = await mountNotes(t);
  const first = await view.create();
  await typeNote(view.host, '  First thought  ');
  const second = await view.create();
  assert.equal(view.disk.get('/a.md').highlights.find(h => h.id === first).note, 'First thought');
  assert.equal(view.host.querySelector('textarea').value, '');
  assert.ok(document.activeElement === view.host.querySelector('textarea'));
  await typeNote(view.host, 'Second thought');
  const version = view.api().getMutationVersion();
  await view.start(second);
  assert.equal(view.host.querySelector('textarea').value, 'Second thought');
  assert.equal(view.api().getMutationVersion(), version, 'same-ID start must preserve the draft without a write');
  await act(async () => view.flushNoteRef.current());
  assert.equal(view.disk.get('/a.md').highlights.find(h => h.id === second).note, 'Second thought');
});

test('existing row actions save the previous draft before starting a different note', async t => {
  const view = await mountNotes(t, { visible: true, initial: [highlight('existing', 'Original'), highlight('other')] });
  await view.click('Edit note');
  await typeNote(view.host, 'Keep this edit');
  const addNote = view.host.querySelector('[data-note-action="other"]');
  assert.equal(addNote.classList.contains('opacity-0'), false, 'Add note is visible without hovering');
  // click() deliberately omits the browser blur that ordinarily precedes a pointer click.
  await act(async () => addNote.click());
  assert.equal(view.disk.get('/a.md').highlights[0].note, 'Keep this edit');
  assert.ok(document.activeElement === view.host.querySelector('textarea'));
  await typeNote(view.host, 'Other thought');
  await act(async () => view.flushNoteRef.current());
  assert.equal(view.disk.get('/a.md').highlights[1].note, 'Other thought');
});

test('document replacement flushes to the original path and installs a fresh note handle', async t => {
  const view = await mountNotes(t, { strict: true, visible: true, initial: [highlight('existing', 'A original')] });
  const oldHandle = view.startNoteRef.current;
  await view.click('Edit note');
  await typeNote(view.host, 'A unfinished');
  await view.switchTo('/b.md');
  assert.equal(view.disk.get('/a.md').highlights[0].note, 'A unfinished');
  assert.equal(view.disk.get('/b.md').highlights[0].note, 'B original');
  assert.equal(typeof view.startNoteRef.current, 'function');
  assert.notEqual(view.startNoteRef.current, oldHandle);
  await view.create();
  await typeNote(view.host, 'B new note');
  // This is the existing quit order: flush while mutations are allowed, then lock and drain.
  await act(async () => {
    view.flushNoteRef.current();
    view.api().setLocked(true);
    await view.api().waitForSaves();
  });
  assert.equal(view.disk.get('/b.md').highlights[1].note, 'B new note');
  assert.equal(view.disk.get('/a.md').highlights.length, 1);
  assert.deepEqual(view.api().pendingRecords(), {});
});

test('a locked creation starts no note, and canceling an empty new note keeps its highlight', async t => {
  const view = await mountNotes(t);
  view.api().setLocked(true);
  assert.equal(await view.create(), undefined);
  assert.ok(view.host.querySelector('aside') === null);
  assert.equal(view.writes.length, 0);
  view.api().setLocked(false);
  const id = await view.create();
  await act(async () => view.host.querySelector('textarea').dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  assert.ok(view.host.querySelector('textarea') === null);
  assert.equal(view.api().highlights[0].id, id);
  assert.equal(view.disk.get('/a.md').highlights[0].id, id);
  assert.equal(view.writes.length, 1);
  assert.equal(document.activeElement.textContent.trim(), 'Add note');
});

async function mountToolbar(t) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const calls = [];
  const contentRef = { current: null };
  const render = async (path = '/a.md', source = anchor.exact) => {
    await act(async () => root.render(React.createElement(ToastProvider, null,
      React.createElement('article', { ref: contentRef }, React.createElement('p', null, anchor.exact)),
      React.createElement(HighlightToolbar, {
        key: JSON.stringify([path, source]), source, contentRef, isEditing: false,
        getActiveHeadingId: () => 'intro',
        onHighlight: (...args) => calls.push(['highlight', ...args]),
        onNote: (...args) => calls.push(['note', ...args]),
      }))));
  };
  await render();
  t.after(async () => {
    await act(async () => root.unmount()); host.remove();
    window.getSelection().removeAllRanges();
  });
  return {
    host, calls, render,
    async select() {
      const range = document.createRange();
      range.selectNodeContents(host.querySelector('p'));
      await act(async () => {
        const selection = window.getSelection();
        selection.removeAllRanges(); selection.addRange(range);
        document.dispatchEvent(new window.Event('selectionchange'));
      });
      return range;
    },
  };
}

test('Note preserves the selection and shares the pending guard with all color actions', async t => {
  const gate = deferred(); const requests = [];
  t.mock.method(anchoring, 'createPositionedAnchor', (...args) => { requests.push(args); return gate.promise; });
  const view = await mountToolbar(t);
  const selected = await view.select();
  const note = findButton(view.host, 'Note');
  const yellow = findButton(view.host, 'Highlight Yellow');
  const mouseDown = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  note.dispatchEvent(mouseDown);
  assert.equal(mouseDown.defaultPrevented, true);
  assert.equal(window.getSelection().toString(), anchor.exact);
  await act(async () => { note.click(); yellow.click(); note.click(); });
  assert.equal(requests.length, 1);
  assert.notEqual(requests[0][0], selected, 'anchor receives the cloned selection');
  assert.equal(requests[0][0].toString(), anchor.exact);
  assert.ok([...view.host.querySelectorAll('button')].every(button => button.disabled));
  await act(async () => gate.resolve(anchor));
  assert.deepEqual(view.calls, [['note', anchor, 'intro']]);
  assert.equal(window.getSelection().rangeCount, 0);
  assert.ok(view.host.querySelector('button') === null);
});

test('color selection only calls the ordinary highlight action', async t => {
  t.mock.method(anchoring, 'createPositionedAnchor', async () => anchor);
  const view = await mountToolbar(t);
  await view.select();
  await act(async () => findButton(view.host, 'Highlight Green').click());
  assert.deepEqual(view.calls, [['highlight', anchor, 'green', 'intro']]);
});

for (const replacement of ['document', 'content']) {
  test(`pending Note cannot publish after ${replacement} replacement`, async t => {
    const gate = deferred();
    t.mock.method(anchoring, 'createPositionedAnchor', () => gate.promise);
    const view = await mountToolbar(t);
    await view.select();
    await act(async () => findButton(view.host, 'Note').click());
    await view.render(replacement === 'document' ? '/b.md' : '/a.md', replacement === 'content' ? 'New content' : anchor.exact);
    await act(async () => gate.resolve(anchor));
    assert.deepEqual(view.calls, []);
  });
}

test('an unsupported selection creates no note and gives retry guidance', async t => {
  t.mock.method(anchoring, 'createPositionedAnchor', async () => null);
  const view = await mountToolbar(t);
  await view.select();
  await act(async () => findButton(view.host, 'Note').click());
  assert.deepEqual(view.calls, []);
  assert.match(view.host.textContent, /This selection includes text that cannot be highlighted/);
});
