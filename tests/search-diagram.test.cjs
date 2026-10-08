const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { act } = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = require('react-dom/client');
const { installDom } = require('./_helpers/dom.cjs');
const { useSearch } = require('../.tmp/workspace-tests/src/hooks/useSearch.js');
const { MermaidSvg } = require('../.tmp/workspace-tests/src/components/MermaidBlock.js');
const { collectText, rangeForOffsets } = require('../.tmp/workspace-tests/src/lib/dom-text.js');
const { clearAnnotationHighlights, wrapRange, createPositionedAnchor, prepareAnnotationDocument, resolveAnchor } = require('../.tmp/workspace-tests/src/lib/text-anchoring.js');

// Mermaid flowchart HTML labels live in foreignObject > div > span > p.
// SVG-only text and hidden labels are deliberately present but unsearchable.
const svg = (labels, version = 0) => `<svg xmlns="http://www.w3.org/2000/svg" data-version="${version}"><text>needle unsupported</text>${labels.map(label => `<g class="node"><g class="label"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>${label}</p></span></div></foreignObject></g></g>`).join('')}<foreignObject><div xmlns="http://www.w3.org/1999/xhtml" class="sr-only">needle hidden</div></foreignObject></svg>`;
const marks = root => [...root.querySelectorAll('mark.search-highlight, mark.search-highlight-active')];
const active = root => root.querySelector('mark.search-highlight-active');

async function mount(t, initial = {}) {
  await installDom();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const frames = new Map(); let frameId = 0;
  t.mock.method(globalThis, 'requestAnimationFrame', callback => { frames.set(++frameId, callback); return frameId; });
  t.mock.method(globalThis, 'cancelAnimationFrame', id => frames.delete(id));
  const scrolls = [];
  t.mock.method(window.HTMLElement.prototype, 'scrollIntoView', function (options) { scrolls.push({ node: this, options }); });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let search, ref, update;
  function Probe() {
    const [view, setView] = React.useState({ mounted: true, doc: 'one', before: 'needle before', after: 'needle after', diagrams: [svg(['needle diagram'])], ...initial });
    update = next => setView(previous => ({ ...previous, ...next }));
    ref = React.useRef(null); search = useSearch(ref);
    // Production MarkdownRenderer is memoized; search state must not re-render its SVG.
    return React.useMemo(() => React.createElement(React.Fragment, null,
      React.createElement('input', { 'aria-label': 'focus sentinel' }),
      view.mounted && React.createElement('article', { ref, key: view.doc },
        React.createElement('p', { id: 'before' }, view.before),
        ...view.diagrams.map((content, i) => content === null
          ? React.createElement('div', { key: i, className: 'mermaid-diagram mermaid-loading' }, 'Rendering diagram...')
          : React.createElement(MermaidSvg, { key: i, svg: content })),
        React.createElement('p', { id: 'after' }, view.after))), [view]);
  }
  await act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Probe))));
  const view = {
    host, frames, scrolls, get search() { return search; }, get article() { return ref.current; },
    async update(next) { await act(async () => update(next)); },
    async frame() { await act(async () => { const queued = [...frames.values()]; frames.clear(); for (const callback of queued) callback(0); }); },
    async query(q) { await act(async () => search.setQuery(q)); },
    async tick(ms = 150) { await act(async () => t.mock.timers.tick(ms)); },
    async find(q = 'needle') { await view.query(q); await view.tick(); },
    async next() { await act(async () => search.next()); },
    async previous() { await act(async () => search.previous()); },
    async clear() { await act(async () => search.clear()); },
    async unmount() { await act(async () => root.unmount()); host.remove(); },
  };
  t.after(view.unmount);
  return view;
}

