const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const storage = require('../.tmp/workspace-tests/src/lib/annotation-storage.js');
const { useAnnotations } = require('../.tmp/workspace-tests/src/hooks/useAnnotations.js');

const copy = (v) => structuredClone(v);
const empty = () => ({ highlights: [], bookmarks: [] });
const record = (note = 'original') => ({ highlights: [{ id: 'h', prefix: '', exact: 'quote', suffix: '', color: 'yellow', note, createdAt: 1, nearestHeadingId: null }], bookmarks: [] });
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
async function settle() { await act(async () => { await new Promise(setImmediate); }); }
async function mount(t, path = '/a.md', strict = false) {
  let api, renders = 0;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  function Probe({ path }) { api = useAnnotations(path); renders++; return null; }
  async function render(path) { await act(async () => root.render(strict ? React.createElement(React.StrictMode, null, React.createElement(Probe, { path })) : React.createElement(Probe, { path }))); }
  await render(path);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  return { api: () => api, renders: () => renders, render, change: async (f) => { await act(async () => f(api)); } };
}
function backingStore(t, initial = new Map([['/a.md', record()]])) {
  const disk = initial; const writes = [];
  t.mock.method(storage, 'loadAnnotations', async (path) => copy(disk.get(path) ?? null));
  t.mock.method(storage, 'saveAnnotations', async (path, data) => { writes.push({ path, data: copy(data) }); disk.set(path, copy(data)); });
  return { disk, writes };
}

test('CRUD uses stable IDs and persists notes, bookmarks and removals across reopen', async (t) => {
  const { disk, writes } = backingStore(t, new Map());
  const view = await mount(t, '/a.md', true);
  await view.change((api) => api.addHighlight({ exact: 'quote', prefix: '', suffix: '' }, 'green', null));
  const id = view.api().highlights[0].id;
  assert.equal(writes.length, 1, 'StrictMode must not duplicate the action');
  assert.equal(disk.get('/a.md').highlights[0].id, id);
  await view.change((api) => api.updateHighlight(id, { note: 'new note' }));
  await view.change((api) => api.toggleBookmark('heading', 'Heading'));
  await view.render('/b.md'); await view.render('/a.md');
  assert.equal(view.api().highlights[0].note, 'new note');
  await view.change((api) => api.removeBookmark(api.bookmarks[0].id));
  await view.change((api) => api.removeHighlight(id));
  await view.render('/b.md'); await view.render('/a.md');
  assert.deepEqual(view.api().highlights, []); assert.deepEqual(view.api().bookmarks, []);
});

test('A→B→A ignores both results and failures from the first A request', async (t) => {
  for (const fail of [false, true]) {
    const reads = [];
    t.mock.method(storage, 'loadAnnotations', () => { const d=deferred(); reads.push(d); return d.promise; });
    const view = await mount(t);
    await view.render('/b.md'); await view.render('/a.md');
    await act(async () => { if (fail) reads[0].reject(new Error('old failure')); else reads[0].resolve(record('obsolete')); });
    assert.equal(view.api().status, 'loading');
    await act(async () => reads[2].resolve(record('current')));
    assert.equal(view.api().highlights[0].note, 'current');
    await act(async () => reads[1].resolve(null));
  }
});

test('reopening during a pending write keeps the new note; a bookmark cannot erase it', async (t) => {
  const { disk } = backingStore(t); const gate = deferred(); let first = true;
  t.mock.method(storage, 'saveAnnotations', async (path, value) => { if (first) { first=false; await gate.promise; } disk.set(path, copy(value)); });
  const view = await mount(t);
  await view.change((api) => api.updateHighlight('h', { note: 'new' }));
  await view.render('/b.md'); await view.render('/a.md');
  assert.equal(view.api().highlights[0].note, 'new');
  await view.change((api) => api.toggleBookmark('intro', 'Intro'));
  await act(async () => gate.resolve()); await settle();
  assert.equal(disk.get('/a.md').highlights[0].note, 'new'); assert.equal(disk.get('/a.md').bookmarks.length, 1);
});

