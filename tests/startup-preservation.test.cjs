const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { mockIPC, clearMocks } = require('@tauri-apps/api/mocks');
const localKey = 'bindars-markdown-formatting-enabled';
const formattingKey = 'markdown-formatting-enabled';
const recent = (path = '/old.md', lastHeadingId = 'intro') => ({ path, name: path.slice(1), openedAt: 1, lastHeadingId });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fresh() {
  for (const name of ['lib/store', 'lib/annotation-storage', 'lib/migrations', 'hooks/useMarkdownFormatting', 'hooks/useRecentFiles']) {
    delete require.cache[require.resolve(`../.tmp/workspace-tests/src/${name}.js`)];
  }
  return {
    formatting: require('../.tmp/workspace-tests/src/hooks/useMarkdownFormatting.js').useMarkdownFormatting,
    recents: require('../.tmp/workspace-tests/src/hooks/useRecentFiles.js').useRecentFiles,
  };
}
function storage(t, values, { bootstrap, get, save } = {}) {
  const cache = structuredClone(values);
  let durable = structuredClone(values);
  const writes = [], reads = [];
  mockIPC(async (cmd, args = {}) => {
    if (cmd === 'initialize_annotation_storage') return bootstrap ? bootstrap() : { settingsReady: true };
    if (cmd === 'plugin:store|load') return 1;
    if (cmd === 'plugin:store|get') {
      reads.push(args.key);
      if (get) { const result = get(args.key); if (result !== undefined) return result; }
      return [structuredClone(cache[args.key] ?? null), args.key in cache];
    }
    if (cmd === 'plugin:store|set') { writes.push(structuredClone(args)); cache[args.key] = structuredClone(args.value); return; }
    if (cmd === 'plugin:store|save') { if (save) await save(); durable = structuredClone(cache); return; }
    throw Error(`Unexpected IPC ${cmd}`);
  });
  t.after(() => { clearMocks(); window.localStorage.clear(); });
  return { cache, durable: () => durable, writes, reads };
}
async function settle() { await act(async () => { await new Promise(setImmediate); }); }
async function mount(t, hook, strict = false) {
  let current;
  function Probe() { current = hook(); return null; }
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(strict ? React.createElement(React.StrictMode, null, React.createElement(Probe)) : React.createElement(Probe)));
  let alive = true;
  const unmount = async () => { if (alive) { alive = false; await act(async () => root.unmount()); host.remove(); } };
  t.after(unmount);
  return { get current() { return current; }, unmount };
}
for (const failure of ['rejected read', 'rejected bootstrap', 'settings denied']) {
  test(`formatting ${failure} preserves both stores through a healthy next process`, async t => {
    window.localStorage.clear();
    let healthy = false;
    const disk = storage(t, { [formattingKey]: false }, {
      bootstrap: () => { if (!healthy && failure === 'rejected bootstrap') throw Error('denied'); return { settingsReady: healthy || failure !== 'settings denied' }; },
      get: key => { if (!healthy && failure === 'rejected read' && key === formattingKey) throw Error('read failed'); },
    });
    const first = await mount(t, fresh().formatting); await settle();
    assert.equal(first.current.loaded, true);
    assert.equal(first.current.enabled, true);
    assert.equal(window.localStorage.getItem(localKey), null);
    assert.deepEqual(disk.writes, []);
    assert.equal(disk.durable()[formattingKey], false);
    await first.unmount(); healthy = true;
    const next = await mount(t, fresh().formatting); await settle();
    assert.equal(next.current.enabled, false);
    assert.equal(window.localStorage.getItem(localKey), 'false');
    assert.deepEqual(disk.writes, []);
  });
}
test('formatting successful absence initializes the default; valid native false only mirrors locally', async t => {
  for (const value of [null, false, 'invalid']) {
    window.localStorage.clear();
    const disk = storage(t, { [formattingKey]: value });
    const view = await mount(t, fresh().formatting); await settle();
    assert.equal(view.current.enabled, value !== false);
    assert.equal(window.localStorage.getItem(localKey), String(value !== false));
    assert.deepEqual(disk.writes.map(w => w.value), value === false ? [] : [true]);
    await view.unmount();
  }
});
test('formatting held read cannot replace explicit rapid toggles or publish after unmount', async t => {
  window.localStorage.clear();
  const held = deferred();
  const disk = storage(t, { [formattingKey]: false }, { get: key => key === formattingKey ? held.promise : undefined });
  const view = await mount(t, fresh().formatting);
  assert.equal(view.current.loaded, false); assert.deepEqual(disk.writes, []);
  await act(async () => { view.current.toggle(); view.current.toggle(); view.current.toggle(); });
  held.resolve([true, true]); await settle();
  assert.equal(view.current.enabled, false);
  assert.deepEqual(disk.writes.map(w => w.value), [false, true, false]);
  assert.equal(disk.durable()[formattingKey], false);
  await view.unmount(); window.localStorage.clear();
  const abandoned = deferred();
  const other = storage(t, { [formattingKey]: false }, { get: () => abandoned.promise });
  const gone = await mount(t, fresh().formatting); await gone.unmount();
  abandoned.resolve([false, true]); await settle();
  assert.equal(window.localStorage.getItem(localKey), null); assert.deepEqual(other.writes, []);
});
test('recents held hydration blocks every mutation then preserves loaded history', async t => {
  const held = deferred(), old = recent();
  const disk = storage(t, { 'config-version': 3, 'recent-files': [old] }, { get: key => key === 'recent-files' ? held.promise : undefined });
  const view = await mount(t, fresh().recents);
  await act(async () => { view.current.addRecent('/new.md', 'new.md'); view.current.removeRecent('/old.md'); view.current.updateScrollPosition('/old.md', 'changed'); });
  assert.deepEqual(disk.writes, []);
  held.resolve([[old], true]); await settle();
  await act(async () => view.current.addRecent('/new.md', 'new.md')); await settle();
  assert.deepEqual(disk.durable()['recent-files'].map(f => f.path), ['/new.md', '/old.md']);
  assert.equal(disk.durable()['recent-files'][1].lastHeadingId, 'intro');
});
for (const value of [{ unknown: [] }, 'unknown']) {
  test(`recents unusable whole ${typeof value} is preserved and unavailable`, async t => {
    const disk = storage(t, { 'config-version': 3, 'recent-files': value });
    const view = await mount(t, fresh().recents); await settle();
    assert.equal(view.current.status, 'unavailable');
    await act(async () => { view.current.addRecent('/new.md', 'new.md'); view.current.removeRecent('/old.md'); view.current.updateScrollPosition('/old.md', 'x'); });
    assert.deepEqual(disk.writes, []); assert.deepEqual(disk.durable()['recent-files'], value);
  });
}
test('recents read failure settles unavailable without writes; later mount reads after successful gate', async t => {
  let fail = true;
  const disk = storage(t, { 'config-version': 3, 'recent-files': [recent()] }, { get: key => { if (key === 'recent-files' && fail) throw Error('read failed'); } });
  const hooks = fresh(), first = await mount(t, hooks.recents); await settle();
  assert.equal(first.current.status, 'unavailable');
  await act(async () => first.current.addRecent('/new.md', 'new.md')); assert.deepEqual(disk.writes, []);
  await first.unmount(); fail = false;
  const next = await mount(t, hooks.recents); await settle();
  assert.equal(next.current.status, 'ready'); assert.equal(next.current.recentFiles[0].path, '/old.md');
  assert.equal(disk.reads.filter(k => k === 'config-version').length, 1);
});