test('diagram redraw keeps ordered marks, active result, focus and scroll through repeated navigation', async t => {
  const v = await mount(t, { diagrams: [svg(['needle d1']), svg(['needle d2', 'needle d2b'])] });
  await v.find(); await v.next(); await v.next();
  assert.equal(marks(v.article).length, 5);
  const input = v.host.querySelector('input'); input.focus();
  v.article.scrollTop = 321;
  for (let i = 1; i <= 25; i++) {
    const old = marks(v.article); const scrollCount = v.scrolls.length;
    await v.update({ diagrams: [svg(['needle d1'], i), svg(['needle d2', 'needle d2b'], i)] });
    assert.equal(v.frames.size, 1, 'several completions coalesce into one refresh');
    await v.frame();
    assert.equal(v.search.query, 'needle'); assert.equal(v.search.matchCount, 5);
    assert.equal(marks(v.article).length, 5); assert.equal(v.search.currentIndex, 2);
    assert.equal(active(v.article)?.parentElement.textContent, 'needle d2');
    assert.ok(old.filter(m => m.closest('.mermaid-diagram')).every(m => !m.isConnected));
    assert.ok(document.activeElement === input); assert.equal(v.article.scrollTop, 321);
    assert.equal(v.scrolls.length, scrollCount, 'background redraw does not navigate');
    for (const [move, index, label] of [['next', 3, 'needle d2b'], ['next', 4, 'needle after'], ['previous', 3, 'needle d2b'], ['previous', 2, 'needle d2']]) {
      await v[move](); assert.equal(v.search.currentIndex, index);
      assert.equal(active(v.article)?.parentElement.textContent, label);
      assert.ok(v.scrolls.at(-1).node === active(v.article));
    }
  }
});

test('every fragment of a logical match activates together through navigation and redraw', async t => {
  const label = 'Amber <strong>bravo</strong> <mark data-highlight-id="saved">cobalt</mark>';
  const v = await mount(t, { before: 'Amber bravo cobalt', after: 'after', diagrams: [svg([label, label])] });
  await v.find('Amber bravo cobalt');
  assert.equal(v.search.matchCount, 3);
  await v.next();
  const assertActive = () => {
    const activeMarks = [...v.article.querySelectorAll('mark.search-highlight-active')];
    assert.equal(activeMarks.length, 4);
    assert.equal(activeMarks.map(mark => mark.textContent).join(''), 'Amber bravo cobalt');
    assert.ok(activeMarks.every(mark => mark.closest('p') === activeMarks[0].closest('p')));
    assert.equal(marks(v.article).length, 9);
  };
  assertActive();
  const scrolls = v.scrolls.length;
  await v.update({ diagrams: [svg([label, label], 1)] });
  await v.frame();
  assertActive();
  assert.equal(v.search.currentIndex, 1);
  assert.equal(v.scrolls.length, scrolls, 'redraw does not navigate');
  await v.next(); assertActive();
  assert.equal(v.search.currentIndex, 2);
  assert.ok(v.scrolls.at(-1).node === active(v.article), 'scroll only the first fragment');
  await v.previous(); assertActive();
  await v.previous();
  assert.equal(v.article.querySelectorAll('mark.search-highlight-active').length, 1);
  await v.clear();
  assert.equal(marks(v.article).length, 0);
  assert.equal(v.article.querySelectorAll('[data-highlight-id="saved"]').length, 2);
});

test('navigation onto connected prose during a pending redraw survives the refresh', async t => {
  const v = await mount(t, { diagrams: [svg(['needle diagram'])] });
  await v.find(); await v.next();
  assert.equal(v.search.currentIndex, 1);
  await v.update({ diagrams: [svg(['needle diagram'], 1)] });
  assert.equal(v.frames.size, 1);
  const scrolls = v.scrolls.length;
  await v.next();
  assert.equal(active(v.article)?.parentElement.id, 'after', 'the still-connected prose result activates immediately');
  assert.ok(v.scrolls.length > scrolls);
  assert.ok(v.scrolls.at(-1).node === active(v.article));
  const afterNavigation = v.scrolls.length;
  await v.frame();
  assert.equal(v.search.matchCount, 3);
  assert.equal(v.search.currentIndex, 2);
  assert.equal(active(v.article)?.parentElement.id, 'after');
  assert.equal(v.scrolls.length, afterNavigation, 'refresh does not scroll the preserved result');
});

test('navigation across replaced labels during a pending redraw keeps the moved ordinal', async t => {
  const v = await mount(t, { before: 'before', after: 'after', diagrams: [svg(['needle one', 'needle two'])] });
  await v.find();
  assert.equal(v.search.currentIndex, 0);
  await v.update({ diagrams: [svg(['needle one', 'needle two'], 1)] });
  const scrolls = v.scrolls.length;
  await v.next();
  assert.equal(v.scrolls.length, scrolls, 'a detached label cannot scroll');
  await v.frame();
  assert.equal(v.search.matchCount, 2);
  assert.equal(v.search.currentIndex, 1);
  assert.equal(active(v.article)?.parentElement.textContent, 'needle two');
  assert.equal(v.scrolls.length, scrolls);
});

