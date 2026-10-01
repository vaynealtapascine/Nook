"use strict";
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {createProcessor} = require('../processing-api');
const {create: createClient} = require('../processing-client');
const {createServer} = require('../server');
const M = require('../model'), Sync = require('../sync-model');
const imageData = 'data:image/png;base64,' + Buffer.from('test image').toString('base64');
const input = (image = imageData) => ({transcribe:true,tag:true,piece:{title:'Garden',imageData:image}});

test('server serializes OCR, coalesces duplicate images, and caches only results', async () => {
  let running = 0, calls = 0; const releases = [];
  const processor = createProcessor({recognizer:{recognize:async()=>{
    calls++; running++; assert.equal(running,1);
    await new Promise(resolve=>releases.push(resolve)); running--;
    return 'I remember the rain. A garden beside the sea.';
  },close:()=>{} }});
  const first = processor.process(input()), duplicate = processor.process({...input(),piece:{...input().piece,title:'Home'}});
  const second = processor.process(input('data:image/png;base64,'+Buffer.from('second image').toString('base64')));
  await new Promise(setImmediate); assert.equal(calls,1); releases.shift()();
  const [a,b] = await Promise.all([first,duplicate]);
  assert.deepEqual(a.tags,['memory','nature','water']); assert.deepEqual(b.tags,['home','memory','nature','water']);
  await new Promise(setImmediate); assert.equal(calls,2); releases.shift()(); await second;
  await processor.process(input()); assert.equal(calls,2); processor.close();
});

test('server validates captures and tags text without creating an OCR worker', async () => {
  let calls = 0; const processor = createProcessor({recognizer:{recognize:async()=>{calls++;return '';},close:()=>{}}});
  assert.deepEqual((await processor.process({transcribe:false,tag:true,piece:{quote:'Our home in the rain'}})).tags,['home','water']);
  assert.equal(calls,0);
  for (const image of ['https://example.com/image.png','file:///private.png','data:image/svg+xml;base64,YQ==','data:image/png;base64,YR==']) {
    await assert.rejects(processor.process(input(image)), /embedded|encoding/);
  }
  await assert.rejects(processor.process({transcribe:false,tag:false,piece:{}}),/Choose/);
  processor.close(); await assert.rejects(processor.process(input()),/unavailable/);
});

test('actual server OCR reads the bundled English model and supplies tags', async t => {
  const processor = createProcessor(); t.after(()=>processor.close());
  await assert.rejects(processor.process(input('data:image/png;base64,YQ==')), /could not read/);
  const data = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname,'fixtures/ocr.png')).toString('base64');
  const result = await processor.process(input(data));
  assert.match(result.ocrText,/I remember the rain/); assert.match(result.ocrText,/garden beside the sea/);
  assert.deepEqual(result.tags,['memory','nature','water']); assert.equal(result.source,'server');
});

test('a full image queue stays bounded and a failed job does not block retries', async () => {
  let release, fail = true;
  const processor=createProcessor({maxJobs:1,recognizer:{recognize:async()=>{await new Promise(resolve=>release=resolve); if(fail) throw new Error('Reader failed'); return 'The rain';},close:()=>{}}});
  const first=processor.process(input()); await new Promise(setImmediate);
  await assert.rejects(processor.process(input('data:image/png;base64,YQ==')), error=>error.status===503);
  const rejected=assert.rejects(first,/Reader failed/); release(); await rejected;
  fail=false; const retry=processor.process(input()); await new Promise(setImmediate); release();
  assert.equal((await retry).ocrText,'The rain'); processor.close();
});