for (const version of [0, 1, 2, 3, null]) {
  test(`recents version ${version} normalizes entries and strips exactly the historical prefix`, async t => {
    const records = [
      { ...recent('/old.md', 'user-content-user-content-intro'), extension: { keep: true } },
      recent('/single.md', 'user-content-intro'),
      recent('/heading.md', 42),
      { path: '/missing-heading.md', name: '', openedAt: 0 },
      null, false, [], {}, recent('', 'x'), { ...recent('/nan.md'), openedAt: NaN },
      { ...recent('/infinite.md'), openedAt: Infinity }, { ...recent('/date.md'), openedAt: 9e15 },
      { ...recent('/name.md'), name: 2 }, { ...recent('/time.md'), openedAt: '1' },
    ];
    const disk = storage(t, { 'config-version': version, 'recent-files': records });
    const view = await mount(t, fresh().recents, true); await settle();
    const modern = version === 3;
    assert.equal(view.current.status, 'ready');
    assert.deepEqual(view.current.recentFiles.map(f => f.path), ['/old.md', '/single.md', '/heading.md', '/missing-heading.md']);
    assert.deepEqual(view.current.recentFiles.map(f => f.lastHeadingId), [modern ? 'user-content-user-content-intro' : 'user-content-intro', modern ? 'user-content-intro' : 'intro', null, null]);
    assert.deepEqual(view.current.recentFiles[0].extension, { keep: true });
    assert.equal(disk.reads.filter(k => k === 'config-version').length, 1);
    assert.equal(disk.writes.filter(w => w.key === 'recent-files').length, modern ? 0 : 1);
    assert.equal(disk.cache['config-version'], 3);
    // Exercise the actual renderer with the boundary's decoded records.
    const { renderComponent } = require('./_helpers/component-view.cjs');
    const { RecentFiles } = require('../.tmp/workspace-tests/src/components/RecentFiles.js');
    const list = renderComponent(RecentFiles, { files: view.current.recentFiles, currentFilePath: null, openingPath: null, onOpen() {}, onRemove() {} });
    try { assert.equal(list.host.querySelectorAll('button').length, 8); } finally { list.cleanup(); }
  });
}
for (const version of ['2', -1, 1.5, {}, 4, Infinity]) {
  test(`recents invalid or future version ${JSON.stringify(version)} preserves the entire value`, async t => {
    const original = { 'config-version': version, 'recent-files': [recent('/old.md', 'user-content-intro')] };
    const disk = storage(t, original);
    const view = await mount(t, fresh().recents); await settle();
    assert.equal(view.current.status, 'unavailable');
    await act(async () => view.current.addRecent('/new.md', 'new.md'));
    assert.deepEqual(disk.writes, []); assert.deepEqual(disk.durable(), original);
  });
}
test('recents successful absence is ready and initializes only after explicit mutation', async t => {
  const disk = storage(t, { 'config-version': 3 });
  const view = await mount(t, fresh().recents); await settle();
  assert.equal(view.current.status, 'ready'); assert.deepEqual(view.current.recentFiles, []); assert.deepEqual(disk.writes, []);
  await act(async () => view.current.addRecent('/new.md', 'new.md')); await settle();
  assert.equal(disk.durable()['recent-files'][0].path, '/new.md');
});
test('recents ready mutations preserve order, limit, extra fields and headings without StrictMode duplicate writes', async t => {
  const original = Array.from({ length: 10 }, (_, i) => ({ ...recent(`/${i}.md`), extra: i }));
  const disk = storage(t, { 'config-version': 3, 'recent-files': original });
  const hooks = fresh();
  const view = await mount(t, hooks.recents, true); await settle();
  await act(async () => {
    view.current.addRecent('/5.md', 'renamed.md');
    view.current.updateScrollPosition('/5.md', 'updated');
    view.current.addRecent('/new.md', 'new.md');
    view.current.removeRecent('/2.md');
    view.current.updateScrollPosition('/missing.md', 'ignored');
    view.current.updateScrollPosition('/5.md', 'updated');
  }); await settle();
  assert.equal(disk.writes.length, 4);
  const saved = disk.durable()['recent-files'];
  assert.deepEqual(saved.map(f => f.path), ['/new.md', '/5.md', '/0.md', '/1.md', '/3.md', '/4.md', '/6.md', '/7.md', '/8.md']);
  assert.equal(saved[1].lastHeadingId, 'updated'); assert.equal(saved[1].extra, 5);
  await view.unmount();
  const later = await mount(t, hooks.recents); await settle();
  assert.deepEqual(later.current.recentFiles, saved);
  assert.equal(disk.reads.filter(k => k === 'config-version').length, 1);
});
test('recents abandoned held read cannot replace a newer mount; StrictMode shares held migration', async t => {
  const version = deferred(), oldRead = deferred(); let historyReads = 0;
  const disk = storage(t, { 'config-version': 2, 'recent-files': [recent()] }, { get: key => {
    if (key === 'config-version') return version.promise;
    // Migration has one read, followed by the first mount's held hydration.
    if (key === 'recent-files' && ++historyReads === 2) return oldRead.promise;
  } });
  const hooks = fresh(), first = await mount(t, hooks.recents, true);
  assert.equal(disk.reads.filter(k => k === 'config-version').length, 1);
  version.resolve([2, true]); await settle();
  assert.equal(first.current.status, 'loading'); await first.unmount();
  const next = await mount(t, hooks.recents, true); await settle();
  await act(async () => next.current.addRecent('/new.md', 'new.md')); await settle();
  oldRead.resolve([[recent('/stale.md')], true]); await settle();
  assert.deepEqual(next.current.recentFiles.map(f => f.path), ['/new.md', '/old.md']);
  assert.deepEqual(disk.durable()['recent-files'], next.current.recentFiles);
  assert.equal(disk.writes.filter(w => w.key === 'config-version').length, 1);
});
for (const failAt of ['data', 'version']) {
  test(`recents failed migration ${failAt} save caches rejection despite changed plugin cache`, async t => {
    let saves = 0, fail = true;
    const original = { 'config-version': 2, 'recent-files': [recent('/old.md', 'user-content-user-content-intro')] };
    const disk = storage(t, original, { save: () => { if (++saves === (failAt === 'data' ? 1 : 2) && fail) throw Error('save failed after cache mutation'); } });
    const hooks = fresh(), first = await mount(t, hooks.recents, true); await settle();
    assert.equal(first.current.status, 'unavailable');
    assert.equal(disk.cache['recent-files'][0].lastHeadingId, 'user-content-intro');
    const afterFailure = structuredClone(disk.cache), writeCount = disk.writes.length;
    await act(async () => { first.current.addRecent('/new.md', 'new.md'); first.current.removeRecent('/old.md'); first.current.updateScrollPosition('/old.md', 'x'); });
    await first.unmount(); fail = false;
    const next = await mount(t, hooks.recents); await settle();
    assert.equal(next.current.status, 'unavailable');
    assert.equal(disk.writes.length, writeCount); assert.deepEqual(disk.cache, afterFailure);
    assert.equal(disk.reads.filter(k => k === 'config-version').length, 1);
    if (failAt === 'data') assert.deepEqual(disk.durable(), original);
    else assert.equal(disk.durable()['config-version'], 2); // D1 remains across restart.
  });
}

