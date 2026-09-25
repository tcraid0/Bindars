const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { act } = React;
const { flushSync } = require('react-dom');
const { createRoot } = require('react-dom/client');
const { mockIPC, clearMocks } = require('@tauri-apps/api/mocks');
const store = require('../.tmp/workspace-tests/src/lib/store.js');
const index = require('../.tmp/workspace-tests/src/lib/workspace-index.js');
const { useWorkspaceIndex } = require('../.tmp/workspace-tests/src/hooks/useWorkspaceIndex.js');
const { useWorkspaceSearch } = require('../.tmp/workspace-tests/src/hooks/useWorkspaceSearch.js');
const { CommandPalette } = require('../.tmp/workspace-tests/src/components/CommandPalette.js');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const meta = (path) => ({ path, name: path.split('/').at(-1), relPath: path.split('/').at(-1) });
const listed = (paths) => ({ files: paths.map(meta), skippedCount: 0, limitHit: false });
const doc = (path, content = '# Original') => index.buildWorkspaceDoc(meta(path), content);
const cache = (docs, extra = {}) => ({
  version: index.WORKSPACE_INDEX_CACHE_VERSION, rootPath: '/a', indexedAt: Date.now(),
  fileCount: docs.length, docs, readFailedCount: 0, complexitySkippedCount: 0,
  listSkippedCount: 0, limitHit: false, ...extra,
});

async function waitFor(assertion) {
  for (let attempt = 0; ; attempt++) {
    try { return assertion(); } catch (error) { if (attempt === 99) throw error; }
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
}

function mount(t, hook, props, renderContent = () => null) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let current;
  function Probe(props) { current = hook(props); return renderContent(current); }
  const render = props => flushSync(() => root.render(React.createElement(Probe, props)));
  render(props);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    flushSync(() => root.unmount());
    host.remove();
  };
  t.after(close);
  return { get value() { return current; }, host, render, close };
}

test.beforeEach(t => {
  t.mock.method(store, 'storeGet', async () => null);
  t.mock.method(store, 'storeSet', async () => true);
});
test.afterEach(() => clearMocks());

for (const destination of ['/b', null]) {
  test(`late discovery cannot republish after switching to ${destination}`, async t => {
    const pending = deferred();
    let listCalls = 0;
    mockIPC((command, args) => {
      if (command === 'list_workspace_markdown_files') {
        listCalls++;
        return args.root === '/a' ? pending.promise : listed(['/b/current.md']);
      }
      return '# Current';
    });
    const view = mount(t, p => useWorkspaceIndex(p.path), { path: '/a' });
    await waitFor(() => assert.equal(listCalls, 1));
    view.render({ path: destination });
    await waitFor(() => assert.equal(view.value.state.status, destination ? 'ready' : 'idle'));
    await act(async () => pending.resolve(listed(['/a/obsolete.md'])));
    assert.equal(view.value.state.rootPath, destination);
    assert.deepEqual(view.value.docs.map(doc => doc.path), destination ? ['/b/current.md'] : []);
  });
}

test('A to B to A does not admit the first A generation', async t => {
  const pending = deferred();
  let lists = 0;
  mockIPC((command, args) => {
    if (command !== 'list_workspace_markdown_files') return '# Current';
    if (++lists === 1) return pending.promise;
    return listed([`${args.root}/current.md`]);
  });
  const view = mount(t, p => useWorkspaceIndex(p.path), { path: '/a' });
  await waitFor(() => assert.equal(lists, 1));
  view.render({ path: '/b' });
  await waitFor(() => assert.equal(view.value.state.status, 'ready'));
  view.render({ path: '/a' });
  await waitFor(() => {
    assert.equal(view.value.state.status, 'ready');
    assert.equal(view.value.docs[0].path, '/a/current.md');
  });
  await act(async () => pending.resolve(listed(['/a/obsolete.md'])));
  assert.equal(view.value.docs[0].path, '/a/current.md');
});

test('late cache hydration cannot overwrite another workspace', async t => {
  const pending = deferred();
  let reads = 0;
  store.storeGet.mock.mockImplementation(async key => {
    if (key !== index.WORKSPACE_INDEX_CACHE_KEY) return null;
    return ++reads === 1 ? pending.promise : null;
  });
  mockIPC(command => command === 'list_workspace_markdown_files' ? listed(['/b/new.md']) : '# New');
  const view = mount(t, p => useWorkspaceIndex(p.path), { path: '/a' });
  await waitFor(() => assert.equal(reads, 1));
  view.render({ path: '/b' });
  await waitFor(() => assert.equal(view.value.state.status, 'ready'));
  await act(async () => pending.resolve(cache([doc('/a/old.md')])));
  assert.equal(view.value.docs[0].path, '/b/new.md');
});

for (const cancel of ['clear', 'unmount']) {
  test(`${cancel} during held reads prevents parsing and cache publication`, async t => {
    const pending = deferred();
    let reads = 0;
    const build = t.mock.method(index, 'tryBuildWorkspaceDoc');
    mockIPC(command => command === 'list_workspace_markdown_files'
      ? listed(Array.from({ length: 16 }, (_, i) => `/a/${i}.md`))
      : (reads++, pending.promise));
    const view = mount(t, p => useWorkspaceIndex(p.path), { path: '/a' });
    await waitFor(() => assert.equal(reads, 8));
    if (cancel === 'clear') view.render({ path: null });
    else view.close();
    await act(async () => pending.resolve('# Unneeded'));
    assert.equal(build.mock.callCount(), 0);
    assert.equal(reads, 8);
    assert.equal(store.storeSet.mock.callCount(), 0);
    if (cancel === 'clear') assert.equal(view.value.state.status, 'idle');
  });
}

