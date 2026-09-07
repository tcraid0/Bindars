const test=require('node:test');
const assert=require('node:assert/strict');
const React=require('react');const {act}=React;const {createRoot}=require('react-dom/client');
const {useAnnotationExit,ANNOTATION_EXIT_WAIT_MS}=require('../.tmp/workspace-tests/src/hooks/useAnnotationExit.js');
const {AnnotationExitDialog}=require('../.tmp/workspace-tests/src/components/AnnotationExitDialog.js');
const {mockIPC,clearMocks}=require('@tauri-apps/api/mocks');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function render(t,initial={}){
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);let api;let records=initial;
  let wait=async()=>{};let retry=()=>{};
  function Probe(){api=useAnnotationExit(()=>records,()=>wait(),()=>retry());return null;}
  await act(async()=>root.render(React.createElement(Probe)));
  t.after(async()=>{await act(async()=>root.unmount());host.remove();});
  return {api:()=>api,records:value=>records=value,wait:value=>wait=value,retry:value=>retry=value};
}
test('quit waits for acknowledgement and allows exit only after pending records clear',async(t)=>{
  const v=await render(t,{'/a.md':{}});const gate=deferred();v.wait(()=>gate.promise);let allowed;
  await act(async()=>{v.api().requestExit().then(result=>allowed=result);});assert.equal(allowed,undefined);
  await act(async()=>{v.records({});gate.resolve();});assert.equal(allowed,true);assert.equal(v.api().paths,null);
});
test('failed saves leave a decision; Keep open does not allow a late completion to quit',async(t)=>{
  const v=await render(t,{'/a.md':{}});let allowed;
  await act(async()=>{v.api().requestExit().then(result=>allowed=result);});
  assert.deepEqual(v.api().paths,['/a.md']);assert.equal(allowed,undefined);
  await act(async()=>v.api().keepOpen());assert.equal(allowed,false);
  v.records({});await act(async()=>{});assert.equal(allowed,false);
});
test('a slow write times out to choices, and cancellation invalidates the old continuation',async(t)=>{
  const v=await render(t,{'/a.md':{}});const gate=deferred();v.wait(()=>gate.promise);
  let fire;const original=global.setTimeout;
  t.mock.method(global,'setTimeout',(fn,ms,...args)=>{if(ms===ANNOTATION_EXIT_WAIT_MS){fire=fn;return 123;}return original(fn,ms,...args);});
  let allowed;await act(async()=>{v.api().requestExit().then(result=>allowed=result);});
  await act(async()=>fire());assert.deepEqual(v.api().paths,['/a.md']);assert.equal(allowed,undefined);
  await act(async()=>v.api().keepOpen());await act(async()=>{v.records({});gate.resolve();});assert.equal(allowed,false);
});
test('retry can finish the current quit; explicit unsaved exit remains available',async(t)=>{
  const v=await render(t,{'/a.md':{}});let allowed;
  await act(async()=>{v.api().requestExit().then(result=>allowed=result);});
  v.retry(()=>v.records({}));await act(async()=>v.api().retry());assert.equal(allowed,true);
  v.records({'/b.md':{}});allowed=undefined;await act(async()=>{v.api().requestExit().then(result=>allowed=result);});
  assert.equal(allowed,undefined);await act(async()=>v.api().quitWithoutSaving());assert.equal(allowed,true);
});
test('recovery-copy cancellation and write failure leave choices usable; successful export contains full records',async(t)=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);let chosen=null;let fail=false;const writes=[];
  const documents={'/a.md':{highlights:[{id:'h',note:'valuable',exact:'quote',prefix:'before',suffix:'after'}],bookmarks:[]}};
  mockIPC((cmd,args)=>{if(cmd==='plugin:dialog|save')return chosen;if(cmd==='export_annotation_recovery'){writes.push(args);if(fail)throw Error('full');return null;}throw Error(cmd);});
  await act(async()=>root.render(React.createElement(AnnotationExitDialog,{paths:['/a.md'],waiting:false,onKeepOpen(){},onRetry(){},onQuit(){},pendingRecords:()=>documents})));
  const click=async()=>{await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Save recovery copy').click());};
  try{
    await click();assert.equal(writes.length,0);
    chosen='/tmp/recovery.json';fail=true;await click();assert.match(host.textContent,/Couldn't save/);
    fail=false;await click();assert.deepEqual(writes[1],{path:chosen,documents});assert.match(host.textContent,/saved and verified/);
    assert.ok([...host.querySelectorAll('button')].every(b=>!b.disabled));
  }finally{await act(async()=>root.unmount());host.remove();clearMocks();}
});
