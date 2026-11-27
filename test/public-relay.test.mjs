import { dockTool } from './dock-tool-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { PUBLIC_RELAY_ORIGIN, PublicRelayConnector } from '../src/public-relay.mjs';
import { TinaMobileWorld, toolSchemas } from '../src/world.mjs';

test('chunk protocol JSON crosses connector without a second resource envelope', async t => {
  const value = {transfer:1,state:'ready',offset:1048576,total:67108864,revision:'a'.repeat(64),sha256:'b'.repeat(64),mime:'image/webp',data:'AQID'};
  const connector = new PublicRelayConnector({}, () => ({origin:'http://127.0.0.1:1',token:'fixture'}),
    async url => {
      assert.equal(url.searchParams.get('offset'),'1048576');
      assert.equal(url.searchParams.get('revision'),'a'.repeat(64));
      return Response.json(value);
    });
  t.after(()=>connector.stop());
  const result=await connector.dispatch({request_id:'chunk',max_response_bytes:8*1024*1024,
    target:{method:'GET',path:'/v1/pet/resource',query:{path:'/packs/test/large.webp',transfer:'chunks',offset:1048576,revision:'a'.repeat(64)}}});
  assert.deepEqual(JSON.parse(Buffer.from(result.body_base64,'base64')),value);
});

test('pet resource failures return bounded explicit results without disconnecting unrelated jobs', async t => {
  const connector = new PublicRelayConnector({}, () => ({ origin:'http://127.0.0.1:1', token:'fixture' }),
    async () => new Response(new Uint8Array(5000), {status:200}));
  t.after(() => connector.stop());
  const job = {request_id:'large-resource', max_response_bytes:4096, target:{method:'GET',path:'/v1/pet/resource',query:{path:'/web/figure.js'}}};
  const large = await connector.dispatch(job);
  assert.equal(large.status, 413);
  assert.equal(JSON.parse(Buffer.from(large.body_base64, 'base64')).error, 'pet_resource_too_large');
  const offline = new PublicRelayConnector({}, () => ({origin:'http://127.0.0.1:1',token:'fixture'}), async () => {throw new Error('private URL must not appear');});
  t.after(() => offline.stop());
  const failed = await offline.dispatch({...job,request_id:'offline-resource'});
  assert.equal(failed.status,504);
  assert.equal(JSON.parse(Buffer.from(failed.body_base64,'base64')).error,'pet_resource_unavailable');
  await assert.rejects(offline.dispatch({...job,request_id:'ordinary-feed',target:{method:'GET',path:'/v1/feed'}}));
});

test('pet bytes and screen frames use only the scoped local routes', async t => {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ method:req.method, url:req.url, body:Buffer.concat(chunks).toString() });
    if (req.url.startsWith('/v1/pet/resource')) { res.writeHead(200, {'content-type':'image/webp'}); res.end(Buffer.from([1,2,3])); }
    else { res.writeHead(200, {'content-type':'application/json'}); res.end('{"ok":true}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const connector = new PublicRelayConnector({}, () => ({origin:`http://127.0.0.1:${server.address().port}`, token:'test'}));
  t.after(() => connector.stop());
  const pet = await connector.dispatch({request_id:'pet', max_response_bytes:4096, target:{method:'GET',path:'/v1/pet/resource',query:{path:'/packs/cat/a.webp'}}});
  assert.deepEqual(JSON.parse(Buffer.from(pet.body_base64,'base64')), {mime:'image/webp', data:'AQID'});
  await connector.dispatch({request_id:'screen', max_response_bytes:4096, target:{method:'POST',path:'/v1/screen',body:{session_id:'s'}}});
  await connector.dispatch({request_id:'stop', max_response_bytes:4096, target:{method:'DELETE',path:'/v1/screen',query:{session_id:'s'}}});
  assert.deepEqual(seen.map(x => x.method), ['GET','POST','DELETE']);
  await assert.rejects(connector.dispatch({request_id:'camera', max_response_bytes:4096, target:{method:'POST',path:'/v1/camera/frame',body:{}}}), /RELAY_JOB_INVALID/);
});