test('formatting StrictMode abandoned hydration cannot overwrite the active local mirror', async t => {
  window.localStorage.clear();
  const abandoned = deferred(); let reads = 0;
  const disk = storage(t, { [formattingKey]: false }, { get: key => key === formattingKey && ++reads === 1 ? abandoned.promise : undefined });
  const view = await mount(t, fresh().formatting, true); await settle();
  assert.equal(view.current.enabled, false);
  abandoned.resolve([true, true]); await settle();
  assert.equal(view.current.enabled, false);
  assert.equal(window.localStorage.getItem(localKey), 'false');
  assert.deepEqual(disk.writes, []);
});
test('formatting a held rejected read settles loading without writing a fallback', async t => {
  window.localStorage.clear();
  const held = deferred();
  const disk = storage(t, { [formattingKey]: false }, { get: () => held.promise });
  const view = await mount(t, fresh().formatting);
  assert.equal(view.current.loaded, false); assert.deepEqual(disk.writes, []);
  held.reject(Error('held read failed')); await settle();
  assert.equal(view.current.loaded, true); assert.equal(view.current.enabled, true);
  assert.equal(window.localStorage.getItem(localKey), null); assert.deepEqual(disk.writes, []);
  assert.equal(disk.durable()[formattingKey], false);
});
