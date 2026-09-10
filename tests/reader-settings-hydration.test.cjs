const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { installDom } = require('./_helpers/dom.cjs');
const { useReaderSettings } = require('../.tmp/workspace-tests/src/hooks/useReaderSettings.js');
const { ReaderControls } = require('../.tmp/workspace-tests/src/components/ReaderControls.js');
const store = require('../.tmp/workspace-tests/src/lib/store.js');

const defaults = {
  fontSize: 17, contentWidth: 65, lineHeight: 1.7, fontFamily: 'newsreader',
  paragraphSpacing: 'comfortable', sceneLensEnabled: false, reducedEffects: false,
};
const chosen = {
  fontSize: 22, contentWidth: 75, lineHeight: 1.9, fontFamily: 'atkinson',
  paragraphSpacing: 'spacious', sceneLensEnabled: true, reducedEffects: true,
};
const primaryKey = 'bindars-settings';
const legacyKey = 'markdown-reader-settings';
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// The actual hook and controls use disposable local storage and an in-memory
// native-store boundary. Every write is captured, including unmount flushes.
async function setup(t, { primary, legacy, native = null, paused = false, strict = false } = {}) {
  await installDom();
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = window.localStorage;
  localStorage.clear();
  if (primary !== undefined) localStorage.setItem(primaryKey, primary);
  if (legacy !== undefined) localStorage.setItem(legacyKey, legacy);
  const localWrites = t.mock.method(localStorage, 'setItem');
  const reads = t.mock.method(store, 'storeGet', async key => {
    assert.equal(key, 'reader-settings');
    return typeof native === 'function' ? native() : native;
  });
  const writes = [];
  t.mock.method(store, 'storeSet', async (key, value) => {
    assert.equal(key, 'reader-settings');
    writes.push(structuredClone(value));
    return true;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const host = document.createElement('div'); document.body.append(host);
  let root = createRoot(host);
  let latest;
  let mounted = true;
  const pause = { paused, isPaused: () => pause.paused };
  function Probe() {
    latest = useReaderSettings(pause);
    const triggerRef = React.useRef(null);
    return React.createElement(ReaderControls, {
      id: 'synthetic-settings', visible: true, triggerRef, settings: latest.settings,
      onUpdate: latest.updateSettings, onReset: latest.resetSettings,
      theme: 'light', onSetTheme() {}, onClose() {}, onClearRecoveryHistory() {},
      recoveryStorageStats: null, recoveryStorageStatsLoading: false, recoveryStorageStatsError: null,
    });
  }
  async function render() {
    await act(async () => root.render(strict
      ? React.createElement(React.StrictMode, null, React.createElement(Probe))
      : React.createElement(Probe)));
  }
  async function unmount() {
    if (mounted) { mounted = false; await act(async () => root.unmount()); }
  }
  t.after(async () => {
    await unmount(); host.remove(); localStorage.clear(); globalThis.localStorage = previousStorage;
  });
  await render();
  return {
    host, reads, writes, localWrites, unmount,
    async remount() { root = createRoot(host); mounted = true; await render(); },
    latest: () => latest,
    async update(value) { await act(async () => latest.updateSettings(value)); },
    async tick(ms) { await act(async () => t.mock.timers.tick(ms)); },
    async setPaused(value) { pause.paused = value; await render(); },
  };
}

for (const [name, options, expected, nativeReads] of [
  ['primary wins as a whole record', { primary: '{"fontSize":20}', legacy: JSON.stringify(chosen), native: chosen }, { ...defaults, fontSize: 20 }, 0],
  ['legacy partial', { legacy: '{"fontFamily":"dm-sans"}', native: chosen }, { ...defaults, fontFamily: 'dm-sans' }, 0],
  ['bad primary JSON falls back to legacy', { primary: '{broken', legacy: '{"reducedEffects":true}', native: chosen }, { ...defaults, reducedEffects: true }, 0],
  ['unusable primary falls back to legacy', { primary: '{"fontSize":null}', legacy: '{"lineHeight":1.8}', native: chosen }, { ...defaults, lineHeight: 1.8 }, 0],
  ['bad primary and legacy fall back to native', { primary: '{broken', legacy: '[]', native: chosen }, chosen, 1],
  ['native partial', { native: { paragraphSpacing: 'compact' } }, { ...defaults, paragraphSpacing: 'compact' }, 1],
  ['absence stays at defaults', {}, defaults, 1],
  ['false is a usable local choice', { primary: '{"sceneLensEnabled":false}', native: chosen }, defaults, 0],
]) {
  test(`reader settings sources: ${name}`, async t => {
    const view = await setup(t, options);
    assert.deepEqual(view.latest().settings, expected);
    assert.equal(view.reads.mock.callCount(), nativeReads);
    assert.ok(view.host.querySelector('[aria-label="Increase line height"]'));
    await view.tick(500);
    await view.unmount();
    assert.deepEqual(view.writes, []);
    assert.equal(view.localWrites.mock.callCount(), 0, 'hydration must not repair storage unsolicited');
  });
}

for (const value of [null, [], 42, 'text', true, {}, { unknown: 20 }, { lineHeight: null }, { reducedEffects: 'false' }]) {
  test(`reader settings sources: unusable local ${JSON.stringify(value)} permits native backup`, async t => {
    const view = await setup(t, { primary: JSON.stringify(value), native: chosen });
    assert.deepEqual(view.latest().settings, chosen);
    assert.equal(view.reads.mock.callCount(), 1);
    assert.equal(view.localWrites.mock.callCount(), 0);
    await view.unmount();
    assert.deepEqual(view.writes, []);
  });
}

for (const source of ['local', 'native']) {
  for (const [name, record, expected] of [
    ['mixed malformed fields', { fontSize: 'garbage', contentWidth: 500, lineHeight: null, fontFamily: 'atkinson', paragraphSpacing: 'bad', sceneLensEnabled: 'false', reducedEffects: true }, { ...defaults, contentWidth: 80, fontFamily: 'atkinson', reducedEffects: true }],
    ['numeric strings and string booleans', { fontSize: '20', contentWidth: '70', lineHeight: '1.8', fontFamily: 'bad', paragraphSpacing: null, sceneLensEnabled: 'true', reducedEffects: 'false' }, defaults],
    ['lower bounds and decimal rounding', { fontSize: -1, contentWidth: 1, lineHeight: 1.36 }, { ...defaults, fontSize: 14, contentWidth: 50, lineHeight: 1.4 }],
    ['upper bounds', { fontSize: 100, contentWidth: 100, lineHeight: 3 }, { ...defaults, fontSize: 24, contentWidth: 80, lineHeight: 2 }],
    ['decimal round to nearest tenth', { lineHeight: 1.76 }, { ...defaults, lineHeight: 1.8 }],
  ]) {
    test(`reader settings ${source}: ${name} render safely without hydration writes`, async t => {
      const view = await setup(t, source === 'local' ? { primary: JSON.stringify(record) } : { native: record });
      assert.deepEqual(view.latest().settings, expected);
      assert.ok(!view.host.textContent.includes('NaN'));
      await view.unmount();
      assert.deepEqual(view.writes, []);
      assert.equal(view.localWrites.mock.callCount(), 0);
    });
  }
}

for (const invalid of [null, '22', NaN, Infinity, -Infinity]) {
  test(`reader settings updates: invalid numbers ${String(invalid)} and enums preserve current choices`, async t => {
    const view = await setup(t, { primary: JSON.stringify(chosen) });
    await view.update({ fontSize: invalid, contentWidth: invalid, lineHeight: invalid,
      fontFamily: 'unsupported', paragraphSpacing: null, sceneLensEnabled: 'false', reducedEffects: null });
    assert.deepEqual(view.latest().settings, chosen);
    await view.update({ fontSize: invalid, lineHeight: invalid, reducedEffects: false });
    const expected = { ...chosen, reducedEffects: false };
    assert.deepEqual(view.latest().settings, expected);
    assert.deepEqual(JSON.parse(localStorage.getItem(primaryKey)), expected);
    await view.unmount();
    assert.deepEqual(view.writes, [expected]);
  });
}

for (const invalid of [NaN, Infinity, -Infinity]) {
  test(`reader settings native: nonfinite ${String(invalid)} cannot reach controls or persistence`, async t => {
    const view = await setup(t, { native: { fontSize: invalid, contentWidth: invalid, lineHeight: invalid, reducedEffects: true } });
    assert.deepEqual(view.latest().settings, { ...defaults, reducedEffects: true });
    await view.update({ sceneLensEnabled: true });
    const expected = { ...defaults, reducedEffects: true, sceneLensEnabled: true };
    assert.deepEqual(JSON.parse(localStorage.getItem(primaryKey)), expected);
    await view.unmount();
    assert.deepEqual(view.writes, [expected]);
  });
}

test('reader settings: actual controls increment/decrement, debounce, unmount flush and round trip', async t => {
  const view = await setup(t, { primary: '{"fontSize":"garbage","lineHeight":null,"reducedEffects":true}' });
  for (const label of ['Increase font size', 'Increase width', 'Increase line height', 'Decrease line height']) {
    await act(async () => view.host.querySelector(`[aria-label="${label}"]`).click());
  }
  const expected = { ...defaults, fontSize: 18, contentWidth: 70, reducedEffects: true };
  assert.deepEqual(view.latest().settings, expected);
  assert.deepEqual(JSON.parse(localStorage.getItem(primaryKey)), expected);
  assert.deepEqual(view.writes, []);
  await view.tick(299); assert.deepEqual(view.writes, []);
  await view.tick(1); assert.deepEqual(view.writes, [expected]);
  await view.update(chosen);
  assert.deepEqual(JSON.parse(localStorage.getItem(primaryKey)), chosen);
  await view.unmount(); assert.deepEqual(view.writes, [expected, chosen]);
  await view.tick(500); assert.deepEqual(view.writes, [expected, chosen]);
  await view.remount();
  assert.deepEqual(view.latest().settings, chosen);
  assert.equal(view.reads.mock.callCount(), 0);
  await act(async () => view.latest().resetSettings());
  assert.deepEqual(JSON.parse(localStorage.getItem(primaryKey)), defaults);
  await view.unmount(); assert.deepEqual(view.writes, [expected, chosen, defaults]);
});

test('reader settings: user update overtakes a held native read', async t => {
  const held = deferred();
  const view = await setup(t, { native: held.promise });
  await view.update({ fontSize: 19 });
  await act(async () => held.resolve(chosen));
  const expected = { ...defaults, fontSize: 19 };
  assert.deepEqual(view.latest().settings, expected);
  assert.deepEqual(JSON.parse(localStorage.getItem(primaryKey)), expected);
  await view.unmount(); assert.deepEqual(view.writes, [expected]);
});

test('reader settings: print holds normalized hydration until release without writes', async t => {
  const held = deferred();
  const view = await setup(t, { native: held.promise, paused: true });
  await act(async () => held.resolve({ fontSize: 99, lineHeight: null, reducedEffects: true }));
  assert.deepEqual(view.latest().settings, defaults);
  await view.setPaused(false);
  assert.deepEqual(view.latest().settings, { ...defaults, fontSize: 24, reducedEffects: true });
  await view.unmount(); assert.deepEqual(view.writes, []);
  assert.equal(view.localWrites.mock.callCount(), 0);
});

test('reader settings: user update overtakes hydration already queued during print', async t => {
  const held = deferred();
  const view = await setup(t, { native: held.promise, paused: true });
  await act(async () => held.resolve(chosen));
  await view.update({ fontSize: 19 });
  assert.deepEqual(view.latest().settings, defaults);
  assert.equal(view.localWrites.mock.callCount(), 0);
  await view.setPaused(false);
  const expected = { ...defaults, fontSize: 19 };
  assert.deepEqual(view.latest().settings, expected);
  assert.deepEqual(JSON.parse(localStorage.getItem(primaryKey)), expected);
  await view.unmount(); assert.deepEqual(view.writes, [expected]);
});

test('reader settings: StrictMode ignores abandoned read', async t => {
  const first = deferred(); const second = deferred(); let count = 0;
  const view = await setup(t, { strict: true, native: () => ++count === 1 ? first.promise : second.promise });
  await act(async () => second.resolve({ fontFamily: 'dm-sans' }));
  await act(async () => first.resolve(chosen));
  assert.deepEqual(view.latest().settings, { ...defaults, fontFamily: 'dm-sans' });
  await view.unmount(); assert.deepEqual(view.writes, []);
});

test('reader settings: hydration after unmount does not write', async t => {
  const held = deferred();
  const unmounted = await setup(t, { native: held.promise });
  await unmounted.unmount();
  await act(async () => held.resolve(chosen));
  assert.deepEqual(unmounted.writes, []);
  assert.equal(unmounted.localWrites.mock.callCount(), 0);
});

for (const value of [[], 42, 'text', true, {}, { lineHeight: null }]) {
  test(`reader settings native: unusable ${JSON.stringify(value)} stays at defaults without writes`, async t => {
    const view = await setup(t, { native: value });
    assert.deepEqual(view.latest().settings, defaults);
    await view.unmount();
    assert.deepEqual(view.writes, []);
    assert.equal(view.localWrites.mock.callCount(), 0);
  });
}

test('reader settings: updates retain every supported font/spacing and discard unknown fields', async t => {
  const view = await setup(t, { primary: JSON.stringify(defaults) });
  for (const fontFamily of ['newsreader', 'source-sans-3', 'dm-sans', 'roboto-slab', 'atkinson', 'opendyslexic']) {
    await view.update({ fontFamily, unknown: 'not a reader setting' });
    assert.deepEqual(view.latest().settings, { ...defaults, fontFamily });
    assert.deepEqual(JSON.parse(localStorage.getItem(primaryKey)), { ...defaults, fontFamily });
  }
  for (const paragraphSpacing of ['compact', 'comfortable', 'spacious']) {
    await view.update({ paragraphSpacing });
    assert.deepEqual(JSON.parse(localStorage.getItem(primaryKey)), { ...defaults, fontFamily: 'opendyslexic', paragraphSpacing });
  }
  await view.unmount();
  assert.deepEqual(view.writes, [{ ...defaults, fontFamily: 'opendyslexic', paragraphSpacing: 'spacious' }]);
});

test('reader settings: updates share hydration bounds and rounding', async t => {
  const view = await setup(t, { primary: JSON.stringify(chosen) });
  await view.update({ fontSize: -100, contentWidth: 100, lineHeight: 1.76 });
  assert.deepEqual(JSON.parse(localStorage.getItem(primaryKey)), { ...chosen, fontSize: 14, contentWidth: 80, lineHeight: 1.8 });
  await view.update({ fontSize: Number.MAX_VALUE, contentWidth: -100, lineHeight: Number.MAX_VALUE });
  assert.deepEqual(JSON.parse(localStorage.getItem(primaryKey)), { ...chosen, fontSize: 24, contentWidth: 50, lineHeight: 2 });
  await view.update({ lineHeight: -100 });
  await view.unmount();
  assert.deepEqual(view.writes, [{ ...chosen, fontSize: 24, contentWidth: 50, lineHeight: 1.4 }]);
});
