const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { mockConvertFileSrc, clearMocks } = require('@tauri-apps/api/mocks');
const { MarkdownRenderer } = require('../.tmp/workspace-tests/src/components/MarkdownRenderer.js');
const { FountainRenderer } = require('../.tmp/workspace-tests/src/components/FountainRenderer.js');
const { ToastProvider } = require('../.tmp/workspace-tests/src/components/ToastProvider.js');
const { DEFAULT_READER_SETTINGS: settings } = require('../.tmp/workspace-tests/src/lib/reader-settings.js');
const { prepareCatalogDocument } = require('../.tmp/workspace-tests/src/lib/document-catalog.js');
const { searchWorkspaceDocs } = require('../.tmp/workspace-tests/src/lib/workspace-search.js');
const { collectSearchRuns } = require('../.tmp/workspace-tests/src/lib/search-runs.js');
const { searchText } = require('../.tmp/workspace-tests/src/lib/search-text.js');
const { useSearch } = require('../.tmp/workspace-tests/src/hooks/useSearch.js');
const { parseFountain } = require('../.tmp/workspace-tests/src/lib/fountain.js');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function mount(t, source, fountain = false) {
  const path = '/documents/passages.' + (fountain ? 'fountain' : 'md');
  const doc = prepareCatalogDocument({ path, name: path, relPath: path, size: source.length, mtimeMs: 1 }, source);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const ref = { current: null };
  let search;
  function Probe({ authorized }) {
    search = useSearch(ref);
    return fountain
      ? React.createElement(FountainRenderer, { parsed: parseFountain(source), settings, contentRef: ref })
      : React.createElement(MarkdownRenderer, {
        content: source, filePath: path, settings, contentRef: ref,
        imagesAuthorized: authorized, onOpenFragment: () => false,
      });
  }
  const render = async (authorized = false) => act(async () => root.render(
    React.createElement(ToastProvider, null, React.createElement(Probe, { authorized })),
  ));
  t.after(async () => { await act(async () => root.unmount()); host.remove(); clearMocks(); });
  await render();
  return {
    doc, host, render,
    get search() { return search; },
    get article() { return ref.current; },
    async clear() { await act(async () => search.clear()); },
    async open(passage) { await act(async () => assert.equal(search.openPassage(passage), true)); },
  };
}

async function assertAgreement(view, query = 'refund policy') {
  await view.clear();
  assert.deepEqual(
    collectSearchRuns(view.article).filter(run => run.passageEligible).map(run => searchText(run.text)),
    view.doc.bodyText.split('\n').map(searchText).filter(Boolean),
    'source extraction and the real reader must agree on eligible block order',
  );
  const hit = searchWorkspaceDocs([view.doc], query, new Map())[0];
  assert.ok(hit?.passages.length);
  for (const passage of hit.passages) {
    await view.open(passage);
    const marks = [...view.article.querySelectorAll('mark.search-highlight-active')];
    assert.equal(searchText(marks.map(mark => mark.textContent).join('')), passage.phrase);
    assert.ok(marks.every(mark => !mark.closest('.frontmatter-header, .markdown-image, .mermaid-diagram, .mermaid-error, .code-block-toolbar, .katex, code, pre')));
    await view.clear();
  }
}

for (const [name, source] of [
  ['tables', '| Topic | Detail |\n| --- | --- |\n| Refund policy | Payment allowed |\n| Other | Refund policy |'],
  ['nested and loose lists', '- Parent refund policy\n\n  More refund policy\n\n  - Child refund policy\n\n- Last refund policy'],
  ['blockquotes', '> Refund **policy**\n>\n> > Nested refund policy\n\nRefund policy'],
  ['footnotes', 'Read[^x] again[^x].\n\n[^x]: Refund policy\n\n    Second refund policy paragraph'],
  ['math and code', 'Formula $$x^2$$ here.\n\nx2\n\nWhere $$y$$ refund policy follows.\n\nRefund `code` policy.'],
  ['tasks and repeated paragraphs', '- [x] Refund policy\n- [ ] Refund policy\n\nRefund policy. Refund policy.\n\nRefund policy.'],
  ['dropped HTML and inline formatting', 'Refund <span>policy</span> applies.\n\nRefund **policy** applies.\n\nRefund  \npolicy applies.'],
]) {
  test(`passage agreement across ${name}`, async t => assertAgreement(await mount(t, source)));
}

for (const field of ['title', 'description', 'subtitle', 'author']) {
  test(`frontmatter ${field} cannot shift repeated body passage ordinals`, async t => {
    const view = await mount(t, `---\n${field}: Refund policy.\n---\n\nRefund policy.\n\nRefund policy.`);
    await assertAgreement(view);
    const hit = searchWorkspaceDocs([view.doc], 'refund policy', new Map())[0];
    assert.equal(hit.passageCount, 2);
    const body = [...view.article.querySelectorAll('p')].filter(p => !p.closest('.frontmatter-header'));
    for (let i = 0; i < 2; i++) {
      await view.open(hit.passages[i]);
      assert.ok(body[i].contains(view.article.querySelector('mark.search-highlight-active')));
    }
    assert.ok(view.article.querySelector('.frontmatter-header mark.search-highlight'), 'Find still includes displayed metadata');
  });
}

for (const [name, body, selector] of [
  ['heading', '# Python', 'h1'],
  ['paragraph', 'Python', 'p'],
  ['list item', '- Python', 'li'],
  ['table cell', '| Language |\n| --- |\n| Python |', 'td'],
]) {
  test(`fenced language label cannot take an identical ${name} passage`, async t => {
    const view = await mount(t, '```python\nprint(1)\n```\n\n' + body);
    await assertAgreement(view, 'python');
    const hit = searchWorkspaceDocs([view.doc], 'python', new Map())[0];
    assert.equal(hit.passageCount, 1);
    await view.open(hit.passages[0]);
    assert.ok(view.article.querySelector(selector).contains(view.article.querySelector('mark.search-highlight-active')));
    assert.ok(view.article.querySelector('.code-lang-chip mark.search-highlight'), 'Find still includes the displayed language label');
    assert.equal(view.article.querySelectorAll('button mark').length, 0, 'Copy remains outside Find');
  });
}

