import { dockTool } from './dock-tool-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { TinaMobileWorld } from '../src/world.mjs';
import { MobileStore } from '../src/store.mjs';
import { DatabaseSync } from 'node:sqlite';

test('API 6 previous-contract wrapper can delegate to the API 5 console without recursion', () => {
  const instance = new TinaMobileWorld({});
  Object.defineProperty(instance, 'webUi', { value: (...args) => instance.console(...args), configurable: true });
  assert.equal(instance.webUi().config[0].owner, 'world:milkcoo-app');
  assert.equal(instance.webUi().promptDocs[0].role, 'envPrompt');
});

test('old media table upgrades in place without losing original bytes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'coo-media-old-')), path = join(dir, 'mobile.sqlite');
  t.after(() => { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.match(basename(dir), /^coo-media-old-/); rmSync(dir, { recursive: true, force: true }); });
  const old = new DatabaseSync(path);
  old.exec('CREATE TABLE media (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, mime TEXT NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL)');
  const bytes = Buffer.from('old media'); const hash = createHash('sha256').update(bytes).digest('hex');
  old.prepare('INSERT INTO media VALUES (?,?,?,?,?)').run('legacy', 'phone', 'audio/mp4', hash, bytes); old.close();
  const current = new MobileStore(path);
  assert.deepEqual(Buffer.from(current.getMedia('legacy').data), bytes);
  assert.equal(current.getMedia('legacy').file_name, null);
  current.putMedia('named', 'phone', 'video/mp4', hash, bytes, 'clip.mp4');
  assert.equal(current.getMediaInfo('named').file_name, 'clip.mp4'); current.close();
  const reopened = new MobileStore(path); assert.deepEqual(Buffer.from(reopened.getMedia('legacy').data), bytes); reopened.close();
});

