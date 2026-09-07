const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { WorkspacePanel } = require('../.tmp/workspace-tests/src/components/WorkspacePanel.js');
const { CommandPalette } = require('../.tmp/workspace-tests/src/components/CommandPalette.js');

const state = {
  rootPath:'/workspace', status:'ready', fileCount:2, processedCount:2, indexedCount:1,
  indexedAt:1234, error:null, listSkippedCount:0, readFailedCount:1,
  complexitySkippedCount:0, limitHit:true,
};

test('workspace reports successful/discovered counts even when the limit is reached', () => {
  const html = renderToStaticMarkup(React.createElement(WorkspacePanel, {
    rootPath: state.rootPath, state, backlinks:[], mentions:[],
  }));
  assert.match(html, /1\/2 files indexed \(limit reached\)/);
  assert.match(html, /Reindex after files change/);
  assert.match(html, /Last indexed:/);
});

for (const [status, message] of [
  ['idle', /Choose a folder in the Workspace panel/],
  ['indexing', /Waiting for indexing to finish/],
  ['error', /Indexing failed/],
  ['ready', /No indexed files to show/],
]) {
  test(`empty palette explains ${status} state`, () => {
    const html = renderToStaticMarkup(React.createElement(CommandPalette, {
      visible:true, query:'', pending:false, results:[], selectedIndex:0, status,
    }));
    assert.match(html, message);
    assert.doesNotMatch(html, /Results improve as indexing progresses/);
  });
}