test('late initial diagram after a completed query preserves the connected prose result', async t => {
  const v = await mount(t, { diagrams: [null] });
  await v.find(); await v.next();
  assert.equal(v.search.matchCount, 2); assert.equal(v.search.currentIndex, 1);
  const scrollCount = v.scrolls.length;
  await v.update({ diagrams: [svg(['needle late'])] }); await v.frame();
  assert.equal(v.search.matchCount, 3); assert.equal(v.search.currentIndex, 2);
  assert.equal(active(v.article)?.parentElement.id, 'after');
  assert.equal(v.scrolls.length, scrollCount);
  await v.previous(); assert.ok(active(v.article).closest('foreignObject'));
});

test('diagrams completing on separate frames each refresh without losing a later prose result', async t => {
  const v = await mount(t, { diagrams: [null, null], after: 'needle one and needle two' });
  await v.find(); await v.next(); await v.next();
  assert.equal(v.search.currentIndex, 2);
  await v.update({ diagrams: [svg(['needle first']), null] }); await v.frame();
  assert.equal(v.search.matchCount, 4); assert.equal(v.search.currentIndex, 3);
  await v.update({ diagrams: [svg(['needle first']), svg(['needle second'])] }); await v.frame();
  assert.equal(v.search.matchCount, 5); assert.equal(v.search.currentIndex, 4);
  assert.equal(active(v.article)?.nextSibling.textContent, ' two');
});

test('query debounce, clearing and out-of-reader events cannot revive old search work', async t => {
  const v = await mount(t); await v.find();
  const before = marks(v.article);
  document.body.dispatchEvent(new Event('bindars:diagram-rendered', { bubbles: true }));
  await v.frame(); assert.deepEqual(marks(v.article), before);
  await v.update({ diagrams: [svg(['needle new'], 1)] });
  await v.query('new'); await v.frame();
  assert.equal(v.search.query, 'new');
  await v.tick(149); assert.equal(v.search.matchCount, 3, 'existing debounce semantics are retained');
  await v.tick(1); assert.equal(v.search.matchCount, 1);
  assert.equal(active(v.article).textContent, 'new');
  await v.update({ diagrams: [svg(['needle new', 'new'], 2)] });
  await v.clear(); await v.frame(); await v.tick();
  assert.equal(v.search.query, ''); assert.equal(v.search.matchCount, 0); assert.equal(marks(v.article).length, 0);
  await v.query('needle'); await v.clear(); await v.tick();
  assert.equal(v.search.query, '');
  await v.find();
  await v.update({ diagrams: [svg(['needle replacement'], 3)] });
  await v.query(''); await v.frame(); await v.tick();
  assert.equal(v.search.matchCount, 0); assert.equal(marks(v.article).length, 0);
  await v.find('   '); await v.update({ diagrams: [svg(['needle ignored'], 4)] });
  await v.frame(); assert.equal(marks(v.article).length, 0);
  await v.find(); await v.update({ diagrams: [svg(['needle latest'], 5)] }); await v.frame();
  assert.equal(marks(v.article).length, 3, 'completed and cancelled timers no longer mean pending');
});

test('a pending query searches the latest diagram and ignores earlier query timers', async t => {
  const v = await mount(t); await v.find();
  await v.query('wrong'); await v.tick(70); await v.query('latest');
  await v.update({ diagrams: [svg(['latest', 'latest'], 1)] }); await v.frame();
  await v.tick(); assert.equal(v.search.matchCount, 2); assert.equal(v.search.query, 'latest');
  assert.deepEqual(marks(v.article).map(m => m.textContent), ['latest', 'latest']);
  await v.update({ diagrams: [svg(['latest'], 2)] }); await v.frame();
  assert.equal(v.search.matchCount, 1);
});

