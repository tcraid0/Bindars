const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { flushSync } = require('./_helpers/react.cjs');
const { installDom } = require('./_helpers/dom.cjs');
const { findEditorView } = require('./_helpers/codemirror.cjs');
const { EditorSelection, EditorState, StateEffect } = require('@codemirror/state');
const { forceParsing } = require('@codemirror/language');
const { undo, redo, undoDepth } = require('@codemirror/commands');
const commands = require('../.tmp/workspace-tests/src/components/markdown-formatting-commands.js');
const { markdownGfmParser } = require('../.tmp/workspace-tests/src/components/markdown-decorations.js');
const { createView, useSpec } = require('./_helpers/markdown-command-view.cjs');
function key(target, key, options = {}) {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  flushSync(() => target.dispatchEvent(event));
  return event;
}
async function frame() { await act(async () => { await new Promise(resolve => window.requestAnimationFrame(resolve)); }); }
async function render(source = 'alpha beta', extra = {}, { strict = false } = {}) {
  await installDom();
  const { MarkdownEditor } = require('../.tmp/workspace-tests/src/components/MarkdownEditor.js');
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host), ref = React.createRef(), refusals = [], publications = [];
  let props = { buffer: source, fileType: 'markdown', markdownFormattingEnabled: true,
    settings: {contentWidth:65,fontSize:18,lineHeight:1.6,fontFamily:'newsreader'}, saveError:null,
    canSaveAsAfterError:false, onBufferChange(value) { publications.push(value); return true; },
    onFormattingRefusal: reason => refusals.push(reason), onSaveAsAfterError() {}, onDismissSaveError() {}, ...extra };
  const draw = () => flushSync(() => { const editor = React.createElement(MarkdownEditor, {...props, ref}); root.render(strict ? React.createElement(React.StrictMode, null, editor) : editor); });
  draw(); await frame();
  const view = findEditorView(host);
  return { host, ref, view, refusals, publications, rerender(update) { props = {...props,...update}; draw(); },
    button(label) { return [...host.querySelectorAll('button')].find(b => b.textContent.trim() === label || b.getAttribute('aria-label') === label || b.querySelector('span')?.textContent === label); },
    click(label) { const b = this.button(label); assert.ok(b, label); flushSync(() => b.click()); return b; },
    cleanup() { flushSync(() => root.unmount()); host.remove(); } };
}

test('toolbar pointer command retains reversed selection, focus, history and the single publication path', async () => {
  const r = await render();
  try {
    r.view.dispatch({selection:EditorSelection.single(10,6)});
    const bold = r.button('Bold');
    const down = new window.MouseEvent('mousedown',{bubbles:true,cancelable:true});
    bold.dispatchEvent(down); assert.equal(down.defaultPrevented,true);
    r.click('Bold');
    assert.equal(r.view.state.doc.toString(),'alpha **beta**');
    assert.equal(r.view.state.selection.main.anchor,12); assert.equal(r.view.state.selection.main.head,8);
    assert.ok(document.activeElement === r.view.contentDOM); assert.equal(undoDepth(r.view.state),1);
    assert.deepEqual(r.publications,[]);
    r.rerender({markdownFormattingEnabled:false,saveError:'Disk full'});
    assert.ok(findEditorView(r.host) === r.view); assert.equal(r.ref.current.flushPendingChanges(),true);
    assert.deepEqual(r.publications,['alpha **beta**']);
    assert.ok(undo(r.view)); assert.equal(r.view.state.doc.toString(),'alpha beta');
    assert.ok(redo(r.view)); assert.equal(r.view.state.doc.toString(),'alpha **beta**');
  } finally { r.cleanup(); }
});

test('toolbar is one tab stop, arrow navigation wraps, Alt-F10 enters, and Escape returns to editor', async () => {
  const r = await render();
  try {
    assert.equal(r.host.querySelectorAll('[role="toolbar"] [tabindex="0"]').length,1);
    const event = key(r.view.contentDOM,'F10',{altKey:true}); assert.equal(event.defaultPrevented,true);
    const first = document.activeElement; assert.match(first.textContent,/Paragraph/);
    const order = ['Paragraph ⌄', 'Bold', 'Bullets', 'Numbered', 'Checklist', 'More ⌄', 'Styled'];
    assert.deepEqual([...r.host.querySelectorAll('[data-toolbar-item]')].map(b => b.textContent.trim()), order);
    for (const expected of order.slice(1)) {
      key(document.activeElement, 'ArrowRight'); assert.equal(document.activeElement.textContent.trim(), expected);
      assert.equal(r.host.querySelectorAll('[role="toolbar"] [tabindex="0"]').length, 1);
    }
    key(document.activeElement, 'ArrowRight'); assert.ok(document.activeElement === first);
    key(first,'ArrowLeft'); assert.equal(document.activeElement.textContent,'Styled');
    key(document.activeElement,'ArrowRight'); assert.ok(document.activeElement === first);
    key(first,'Tab'); assert.equal(r.view.state.doc.toString(),'alpha beta');
    const escape = key(first,'Escape'); assert.equal(escape.defaultPrevented,true);
    assert.ok(document.activeElement === r.view.contentDOM);
  } finally { r.cleanup(); }
});

