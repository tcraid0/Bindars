const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkspaceDoc } = require('../.tmp/workspace-tests/src/lib/workspace-index.js');
const { searchWorkspaceDocs } = require('../.tmp/workspace-tests/src/lib/workspace-search.js');
const { MAX_WORKSPACE_BODY_CHARS } = require('../.tmp/workspace-tests/src/lib/workspace-limits.js');
const meta = { path:'/workspace/note.md', name:'note.md', relPath:'note.md' };
const hits = (source, query) => searchWorkspaceDocs([buildWorkspaceDoc(meta, source)], query, new Map());

for (const source of [
  'A **bright** future.', 'A *bright* future.', 'A [bright](other.md) future.',
  'A [bright][ref] future.\n\n[ref]: other.md', 'A bright\nfuture.', 'A bright  \nfuture.',
]) {
  test(`body phrase survives inline Markdown: ${JSON.stringify(source)}`, () => {
    assert.equal(hits(source, 'bright future').filter(hit => hit.kind === 'content').length, 1);
  });
}

test('body text decodes entities and excludes invisible comments and reference destinations', () => {
  const source = 'Fish &amp; chips. <!-- ghostneedle -->\n\n[Visible][ref]\n\n[ref]: secretneedle.md';
  assert.equal(hits(source, 'fish & chips').length, 1);
  assert.equal(hits(source, 'ghostneedle').length, 0);
  assert.equal(hits(source, 'secretneedle').length, 0);
  assert.equal(hits(source, 'visible').length, 1);
});

for (const source of [
  '```\nexcludedneedle\n```', '~~~\nexcludedneedle\n~~~', '    excludedneedle',
  '`excludedneedle`', '![excludedneedle](photo.png)', '![excludedneedle][img]\n\n[img]: photo.png',
  '$$excludedneedle$$', '```mermaid\nexcludedneedle\n```',
  '<!-- excludedneedle -->',
]) {
  test(`body excerpt omits unsupported search content: ${JSON.stringify(source)}`, () => {
    assert.equal(hits(source, 'excludedneedle').length, 0);
  });
}

for (const source of ['bright\n\nfuture', '- bright\n- future', '| bright | future |\n| --- | --- |', 'bright `code` future']) {
  test(`body phrases do not cross block or omitted-content boundaries: ${JSON.stringify(source)}`, () => {
    assert.equal(hits(source, 'bright future').length, 0);
    assert.equal(hits(source, 'bright').length, 1);
    assert.equal(hits(source, 'future').length, 1);
  });
}

test('truncated body stays bounded while later headings remain searchable', () => {
  const source = 'ordinary prose '.repeat(2200) + '\n\nlatebodyneedle\n\n## Late heading';
  const doc = buildWorkspaceDoc(meta, source);
  assert.equal(doc.bodyText.length, MAX_WORKSPACE_BODY_CHARS);
  assert.equal(searchWorkspaceDocs([doc], 'latebodyneedle', new Map()).length, 0);
  assert.ok(searchWorkspaceDocs([doc], 'late heading', new Map()).some(hit => hit.kind === 'heading'));
});
