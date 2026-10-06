const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { installDom } = require('./_helpers/dom.cjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Control the renderer promise, leaving MermaidBlock, MermaidSvg, and their
// actual DOM/event lifecycle in production code. Real Mermaid is checked in WebKit.
const renders = [];
const modulePath = require.resolve('mermaid');
require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports: {
  __esModule: true, default: { initialize() {}, render() {
    return new Promise((resolve, reject) => renders.push({ resolve, reject }));
  } },
} };
const { MermaidBlock } = require('../.tmp/workspace-tests/src/components/MermaidBlock.js');
const { useSearch } = require('../.tmp/workspace-tests/src/hooks/useSearch.js');
const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g class="label"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>needle label</p></span></div></foreignObject></g></svg>';

test('Mermaid completion and failure after an applied search both refresh searchable output', async t => {
  await installDom();
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const frames = new Map(); let frameId = 0;
  t.mock.method(globalThis, 'requestAnimationFrame', callback => { frames.set(++frameId, callback); return frameId; });
  t.mock.method(globalThis, 'cancelAnimationFrame', id => frames.delete(id));
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); let search, setChart;
  function Probe() {
    const ref = React.useRef(null); search = useSearch(ref);
    const [chart, update] = React.useState('flowchart LR; A[needle]'); setChart = update;
    return React.createElement('article', { ref }, React.createElement(MermaidBlock, { chart }));
  }
  const frame = async () => act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(f => f(0)); });
  try {
    await act(async () => root.render(React.createElement(Probe)));
    assert.equal(renders.length, 1); assert.ok(host.querySelector('.mermaid-loading'));
    await act(async () => { search.setQuery('needle'); });
    await act(async () => t.mock.timers.tick(150));
    assert.equal(search.matchCount, 0, 'query really completes while Mermaid is unresolved');
    await act(async () => renders.shift().resolve({ svg })); await frame();
    assert.equal(search.matchCount, 1); assert.ok(host.querySelector('foreignObject mark.search-highlight-active'));
    const previous = host.querySelector('mark.search-highlight-active');
    await act(async () => setChart('flowchart LR; A[needle] -->'));
    assert.equal(renders.length, 1);
    await act(async () => renders.shift().reject(new Error('parse failed'))); await frame();
    assert.ok(host.querySelector('.mermaid-error')); assert.ok(!previous.isConnected);
    assert.equal(search.matchCount, 1); assert.ok(host.querySelector('.mermaid-error mark.search-highlight-active'));
    await act(async () => search.previous()); assert.ok(host.querySelector('mark.search-highlight-active').isConnected);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