test('vertical arrows open the focused style or More menu', async () => {
  const r = await render();
  try {
    for (const arrow of ['ArrowDown', 'ArrowUp']) {
      for (const [label, menu] of [['Text style: Paragraph', 'Text style'], ['More ⌄', 'More formatting']]) {
        flushSync(() => r.button(label).focus());
        assert.equal(key(document.activeElement, arrow).defaultPrevented, true);
        assert.equal(r.host.querySelector('[role="menu"]').getAttribute('aria-label'), menu);
        assert.ok(r.host.querySelector('[role="menu"]').contains(document.activeElement));
        key(document.activeElement, 'Escape');
        assert.ok(document.activeElement === r.button(label));
      }
    }
    assert.doesNotMatch(r.host.textContent, /Formatting is checked when applied/);
    flushSync(() => r.ref.current.beginLink());
    assert.match(r.host.querySelector('form').textContent, /Link to/);
    assert.ok(r.button('Add link'));
  } finally { r.cleanup(); }
});

test('menus focus items, expose completed actions and consume Escape before edit-exit handlers', async () => {
  const r = await render();
  let bubbled = 0; const onKey = e => { if (!e.defaultPrevented && e.key === 'Escape') bubbled++; };
  window.addEventListener('keydown',onKey);
  try {
    r.click('More ⌄');
    assert.deepEqual([...r.host.querySelectorAll('[role="menu"] button > span')].map(e=>e.textContent),['Italic','Link','Quote','Divider','Indent more','Indent less','Mark done']);
    assert.equal(document.activeElement.textContent.startsWith('Italic'),true);
    key(document.activeElement,'ArrowUp'); assert.equal(document.activeElement.textContent.startsWith('Mark done'),true);
    key(document.activeElement,'Escape'); assert.equal(bubbled,0);
    assert.ok(r.host.querySelector('[role="menu"]') === null);
    assert.ok(document.activeElement === r.button('More ⌄'));
    r.click('Checklist'); assert.equal(r.view.state.doc.toString(),'- [ ] alpha beta');
    assert.ok(document.activeElement === r.view.contentDOM);
  } finally { window.removeEventListener('keydown',onKey); r.cleanup(); }
});

