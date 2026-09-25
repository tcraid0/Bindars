const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnchor, createPositionedAnchor, prepareAnnotationDocument, resolveAnchor, wrapRange, clearAnnotationHighlights } = require('../.tmp/workspace-tests/src/lib/text-anchoring.js');
const { collectText, rangeForOffsets } = require('../.tmp/workspace-tests/src/lib/dom-text.js');
const { highlightSearchMatches, clearSearchHighlights } = require('../.tmp/workspace-tests/src/hooks/useSearch.js');
function fixture(html) {const c=document.createElement('article');c.innerHTML=html;return c;}
function selection(c,exact,last=false) {const {text,spans}=collectText(c);const i=last?text.lastIndexOf(exact):text.indexOf(exact);return rangeForOffsets(spans,i,i+exact.length);}

test('invalid empty or whitespace stored quotes finish without attaching',()=>{
  const c=fixture('<p>abc</p>');
  for(const exact of ['', ' ', '\n']) assert.equal(resolveAnchor({exact,prefix:'',suffix:''},c).status,'missing');
});
test('second identical passage stays attached on creation and unchanged reopen; legacy duplicates remain uncertain',async()=>{
  const paragraph='A'.repeat(40)+'quote'+'B'.repeat(40);
  const c=fixture(`<p>${paragraph}</p><p>${paragraph}</p>`);
  const range=selection(c,'quote',true);
  const legacy=createAnchor(range,c); assert.equal(resolveAnchor(legacy,c).status,'uncertain');
  const anchor=await createPositionedAnchor(range,c,'source');
  const reopened=fixture(c.innerHTML);
  const result=resolveAnchor(anchor,reopened,await prepareAnnotationDocument(reopened,'source'));
  assert.equal(result.range.startContainer,reopened.children[1].firstChild);
  // Deleting the selected second copy must not authorize attaching to the first.
  reopened.children[1].remove();
  assert.equal(resolveAnchor(anchor,reopened,await prepareAnnotationDocument(reopened,'edited source')).status,'uncertain');
});
test('exact context survives a distant insertion; edited/deleted contexts never choose an unrelated quote',async()=>{
  const c=fixture('<p>prefix quote suffix</p>');
  const anchor=await createPositionedAnchor(selection(c,'quote'),c,'old');
  c.innerHTML='<p>Unrelated quote location</p>';
  assert.equal(resolveAnchor(anchor,c,await prepareAnnotationDocument(c,'new')).status,'uncertain');
  c.innerHTML='<p>prefix changed suffix</p>'; assert.equal(resolveAnchor(anchor,c).status,'missing');
  const long=fixture('<p>'+ 'A'.repeat(80)+'quote'+'B'.repeat(80)+'</p>');
  const stable=createAnchor(selection(long,'quote'),long);
  long.firstChild.prepend('New beginning ');
  assert.equal(resolveAnchor(stable,long).status,'located');
});
test('inline formatting, links, code, emoji and combining text preserve the exact range through both mark orders',async()=>{
  const c=fixture('<p>Start <strong>bold</strong> <a href="#x">link</a> <code>code</code> 👩🏽‍💻 é end</p>');
  const original=c.innerHTML; const exact=c.textContent.slice(3,-4);
  const anchor=await createPositionedAnchor(selection(c,exact),c,'source');
  highlightSearchMatches(c,'bold link');
  const result=resolveAnchor(anchor,c,await prepareAnnotationDocument(c,'source'));
  assert.equal(result.range.toString(),exact); wrapRange(result.range,'annotation-highlight-yellow','h');
  clearSearchHighlights(c); assert.equal(c.textContent,fixture(original).textContent);
  clearAnnotationHighlights(c); assert.equal(c.innerHTML,original);
});
test('unsupported SVG/hidden math cannot be selected or painted; HTML labels and visual math can',async()=>{
  const c=fixture('<svg><text>SVG label</text><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">HTML label</div></foreignObject></svg><p>Before <span class="katex-mathml">hidden</span><span class="katex-html">visible</span> after</p>');
  const bad=document.createRange();bad.selectNodeContents(c.querySelector('text'));
  assert.equal(createAnchor(bad,c),null);
  const mixed=document.createRange();mixed.selectNodeContents(c.querySelector('p')); assert.equal(createAnchor(mixed,c),null);
  for(const text of ['HTML label','visible']) {
    const anchor=await createPositionedAnchor(selection(c,text),c,'source');
    const result=resolveAnchor(anchor,c,await prepareAnnotationDocument(c,'source'));
    wrapRange(result.range,'annotation-highlight-yellow',text);
  }
  assert.ok(!c.querySelector('text mark'));assert.ok(!c.querySelector('.katex-mathml mark'));
  assert.equal(c.querySelectorAll('mark').length,2);
});
test('search spans marks and inline nodes but not separate blocks; Unicode case folding keeps DOM text intact',()=>{
  const c=fixture('<p>Alpha <em>beta</em> gamma İ i</p><p>delta</p>');const text=c.textContent;
  assert.equal(highlightSearchMatches(c,'Alpha beta').length,1);clearSearchHighlights(c);
  assert.equal(highlightSearchMatches(c,'gamma İ').length,1);clearSearchHighlights(c);
  assert.equal(highlightSearchMatches(c,'i').length,1);clearSearchHighlights(c);
  assert.equal(highlightSearchMatches(c,'i delta').length,0);assert.equal(c.textContent,text);
});
