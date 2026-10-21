const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { installDom } = require('./_helpers/dom.cjs');
const { useSearch, highlightSearchMatches, clearSearchHighlights, MAX_SEARCH_MATCHES, MAX_SEARCH_FRAGMENTS } = require('../.tmp/workspace-tests/src/hooks/useSearch.js');
const { phraseMatches } = require('../.tmp/workspace-tests/src/lib/search-text.js');
const { MarkdownRenderer } = require('../.tmp/workspace-tests/src/components/MarkdownRenderer.js');
const { SearchBar } = require('../.tmp/workspace-tests/src/components/SearchBar.js');
const { ToastProvider } = require('../.tmp/workspace-tests/src/components/ToastProvider.js');
const { DEFAULT_READER_SETTINGS } = require('../.tmp/workspace-tests/src/lib/reader-settings.js');
const { collectText, rangeForOffsets } = require('../.tmp/workspace-tests/src/lib/dom-text.js');
const { wrapRange, clearAnnotationHighlights } = require('../.tmp/workspace-tests/src/lib/text-anchoring.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const noOpen = () => false;
const marks = el => [...el.querySelectorAll('mark.search-highlight, mark.search-highlight-active')];

async function mount(t, content) {
  await installDom();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const frames = new Map(); let frameId = 0;
  t.mock.method(globalThis, 'requestAnimationFrame', callback => { frames.set(++frameId, callback); return frameId; });
  t.mock.method(globalThis, 'cancelAnimationFrame', id => frames.delete(id));
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host), ref = { current: null };
  let search, update;
  function Probe() {
    const [doc, setDoc] = React.useState({ content, filePath: '/synthetic/one.md', settings: DEFAULT_READER_SETTINGS });
    update = change => setDoc(prev => ({ ...prev, ...change }));
    search = useSearch(ref, true);
    // The app clears Find after a document identity change (the renderer keys its article).
    const previous = React.useRef(doc);
    React.useEffect(() => {
      if (previous.current.content !== doc.content || previous.current.filePath !== doc.filePath) search.clear();
      previous.current = doc;
    }, [doc, search.clear]);
    return React.createElement(ToastProvider, null,
      React.createElement(SearchBar, { visible: true, focusRequest: 0, ...search, onQueryChange: search.setQuery,
        onNext: search.next, onPrevious: search.previous, onClose: search.clear }),
      React.createElement(MarkdownRenderer, { ...doc, contentRef: ref, onOpenFragment: noOpen }));
  }
  await act(async () => root.render(React.createElement(Probe)));
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  return {
    host, get article() { return ref.current; }, get search() { return search; },
    async query(q) { await act(async () => search.setQuery(q)); },
    async tick() { await act(async () => t.mock.timers.tick(150)); },
    async find(q) { await this.query(q); await this.tick(); },
    async clear() { await act(async () => search.clear()); },
    async update(doc) { await act(async () => update(doc)); },
    async refresh() { await act(async () => { ref.current.dispatchEvent(new Event('bindars:diagram-rendered', { bubbles: true })); });
      await act(async () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(0); } }); },
    async move(direction) { await act(async () => search[direction]()); },
  };
}

for (const count of [10000, 20000]) {
  test(`dense ${count}-match Find bounds paint, reports a prefix, changes query and clears`, async t => {
    const content = 'a x '.repeat(count) + 'unique';
    const v = await mount(t, content), original = v.article.querySelector('p').firstChild;
    await v.find('a');
    assert.equal(v.search.matchCount, MAX_SEARCH_MATCHES);
    assert.equal(v.search.limited, true);
    assert.equal(marks(v.article).length, MAX_SEARCH_MATCHES);
    assert.match(v.host.querySelector('[aria-live]').textContent, /1 of 1000 shown · Refine search/);
    assert.equal(v.article.textContent, content);
    await v.move('previous');
    assert.equal(v.search.currentIndex, MAX_SEARCH_MATCHES - 1);
    assert.equal(v.article.querySelectorAll('.search-highlight-active').length, 1);
    await v.move('next'); assert.equal(v.search.currentIndex, 0);
    await v.find('x');
    assert.ok(marks(v.article).every(mark => mark.textContent === 'x'));
    await v.find('unique');
    assert.equal(v.search.matchCount, 1); assert.equal(v.search.limited, false);
    assert.equal(v.host.querySelector('[aria-live]').textContent, '1 of 1');
    await v.query('a'); await v.clear(); await v.tick();
    assert.equal(v.search.query, ''); assert.equal(v.search.limited, false);
    assert.equal(marks(v.article).length, 0);
    assert.equal(v.article.textContent, content);
    assert.ok(v.article.querySelector('p').firstChild === original);
    assert.equal(original.data, content);
  });
}

test('the exact match ceiling is a complete count; a later block makes it limited', async t => {
  const v = await mount(t, 'a x '.repeat(MAX_SEARCH_MATCHES));
  await v.find('a'); assert.equal(v.search.limited, false);
  assert.equal(v.host.querySelector('[aria-live]').textContent, '1 of 1000');
  await v.update({ content: 'a x '.repeat(MAX_SEARCH_MATCHES) + '\n\na' });
  await v.find('a'); assert.equal(v.search.limited, true);
});