test('link form fills selection, supports keyboard cancel and retires replacements even on unchanged editor state', async () => {
  const forms = [];
  const r = await render();
  try {
    r.view.dispatch({selection:{anchor:6,head:10}});
    // Observe bridge tokens directly as a stale form's delayed submit would.
    const { CodeMirrorEditor } = require('../.tmp/workspace-tests/src/components/CodeMirrorEditor.js');
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); const ref = React.createRef();
    flushSync(() => root.render(React.createElement(CodeMirrorEditor,{ref,initialDocument:'beta',fileType:'markdown',markdownFormattingEnabled:true,
      onBufferChange(){return true;},onLinkFormChange:form=>forms.push(form)})));
    try {
      flushSync(()=>ref.current.beginLink()); const a = forms.at(-1); const view = findEditorView(host); const state = view.state;
      flushSync(()=>ref.current.beginLink()); const b = forms.at(-1); assert.notEqual(a.id,b.id); assert.equal(view.state,state);
      const stale = ref.current.applyLink(a.id,{label:'beta',destination:'https://example.com'});
      assert.equal(stale.applied,false); assert.match(stale.reason,/Open Link again/); assert.equal(view.state,state);
      flushSync(()=>ref.current.cancelLink(b.id)); assert.equal(ref.current.applyLink(b.id,{label:'x',destination:'#x'}).applied,false);
    } finally { flushSync(()=>root.unmount()); host.remove(); }
    flushSync(()=>r.ref.current.beginLink());
    assert.equal(r.host.querySelector('[name="label"]').value,'beta');
    assert.equal(document.activeElement.name,'destination');
    key(document.activeElement,'Escape'); assert.ok(r.host.querySelector('form') === null);
    assert.equal(r.view.state.doc.toString(),'alpha beta'); assert.deepEqual([r.view.state.selection.main.anchor,r.view.state.selection.main.head],[6,10]);
    assert.ok(document.activeElement === r.view.contentDOM);
    flushSync(()=>r.ref.current.beginLink());
    const form = r.host.querySelector('form');
    // React's controlled input setter is exercised through the form's change event.
    const field = form.querySelector('[name="destination"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    setter.call(field,'https://example.com');
    flushSync(()=>field.dispatchEvent(new window.Event('input',{bubbles:true})));
    form.dispatchEvent(new window.CompositionEvent('compositionstart',{bubbles:true}));
    flushSync(()=>form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
    assert.equal(r.view.state.doc.toString(),'alpha beta');assert.match(form.querySelector('[role="alert"]').textContent,/composition/);assert.deepEqual(r.refusals,[]);
    form.dispatchEvent(new window.CompositionEvent('compositionend',{bubbles:true}));
    flushSync(()=>form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
    assert.equal(r.view.state.doc.toString(),'alpha [beta](<https://example.com>)');
    assert.ok(document.activeElement === r.view.contentDOM); assert.equal(undoDepth(r.view.state),1);
  } finally { r.cleanup(); }
});

test('shared shortcut, beforeinput and pointer refusals consume input and report without changing history', async () => {
  const r = await render('`code`');
  try {
    r.view.dispatch({selection:{anchor:3}});
    const original = r.view.state;
    assert.equal(key(r.view.contentDOM,'b',{ctrlKey:true}).defaultPrevented,true);
    assert.equal(key(r.view.contentDOM,'i',{ctrlKey:true}).defaultPrevented,true);
    const native = new window.InputEvent('beforeinput',{inputType:'formatBold',bubbles:true,cancelable:true});
    r.view.contentDOM.dispatchEvent(native); assert.equal(native.defaultPrevented,true);
    r.click('Bold');
    assert.equal(r.view.state,original); assert.equal(undoDepth(r.view.state),0);
    assert.equal(r.refusals.length,4); assert.ok(r.refusals.every(reason=>reason===r.refusals[0]));
    assert.match(r.refusals[0],/code/);
    const search = key(r.view.contentDOM,'k',{ctrlKey:true}); assert.equal(search.defaultPrevented,false);
    const tab = key(r.view.contentDOM,'Tab'); assert.equal(tab.defaultPrevented,false);
    assert.deepEqual(r.publications,[]);
  } finally { r.cleanup(); }
});

test('composition, multi-selection and readonly guards apply to the bridge; Fountain exposes no controls', async () => {
  const r = await render();
  try {
    r.view.contentDOM.dispatchEvent(new window.CompositionEvent('compositionstart',{bubbles:true}));
    const source = r.view.state.doc;
    r.click('Bold'); assert.equal(r.view.state.doc,source); assert.match(r.refusals.at(-1),/composition/);
    r.view.contentDOM.dispatchEvent(new window.CompositionEvent('compositionend',{bubbles:true}));
    r.view.dispatch({selection:EditorSelection.create([EditorSelection.cursor(1),EditorSelection.cursor(8)])});
    r.click('Bullets'); assert.equal(r.view.state.doc,source); assert.match(r.refusals.at(-1),/one selection/);
    r.view.dispatch({effects:StateEffect.appendConfig.of(EditorState.readOnly.of(true))});
    r.click('More ⌄'); r.click('Divider'); assert.equal(r.view.state.doc,source); assert.match(r.refusals.at(-1),/cannot be edited/);
  } finally { r.cleanup(); }
  const fountain = await render('INT. ROOM - DAY',{fileType:'fountain'});
  try { assert.ok(fountain.host.querySelector('[role="toolbar"]') === null); assert.equal(fountain.ref.current.executeFormatting('bold'),null); }
  finally { fountain.cleanup(); }
});

test('external adoption invalidates pending link and feedback without publication or an editor remount', async () => {
  const r = await render();
  try {
    flushSync(()=>r.ref.current.beginLink()); assert.ok(r.host.querySelector('form'));
    flushSync(()=>assert.equal(r.ref.current.adoptExternalDocument('alpha beta','###### Six'),true));
    assert.ok(r.host.querySelector('form') === null); await frame();
    assert.ok(findEditorView(r.host) === r.view); assert.equal(r.view.state.doc.toString(),'###### Six');
    assert.match(r.host.querySelector('[role="toolbar"]').textContent,/Heading 6/); assert.deepEqual(r.publications,[]);
    r.click('More ⌄'); assert.ok(r.host.querySelector('[role="menu"]'));
    flushSync(()=>assert.equal(r.ref.current.adoptExternalDocument('###### Six','###### Replacement'),true));
    assert.ok(!r.host.querySelector('[role="menu"]')); assert.ok(document.activeElement === r.button('More ⌄'));
  } finally { r.cleanup(); }
});

test('cold, after-edit and large-selection feedback does no planning, reader parse or forced parser work', async t => {
  await installDom();
  const { unified } = await import('unified');
  for (const source of ['word\n\n$$x$$\n\n'.repeat(3000),'~first\nsecond~\n'.repeat(6000)]) {
    const host = createView(source,EditorSelection.cursor(2),{parse:false});
    try {
      const parse = t.mock.method(Object.getPrototypeOf(unified()),'parse');
      const ensure = t.mock.method(require('@codemirror/language'),'ensureSyntaxTree');
      const update = t.mock.method(EditorState.prototype,'update');
      const full = t.mock.method(markdownGfmParser,'parse');
      for (let i=0;i<10;i++) commands.formattingToolbarState(host.view.state);
      const edited = host.view.state.update({changes:{from:0,insert:'new '}}).state;
      const selected = edited.update({selection:EditorSelection.single(0,edited.doc.length)}).state;
      update.mock.resetCalls();
      for (const state of [edited,selected]) for(let i=0;i<10;i++) commands.formattingToolbarState(state);
      assert.equal(parse.mock.callCount(),0); assert.equal(ensure.mock.callCount(),0);
      assert.equal(full.mock.callCount(),0); assert.equal(update.mock.callCount(),0);
      parse.mock.restore(); ensure.mock.restore(); update.mock.restore(); full.mock.restore();
    } finally { host.destroy(); }
  }
});

test('feedback derives known context and represents unsupported or unknown state honestly', async () => {
  await installDom();
  useSpec('**wo|rd**',{},view=>assert.equal(commands.formattingToolbarState(view.state).commands.bold.active,true));
  for (const spec of ['###### Si|x','###### Six|','###### Six|\n\nbody']) useSpec(spec,{},view=>assert.equal(commands.formattingToolbarState(view.state).headingLevel,6));
  useSpec('`co|de`',{},view=>assert.match(commands.formattingToolbarState(view.state).commands.bold.reason,/code/));
  useSpec('---\na: |b\n---',{},view=>assert.match(commands.formattingToolbarState(view.state).commands.quote.reason,/details/));
  useSpec('[[first\n\nsecond]]',{},view=>assert.equal(commands.formattingToolbarState(view.state).commands.bold.active,null));
});

test('mounted feedback coalesces and emits only changed snapshots independently of publication', async () => {
  await installDom();
  const { CodeMirrorEditor } = require('../.tmp/workspace-tests/src/components/CodeMirrorEditor.js');
  const host = document.createElement('div'); document.body.append(host); const root=createRoot(host), snapshots=[], publications=[];
  flushSync(()=>root.render(React.createElement(CodeMirrorEditor,{initialDocument:'alpha beta\n\n**bold**',fileType:'markdown',markdownFormattingEnabled:true,
    onFormattingState:s=>snapshots.push(s),onBufferChange:s=>{publications.push(s);return true;}})));
  try {
    const view=findEditorView(host); await frame(); const initial=snapshots.length;
    view.dispatch({selection:{anchor:1}}); view.dispatch({selection:{anchor:2}}); view.dispatch({selection:{anchor:3}});
    await frame(); assert.equal(snapshots.length,initial); assert.equal(publications.length,0);
    view.dispatch({selection:{anchor:16}}); await frame(); assert.equal(snapshots.length,initial+1);
    assert.equal(snapshots.at(-1).commands.bold.active,true);
    view.dispatch({changes:{from:16,insert:'x'}}); await frame(); assert.equal(publications.length,0);
  } finally {flushSync(()=>root.unmount());host.remove();}
});

test('Styled marks keep source characters and navigation intact, and Plain removes all added decorations', async () => {
  const source = '# Heading\n\n**Strong** and *italic*\n\n10. numbered item\n    continued\n\n* * *\n';
  const r = await render(source);
  try {
    forceParsing(r.view,r.view.state.doc.length,2000); await frame();
    assert.equal(r.view.contentDOM.textContent.replace(/\n/g,''),source.replace(/\n/g,''));
    assert.ok(r.host.querySelector('.cm-md-strong')); assert.ok(r.host.querySelector('.cm-md-emphasis'));
    assert.ok(r.host.querySelector('.cm-md-divider')); assert.ok(r.host.querySelector('.cm-md-h1'));
    assert.match(r.host.querySelector('.cm-md-list-line').getAttribute('style'),/padding-left: 4ch; text-indent: -4ch/);
    const at=source.indexOf('Strong'); r.view.dispatch({selection:{anchor:at}}); key(r.view.contentDOM,'ArrowRight');
    assert.equal(r.view.state.selection.main.head,at+1);
    const selection=r.view.state.selection;
    r.rerender({markdownFormattingEnabled:false}); await frame();
    for(const cls of ['strong','emphasis','divider','list-line','h1','marker']) assert.ok(r.host.querySelector(`.cm-md-${cls}`) === null,cls);
    assert.equal(r.view.state.doc.toString(),source); assert.equal(r.view.state.selection,selection); assert.equal(undoDepth(r.view.state),0);
  } finally {r.cleanup();}
});

test('link intent is retired by path changes and unmount without stealing focus', async t => {
  await installDom();
  const captured=[]; const original=commands.beginLinkCommand;
  t.mock.method(commands,'beginLinkCommand',(...args)=>{const result=original(...args);captured.push(result.intent);return result;});
  const r=await render('plain',{filePath:'/work/a.md'});
  try {
    flushSync(()=>r.ref.current.beginLink()); const first=captured.at(-1);
    r.rerender({filePath:'/work/b.md'});
    assert.ok(r.host.querySelector('form') === null);
    assert.equal(commands.applyLinkCommand(r.view,first,{label:'x',destination:'#x'},first.context).applied,false);
    flushSync(()=>r.ref.current.beginLink()); const second=captured.at(-1);
    r.cleanup();
    assert.equal(commands.applyLinkCommand(r.view,second,{label:'x',destination:'#x'},second.context).applied,false);
  } finally {if(r.host.isConnected)r.cleanup();}
});

test('list shortcut refusal uses the toolbar reporting path and ordinary indentation stays available', async () => {
  const r=await render('- first\n- second');
  try {
    r.view.dispatch({selection:{anchor:3}});
    const original=r.view.state;
    assert.equal(key(r.view.contentDOM,']',{ctrlKey:true}).defaultPrevented,true);
    assert.equal(r.view.state,original); assert.match(r.refusals.at(-1),/preceding sibling/i);
    const reason=r.refusals.at(-1); r.click('More ⌄');r.click('Indent more');assert.equal(r.refusals.at(-1),reason);
  } finally {r.cleanup();}
  const plain=await render('plain');
  try {key(plain.view.contentDOM,']',{ctrlKey:true});assert.equal(plain.view.state.doc.toString(),'  plain');}
  finally {plain.cleanup();}
});

test('feedback invalidates for composition without publishing or changing the document', async () => {
  const r = await render('alpha');
  try {
    r.view.dispatch({selection:{anchor:2}});await frame();
    r.view.contentDOM.dispatchEvent(new window.CompositionEvent('compositionstart',{bubbles:true}));await frame();
    assert.match(r.button('Bold').getAttribute('title'),/composition/);
    r.view.contentDOM.dispatchEvent(new window.CompositionEvent('compositionend',{bubbles:true}));await frame();await frame();
    assert.doesNotMatch(r.button('Bold').getAttribute('title'),/composition/);
    assert.equal(r.view.state.doc.toString(),'alpha');assert.deepEqual(r.publications,[]);
  } finally {r.cleanup();}
});

test('available parse progress refreshes previously unknown heading feedback without planning', async () => {
  const source='ordinary paragraph\n\n'.repeat(20000)+'###### Target';
  const r=await render(source);
  try {
    const pos=source.length-2;
    r.view.dispatch({selection:{anchor:pos}});await frame();
    forceParsing(r.view,r.view.state.doc.length,10000);await frame();
    assert.match(r.host.querySelector('[role="toolbar"]').textContent,/Heading 6/);
    assert.equal(r.view.state.doc.toString(),source);assert.deepEqual(r.publications,[]);
  } finally {r.cleanup();}
});


function inputField(field, value) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(field, value);
  flushSync(() => field.dispatchEvent(new window.Event('input', { bubbles: true })));
}
function submitForm(form) { flushSync(() => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))); }

