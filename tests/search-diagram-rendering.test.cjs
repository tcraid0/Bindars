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

test('document passages ignore diagram loading, labels and errors while Find includes them', async t => {
  await installDom();
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  const { MarkdownRenderer } = require('../.tmp/workspace-tests/src/components/MarkdownRenderer.js');
  const { ToastProvider } = require('../.tmp/workspace-tests/src/components/ToastProvider.js');
  const { DEFAULT_READER_SETTINGS: settings } = require('../.tmp/workspace-tests/src/lib/reader-settings.js');
  const { prepareCatalogDocument } = require('../.tmp/workspace-tests/src/lib/document-catalog.js');
  const { searchWorkspaceDocs } = require('../.tmp/workspace-tests/src/lib/workspace-search.js');
  const source = '```mermaid\ngraph TD\n A[Refund policy.]\n```\n\nRefund policy.\n\nRefund policy.';
  const doc = prepareCatalogDocument({ path: '/diagram.md', name: 'diagram.md', relPath: 'diagram.md', size: source.length, mtimeMs: 1 }, source);
  const hit = searchWorkspaceDocs([doc], 'refund policy', new Map())[0];
  assert.equal(hit.passageCount, 2);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const frames = new Map(); let frameId = 0;
  t.mock.method(globalThis, 'requestAnimationFrame', callback => { frames.set(++frameId, callback); return frameId; });
  t.mock.method(globalThis, 'cancelAnimationFrame', id => frames.delete(id));
  let search;
  function Probe({ content }) {
    const ref = React.useRef(null); search = useSearch(ref);
    return React.createElement(MarkdownRenderer, { content, filePath: '/diagram.md', settings, contentRef: ref, imagesAuthorized: true, onOpenFragment: () => false });
  }
  const render = async content => act(async () => root.render(React.createElement(ToastProvider, null, React.createElement(Probe, { content }))));
  const frame = async () => act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(f => f(0)); });
  const assertTarget = () => {
    const paragraphs = [...host.querySelectorAll('article > p')];
    assert.ok(paragraphs[1].contains(host.querySelector('mark.search-highlight-active')), 'the second body paragraph stays active');
  };
  try {
    await render(source);
    assert.ok(host.querySelector('.mermaid-loading'));
    await act(async () => assert.equal(search.openPassage(hit.passages[1]), true));
    assertTarget();
    await act(async () => renders.shift().resolve({ svg: svg.replace('needle label', 'Refund policy.') }));
    await frame();
    assertTarget();
    assert.equal(search.matchCount, 3, 'Find includes the diagram label');
    for (let i = 0; i < 2; i++) {
      await act(async () => assert.equal(search.openPassage(hit.passages[i]), true));
      assert.ok(host.querySelectorAll('article > p')[i].contains(host.querySelector('mark.search-highlight-active')));
    }
    await render(source.replace('graph TD', 'invalid diagram'));
    await act(async () => renders.shift().reject(new Error('Refund policy.')));
    await frame();
    assert.ok(host.querySelector('.mermaid-error'));
    await act(async () => assert.equal(search.openPassage(hit.passages[1]), true));
    assertTarget();
    assert.ok(host.querySelector('.mermaid-error mark.search-highlight'), 'Find includes error output without counting it as a prose passage');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