test('native connector carries only the three fixed ecosystem routes through real HTTP', async t => {
  const calls = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer synthetic-world');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    calls.push({ method: req.method, path: req.url, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: 'fixture', received: body }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const connector = new PublicRelayConnector({}, () => ({ origin: `http://127.0.0.1:${server.address().port}`, token: 'synthetic-world' }));
  t.after(() => connector.stop());
  const bodies = [undefined, { ticket: 'synthetic', deviceId: 'phone', operationId: 'install' },
    { serviceId: 'bottle', method: 'POST', path: '/api/pick', body: { count: 1 } }];
  const routes = [['GET', '/v1/ecosystem'], ['POST', '/v1/ecosystem/handoff'], ['POST', '/v1/ecosystem/invoke']];
  for (let index = 0; index < routes.length; index++) {
    const [method, path] = routes[index];
    const reply = await connector.dispatch({ request_id: `ecosystem-${index}`, max_response_bytes: 4096,
      target: { method, path, ...(bodies[index] ? { body: bodies[index] } : {}) } });
    assert.equal(reply.status, 200);
    assert.deepEqual(JSON.parse(Buffer.from(reply.body_base64, 'base64')).received, bodies[index] ?? null);
  }
  assert.equal(calls.length, 3);
  for (const path of ['https://outside.invalid/', '/v1/ecosystem/login', '/v1/ecosystem/../../admin']) {
    await assert.rejects(connector.dispatch({ request_id: 'bad-route', max_response_bytes: 4096,
      target: { method: 'POST', path, body: {} } }), /RELAY_JOB_INVALID/);
  }
  assert.equal(calls.length, 3);
});

test('public relay binds once, persists the computer credential and forwards the allowed local operation', async t => {
  const key = `mck_${'a'.repeat(43)}`;
  const deviceToken = `mcd_${'b'.repeat(43)}`;
  const localToken = 'local-test-only';
  const secrets = new Map();
  const context = { secret: name => secrets.get(name), storeSecret: (name, value) => secrets.set(name, value) };
  const calls = [];
  const request = async (url, options) => {
    const pathname = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push(pathname);
    if (pathname === '/relay/enroll') {
      assert.equal(body.key, key);
      assert.equal(body.role, 'connector');
      assert.equal(options.headers.authorization, undefined);
      return Response.json({ role: 'connector', device_id: body.device_id, token: deviceToken });
    }
    if (pathname === '/relay/poll') {
      assert.equal(options.headers.authorization, `Bearer ${deviceToken}`);
      return Response.json({ job: { request_id: 'sample', max_response_bytes: 100,
        target: { method: 'GET', path: '/v1/feed', query: { device_id: 'phone-1' } } } });
    }
    if (pathname === '/v1/feed') {
      assert.equal(new URL(url).origin, 'http://127.0.0.1:7801');
      assert.equal(new URL(url).searchParams.get('device_id'), 'phone-1');
      assert.equal(options.headers.authorization, `Bearer ${localToken}`);
      return Response.json({ items: [] });
    }
    assert.equal(pathname, '/relay/complete');
    assert.equal(new URL(url).origin, PUBLIC_RELAY_ORIGIN);
    assert.equal(options.headers.authorization, `Bearer ${deviceToken}`);
    assert.deepEqual(body, { request_id: 'sample', status: 200, body_base64: Buffer.from('{"items":[]}').toString('base64') });
    return Response.json({ state: 'completed' });
  };
  const localWorld = () => ({ origin: 'http://127.0.0.1:7801', token: localToken });
  const connector = new PublicRelayConnector(context, localWorld, request);
  t.after(() => connector.stop());
  await connector.bind(key);
  await connector.bind(key);
  await assert.rejects(connector.bind(`mck_${'c'.repeat(43)}`), /RELAY_OTHER_KEY_BOUND/);
  connector.stop();
  const saved = [...secrets.values()][0];
  assert.ok(saved.includes(deviceToken) && !saved.includes(key) && !saved.includes(localToken));
  const resumed = new PublicRelayConnector(context, localWorld, request);
  t.after(() => resumed.stop());
  resumed.start();
  clearTimeout(resumed.timer);
  await resumed.poll();
  assert.equal(resumed.state, 'online');
  assert.deepEqual(calls, ['/relay/enroll', '/relay/poll', '/v1/feed', '/relay/complete']);
  await assert.rejects(resumed.dispatch({ request_id: 'bad', max_response_bytes: 100,
    target: { method: 'GET', path: '/v1/admin' } }), /RELAY_JOB_INVALID/);
});