test('retry cannot overwrite a newer edit or resurrect a removed highlight', async (t) => {
  for (const remove of [false, true]) {
    const { disk } = backingStore(t); const gate = deferred(); let writes = 0;
    t.mock.method(storage, 'saveAnnotations', async (path, value) => {
      writes++;
      if (writes === 1) throw new Error('disk full');
      if (writes === 2) await gate.promise;
      disk.set(path, copy(value));
    });
    const view = await mount(t);
    await view.change((api) => api.updateHighlight('h', { note: 'old failed' }));
    assert.ok(view.api().saveError);
    await view.change((api) => remove ? api.removeHighlight('h') : api.updateHighlight('h', { note: 'latest' }));
    await view.change((api) => { api.retrySave(); api.retrySave(); });
    await act(async () => gate.resolve()); await settle();
    assert.equal(writes, 2);
    assert.deepEqual(disk.get('/a.md').highlights.map((h) => h.note), remove ? [] : ['latest']);
    assert.equal(view.api().saveError, null);
  }
});

test('failed changes on two documents remain independently recoverable', async (t) => {
  const { disk } = backingStore(t, new Map([['/a.md', record()], ['/b.md', record()]]));
  t.mock.method(storage, 'saveAnnotations', async () => { throw new Error('disk full'); });
  const view = await mount(t);
  await view.change((api) => api.updateHighlight('h', { note: 'A new' }));
  await view.render('/b.md'); await view.change((api) => api.updateHighlight('h', { note: 'B new' }));
  assert.deepEqual(Object.keys(view.api().pendingRecords()).sort(), ['/a.md','/b.md']);
  t.mock.method(storage, 'saveAnnotations', async (path,value) => { if(path==='/a.md') throw new Error('still failing'); disk.set(path,copy(value)); });
  await view.change((api) => api.retrySave()); await settle();
  assert.deepEqual(Object.keys(view.api().pendingRecords()), ['/a.md']);
  await view.render('/a.md'); assert.equal(view.api().highlights[0].note, 'A new');
  t.mock.method(storage, 'saveAnnotations', async (path,value) => disk.set(path,copy(value)));
  await view.change((api) => api.retrySave()); await settle();
  assert.deepEqual(view.api().pendingRecords(), {});
  assert.equal(disk.get('/a.md').highlights[0].note, 'A new');
  assert.equal(disk.get('/b.md').highlights[0].note, 'B new');
});

test('loading and failed loads never save an empty collection; retry can recover', async (t) => {
  const { writes } = backingStore(t); const read = deferred();
  t.mock.method(storage,'loadAnnotations',()=>read.promise);
  const view=await mount(t);
  await view.change((api)=>api.toggleBookmark('x','X'));
  await act(async()=>read.reject(new Error('unavailable')));
  await view.change((api)=>api.toggleBookmark('x','X'));
  assert.equal(writes.length,0); assert.equal(view.api().status,'error');
  t.mock.method(storage,'loadAnnotations',async()=>record());
  await view.change((api)=>api.retryLoad());
  assert.equal(view.api().status,'ready'); assert.equal(view.api().highlights[0].note,'original');
});

test('unknown fields and unreadable entries survive editing a valid note', async (t) => {
  const data=record(); data.future={keep:true}; data.highlights[0].future=42; data.highlights.push({id:'damaged',note:'do not lose'});
  const {disk}=backingStore(t,new Map([['/a.md',data]])); const view=await mount(t);
  assert.ok(view.api().dataWarning);
  await view.change((api)=>api.updateHighlight('h',{note:'edited'}));
  assert.equal(disk.get('/a.md').future.keep,true); assert.equal(disk.get('/a.md').highlights[0].future,42);
  assert.deepEqual(disk.get('/a.md').highlights[1],{id:'damaged',note:'do not lose'});
});

test('a stale note callback retains its originating document and quit lock prevents later mutations', async (t) => {
  const {disk}=backingStore(t,new Map([['/a.md',record()],['/b.md',record()]])); const view=await mount(t);
  const updateA=view.api().updateHighlight;
  await view.render('/b.md'); await act(async()=>updateA('h',{note:'A draft'}));
  assert.equal(disk.get('/a.md').highlights[0].note,'A draft'); assert.equal(disk.get('/b.md').highlights[0].note,'original');
  view.api().setLocked(true); await view.change((api)=>api.updateHighlight('h',{note:'blocked'}));
  assert.equal(view.api().highlights[0].note,'original'); view.api().setLocked(false);
});

