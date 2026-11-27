import { dockTool } from './dock-tool-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { TinaMobileWorld } from '../src/world.mjs';

test('real World HTTP -> device poll -> correlated capture receipt -> real tool blob, without a model call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'milkcoo-native-http-'));
  const world = new TinaMobileWorld({ botDir: dir, dataDir: dir, cfg: { host: '127.0.0.1', port: 0, tokenSecret: 'test' }, secret: () => 'synthetic-native-token' });
  const host = { store: { range: () => [], latestCursor: () => 0 }, pushEvent: () => { throw new Error('Device sync must not wake a model'); } };
  await world.start(host); world.canAcceptImage = async () => true;
  const base = 'http://127.0.0.1:' + world.address().port;
  const api = async (path, body) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer synthetic-native-token', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  try {
    assert.equal((await fetch(base + '/v1/native/devices')).status, 401);
    assert.equal((await api('/v1/health')).native_device_channel, true);
    await api('/v1/native/poll', { device_id: 'phone', capabilities: { capture: { screen: { active: true } } } });
    const tool = dockTool(world, 'screen');
    const call = { callId: 'original-peek-call', role: 'main' };
    const reply = tool.handler({ device_id: 'phone' }, call);
    const { operations } = await api('/v1/native/poll', { device_id: 'phone' });
    assert.equal(operations.length, 1); assert.equal(operations[0].path, '/native/capture');
    assert.equal((await api('/v1/native/poll', { device_id: 'other' })).operations.length, 0);
    const bytes = Buffer.from('synthetic captured image bytes'), media_id = createHash('sha256').update(bytes).digest('hex');
    await api('/v1/native/result', { device_id: 'phone', operation_id: operations[0].operation_id,
      result: { state: 'succeeded', ok: true, media_id, captured_at: '2026-11-07T01:00:00Z' }, media: { data: bytes.toString('base64'), mime: 'image/jpeg' } });
    const output = await reply; assert.deepEqual(output.blobs[0].bytes, bytes); assert.match(output.text, /2026-11-07/);
    const replay = await tool.handler({ device_id: 'phone' }, call); assert.deepEqual(replay.blobs[0].bytes, bytes);
    assert.equal((await api('/v1/native/poll', { device_id: 'phone' })).operations.length, 0);
  } finally { await world.stop(); }
});

test('one World directory adapter forwards actual public Core routes without changing another target', async () => {
  const calls=[];
  const dir=mkdtempSync(join(tmpdir(),'milkcoo-public-worlds-'));
  const deployment=createHash('sha256').update(dir).digest('hex');
  const core=createServer((req,res)=>{
    res.writeHead(200,{'content-type':'application/json'});
    if (req.url==='/api/run/lifecycle') { res.end(JSON.stringify({deployment,ready:true})); return; }
    calls.push(req.url);
    res.end(JSON.stringify(req.url==='/api/worlds'?{worlds:[{id:'fixture',status:'active'}]}:{protocolVersion:1,providers:[]}));
  });
  await new Promise(done=>core.listen(0,'127.0.0.1',done));
  const world=new TinaMobileWorld({botDir:dir,dataDir:dir,cfg:{host:'127.0.0.1',port:0,consolePort:core.address().port,tokenSecret:'test'},secret:()=> 'synthetic-public-token'});
  await world.start({store:{range:()=>[],latestCursor:()=>0},pushEvent:()=>{throw new Error('Viewing Worlds must stay silent');}});
  const base='http://127.0.0.1:'+world.address().port;
  try {
    for(const path of ['/api/worlds','/api/webui/manifest']){
      const response=await fetch(base+'/v1/desktop/public',{method:'POST',headers:{authorization:'Bearer synthetic-public-token','content-type':'application/json'},body:JSON.stringify({path,method:'GET'})});
      assert.equal(response.status,200);await response.json();
    }
    const rejected=await fetch(base+'/v1/desktop/public',{method:'POST',headers:{authorization:'Bearer synthetic-public-token','content-type':'application/json'},body:JSON.stringify({path:'/arbitrary',method:'GET'})});
    assert.equal(rejected.status,403);await rejected.body.cancel();
    assert.deepEqual(calls,['/api/worlds','/api/webui/manifest']);
  } finally {await world.stop();core.closeAllConnections();await new Promise(done=>core.close(done));}
});