test('fragment ceiling admits whole matches across formatting and annotations', async t => {
  const v = await mount(t, ('a**b***c* ').repeat(800));
  const { text, spans } = collectText(v.article);
  wrapRange(rangeForOffsets(spans, 1, 2), 'annotation-highlight-yellow', 'saved');
  const annotation = v.article.querySelector('[data-highlight-id="saved"]');
  const before = v.article.innerHTML;
  await v.find('abc');
  assert.equal(v.search.matchCount, Math.floor(MAX_SEARCH_FRAGMENTS / 3));
  assert.equal(v.search.limited, true);
  assert.equal(marks(v.article).length, Math.floor(MAX_SEARCH_FRAGMENTS / 3) * 3);
  assert.equal(v.article.querySelectorAll('.search-highlight-active').length, 3);
  assert.equal(v.article.textContent, text);
  await v.clear();
  assert.equal(v.article.innerHTML, before);
  assert.ok(v.article.querySelector('[data-highlight-id="saved"]') === annotation);
  // Settings rerender the actual memoized renderer without replacing annotation DOM.
  await v.update({ settings: { ...DEFAULT_READER_SETTINGS, paragraphSpacing: "compact" } });
  assert.ok(v.article.querySelector('[data-highlight-id="saved"]') === annotation);
  assert.equal(annotation.textContent, 'b');
  await v.find('abc'); clearAnnotationHighlights(v.article);
  await v.clear(); assert.equal(v.article.textContent, text);
  await v.update({ content: 'Replacement **text** after Find.' });
  assert.equal(v.article.textContent, 'Replacement text after Find.');
});

test('one over-budget fragmented match paints nothing and never claims no results', async t => {
  const v = await mount(t, 'placeholder');
  const p = v.article.querySelector('p');
  p.replaceChildren(...Array.from({ length: MAX_SEARCH_FRAGMENTS + 1 }, () => {
    const em = document.createElement('em'); em.textContent = 'a'; return em;
  }));
  await v.find('a'.repeat(MAX_SEARCH_FRAGMENTS + 1));
  assert.equal(v.search.matchCount, 0); assert.equal(v.search.limited, true);
  assert.equal(marks(v.article).length, 0);
  assert.equal(v.host.querySelector('[aria-live]').textContent, 'Results limited · Refine search');
  assert.ok(v.host.querySelector('[aria-label="Next match"]').disabled);
  assert.equal(p.textContent, 'a'.repeat(MAX_SEARCH_FRAGMENTS + 1));
});

test('fragment boundary is exact and no partial final match is painted', async () => {
  await installDom();
  const article = document.createElement('article');
  article.innerHTML = '<p>' + '<em>a</em>'.repeat(MAX_SEARCH_FRAGMENTS) + '</p>';
  const matches = highlightSearchMatches(article, 'a'.repeat(MAX_SEARCH_FRAGMENTS));
  assert.equal(matches.length, 1); assert.equal(matches[0].length, MAX_SEARCH_FRAGMENTS);
  clearSearchHighlights(article);
  assert.equal(article.textContent, 'a'.repeat(MAX_SEARCH_FRAGMENTS));
});

test('switching files during capped Find cancels pending queries and clears the limit state', async t => {
  const content = 'a x '.repeat(20000) + 'end';
  const v = await mount(t, content);
  await v.find('a'); const old = v.article;
  await v.query('x');
  await v.update({ filePath: '/synthetic/two.md' });
  await v.tick();
  assert.ok(v.article !== old);
  assert.equal(v.article.textContent, content);
  assert.equal(v.search.query, ''); assert.equal(v.search.matchCount, 0); assert.equal(v.search.limited, false);
  assert.equal(marks(v.article).length, 0);
  await v.update({ content: 'new document' });
  await v.find('new'); assert.equal(v.search.matchCount, 1);
});

test('bounded phrase enumeration retains complete Unicode offsets', () => {
  assert.deepEqual(phraseMatches('İ İ İ', 'i\u0307', true, 2), [{ start: 0, end: 1 }, { start: 2, end: 3 }]);
  assert.deepEqual(phraseMatches('a a a', 'a', true, 0), []);
});

test('workspace passage navigation beyond either cap opens a bounded window at the target', async t => {
  const dense = 'a x '.repeat(2000) + 'end';
  const v = await mount(t, dense + '\n\na end\n\na next');
  const passage = { phrase: 'a', block: dense, blockOccurrence: 0, matchOccurrence: 1500 };
  await act(async () => assert.equal(v.search.openPassage(passage), true));
  assert.equal(v.search.limited, true);
  assert.equal(v.search.matchCount, 502);
  assert.equal(v.search.currentIndex, 0);
  const paragraph = v.article.querySelector('p');
  assert.equal(paragraph.firstChild.data, 'a x '.repeat(1500));
  assert.equal(v.article.querySelector('.search-highlight-active').textContent, 'a');
  assert.equal(v.host.querySelector('[aria-live]').textContent, '1 of 502 shown · Refine search');
  await v.refresh();
  assert.equal(paragraph.firstChild.data, 'a x '.repeat(1500), 'diagram refresh retains the passage window');
  assert.equal(v.search.currentIndex, 0); assert.equal(v.search.matchCount, 502);
  await v.move('previous'); assert.equal(v.search.currentIndex, 501);
  await act(async () => assert.equal(v.search.openPassage({ ...passage, block: 'a end', matchOccurrence: 0 }), true));
  assert.equal(v.article.querySelector('.search-highlight-active').parentElement.textContent, 'a end');
  // A missing occurrence must not fall through into the next block's match.
  await act(async () => assert.equal(v.search.openPassage({ ...passage, block: 'a end', matchOccurrence: 100 }), false));
  assert.equal(v.search.matchCount, 0); assert.equal(marks(v.article).length, 0);
  await v.move('next'); assert.equal(v.search.currentIndex, -1);
});