test('Link pointer actions survive the macOS non-focusable-button mouse sequence', async () => {
  const r = await render('alpha beta');
  r.host.tabIndex = -1;
  // WKWebView can focus the enclosing Document instead of the clicked button.
  // Model that default only when mousedown allows it; jsdom has no native default.
  const pointerClick = button => {
    flushSync(() => {
      button.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
      button.dispatchEvent(down);
      if (!down.defaultPrevented) r.host.focus();
    });
    if (button.isConnected) flushSync(() => button.click());
  };
  try {
    r.view.dispatch({ selection: EditorSelection.single(10, 6) });
    flushSync(() => r.ref.current.beginLink());
    inputField(r.host.querySelector('[name="destination"]'), 'https://example.com/pointer');
    pointerClick(r.button('Add link'));
    assert.equal(r.view.state.sliceDoc(), 'alpha [beta](<https://example.com/pointer>)');
    assert.equal(undoDepth(r.view.state), 1);
    assert.ok(document.activeElement === r.view.contentDOM);
    flushSync(() => undo(r.view));
    assert.equal(r.view.state.sliceDoc(), 'alpha beta');
    flushSync(() => r.ref.current.beginLink());
    inputField(r.host.querySelector('[name="destination"]'), '#cancelled');
    pointerClick(r.button('Cancel'));
    assert.ok(!r.host.querySelector('form'));
    assert.equal(r.view.state.sliceDoc(), 'alpha beta');
    assert.deepEqual([r.view.state.selection.main.anchor, r.view.state.selection.main.head], [10, 6]);
    assert.ok(document.activeElement === r.view.contentDOM);
  } finally { r.cleanup(); }
});