test('desktop World actions check their deployment, preserve restart state and never retry a lost response', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'milkcoo-desktop-target-'));
  const deployment = createHash('sha256').update(dir).digest('hex');
  const lifecycle = { deployment, ready: true, bootId: 'old-boot' };
  const packageEntry = { kind: 'world', name: 'cortico-world-test', version: '1.2.3', state: 'pending-restart', loaded: false };
  let installed = false;
  const writes = [];
  const core = createServer(async (req, res) => {
    const reply = (data, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'GET' && req.url === '/api/run/lifecycle') return reply(lifecycle);
    if (req.method === 'GET' && req.url === '/api/extensions') return reply({ extensions: installed ? [packageEntry] : [] });
    if (req.method === 'GET' && req.url === '/api/extensions/search?kind=world') return reply({ hits: [packageEntry] });
    if (req.method !== 'POST') return reply({}, 404);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    writes.push({ path: req.url, body: raw ? JSON.parse(raw) : undefined });
    if (req.url === '/api/extensions/install') {
      installed = true;
      if (writes.at(-1).body.name === 'cortico-world-lost') { req.socket.destroy(); return; }
      return reply({ ok: true, restartRequired: true });
    }
    if (req.url === '/api/run/restart') { lifecycle.ready = false; return reply({ ok: true, steps: [] }); }
    if (req.url === '/api/worlds/restart') return reply({}, 401);
    return reply({}, 404);
  });
  await new Promise(done => core.listen(0, '127.0.0.1', done));
  const world = new TinaMobileWorld({ botDir: dir, dataDir: dir,
    cfg: { host: '127.0.0.1', port: 0, consolePort: core.address().port, tokenSecret: 'test' },
    secret: () => 'synthetic-target-token' });
  await world.start({ store: { range: () => [], latestCursor: () => 0 } });
  t.after(async () => {
    await world.stop();
    core.closeAllConnections();
    if (core.listening) await new Promise(done => core.close(done));
  });
  const call = async (path, method = 'GET', body, expectedDeployment) => {
    const response = await fetch('http://127.0.0.1:' + world.address().port + '/v1/desktop/public', {
      method: 'POST', headers: { authorization: 'Bearer synthetic-target-token', 'content-type': 'application/json' },
      body: JSON.stringify({ path, method, body, expectedDeployment }),
    });
    return { status: response.status, data: await response.json() };
  };
  const install = { name: packageEntry.name, version: packageEntry.version };
  assert.equal((await call('/api/extensions/search?kind=world', 'GET', undefined, deployment)).data.hits.length, 1);
  assert.equal((await call('/api/extensions/install', 'POST', install, 'f'.repeat(64))).status, 409);
  lifecycle.deployment = 'port-reassigned';
  assert.equal((await call('/api/run/lifecycle')).status, 409);
  assert.equal((await call('/api/extensions/install', 'POST', install, deployment)).status, 409);
  assert.equal(writes.length, 0);
  lifecycle.deployment = deployment;
  assert.deepEqual(await call('/api/extensions/install', 'POST', install, deployment), { status: 200, data: { ok: true, restartRequired: true } });
  assert.deepEqual((await call('/api/extensions')).data.extensions, [packageEntry]);
  assert.equal((await call('/api/run/restart', 'POST', undefined, deployment)).status, 403);
  lifecycle.ready = false;
  assert.equal((await call('/api/run/lifecycle')).data.ready, false);
  assert.equal((await call('/api/extensions/install', 'POST', install, deployment)).status, 503);
  lifecycle.bootId = 'new-boot'; lifecycle.ready = true;
  packageEntry.state = 'loaded'; packageEntry.loaded = true;
  assert.equal((await call('/api/run/lifecycle')).data.bootId, 'new-boot');
  assert.equal((await call('/api/extensions')).data.extensions[0].state, 'loaded');
  assert.equal((await call('/api/worlds/restart', 'POST', { id: 'fixture' }, deployment)).status, 401);
  assert.equal((await call('/api/extensions/install', 'POST', { name: 'cortico-world-lost' }, deployment)).status, 502);
  assert.deepEqual(writes.map(write => write.path), ['/api/extensions/install', '/api/worlds/restart', '/api/extensions/install']);
  await new Promise(done => core.close(done));
  assert.equal((await call('/api/run/lifecycle')).status, 503);
});
