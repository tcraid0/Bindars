const test=require('node:test');
const assert=require('node:assert/strict');
const {mockIPC,clearMocks}=require('@tauri-apps/api/mocks');
function fresh() {
  for(const name of ['store','annotation-storage']) delete require.cache[require.resolve(`../.tmp/workspace-tests/src/lib/${name}.js`)];
  return {store:require('../.tmp/workspace-tests/src/lib/store.js'),annotations:require('../.tmp/workspace-tests/src/lib/annotation-storage.js')};
}
test('shared store cannot open or write before native preservation bootstrap succeeds',async()=>{
  const {store}=fresh();const calls=[];let release;
  const pending=new Promise(r=>release=r);
  mockIPC((cmd)=>{calls.push(cmd);if(cmd==='initialize_annotation_storage')return pending;if(cmd==='plugin:store|load')return 1;return null;});
  try {
    const write=store.storeSet('theme','dark');await new Promise(setImmediate);
    assert.deepEqual(calls,['initialize_annotation_storage']);
    release({settingsReady:true,settingsError:null});assert.equal(await write,true);
    assert.deepEqual(calls,['initialize_annotation_storage','plugin:store|load','plugin:store|set','plugin:store|save']);
  } finally{clearMocks();}
});
test('damaged settings are never loaded as plugin defaults while separate annotations remain readable',async()=>{
  const {store,annotations}=fresh();const calls=[];
  mockIPC(cmd=>{calls.push(cmd);if(cmd==='initialize_annotation_storage')return {settingsReady:false,settingsError:'damaged'};if(cmd==='load_annotations')return {highlights:[],bookmarks:[]};throw Error('must not open plugin');});
  try {
    assert.equal((await store.storeTryGet('theme')).ok,false);assert.equal(await store.storeSet('theme','light'),false);
    assert.deepEqual(await annotations.loadAnnotations('/a.md'),{highlights:[],bookmarks:[]});
    assert.ok(!calls.includes('plugin:store|load'));
  }finally{clearMocks();}
});
test('failed bootstrap can retry; a failed disk save is not acknowledged',async()=>{
  const {store}=fresh();let bootstrap=0;
  mockIPC(cmd=>{
    if(cmd==='initialize_annotation_storage'){if(++bootstrap===1)throw Error('unavailable');return {settingsReady:true,settingsError:null};}
    if(cmd==='plugin:store|load')return 1;
    if(cmd==='plugin:store|save')throw Error('disk full');
    return null;
  });
  try {
    assert.equal((await store.storeTryGet('theme')).ok,false);
    assert.equal(await store.storeSet('theme','dark'),false);assert.equal(bootstrap,2);
  }finally{clearMocks();}
});

test('preference migration leaves legacy annotation records alone and does not advance after failure', async (t) => {
  const { store } = fresh();
  const migrationPath = require.resolve('../.tmp/workspace-tests/src/lib/migrations.js');
  delete require.cache[migrationPath];
  const { runMigrations } = require(migrationPath);
  const writes = [];
  const reads = [];
  let fail = true;
  t.mock.method(store, 'storeTryGet', async (key) => {
    reads.push(key);
    return { ok: true, value: key === 'config-version' ? 2 : [{ path: '/a.md', name: 'a.md', openedAt: 1, lastHeadingId: 'user-content-intro' }] };
  });
  t.mock.method(store, 'storeSet', async (key, value) => {
    writes.push({ key, value: structuredClone(value) });
    return !fail;
  });
  await assert.rejects(runMigrations(), /save migrated settings/);
  assert.deepEqual(writes.map((item) => item.key), ['recent-files']);
  fail = false;
  await assert.rejects(runMigrations(), /save migrated settings/);
  assert.equal(writes.length, 1, 'failed migration must not retry in this process');
  delete require.cache[migrationPath];
  await require(migrationPath).runMigrations();
  assert.deepEqual(writes.slice(1).map((item) => item.key), ['recent-files', 'config-version']);
  assert.equal(writes[1].value[0].lastHeadingId, 'intro');
  assert.equal(writes[2].value, 3);
  assert.ok(reads.every((key) => ['config-version', 'recent-files'].includes(key)));
});