test('typed Link draft survives Styled click-through, harmless effects and parse publication, then applies to its original selection', async () => {
  const source='label\n\n'+('ordinary study paragraph\n\n'.repeat(9500));
  let toggles=0;
  const r=await render(source);
  try {
    r.rerender({onToggleMarkdownFormatting() { toggles++; r.rerender({markdownFormattingEnabled:false}); }});
    r.view.dispatch({selection:EditorSelection.single(5,0)});
    flushSync(()=>r.ref.current.beginLink());
    const form=r.host.querySelector('form'), label=form.querySelector('[name="label"]'), destination=form.querySelector('[name="destination"]');
    inputField(label,'A typed label'); inputField(destination,'https://example.com/typed');
    const doc=r.view.state.doc, selection=r.view.state.selection;
    const styled=r.button('Toggle markup formatting');
    // The real control click invokes the preference callback. Its pointerdown
    // is also used, to catch outside-dismissal before the click handler runs.
    flushSync(()=>styled.dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true,button:0})));
    r.click('Toggle markup formatting');
    assert.equal(toggles,1); assert.ok(r.host.querySelector('form') === form);
    const harmless=StateEffect.define();
    flushSync(()=>r.view.dispatch({effects:harmless.of('unchanged target')}));
    flushSync(()=>forceParsing(r.view,r.view.state.doc.length,10000));await frame();
    assert.ok(r.view.state.doc === doc);assert.ok(r.view.state.selection === selection);
    assert.ok(r.host.querySelector('form') === form);
    assert.equal(label.value,'A typed label');assert.equal(destination.value,'https://example.com/typed');
    assert.ok(document.activeElement === destination);
    submitForm(form);
    assert.equal(r.view.state.sliceDoc(),'[A typed label](<https://example.com/typed>)'+source.slice(5));
    assert.equal(undoDepth(r.view.state),1);assert.ok(document.activeElement === r.view.contentDOM);
    assert.deepEqual(r.publications,[]);r.ref.current.flushPendingChanges();assert.equal(r.publications.length,1);
    undo(r.view);assert.equal(r.view.state.sliceDoc(),source);
  } finally {r.cleanup();}
});

test('development Strict Mode preserves a newly opened Link form and typed input', async () => {
  const r=await render('label',{}, {strict:true});
  try {
    r.view.dispatch({selection:{anchor:0,head:5}});flushSync(()=>r.ref.current.beginLink());await frame();
    const form=r.host.querySelector('form');assert.ok(form,'Strict Mode must not dismiss the new form');
    inputField(form.querySelector('[name="destination"]'),'https://example.com/strict');
    r.rerender({saveError:'Disk full'});await frame();assert.ok(r.host.querySelector('form') === form);
    submitForm(form);assert.equal(r.view.state.sliceDoc(),'[label](<https://example.com/strict>)');
    assert.equal(undoDepth(r.view.state),1);assert.ok(document.activeElement === r.view.contentDOM);
  } finally {r.cleanup();}
});

