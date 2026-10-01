"use strict";
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const shares = require('../share-inbox'), M = require('../model'), Sync = require('../sync-model');
const { createServer } = require('../server');
const root = path.join(__dirname, '..');

test('Android shares accept text-field URLs, passages with sources, and multiple images', () => {
  let form = new FormData();
  form.set('title', 'A garden'); form.set('text', 'https://example.com/garden');
  form.append('images', new Blob([]), '');
  assert.equal(shares.textPiece(shares.fromForm(form, 'one')).kind, 'link');
  form.delete('images');
  form.set('text', 'The garden remembers.\nThe rain returns.'); form.set('url', 'https://example.com/garden');
  form.append('images', new Blob(['one'], {type:'image/png'}), 'one.png');
  form.append('images', new Blob(['two']), 'two.jpg');
  const share = shares.fromForm(form, 'two', 42);
  assert.equal(share.files.length, 2); assert.equal(share.files[1].blob.type, 'image/jpeg');
  assert.equal(share.createdAt, 42);
  assert.equal(shares.textPiece(share).quote, 'The garden remembers.\nThe rain returns.');
  assert.equal(shares.textPiece(share).url, 'https://example.com/garden');
  const imageOnly = new FormData(); imageOnly.set('title', 'A garden');
  imageOnly.append('images', new Blob(['one'], {type:'image/png'}), 'one.png');
  assert.equal(shares.textPiece(shares.fromForm(imageOnly, 'three')), null);
});

test('empty, unsafe, unsupported and oversize shares cannot silently lose content', () => {
  assert.throws(() => shares.fromForm(new FormData(), 'one'), /Nothing arrived/);
  const form = new FormData(); form.append('images', new Blob([], {type:'image/png'}), 'one.png');
  assert.throws(() => shares.fromForm(form, 'one'), /arrived empty/);
  form.set('images', new Blob(['x'], {type:'image/svg+xml'}), 'one.svg');
  assert.throws(() => shares.fromForm(form, 'one'), /PNG, JPEG/);
  form.set('images', new Blob([new Uint8Array(20 * 1024 * 1024 + 1)], {type:'image/png'}), 'one.png');
  assert.throws(() => shares.fromForm(form, 'one'), /20 MB/);
  assert.equal(shares.textPiece({title:'Link', text:'',url:'javascript:alert(1)',files:[]}), null);
});

function worker(inbox) {
  const listeners = {}, cache = new Map();
  const context = { self: {location:{href:'https://nook.example/sw.js'}, addEventListener:(name, fn) => listeners[name] = fn}, importScripts:()=>{},
    NookShares: { ...shares, put: async share => { if (inbox.fail) throw new Error('Storage full'); inbox.entries.push(structuredClone(share)); } },
    URL, Request, Response, crypto:require('node:crypto').webcrypto,
    caches:{open:async()=>({match:async key=>cache.get(key), put:async(key,value)=>cache.set(key,value)})},
    fetch:async()=>{throw new Error('offline');}
  };
  vm.runInNewContext(fs.readFileSync(path.join(root,'sw.js'),'utf8'), context);
  return { listeners, cache, async request(request) { let result; listeners.fetch({request,respondWith:p=>result=p}); return await result; } };
}
test('offline worker saves POST shares locally before redirect and serves the cached app', async () => {
  const inbox = {entries:[]}, sw = worker(inbox), form = new FormData(); form.set('text','Offline rain');
  const response = await sw.request(new Request('https://nook.example/share-target', {method:'POST',body:form}));
  assert.equal(response.status,303); assert.equal(inbox.entries[0].text,'Offline rain');
  assert.equal(response.headers.get('Location'),'https://nook.example/?shared=1');
  sw.cache.set('https://nook.example/index.html',new Response('cached Nook'));
  const navigation = {url:'https://nook.example/?shared=1', method:'GET', mode:'navigate', headers:new Headers()};
  const shell = await sw.request(navigation); assert.equal(await shell.text(),'cached Nook');
  inbox.fail = true;
  const failed = await sw.request(new Request('https://nook.example/share-target', {method:'POST',body:form}));
  assert.equal(failed.status,400); assert.match(await failed.text(),/Storage full/); assert.equal(inbox.entries.length,1);
  assert.equal(await sw.request(new Request('https://elsewhere.example/share-target', {method:'POST',body:form})),undefined);
});