test('repeated one-word passages retain their destinations around several fenced language labels', async t => {
  const view = await mount(t, 'Python\n\n```python\nprint(1)\n```\n\nPython\n\n```python\nprint(2)\n```\n\nPython');
  await assertAgreement(view, 'python');
  const hit = searchWorkspaceDocs([view.doc], '"Python"', new Map())[0];
  assert.equal(hit.passageCount, 3);
  const paragraphs = [...view.article.querySelectorAll('p')];
  assert.equal(paragraphs.length, 3);
  for (const [index, passage] of hit.passages.entries()) {
    await view.open(passage);
    assert.ok(paragraphs[index].contains(view.article.querySelector('mark.search-highlight-active')), `passage ${index + 1} must select its own paragraph`);
  }
});

test('longer repeated passages retain their destinations after a fenced language label', async t => {
  const view = await mount(t, '```python\nprint(1)\n```\n\nPython is installed.\n\nPython is installed.');
  await assertAgreement(view, '"python is installed"');
  const hit = searchWorkspaceDocs([view.doc], '"python is installed"', new Map())[0];
  assert.equal(hit.passageCount, 2);
  await view.open(hit.passages[1]);
  assert.ok(view.article.querySelectorAll('p')[1].contains(view.article.querySelector('mark.search-highlight-active')));
});

test('fences without language labels cannot turn Copy controls or code into passages', async t => {
  const view = await mount(t, '```\nCopy\n```\n\nCopy');
  await assertAgreement(view, 'copy');
  const hit = searchWorkspaceDocs([view.doc], 'copy', new Map())[0];
  assert.equal(hit.passageCount, 1);
  await view.open(hit.passages[0]);
  assert.ok(view.article.querySelector('p').contains(view.article.querySelector('mark.search-highlight-active')));
  assert.ok(view.article.querySelector('pre code mark.search-highlight'), 'Find still includes code');
  assert.equal(view.article.querySelectorAll('button mark').length, 0, 'Find does not include Copy controls');
});

for (const src of ['https://example.com/image.png', '/image.png', 'file:///image.png', 'data:image/png;base64,eA==', '../outside.png', '']) {
  test(`blocked image preserves both surrounding passages: ${src}`, async t => {
    const view = await mount(t, `Before refund policy ![refund policy](${src}) after refund policy.`);
    assert.ok(view.article.querySelector('.image-notice'));
    await assertAgreement(view);
    const hit = searchWorkspaceDocs([view.doc], 'refund policy', new Map())[0];
    assert.equal(hit.passageCount, 2);
    await view.open(hit.passages[1]);
    assert.ok(view.article.querySelector('.image-notice mark.search-highlight'), 'Find may match the generated notice independently');
  });
}

test('image authorization, loading, success and failure keep passage boundaries and existing marks', async t => {
  mockConvertFileSrc('macos');
  const view = await mount(t, 'Before refund policy ![refund policy](missing.png) after refund policy.');
  assert.equal(view.article.querySelector('img').getAttribute('src'), null);
  await assertAgreement(view);
  await view.render(true);
  assert.ok(view.article.querySelector('img').getAttribute('src'));
  await assertAgreement(view);
  await act(async () => view.article.querySelector('img').dispatchEvent(new Event('load')));
  await assertAgreement(view);
  const hit = searchWorkspaceDocs([view.doc], 'refund policy', new Map())[0];
  await view.open(hit.passages[1]);
  const active = view.article.querySelector('mark.search-highlight-active');
  await act(async () => view.article.querySelector('img').dispatchEvent(new Event('error')));
  assert.ok(active.isConnected, 'replacing the image must preserve the surrounding highlighted prose');
  assert.ok(view.article.querySelector('.image-notice'));
  await assertAgreement(view);
});

test('image-only blocks and adjacent failed images cannot join prose across omitted content', async t => {
  const view = await mount(t, 'Refund policy.\n\n![one](https://example.com/one)\n\nRefund policy.\n\nBefore refund policy ![two](/two) ![three](/three) after refund policy.');
  await assertAgreement(view);
  assert.equal(searchWorkspaceDocs([view.doc], '"policy after"', new Map()).length, 0);
});

test('Fountain title ordering, duplicate keys, dialogue, notes and synopsis agree with the reader', async t => {
  const view = await mount(t, 'Author: Ada\nTitle: Refund policy\nCredit: Written by\nTitle: Hidden duplicate\nContact: Refund policy\n\nINT. ROOM - DAY #12#\n\nSARAH\nRefund policy applies.\n\nJOHN ^\nRefund policy applies.\n\n[[Refund policy note]]\n\n= Refund policy synopsis', true);
  await assertAgreement(view);
  assert.doesNotMatch(view.article.textContent, /Hidden duplicate/);
});

test('later unordered words resolve through inline formatting', async t => {
  const view = await mount(t, 'Payment ' + 'ordinary explanation '.repeat(18) + 'refund **payment** terms apply.');
  await assertAgreement(view, 'payment refund');
  const hit = searchWorkspaceDocs([view.doc], 'payment refund', new Map())[0];
  await view.open(hit.passages[0]);
  assert.equal([...view.article.querySelectorAll('mark.search-highlight-active')].map(mark => mark.textContent).join(''), 'refund payment');
});
