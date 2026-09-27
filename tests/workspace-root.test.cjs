const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { mockIPC, clearMocks } = require('@tauri-apps/api/mocks');
const store = require('../.tmp/workspace-tests/src/lib/store.js');
const { useWorkspaceRoot } = require('../.tmp/workspace-tests/src/hooks/useWorkspaceRoot.js');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
async function mount(t, { strict = false, hydrate = async () => '/saved', pick = async () => null } = {}) {
  t.mock.method(store, 'storeGet', hydrate);
  t.mock.method(store, 'storeSet', async () => true);
  mockIPC(command => { assert.equal(command, 'plugin:dialog|open'); return pick(); });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); let value;
  function Probe() { value = useWorkspaceRoot(); return null; }
  await act(async () => root.render(strict ? React.createElement(React.StrictMode, null, React.createElement(Probe)) : React.createElement(Probe)));
  t.after(async () => { await act(async () => root.unmount()); host.remove(); window.localStorage.removeItem('bindars-workspace-root'); clearMocks(); });
  return () => value;
}
test('folder hydration survives StrictMode effect replay', async t => {
  const value = await mount(t, { strict: true }); assert.equal(value().rootPath, '/saved');
});
test('cancel before slow hydration preserves the stored folder', async t => {
  const hydration = deferred(); const value = await mount(t, { hydrate: () => hydration.promise });
  await act(async () => { await value().chooseRoot(); });
  await act(async () => hydration.resolve('/saved')); assert.equal(value().rootPath, '/saved');
});
test('Clear owns the folder even if an older picker completes later', async t => {
  const picker = deferred(); const value = await mount(t, { pick: () => picker.promise }); let result;
  await act(async () => { result = value().chooseRoot(); });
  await act(async () => value().clearRoot());
  await act(async () => { picker.resolve('/old-choice'); assert.equal(await result, null); });
  assert.equal(value().rootPath, null);
});
test('a cancelled newer picker invalidates an older result without clearing the folder', async t => {
  const first = deferred(), second = deferred(); let calls = 0;
  const value = await mount(t, { pick: () => ++calls === 1 ? first.promise : second.promise }); let a, b;
  await act(async () => { a = value().chooseRoot(); b = value().chooseRoot(); });
  await act(async () => { second.resolve(null); await b; });
  await act(async () => { first.resolve('/stale'); await a; });
  assert.equal(value().rootPath, '/saved');
});