test('processing HTTP requires pairing, blocks foreign origins, and never serves backend modules', async t => {
  const server = createServer({processing:{recognizer:{recognize:async()=> 'The rain',close:()=>{}}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base = 'http://127.0.0.1:'+server.address().port;
  const options = {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input())};
  const unpaired = await fetch(base+'/api/process',{...options,headers:{...options.headers,'X-Forwarded-For':'100.64.0.2'}});
  assert.equal(unpaired.status,401);
  assert.equal((await fetch(base+'/api/process',{...options,headers:{...options.headers,Origin:'https://untrusted.example'}})).status,403);
  const good = await fetch(base+'/api/process',options); assert.equal(good.status,200); assert.equal((await good.json()).source,'server');
  for(const module of ['/processing-api.js','/ocr-worker.js','/node_modules/tesseract.js/src/index.js']) assert.equal((await fetch(base+module)).status,404);
  assert.equal((await fetch(base+'/processing-client.js')).status,200);
});

function client(overrides = {}) {
  const calls = [], options = {
    online:()=>true,onMode:mode=>calls.push(mode),
    getWorker:async()=>{calls.push('worker'); return {recognize:async()=>({data:{text:'The garden remembers the rain.'}})};},
    fetch:async(url,request)=>{ calls.push('request'); assert.equal(url,'/api/process'); assert.equal(request.credentials,'same-origin'); return new Response(JSON.stringify({ocrText:'Server rain',tags:['water'],source:'server'})); },
    ...overrides,
  };
  return {instance:createClient(options),calls};
}
test('connected client offloads OCR and tags without starting its local worker', async () => {
  const c = client(), result = await c.instance.process(input().piece,{transcribe:true,tag:true,location:'server'});
  assert.equal(result.source,'server'); assert.deepEqual(c.calls,['server','request']);
});
test('offline, unavailable and unpaired clients keep gathering locally', async () => {
  for(const overrides of [{online:()=>false},{fetch:async()=>{throw new Error('Disconnected');}},{fetch:async()=>new Response(JSON.stringify({error:'Pair first'}),{status:401})},{fetch:async()=>new Response('{}',{status:503})}]) {
    const c=client(overrides), result=await c.instance.process(input().piece,{transcribe:true,tag:true,location:'server'});
    assert.equal(result.source,'device'); assert.match(result.ocrText,/garden/); assert.deepEqual(result.tags,['memory','nature','water']); assert.ok(c.calls.includes('worker'));
  }
});
test('device preference and text-only tagging never require server or OCR downloads', async () => {
  const c=client();
  const result=await c.instance.process({quote:'I remember the rain'},{transcribe:false,tag:true,location:'device'});
  assert.deepEqual(c.calls,['device']); assert.deepEqual(result.tags,['memory','water']);
  const requestClient=client({fetch:async(url,req)=>{ const body=JSON.parse(req.body); assert.equal('imageData' in body.piece,false); return new Response(JSON.stringify({ocrText:'',tags:['water']})); }});
  await requestClient.instance.process({quote:'Rain',imageData},{transcribe:false,tag:true,location:'server'});
  assert.deepEqual(requestClient.calls,['server']);
});
test('invalid server captures show an error instead of running the same OCR locally', async () => {
  const c=client({fetch:async()=>new Response(JSON.stringify({error:'Invalid image'}),{status:422})});
  await assert.rejects(c.instance.process(input().piece,{transcribe:true,tag:true,location:'server'}),/Invalid image/);
  assert.deepEqual(c.calls,['server']);
});

test('server and device processing receipts merge without duplicating the same piece', () => {
  const base=M.normalize({...M.empty(),pieces:[{id:'piece-1',kind:'quote',quote:'The rain',tags:[]}]});
  const local=M.snapshot(base),remote=M.snapshot(base);
  Object.assign(local.pieces[0],{tags:['water'],processingSource:'device',taggingStatus:'done'});
  Object.assign(remote.pieces[0],{tags:['water'],processingSource:'server',taggingStatus:'failed'});
  const result=Sync.merge(base,local,remote);
  assert.equal(result.workspace.pieces.length,1); assert.equal(result.conflicts.length,0);
  assert.equal(result.workspace.pieces[0].taggingStatus,'done'); assert.deepEqual(result.workspace.pieces[0].tags,['water']);
});