test('record preparation failure leaves work retryable and other documents can save', async (t) => {
  const { disk } = backingStore(t);
  const records = require('../.tmp/workspace-tests/src/lib/annotation-record.js');
  const prepare = records.storedAnnotationRecord;
  let fail = true;
  t.mock.method(records, 'storedAnnotationRecord', (entry) => {
    if (fail) { fail = false; throw new Error('unexpected preparation failure'); }
    return prepare(entry);
  });
  const view = await mount(t);
  await view.change(api => api.updateHighlight('h', { note: 'preserve me' }));
  assert.equal(view.api().saving, false);
  assert.equal(view.api().canRetrySave, true);
  assert.ok(view.api().saveError);
  assert.equal(view.api().pendingRecords()['/a.md'].highlights[0].note, 'preserve me');
  await view.render('/b.md');
  await view.change(api => api.toggleBookmark('b', 'B'));
  assert.equal(disk.get('/b.md').bookmarks.length, 1);
  await view.change(api => api.retrySave());
  await view.api().waitForSaves();
  assert.equal(disk.get('/a.md').highlights[0].note, 'preserve me');
  assert.deepEqual(view.api().pendingRecords(), {});
});

test('a rejected completion callback does not poison the next save', async (t) => {
  const { disk } = backingStore(t);
  const useState = React.useState;
  let failRefresh = false;
  t.mock.method(React, 'useState', (...args) => {
    const [value, setValue] = useState(...args);
    return [value, update => {
      if (failRefresh && typeof update === 'function') {
        failRefresh = false;
        throw new Error('completion notification failed');
      }
      setValue(update);
    }];
  });
  let first = true;
  t.mock.method(storage, 'saveAnnotations', async (path, value) => {
    disk.set(path, copy(value));
    if (first) { first = false; failRefresh = true; }
  });
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  const view = await mount(t);
  await view.change(api => api.updateHighlight('h', { note: 'first' }));
  await view.api().waitForSaves();
  assert.ok(errors.some(args => String(args[0]).includes('Save queue callback failed')));
  await view.change(api => api.updateHighlight('h', { note: 'latest' }));
  assert.equal(disk.get('/a.md').highlights[0].note, 'latest');
  assert.equal(view.api().saving, false);
  assert.deepEqual(view.api().pendingRecords(), {});
});

for (const [label, updates] of [
  ['empty update', {}],
  ['same note', { note: 'original' }],
  ['same color with omitted note', { color: 'yellow' }],
  ['both fields unchanged', { note: 'original', color: 'yellow' }],
]) {
  test(`R8 ${label} preserves identity without writes or notifications`, async (t) => {
    const { disk, writes } = backingStore(t);
    const view = await mount(t, '/a.md', true);
    const highlights = view.api().highlights;
    const renders = view.renders();
    await view.change(api => api.updateHighlight('h', updates));
    assert.equal(view.api().highlights, highlights);
    assert.equal(view.renders(), renders);
    assert.equal(view.api().getMutationVersion(), 0);
    assert.equal(writes.length, 0);
    assert.deepEqual(disk.get('/a.md'), record());
    assert.deepEqual(view.api().pendingRecords(), {});
    assert.equal(view.api().saveError, null);
  });
}

test('R8 real color/note edits persist; omission preserves a note and explicit undefined removes it once', async (t) => {
  const { disk, writes } = backingStore(t);
  const view = await mount(t);
  await view.change(api => api.updateHighlight('h', { color: 'blue' }));
  assert.equal(disk.get('/a.md').highlights[0].note, 'original');
  assert.equal(disk.get('/a.md').highlights[0].color, 'blue');
  await view.change(api => api.updateHighlight('h', { note: 'edited', color: 'blue' }));
  assert.equal(disk.get('/a.md').highlights[0].note, 'edited');
  await view.change(api => api.updateHighlight('h', { note: undefined }));
  assert.equal(JSON.parse(JSON.stringify(disk.get('/a.md'))).highlights[0].note, undefined);
  assert.equal(writes.length, 3);
  assert.equal(view.api().getMutationVersion(), 3);
  const highlights = view.api().highlights;
  await view.change(api => api.updateHighlight('h', { note: undefined }));
  assert.equal(view.api().highlights, highlights);
  assert.equal(writes.length, 3);
  assert.equal(view.api().getMutationVersion(), 3);
});