test('native bot tools read and reply in the room with the connector credential and an idempotent receipt', async t => {
  const key = `mck_${'a'.repeat(43)}`, token = `mcd_${'b'.repeat(43)}`;
  const me = { id: 'bot-1234567890abcdef', kind: 'bot', avatar: '机' };
  const human = { id: 'human-1234567890abcdef', kind: 'human', avatar: '人' };
  const replyId = `m_${'1'.repeat(32)}`, messageId = `m_${'2'.repeat(32)}`;
  const secrets = new Map(), requests = [], submitted = new Map();
  const context = { botDir: 'bot-fixture', secret: name => secrets.get(name), storeSecret: (name, value) => secrets.set(name, value) };
  let responseMode = 'lost';
  const connector = new PublicRelayConnector(context, () => { assert.fail('Group chat must not access the private World'); }, async (url, options) => {
    const { origin, pathname } = new URL(url), body = JSON.parse(options.body);
    assert.equal(origin, PUBLIC_RELAY_ORIGIN);
    assert.equal(options.redirect, 'error');
    requests.push({ pathname, body });
    if (pathname === '/relay/enroll') return Response.json({ role: 'connector', device_id: body.device_id, token });
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    assert.equal(body.key, undefined);
    if (pathname === '/relay/world-chat/feed') {
      if (responseMode === 'revoked') return Response.json({ error: 'not_authorized_or_unavailable' }, { status: 403 });
      return Response.json({ me, messages: [{ id: replyId, author: human, text: '晚上好' }], next_cursor: 4, has_more: false,
        bot_listen_enabled: true, bot_listen_revision: 1, bot_listen_start_cursor: 0,
        notice: { text: '欢迎进群' }, mute: null, can_moderate: false });
    }
    assert.equal(pathname, '/relay/world-chat/post');
    if (responseMode === 'muted') return Response.json({ error: 'world_chat_muted' }, { status: 423 });
    if (responseMode === 'rate-limited') return Response.json({ error: 'world_chat_rate_limited' }, { status: 429 });
    const message = submitted.get(body.client_id) ?? { id: messageId, text: body.text, author: me,
      mentions: [human.id], reply_to: { id: body.reply_to, author: human, text: '晚上好' } };
    submitted.set(body.client_id, message);
    if (responseMode === 'lost') throw new TypeError('transport closed after commit');
    return Response.json({ message });
  });
  t.after(() => connector.stop());
  const world = new TinaMobileWorld(context);
  world.publicRelay = connector; world.host = {}; world.store = {};
  const read = dockTool(world, 'room_read').handler, post = dockTool(world, 'room_post').handler;
  const failure = async result => {
    const receipt = await result;
    assert.equal(receipt.failed, true);
    return JSON.parse(receipt.text);
  };
  assert.equal((await failure(read({}))).error, 'WORLD_CHAT_UNBOUND');
  assert.equal(requests.length, 0);
  await connector.bind(key);
  clearTimeout(connector.timer);
  assert.deepEqual(requests.map(r => r.pathname), ['/relay/enroll']);

  assert.equal(JSON.parse(await read({})).notice.text, '欢迎进群');
  assert.deepEqual(requests.at(-1).body, { limit: 10 });
  assert.equal(JSON.parse(await read({ after: 0, limit: 2 })).me.kind, 'bot');
  assert.deepEqual(requests.at(-1).body, { after: 0, limit: 2 });
  const args = { text: `@${human.id} 晚上好`, reply_to: replyId };
  const call = { role: 'assistant', callId: 'host-post' };
  const unknown = await failure(post(args, call));
  assert.equal(unknown.state, 'unknown');
  assert.match(unknown.client_id, /^world-chat-[0-9a-f]{64}$/);
  responseMode = 'ready';
  assert.equal(JSON.parse(await post(args, call)).message.id, messageId);
  assert.equal(JSON.parse(await post({ ...args, client_id: unknown.client_id }, { callId: 'manual-retry' })).message.id, messageId);
  assert.equal(submitted.size, 1);
  assert.deepEqual(requests.at(-1).body, requests.at(-2).body);
  assert.equal((await failure(post({ ...args, author: human }, call))).error, 'INVALID_WORLD_CHAT_INPUT');
  await assert.rejects(connector.worldChat('mute', {}), /WORLD_CHAT_INVALID_OPERATION/);
  responseMode = 'muted';
  assert.equal((await failure(post(args, { callId: 'new-call' }))).error, 'world_chat_muted');
  responseMode = 'rate-limited';
  assert.equal((await failure(post(args, { callId: 'limited-call' }))).error, 'world_chat_rate_limited');
  responseMode = 'revoked';
  assert.equal((await failure(read({}))).error, 'RELAY_AUTH_REJECTED');
  assert.ok(requests.slice(1).every(r => /^\/relay\/world-chat\/(feed|post)$/.test(r.pathname)));

  const manifest = JSON.parse(readFileSync(new URL('../describe.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.tools, toolSchemas);
});