test('clear during the inter-batch yield starts no additional reads', async t => {
  let reads = 0;
  mockIPC(command => command === 'list_workspace_markdown_files'
    ? listed(Array.from({ length: 24 }, (_, i) => `/a/${i}.md`))
    : (reads++, '# Note'));
  const timer = global.setTimeout;
  const yielded = deferred();
  let resume;
  t.mock.method(global, 'setTimeout', (callback, ms, ...args) => {
    if (ms === 0 && reads === 8 && !resume) {
      resume = callback;
      yielded.resolve();
      return 0;
    }
    return timer(callback, ms, ...args);
  });
  const view = mount(t, p => useWorkspaceIndex(p.path), { path: '/a' });
  await act(async () => yielded.promise);
  view.render({ path: null });
  await act(async () => resume());
  assert.equal(reads, 8);
  assert.equal(view.value.state.status, 'idle');
});

test('malformed current cache is ignored, rebuilt, and replaced with a valid snapshot', async t => {
  store.storeGet.mock.mockImplementation(async key => key === index.WORKSPACE_INDEX_CACHE_KEY
    ? cache([null]) : null);
  mockIPC(command => command === 'list_workspace_markdown_files' ? listed(['/a/good.md']) : '# Good');
  const view = mount(t, p => useWorkspaceIndex(p.path), { path: '/a' });
  await waitFor(() => assert.equal(view.value.state.status, 'ready'));
  assert.equal(view.value.docs[0].title, 'Good');
  const writes = store.storeSet.mock.calls.map(call => call.arguments);
  assert.equal(writes.length, 1, 'no redundant null writes to already-empty legacy caches');
  assert.equal(index.isWorkspaceIndexCache(writes[0][1], '/a'), true);
});

test('partial cache remains usable on restart; manual Reindex repairs renamed and unreadable files', async t => {
  let saved = null, phase = 0, reads = 0;
  store.storeGet.mock.mockImplementation(async key => key === index.WORKSPACE_INDEX_CACHE_KEY ? saved : null);
  store.storeSet.mock.mockImplementation(async (key, value) => {
    if (key === index.WORKSPACE_INDEX_CACHE_KEY) saved = JSON.parse(JSON.stringify(value));
    return true;
  });
  mockIPC((command, args) => {
    if (command === 'list_workspace_markdown_files') return listed(phase ? ['/a/renamed.md'] : ['/a/ok.md', '/a/fail.md']);
    reads++;
    if (!phase && args.path.endsWith('fail.md')) throw Error('temporarily unreadable');
    return phase ? '# Replaced' : '# Original';
  });
  let view = mount(t, p => useWorkspaceIndex(p.path), { path: '/a' });
  await waitFor(() => assert.equal(view.value.state.status, 'ready'));
  assert.equal(view.value.state.readFailedCount, 1);
  view.close();
  phase = 1;
  view = mount(t, p => useWorkspaceIndex(p.path), { path: '/a' });
  await waitFor(() => assert.equal(view.value.state.status, 'ready'));
  assert.equal(reads, 2);
  assert.equal(view.value.docs[0].title, 'Original');
  flushSync(() => view.value.reindex());
  await waitFor(() => assert.equal(view.value.docs[0]?.title, 'Replaced'));
  assert.deepEqual(view.value.docs.map(doc => doc.path), ['/a/renamed.md']);
  assert.equal(view.value.state.readFailedCount, 0);
});

test('failed refresh keeps the previous searchable snapshot and its diagnostics', async t => {
  let fail = false;
  mockIPC(command => {
    if (command !== 'list_workspace_markdown_files') return '# Good';
    if (fail) throw Error('root unavailable');
    return listed(['/a/good.md']);
  });
  const view = mount(t, p => useWorkspaceIndex(p.path), { path: '/a' });
  await waitFor(() => assert.equal(view.value.state.status, 'ready'));
  fail = true;
  flushSync(() => view.value.reindex());
  await waitFor(() => assert.equal(view.value.state.status, 'error'));
  assert.equal(view.value.docs[0].title, 'Good');
  assert.equal(view.value.state.indexedCount, 1);
  assert.ok(view.value.state.indexedAt);
});

test('new queries remove old buttons and selection until settled; reset cancels pending queries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const docs = [doc('/a/alpha.md', '# Alpha'), doc('/a/beta.md', '# Beta')];
  const view = mount(t, () => useWorkspaceSearch({ docs, recentFiles: [] }), {}, search =>
    React.createElement(CommandPalette, { visible: true, status: 'ready', ...search,
      onQueryChange: search.setQuery, onClose: search.reset, onOpenHit() {}, onHoverIndex: search.setSelectedIndex }));
  flushSync(() => view.value.setQuery('alpha'));
  flushSync(() => t.mock.timers.tick(100));
  assert.equal(view.value.selectedHit.path, '/a/alpha.md');
  flushSync(() => view.value.setQuery('beta'));
  assert.equal(view.value.query, 'beta');
  assert.equal(view.value.selectedHit, null);
  assert.equal(view.host.querySelectorAll('li button').length, 0);
  assert.match(view.host.textContent, /Updating results/);
  flushSync(() => t.mock.timers.tick(100));
  assert.equal(view.value.selectedHit.path, '/a/beta.md');
  flushSync(() => { view.value.setQuery('alpha'); view.value.setQuery('missing'); });
  flushSync(() => view.value.reset());
  flushSync(() => t.mock.timers.tick(100));
  assert.equal(view.value.query, '');
  assert.equal(view.value.results.length, 2);
});