test('named video and arbitrary files preserve bytes and are retried by stable identity', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coo-media-files-')), events = [];
  const host = {
    store: { range: q => events.filter(e => e.source === q.source && e.senderKey === q.senderKey) },
    pushEvent: async event => { const result = { ...event, cursor: events.length + 1 }; events.push(result); return result; },
    blob: handle => handle === 'mem:pdf' ? { mime: 'application/pdf', bytes: Buffer.from('pdf-bytes') } : null,
  };
  const world = new TinaMobileWorld({ cfg: { host: '127.0.0.1', port: 0, tokenSecret: 'TEST' }, dataDir: dir, botDir: dir, secret: () => 'fixture' });
  await world.start(host);
  t.after(async () => { await world.stop(); assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.match(basename(dir), /^coo-media-files-/); rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${world.address().port}`;
  const req = async (path, body) => {
    const response = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const bytes = Buffer.from('short-video-test');
  const item = { id: 'clip', device_id: 'ios-a', text: '[视频] clip.mp4', created_at: '2026-10-30T00:00:00Z',
    mime: 'video/mp4', file_name: 'clip.mp4', data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') };
  assert.equal((await req('/v1/media', item)).status, 201);
  assert.equal((await req('/v1/media', item)).status, 200);
  assert.equal((await req('/v1/media', { ...item, file_name: 'changed.mp4' })).status, 409);
  assert.equal((await req('/v1/media', { ...item, id: 'bad', file_name: '../bad.mp4' })).status, 400);
  while (world.pending) await world.pending;
  assert.equal(events.length, 1); assert.equal(events[0].blobs[0].name, 'clip.mp4');
  assert.deepEqual(Buffer.from(events[0].blobs[0].bytes), bytes);
  const metadata = await req('/v1/media?id=clip&device_id=ios-a&metadata=1');
  assert.equal(metadata.body.file_name, 'clip.mp4'); assert.equal(metadata.body.mime, 'video/mp4');
  const sender = dockTool(world, 'reply').handler;
  const reply = JSON.parse(await sender({ device_id: 'ios-a', in_reply_to: 'clip', handle: 'mem:pdf', file_name: 'report.pdf', text: 'PDF' }, { role: 'assistant', callId: 'file-reply' }));
  const got = await req(`/v1/media?id=${encodeURIComponent(reply.id)}&device_id=ios-a`);
  assert.equal(got.body.file_name, 'report.pdf'); assert.equal(got.body.mime, 'application/pdf');
  assert.equal(Buffer.from(got.body.data, 'base64').toString(), 'pdf-bytes');
});

test('bidirectional media retains bytes, device and original message, and retries are idempotent', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coo-media-test-'));
  const events = [], data = Buffer.from('test-only image bytes');
  const host = {
    store: { range: q => events.filter(e => e.source === q.source && e.senderKey === q.senderKey) },
    pushEvent: async event => { const result = { ...event, cursor: events.length + 1 }; events.push(result); return result; },
    blob: handle => handle === 'mem:voice' ? { mime: 'audio/mpeg', bytes: Buffer.from('test-only voice') } : null,
  };
  const world = new TinaMobileWorld({ cfg: { host: '127.0.0.1', port: 0, tokenSecret: 'TEST' }, dataDir: dir, botDir: dir, secret: () => 'fixture' });
  await world.start(host);
  t.after(async () => { await world.stop(); assert.equal(dirname(resolve(dir)),resolve(tmpdir())); assert.match(basename(dir),/^coo-media-test-/); rmSync(dir,{recursive:true,force:true}); });
  const url = `http://127.0.0.1:${world.address().port}`;
  const req = async (path, body, auth = true) => {
    const res = await fetch(url+path,{method:body?'POST':'GET',headers:{...(auth?{authorization:'Bearer fixture'}:{}),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
    return {status:res.status,body:await res.json()};
  };
  const input = {id:'photo-a',device_id:'phone-a',created_at:'2026-10-28T01:00:00Z',text:'[图片]',mime:'image/jpeg',sha256:createHash('sha256').update(data).digest('hex'),data:data.toString('base64')};
  assert.equal((await req('/v1/media',input,false)).status,401);
  assert.equal((await req('/v1/media',{...input,sha256:'invalid'})).status,400);
  assert.equal((await req('/v1/media',input)).status,201);
  assert.equal((await req('/v1/media',input)).status,200);
  const other = Buffer.from('different');
  assert.equal((await req('/v1/media',{...input,data:other.toString('base64'),sha256:createHash('sha256').update(other).digest('hex')})).status,409);
  while (world.pending) await world.pending;
  assert.equal(events.length,1); assert.equal(events[0].type,'coo_mobile.message');
  assert.deepEqual(Buffer.from(events[0].blobs[0].bytes),data);
  assert.equal((await req('/v1/media?id=photo-a&device_id=phone-b')).status,404);
  assert.equal((await req('/v1/media?id=photo-a&device_id=phone-a&metadata=1',undefined,false)).status,401);
  assert.equal((await req('/v1/media?id=photo-a&device_id=phone-b&metadata=1')).status,404);
  const meta = await req('/v1/media?id=photo-a&device_id=phone-a&metadata=1');
  assert.equal(meta.body.mime,'image/jpeg'); assert.equal(meta.body.size,data.length);
  assert.equal(Object.hasOwn(meta.body,'data'),false, 'metadata must not download attachment bytes');
  const restored = await req('/v1/media?id=photo-a&device_id=phone-a');
  assert.deepEqual(Buffer.from(restored.body.data,'base64'),data);
  const sender = dockTool(world, 'reply').handler;
  const args = {device_id:'phone-a',in_reply_to:'photo-a',handle:'mem:voice',text:'一段语音'};
  const call = {role:'assistant',callId:'test-voice-1'};
  const receipt = JSON.parse(await sender(args,call));
  assert.equal(JSON.parse(await sender(args,call)).id,receipt.id);
  const feed = (await req('/v1/feed?device_id=phone-a')).body;
  assert.equal(feed.items.find(x=>x.id===receipt.id).source_ref,`coo-media:${receipt.id}`);
  const voice = await req(`/v1/media?id=${encodeURIComponent(receipt.id)}&device_id=phone-a`);
  assert.equal(voice.body.mime,'audio/mpeg'); assert.equal(Buffer.from(voice.body.data,'base64').toString(),'test-only voice');
  assert.equal((await sender({...args,handle:'mem:missing'},{...call,callId:'missing'})).failed,true);
});