test('a live Link form reports validation once inline and preserves fields during composition', async () => {
  const r=await render('label');
  try {
    r.view.dispatch({selection:{anchor:0,head:5}});flushSync(()=>r.ref.current.beginLink());
    const form=r.host.querySelector('form'), destination=form.querySelector('[name="destination"]');
    inputField(destination,'javascript:bad');submitForm(form);
    assert.ok(form.querySelector('[role="alert"]'));assert.match(form.textContent,/Enter an http/);
    assert.deepEqual(r.refusals,[],'form validation must not also emit a toast');
    inputField(destination,'https://example.com');
    form.dispatchEvent(new window.CompositionEvent('compositionstart',{bubbles:true}));submitForm(form);
    assert.ok(r.host.querySelector('form') === form);assert.equal(destination.value,'https://example.com');
    assert.match(form.querySelector('[role="alert"]').textContent,/composition/);assert.deepEqual(r.refusals,[]);
    form.dispatchEvent(new window.CompositionEvent('compositionend',{bubbles:true}));submitForm(form);
    assert.equal(r.view.state.sliceDoc(),'[label](<https://example.com>)');assert.deepEqual(r.refusals,[]);
  } finally {r.cleanup();}
});

test('genuine Link target changes retire permanently through selection restoration and Undo', async () => {
  const r=await render('label');
  const captured=[];const original=commands.beginLinkCommand;
  // The existing bridge calls the command module; capture its opaque intent
  // only to assert permanent retirement rather than merely a hidden form.
  commands.beginLinkCommand=(...args)=>{const result=original(...args);captured.push(result.intent);return result;};
  try {
    r.view.dispatch({selection:{anchor:0,head:5}});const selection=r.view.state.selection;
    flushSync(()=>r.ref.current.beginLink());const a=captured.at(-1);
    flushSync(()=>r.view.dispatch({selection:{anchor:1}}));flushSync(()=>r.view.dispatch({selection}));
    assert.ok(!r.host.querySelector('form'));
    assert.equal(commands.applyLinkCommand(r.view,a,{label:'x',destination:'#x'},a.context).applied,false);
    flushSync(()=>r.ref.current.beginLink());const b=captured.at(-1);
    flushSync(()=>r.view.dispatch({changes:{from:r.view.state.doc.length,insert:'x'}}));flushSync(()=>undo(r.view));
    assert.equal(r.view.state.sliceDoc(),'label');assert.ok(!r.host.querySelector('form'));
    assert.equal(commands.applyLinkCommand(r.view,b,{label:'x',destination:'#x'},b.context).applied,false);
    assert.equal(undoDepth(r.view.state),0);
  } finally {commands.beginLinkCommand=original;r.cleanup();}
});

test('Link Apply rechecks live read-only state without discarding its draft', async () => {
  const {Compartment}=require('@codemirror/state');const readonly=new Compartment();
  const r=await render('label');
  try {
    r.view.dispatch({effects:StateEffect.appendConfig.of(readonly.of(EditorState.readOnly.of(false))),selection:{anchor:0,head:5}});
    flushSync(()=>r.ref.current.beginLink());const form=r.host.querySelector('form');inputField(form.querySelector('[name="destination"]'),'#section');
    flushSync(()=>r.view.dispatch({effects:readonly.reconfigure(EditorState.readOnly.of(true))}));
    assert.ok(r.host.querySelector('form') === form);submitForm(form);assert.equal(r.view.state.sliceDoc(),'label');assert.match(form.textContent,/cannot be edited/);assert.deepEqual(r.refusals,[]);
    flushSync(()=>r.view.dispatch({effects:readonly.reconfigure(EditorState.readOnly.of(false))}));
    submitForm(form);assert.equal(r.view.state.sliceDoc(),'[label](<#section>)');
  } finally {r.cleanup();}
});

test('More exposes known Italic and Quote states, and leaves unknown state unclaimed', async () => {
  for(const [source,pos,label] of [['*word*',2,'Italic'],['> quote',4,'Quote']]){
    const r=await render(source);
    try {
      r.view.dispatch({selection:{anchor:pos}});await frame();r.click('More ⌄');
      const item=r.button(label);assert.equal(item.getAttribute('role'),'menuitemcheckbox');assert.equal(item.getAttribute('aria-checked'),'true');
      assert.ok(item.querySelector('[aria-hidden="true"]'),'known active state has a visible check');
      for(const plain of ['Link','Indent more','Indent less']) {assert.equal(r.button(plain).getAttribute('role'),'menuitem');assert.equal(r.button(plain).getAttribute('aria-checked'),null);}
    } finally {r.cleanup();}
  }
  const r=await render('plain\n\n*italic*');
  try {r.view.dispatch({selection:EditorSelection.single(0,r.view.state.doc.length)});await frame();r.click('More ⌄');assert.equal(r.button('Italic').getAttribute('aria-checked'),null);}
  finally {r.cleanup();}
});