test('null content refs, reader remounts, document replacement and unmount discard stale work', async t => {
  const v = await mount(t, { mounted: false }); await v.find();
  assert.equal(v.search.matchCount, 0);
  await v.update({ mounted: true }); await v.frame(); assert.equal(v.search.matchCount, 3);
  const oldArticle = v.article;
  await v.update({ diagrams: [svg(['needle old'], 1)] });
  await v.clear(); // App clears on document identity changes and before editor entry.
  await v.update({ doc: 'two', before: 'new prose', after: 'new after', diagrams: [svg(['new diagram'])] });
  document.body.append(oldArticle);
  oldArticle.dispatchEvent(new Event('bindars:diagram-rendered', { bubbles: true }));
  await v.frame(); await v.tick();
  assert.equal(v.search.query, ''); assert.equal(marks(v.article).length, 0); oldArticle.remove();
  await v.find('new'); await v.update({ mounted: false });
  await v.clear(); await v.update({ mounted: true }); await v.find('new');
  assert.equal(v.search.matchCount, 3);
  await v.update({ diagrams: [svg(['new queued'], 2)] }); await v.query('pending');
  await v.unmount(); await v.frame(); await v.tick();
  assert.equal(v.frames.size, 0); assert.equal(document.querySelectorAll('mark').length, 0);
});

test('queued redraw and query callbacks cannot paint a replaced container', async t => {
  const v = await mount(t); await v.find();
  await v.update({ diagrams: [svg(['needle queued'], 1)] });
  await v.update({ doc: 'two', diagrams: [] }); await v.frame();
  assert.equal(marks(v.article).length, 0);
  await v.query('needle'); await v.update({ doc: 'three' }); await v.tick();
  assert.equal(marks(v.article).length, 0);
});

test('changed diagram counts clamp missing active results, handle zero and recover', async t => {
  const v = await mount(t, { before: 'before', after: 'after', diagrams: [svg(['needle one', 'needle two', 'needle three'])] });
  await v.find(); await v.next(); await v.next();
  await v.update({ diagrams: [svg(['needle one'], 1)] }); await v.frame();
  assert.equal(v.search.matchCount, 1); assert.equal(v.search.currentIndex, 0); assert.ok(active(v.article));
  await v.update({ diagrams: [svg(['gone'], 2)] }); await v.frame();
  assert.equal(v.search.matchCount, 0); assert.equal(v.search.currentIndex, -1); assert.equal(active(v.article), null);
  const scrollCount = v.scrolls.length; await v.next(); await v.previous();
  assert.equal(v.scrolls.length, scrollCount);
  await v.update({ diagrams: [svg(['needle returned'], 3)] }); await v.frame();
  assert.equal(v.search.matchCount, 1); assert.equal(v.search.currentIndex, 0); assert.ok(active(v.article));
});

test('saved annotations can repaint before or after search while text and navigation survive', async t => {
  const v = await mount(t);
  const source = 'synthetic document';
  const index = collectText(v.article); const start = index.text.indexOf('needle diagram');
  const anchor = await createPositionedAnchor(rangeForOffsets(index.spans, start, start + 'needle diagram'.length), v.article, source);
  const proseNode = v.article.querySelector('#before').firstChild;
  const text = v.article.textContent;
  async function annotate() {
    const evidence = await prepareAnnotationDocument(v.article, source);
    clearAnnotationHighlights(v.article);
    const result = resolveAnchor(anchor, v.article, evidence); assert.equal(result.status, 'located');
    wrapRange(result.range, 'annotation-highlight-yellow', 'saved');
  }
  await annotate(); await v.find();
  for (let i = 1; i <= 8; i++) {
    await v.update({ diagrams: [svg(['needle diagram'], i)] });
    if (i % 2) { await annotate(); await v.frame(); }
    else { await v.frame(); await annotate(); }
    assert.equal(marks(v.article).length, 3); assert.equal(v.search.matchCount, 3);
    assert.equal(v.article.textContent, text); assert.ok(v.article.contains(proseNode));
    assert.equal([...v.article.querySelectorAll('[data-highlight-id="saved"]')].map(m => m.textContent).join(''), 'needle diagram');
    await v.next(); await v.previous(); assert.ok(active(v.article).isConnected);
    assert.equal(v.article.querySelector('svg text').textContent, 'needle unsupported');
    assert.equal(v.article.querySelector('.sr-only').textContent, 'needle hidden');
  }
  await v.clear(); assert.equal(v.article.textContent, text);
  assert.ok(v.article.querySelector('[data-highlight-id="saved"]'));
  assert.ok(v.article.querySelector('#before').firstChild === proseNode);
});