test('R8 missing IDs, absent note removal and retained unreadable entries are no-ops', async (t) => {
  const data = record();
  delete data.highlights[0].note;
  data.highlights.push({ id: 'unreadable', note: 'retain me' });
  const { disk, writes } = backingStore(t, new Map([['/a.md', data]]));
  const view = await mount(t);
  const highlights = view.api().highlights;
  for (const id of ['h', 'missing', 'unreadable']) {
    await view.change(api => api.updateHighlight(id, { note: undefined }));
  }
  assert.equal(view.api().highlights, highlights);
  assert.equal(view.api().getMutationVersion(), 0);
  assert.equal(writes.length, 0);
  assert.deepEqual(disk.get('/a.md'), data);
});

test('R8 an unchanged update during a real write does not queue another revision', async (t) => {
  const { disk, writes } = backingStore(t);
  const gate = deferred();
  t.after(() => gate.resolve());
  t.mock.method(storage, 'saveAnnotations', async (path, data) => {
    writes.push({ path, data: copy(data) });
    await gate.promise;
    disk.set(path, copy(data));
  });
  const view = await mount(t);
  await view.change(api => api.updateHighlight('h', { note: 'pending' }));
  await view.change(api => api.updateHighlight('h', { note: 'pending' }));
  assert.equal(view.api().getMutationVersion(), 1);
  assert.equal(view.api().pendingRecords()['/a.md'].highlights[0].note, 'pending');
  assert.equal(disk.get('/a.md').highlights[0].note, 'original');
  await act(async () => gate.resolve());
  await settle();
  assert.equal(writes.length, 1, 'no extra per-document revision to persist');
  assert.equal(disk.get('/a.md').highlights[0].note, 'pending');
  assert.deepEqual(view.api().pendingRecords(), {});
});

test('R8 highlight updates cannot bypass loading, failed-load or quit locks', async (t) => {
  const { writes } = backingStore(t);
  const read = deferred();
  t.mock.method(storage, 'loadAnnotations', () => read.promise);
  const view = await mount(t);
  await view.change(api => api.updateHighlight('h', { note: 'while loading' }));
  await act(async () => read.reject(new Error('unavailable')));
  await view.change(api => api.updateHighlight('h', { note: 'after failed load' }));
  t.mock.method(storage, 'loadAnnotations', async () => record());
  await view.change(api => api.retryLoad());
  view.api().setLocked(true);
  await view.change(api => api.updateHighlight('h', { note: 'while locked' }));
  assert.equal(view.api().highlights[0].note, 'original');
  assert.equal(writes.length, 0);
  assert.equal(view.api().getMutationVersion(), 0);
});

async function mountNotePanel(t) {
  const { AnnotationsPanel } = require('../.tmp/workspace-tests/src/components/AnnotationsPanel.js');
  const { ToastProvider } = require('../.tmp/workspace-tests/src/components/ToastProvider.js');
  const previousMatchMedia = globalThis.matchMedia;
  globalThis.matchMedia = window.matchMedia.bind(window);
  t.after(() => {
    if (previousMatchMedia) globalThis.matchMedia = previousMatchMedia;
    else delete globalThis.matchMedia;
  });
  let api, setVisible;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  function Probe() {
    api = useAnnotations('/a.md');
    const [visible, show] = React.useState(true); setVisible = show;
    return React.createElement(ToastProvider, null, React.createElement(AnnotationsPanel, {
      visible, filePath: '/a.md', fileName: 'a.md', annotationStatus: api.status,
      annotationsReady: api.ready, loadError: api.loadError, saveError: api.saveError,
      canRetrySave: api.canRetrySave, highlights: api.highlights, bookmarks: api.bookmarks,
      headings: [], onRetryLoad: api.retryLoad, onRetrySave: api.retrySave,
      onRemoveHighlight: api.removeHighlight, onUpdateHighlight: api.updateHighlight,
      onClickHighlight() {}, onClickBookmark() {}, onClose: () => show(false),
    }));
  }
  await act(async () => root.render(React.createElement(Probe)));
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  return {
    host, api: () => api,
    async click(label) {
      const button = [...host.querySelectorAll('button')].find(button =>
        button.getAttribute('aria-label') === label || button.textContent.trim() === label);
      assert.ok(button, label);
      await act(async () => button.click());
    },
    async reopen() { await act(async () => setVisible(true)); },
  };
}