test('inconclusive bounded metadata feedback stays unknown without doing authoritative work', async t => {
  await installDom();const {unified}=await import('unified');
  const source=['---',...Array.from({length:48},(_,i)=>`field${i}: value`),'---','','body'].join('\n');
  const pos=source.indexOf('field38')+4;
  const host=createView(source,EditorSelection.cursor(pos),{});
  try {
    const parse=t.mock.method(Object.getPrototypeOf(unified()),'parse'),ensure=t.mock.method(require('@codemirror/language'),'ensureSyntaxTree');
    const snapshot=commands.formattingToolbarState(host.view.state);assert.equal(snapshot.commands.bold.available,true);
    assert.equal(snapshot.commands.bold.active,null);assert.equal(snapshot.headingLevel,null);
    assert.equal(parse.mock.callCount(),0);assert.equal(ensure.mock.callCount(),0);
    parse.mock.restore();ensure.mock.restore();
    assert.equal(commands.applyEmphasisCommand(host.view,'bold').applied,false);
    assert.equal(commands.formattingToolbarState(host.view.state).commands.bold.available,false);
  } finally {host.destroy();}
});

test('Styled list hanging columns include authored marker and task spacing', async () => {
  for(const [source,column] of [['-  ',3],['10.  ',5],['-  double space item',3],['10.  double space item',5],['-  [x]   finished task',9],['  10.  [ ]  nested task',12]]){
    const r=await render(source);
    try {forceParsing(r.view,r.view.state.doc.length,2000);await frame();const line=r.host.querySelector('.cm-md-list-line');assert.ok(line,source);assert.match(line.getAttribute('style'),new RegExp(`padding-left: ${column}ch; text-indent: -${column}ch`),source);assert.equal(r.view.state.sliceDoc(),source);assert.equal(undoDepth(r.view.state),0);}
    finally {r.cleanup();}
  }
});

test('formatting shortcuts share the button path from toolbar/menu buttons, leaving Link text inputs alone', async () => {
  const r=await render('alpha');
  try {
    r.view.dispatch({selection:{anchor:2}});flushSync(()=>r.button('Bold').focus());assert.equal(key(document.activeElement,'b',{ctrlKey:true}).defaultPrevented,true);assert.equal(r.view.state.sliceDoc(),'**alpha**');
    r.click('More ⌄');assert.equal(key(document.activeElement,'i',{ctrlKey:true}).defaultPrevented,true);assert.equal(r.view.state.sliceDoc(),'***alpha***');
    flushSync(()=>{undo(r.view);undo(r.view);});flushSync(()=>r.ref.current.beginLink());const field=r.host.querySelector('[name="label"]');flushSync(()=>field.focus());
    assert.equal(key(field,'b',{ctrlKey:true}).defaultPrevented,false);assert.equal(r.view.state.sliceDoc(),'alpha');
    assert.equal(key(field,'i',{ctrlKey:true,isComposing:true}).defaultPrevented,false);assert.ok(r.host.querySelector('form'));
  } finally {r.cleanup();}
});


test('real form unmount retires its intent with the editor still mounted; replay and replacements do not', async t => {
  await installDom();
  const {CodeMirrorEditor}=require('../.tmp/workspace-tests/src/components/CodeMirrorEditor.js');
  const {MarkdownFormattingToolbar}=require('../.tmp/workspace-tests/src/components/MarkdownFormattingToolbar.js');
  const original=commands.beginLinkCommand,captured=[];
  t.mock.method(commands,'beginLinkCommand',(...args)=>{const result=original(...args);captured.push(result.intent);return result;});
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host),ref=React.createRef(),toolbarRef=React.createRef();
  function Session({show}){
    const [form,setForm]=React.useState(null);
    return React.createElement(React.Fragment,null,
      React.createElement(CodeMirrorEditor,{ref,initialDocument:'label',fileType:'markdown',markdownFormattingEnabled:true,onBufferChange(){return true;},onLinkFormChange:setForm}),
      show && React.createElement(MarkdownFormattingToolbar,{editorRef:ref,toolbarRef,state:null,linkForm:form,styled:true,adoption:0,onToggleStyled(){}}));
  }
  const draw=show=>flushSync(()=>root.render(React.createElement(React.StrictMode,null,React.createElement(Session,{show}))));
  try {
    draw(true);flushSync(()=>ref.current.beginLink());await frame();assert.ok(host.querySelector('form'));const intent=captured.at(-1),view=findEditorView(host);
    await act(async()=>draw(false));assert.ok(!host.querySelector('form'));assert.ok(findEditorView(host) === view);
    assert.equal(commands.applyLinkCommand(view,intent,{label:'x',destination:'#x'},intent.context).applied,false);
    assert.equal(view.state.sliceDoc(),'label');assert.equal(undoDepth(view.state),0);
  } finally {await act(async()=>{root.unmount();});host.remove();}
});

test('Find remains explicit draft dismissal and focuses its existing search field', async () => {
  const r=await render('label');
  try {
    flushSync(()=>r.ref.current.beginLink());const field=r.host.querySelector('[name="label"]');inputField(field,'Typed draft');
    flushSync(()=>r.ref.current.find());await frame();assert.ok(!r.host.querySelector('form[aria-label="Insert link"]'));
    assert.equal(document.activeElement.name,'search');assert.equal(r.view.state.sliceDoc(),'label');assert.equal(undoDepth(r.view.state),0);
  } finally {r.cleanup();}
});