const app = fs.readFileSync(path.join(root,'app.js'),'utf8');
const receiver = app.slice(app.indexOf('  async function receiveShares('), app.indexOf("  window.addEventListener('focus'",app.indexOf('  async function receiveShares(')));
test('failed collection commit retains inbox; replay after commit never duplicates pieces', async () => {
  const form = new FormData(); form.set('text','Shared passage'); const share = shares.fromForm(form,'one');
  const workspace = M.empty(), calls = []; let failCommit = true, failAck = false;
  const context = {collectionReady:true, receivingShares:false, conflict:false, clientSync:null, workspace, batchDepth:0,
    NookShares:{...shares,pending:async()=>[share], remove:async id=>{calls.push('ack'); if(failAck) throw new Error('interrupted acknowledgement');}},
    addPiece:(kind,p)=>workspace.pieces.push({...p,kind}), checkpoint:()=>{}, scheduleSave:()=>{},render:()=>{},toast:()=>{}, console:{error:()=>{}},
    save:async(skip,strict)=>{assert.equal(strict,true); calls.push('commit'); if(failCommit) throw new Error('Storage full');},
    location:{href:'https://nook.example/'}, URL
  };
  const receive = vm.runInNewContext('('+receiver.trim()+')',context);
  await receive(); assert.deepEqual(calls,['commit']); assert.equal(workspace.pieces.length,1);
  failCommit = false; failAck = true;
  await receive(); assert.deepEqual(calls,['commit','commit','ack']); assert.equal(workspace.pieces.length,1);
  failAck = false; await receive(); assert.equal(workspace.pieces.length,1);
  assert.deepEqual(Array.from(workspace.appliedShares),['one']);
  const roundTrip = M.normalize(JSON.parse(JSON.stringify(workspace)));
  assert.deepEqual(roundTrip.appliedShares,['one']);
  assert.deepEqual(Sync.merge(null,roundTrip,M.empty()).workspace.appliedShares,['one']);
});

test('PWA manifest assets have correct MIME types and raster icon dimensions', async t => {
  const server = createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base = 'http://127.0.0.1:'+server.address().port;
  const response = await fetch(base+'/manifest.webmanifest'); assert.match(response.headers.get('content-type'),/application\/manifest\+json/);
  const manifest = await response.json(); assert.equal(manifest.share_target.method,'POST'); assert.equal(manifest.share_target.enctype,'multipart/form-data');
  for (const icon of [...manifest.icons,{src:'/icons/nook-180.png',sizes:'180x180'}]) {
    const r = await fetch(base+icon.src); assert.equal(r.status,200); assert.equal(r.headers.get('content-type'),'image/png');
    const png = Buffer.from(await r.arrayBuffer()); assert.equal(png.readUInt32BE(16),Number(icon.sizes.split('x')[0]));
  }
  assert.equal((await fetch(base+'/share-inbox.js')).status,200);
  assert.equal((await fetch(base+'/scripts/test-share-server.js')).status,404);
});

test('an unreadable incoming image stays in the inbox without blocking later shares', async () => {
  const entries = [{id:'bad',createdAt:1,title:'',text:'',url:'',files:[{blob:new Blob(['broken'])}]}, {id:'good',createdAt:2,title:'',text:'Still gathering',url:'',files:[]}];
  const workspace = M.empty(), acknowledged = [];
  const context = {collectionReady:true,receivingShares:false,conflict:false,clientSync:null,workspace,batchDepth:0,
    NookShares:{...shares,pending:async()=>entries,remove:async id=>acknowledged.push(id)},imageToData:async()=>{throw new Error('Invalid image');},
    addPiece:(kind,p)=>workspace.pieces.push({...p,kind}),checkpoint:()=>{},scheduleSave:()=>{},render:()=>{},toast:()=>{},console:{error:()=>{}},save:async()=>{},location:{href:'https://nook.example/'},URL};
  await vm.runInNewContext('('+receiver.trim()+')',context)();
  assert.deepEqual(acknowledged,['good']); assert.equal(workspace.pieces[0].quote,'Still gathering');
});