for (const unavailable of [false, true]) {
  test(`R8 unchanged note close creates no write or pending warning with storage ${unavailable ? 'unavailable' : 'healthy'}`, async (t) => {
    const data = { ...record(), version: 3 };
    const { disk, writes } = backingStore(t, new Map([['/a.md', data]]));
    if (unavailable) t.mock.method(storage, 'saveAnnotations', async () => {
      writes.push('unexpected attempt'); throw new Error('unavailable');
    });
    const view = await mountNotePanel(t);
    const highlights = view.api().highlights;
    await view.click('Edit note');
    await view.click('Close annotations');
    assert.equal(writes.length, 0);
    assert.equal(view.api().highlights, highlights);
    assert.equal(view.api().getMutationVersion(), 0);
    assert.equal(view.api().saveErrorVersion, 0);
    assert.equal(view.api().saveError, null);
    assert.equal(view.api().canRetrySave, false);
    assert.deepEqual(view.api().pendingRecords(), {});
    assert.deepEqual(disk.get('/a.md'), data);
  });
}

test('R8 unchanged close retains a real failed edit until the explicit Retry button saves it', async (t) => {
  const { disk, writes } = backingStore(t);
  let unavailable = true;
  t.mock.method(storage, 'saveAnnotations', async (path, data) => {
    writes.push({ path, data: copy(data) });
    if (unavailable) throw new Error('unavailable');
    disk.set(path, copy(data));
  });
  const view = await mountNotePanel(t);
  await act(async () => view.api().updateHighlight('h', { note: 'real pending edit' }));
  const error = view.api().saveError;
  assert.ok(error);
  unavailable = false;
  await view.click('Edit note');
  await view.click('Close annotations');
  assert.equal(writes.length, 1, 'unchanged close must not implicitly retry, even after storage recovers');
  assert.equal(view.api().getMutationVersion(), 1);
  assert.equal(view.api().saveError, error);
  assert.equal(view.api().canRetrySave, true);
  assert.equal(view.api().pendingRecords()['/a.md'].highlights[0].note, 'real pending edit');
  assert.equal(disk.get('/a.md').highlights[0].note, 'original');
  await view.reopen();
  await view.click('Retry');
  assert.equal(writes.length, 2);
  assert.equal(view.api().getMutationVersion(), 1);
  assert.equal(disk.get('/a.md').highlights[0].note, 'real pending edit');
  assert.deepEqual(view.api().pendingRecords(), {});
  assert.equal(view.api().saveError, null);
});

for (const cancel of [true, false]) {
  test(`R8 panel note edit ${cancel ? 'can be canceled without mutation' : 'persists with existing trimming'}`, async (t) => {
    const { disk, writes } = backingStore(t);
    const view = await mountNotePanel(t);
    await view.click('Edit note');
    await act(async () => {
      const textarea = view.host.querySelector('textarea');
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(textarea, '  edited note  ');
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    if (cancel) await act(async () => view.host.querySelector('textarea').dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    await view.click('Close annotations');
    assert.equal(writes.length, cancel ? 0 : 1);
    assert.equal(view.api().getMutationVersion(), cancel ? 0 : 1);
    assert.equal(view.api().highlights[0].note, cancel ? 'original' : 'edited note');
    assert.equal(disk.get('/a.md').highlights[0].note, cancel ? 'original' : 'edited note');
  });
}