test('More completes one task in Styled and Plain, switches its action label, and restores writing focus', async () => {
  for (const styled of [true, false]) {
    const r = await render('- [ ] original\n- [X] neighbour', { markdownFormattingEnabled: styled });
    try {
      r.view.dispatch({ selection: { anchor: 3 } }); await frame();
      r.click('More ⌄');
      const done = r.button('Mark done');
      assert.equal(done.getAttribute('role'), 'menuitem');
      assert.equal(done.getAttribute('aria-checked'), null);
      assert.equal(done.getAttribute('aria-disabled'), 'false');
      flushSync(() => done.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 })));
      assert.equal(r.view.state.sliceDoc(), '- [x] original\n- [X] neighbour');
      assert.ok(document.activeElement === r.view.contentDOM);
      assert.equal(undoDepth(r.view.state), 1); await frame();
      flushSync(() => r.button('More ⌄').focus()); key(document.activeElement, 'ArrowDown');
      const notDone = r.button('Mark not done');
      assert.equal(notDone.getAttribute('role'), 'menuitem');
      assert.equal(notDone.getAttribute('aria-checked'), null);
      key(document.activeElement, 'End'); assert.ok(document.activeElement === notDone);
      // Happy DOM has no native Enter-to-click default; supply that keyboard click.
      key(notDone, 'Enter'); flushSync(() => notDone.click());
      assert.equal(r.view.state.sliceDoc(), '- [ ] original\n- [X] neighbour');
      assert.ok(document.activeElement === r.view.contentDOM);
      assert.equal(undoDepth(r.view.state), 2);
      r.view.dispatch({ selection: { anchor: r.view.state.doc.length } }); await frame();
      r.click('More ⌄'); assert.ok(r.button('Mark not done'));
    } finally { r.cleanup(); }
  }
});

test('More explains unavailable completion and uses the existing refusal path', async () => {
  const r = await render('ordinary words');
  try {
    r.click('More ⌄'); const action = r.button('Mark done');
    assert.equal(action.getAttribute('aria-disabled'), 'true');
    assert.match(action.textContent, /Place the cursor on a checklist item/);
    r.click('Mark done');
    assert.equal(r.refusals.at(-1), 'Place the cursor on a checklist item');
    assert.equal(r.view.state.sliceDoc(), 'ordinary words');
    assert.ok(document.activeElement === r.view.contentDOM); assert.equal(undoDepth(r.view.state), 0);
  } finally { r.cleanup(); }
});

test('list feedback at the end of a line matches what the list commands do', () => {
  const cases = [
    '- [ ] buy milk|\n- [ ] eggs', '- [ ] buy mi|lk\n- [ ] eggs',
    '- [ ] buy milk\n- [ ] eggs|', '- [ ] a\n- [ ] b|\n- [ ] c',
    '- one\n- two|\n- three', '1. one|\n2. two',
    '- [ ] parent\n  - [ ] child|\n- [ ] next', '- [ ] parent|\n  - [ ] child',
    '- [ ] first line\n  second line|\n- [ ] next', '- [ ] first line\nlazy|\n- [ ] next',
    '- [ ] first\n\n  more|\n- [ ] next', '- one\n- |', '- [ ] one\n- [ ] |',
  ];
  for (const spec of cases) for (const command of ['indent', 'outdent', 'checklist', 'bullets', 'numbered']) {
    useSpec(spec, {}, view => {
      const shown = commands.formattingToolbarState(view.state, false).commands[command];
      if (['checklist', 'bullets', 'numbered'].includes(command)) {
        const kind = spec.includes('[ ]') ? 'checklist' : spec.startsWith('1.') ? 'numbered' : 'bullets';
        assert.equal(shown.active, command === kind, spec + command);
        const status = commands.listCommandStatus(view.state, command);
        if (status.available) assert.equal(shown.active, status.active, spec + command);
      }
      const before = view.state.doc;
      const result = commands.executeFormattingCommand(view, command);
      if (!result.applied) assert.equal(view.state.doc, before, spec + command);
      if (!shown.available) assert.equal(result.applied, false, spec + command);
    });
  }
  useSpec('- [ ] buy milk|', {}, view => {
    const shown = commands.formattingToolbarState(view.state, false).commands;
    assert.equal(shown.checklist.active, true);
    assert.equal(shown.indent.available, false);
    assert.match(shown.indent.reason, /preceding sibling/);
    assert.equal(shown.outdent.available, false);
  });
  useSpec('- one\n- two|', {}, view => {
    assert.equal(commands.formattingToolbarState(view.state, false).commands.indent.available, true);
    assert.equal(commands.executeFormattingCommand(view, 'indent').applied, true);
  });
  useSpec('- parent\n  - child|', {}, view => {
    assert.equal(commands.formattingToolbarState(view.state, false).commands.outdent.available, true);
  });
});

test('an empty or blank line after a list greys Indent more and Indent less', () => {
  for (const spec of ['- one\n- two\n|', '- one\n- two\n  |', '- one\n|\n- two', '|']) {
    useSpec(spec, {}, view => {
      for (const command of ['indent', 'outdent']) {
        const shown = commands.formattingToolbarState(view.state, false).commands[command];
        assert.equal(shown.available, false, spec);
        assert.equal(shown.reason, commands.executeFormattingCommand(view, command).reason);
      }
    });
  }
  useSpec('- one\n- two\n' + ' '.repeat(101) + '|', {}, view => {
    assert.equal(commands.formattingToolbarState(view.state, false).commands.indent.available, true);
    assert.equal(commands.executeFormattingCommand(view, 'indent').applied, false);
  });
});

test('the caret before an indented sub-item reads that sub-item', () => {
  useSpec('- parent\n|  - child', {}, view => {
    assert.equal(commands.formattingToolbarState(view.state, false).commands.outdent.available, true);
    assert.equal(commands.executeFormattingCommand(view, 'outdent').applied, true);
  });
});
