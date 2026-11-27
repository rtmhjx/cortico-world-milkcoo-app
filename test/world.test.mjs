import { dockTool } from './dock-tool-fixture.mjs';
import { readBootstrap } from './apk-bootstrap-reader.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { TinaMobileWorld, toolSchemas } from '../src/world.mjs';
import { MobileStore } from '../src/store.mjs';
import { addBootstrap } from '../src/apk-bootstrap.mjs';
import { createServer, request as httpRequest } from 'node:http';
import { MobilePairing } from '../src/pairing.mjs';

const token = 'test-token-no-production-secret';
const appTemplatePresent = existsSync(new URL('../client/Coo-Mobile-0.6.0-dev.2-debug.apk', import.meta.url));
const input = (id, device = 'phone-a', text = '你好，手机原文') => ({ id, device_id: device, text, created_at: '2026-10-28T01:00:00+08:00' });

test('authenticated phone chunk route reports pending then verifiable bounded JSON', async t => {
  const upstream=createServer((req,res)=>{res.writeHead(200,{'content-type':'image/webp'});res.end(Buffer.alloc(2*1024*1024+7,51));});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>upstream.close(resolve)));
  const { context, request }=await fixture(t); context.cfg.petPort=upstream.address().port;
  const path='/v1/pet/resource?path=/packs/test/large.webp&transfer=chunks&offset=0';
  assert.equal((await request(path,undefined,false)).status,401);
  let response=await request(path); assert.equal(response.status,200);
  while(response.body.state==='pending') { await new Promise(r=>setTimeout(r,10));response=await request(path); }
  assert.equal(response.body.transfer,1);assert.equal(response.body.total,2*1024*1024+7);
  const last=await request('/v1/pet/resource?path=/packs/test/large.webp&transfer=chunks&offset=2097152&revision='+response.body.revision);
  assert.equal(Buffer.from(last.body.data,'base64').length,7);
});
function fakeHost() {
  const events = [];
  return {
    events, attempts: 0, fail: false,
    store: {
      latestCursor: () => events.at(-1)?.cursor ?? 0,
      range: q => events.filter(e => (q.source === undefined || e.source === q.source) && (q.senderKey === undefined || e.senderKey === q.senderKey)
        && (q.fromCursor === undefined || e.cursor >= q.fromCursor) && (q.toCursor === undefined || e.cursor <= q.toCursor)).slice(-(q.limit ?? events.length)),
    },
    async pushEvent(event, options) {
      this.attempts++;
      if (this.fail) throw new Error('simulated-disk-error');
      assert.equal(options.trigger, event.type === 'coo_mobile.pet_touch' ? 'piggyback' : 'flush');
      const saved = { ...event, cursor: events.length + 1 };
      events.push(saved); return saved;
    },
  };
}
async function fixture(t, host = fakeHost()) {
  const dir = mkdtempSync(join(tmpdir(), 'tina-mobile-world-'));
  const context = { cfg: { host: '127.0.0.1', port: 0, tokenSecret: 'TEST' }, dataDir: dir, botDir: dir,
    secret: name => { assert.equal(name, 'TEST'); return token; } };
  const world = new TinaMobileWorld(context);
  await world.start(host);
  t.after(async () => {
    await world.stop();
    const target = resolve(dir);
    assert.equal(dirname(target), resolve(tmpdir()), 'cleanup must remain directly inside the system temp directory');
    assert.match(basename(target), /^tina-mobile-world-/);
    rmSync(target, { recursive: true, force: true });
  });
  const request = async (path, body, auth = true) => {
    const response = await fetch(`http://127.0.0.1:${world.address().port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const flush = async () => { while (world.pending) await world.pending; };
  return { world, host, context, dir, request, flush };
}

test('local control rejects DNS-rebinding hosts without affecting the phone API', async t => {
  const { world } = await fixture(t);
  const port = world.address().port;
  const get = (path, host, authorization) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, headers: { host, ...(authorization ? { authorization } : {}) } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end();
  });
  for (const path of ['/_coo/ios-pair', '/_coo/install.apk', '/_coo/devices', '/_coo/easytier', '/_coo/model-panel', '/_coo/relay-apk', '/_coo/world-chat']) {
    for (const host of [`attacker.example:${port}`, `localhost.attacker.example:${port}`, 'localhost:1']) {
      assert.equal(await get(path, host), 403, `${path} should reject ${host}`);
    }
  }
  assert.equal(world.pairing.tickets.size, 0, 'an invalid host must not issue a pairing ticket');
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
    assert.equal(await get('/_coo/ios-pair', host), 200, `local host ${host} should be accepted`);
  }
  assert.equal(await get('/v1/health', `phone.example:${port}`, `Bearer ${token}`), 200, 'phone API must remain usable through a non-local host');
});

test('World control panel reads and updates shared room listening without exposing a model tool', async t => {
  const { world } = await fixture(t);
  const origin = `http://127.0.0.1:${world.address().port}`;
  let enabled = false, revision = 0;
  const writes = [];
  world.publicRelay.worldChat = async (operation, input) => {
    assert.equal(operation, 'bot-listen');
    if ('enabled' in input) {
      writes.push(input.enabled);
      if (enabled !== input.enabled) { enabled = input.enabled; revision++; }
    }
    return { bot_listen_enabled: enabled, bot_listen_revision: revision, bot_listen_start_cursor: 0 };
  };
  assert.ok(world.webUi().links.some(link => link.href.endsWith('/_coo/world-chat')));
  const page = await (await fetch(`${origin}/_coo/world-chat`)).text();
  assert.match(page, /已关闭/);
  const nonce = page.match(/name="nonce" value="([^"]+)"/)[1];
  const set = (values, source = origin) => fetch(`${origin}/_coo/world-chat`, { method: 'POST', redirect: 'manual',
    headers: { origin: source }, body: new URLSearchParams(values) });
  assert.equal((await set({ enabled: 'true', nonce }, 'http://other.local')).status, 403);
  assert.equal((await set({ enabled: 'true', nonce: 'wrong' })).status, 403);
  assert.deepEqual(writes, []);
  const response = await set({ enabled: 'true', nonce });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/_coo/world-chat');
  assert.deepEqual(writes, [true]);
  assert.match(await (await fetch(`${origin}/_coo/world-chat`)).text(), /正在收听/);
  enabled = false; revision++; // Same relay setting changed on the phone.
  assert.match(await (await fetch(`${origin}/_coo/world-chat`)).text(), /已关闭/);
});

test('authenticated durable intake, duplicate retry and explicit delivery transition', async t => {
  const { world, host, request, flush } = await fixture(t);
  assert.equal((await request('/v1/health', undefined, false)).status, 401);
  const health = await request('/v1/health');
  assert.equal(health.body.protocol, 'tina-mobile/1');
  assert.equal(health.body.pet_state_mirror, false);
  assert.equal(health.body.desktop_screen, false);
  assert.equal(health.body.world_market, false);
  assert.equal(health.body.model_catalog, false);
  assert.equal((await request('/v1/desktop-screen')).body.available, false);
  const first = await request('/v1/messages', input('msg-a'));
  assert.equal(first.status, 201);
  assert.equal(first.body.state, 'accepted');
  await flush();
  assert.equal(host.events.length, 1);
  assert.equal(host.events[0].origin, 'external');
  assert.equal(host.events[0].senderKey, 'msg-a');
  assert.match(host.events[0].text, /你好，手机原文/);
  assert.equal((await request('/v1/messages', input('msg-a'))).body.state, 'accepted', 'host queue is not delivered');
  assert.equal((await request('/v1/messages', input('msg-a', 'phone-a', 'changed'))).status, 409);
  assert.equal(host.events.length, 1);
  world.onEventsSettled(host.events, 'delivered');
  world.onEventsSettled(host.events, 'delivered');
  assert.equal((await request('/v1/messages', input('msg-a'))).body.state, 'delivered');
  const feed = (await request('/v1/feed?device_id=phone-a')).body;
  assert.deepEqual(feed.items.map(item => item.kind), ['user_message', 'message_state']);
  assert.equal(feed.items[1].state, 'delivered');
  assert.equal((await request('/v1/source?id=msg-a')).body.record.text, input('msg-a').text);
});

test('optional EasyTier panel is local and needs its nonce and same origin before download', async t => {
  const { world } = await fixture(t);
  const origin = `http://127.0.0.1:${world.address().port}`;
  const get = await fetch(`${origin}/_coo/easytier`);
  assert.equal(get.status, 200);
  const html = await get.text();
  assert.match(html, /跨网连接 · 可选组件/);
  assert.match(html, /默认不运行|不会自动运行或安装/);
  const headers = { 'content-type': 'application/x-www-form-urlencoded', origin };
  const noNonce = await fetch(`${origin}/_coo/easytier`, { method: 'POST', headers, body: 'kind=android' });
  assert.equal(noNonce.status, 403);
  const nonce = html.match(/name="nonce" value="([^"]+)"/)?.[1];
  assert.ok(nonce);
  const wrongOrigin = await fetch(`${origin}/_coo/easytier`, { method: 'POST', headers: { ...headers, origin: 'https://example.com' }, body: `nonce=${nonce}&kind=android` });
  assert.equal(wrongOrigin.status, 403);
  await assert.rejects(() => world.handle({ method: 'GET', url: '/_coo/easytier', socket: { remoteAddress: '192.168.3.8', localAddress: '192.168.3.2' } }, {}), /LOCAL_CONTROL_ONLY/);
});

test('iOS pairing is local to the host, temporary, and can be redeemed only once', async t => {
  const { world, request } = await fixture(t);
  const response = await fetch(`http://127.0.0.1:${world.address().port}/_coo/ios-pair`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<svg /); assert.ok(!html.includes(token), 'QR page does not contain the persistent secret');
  const code = html.match(/<code id="code">([A-Za-z0-9_-]{43})<\/code>/)?.[1];
  assert.ok(code, 'manual one-time code is available');
  const first = await request('/v1/ios/pair', { code }, false);
  assert.equal(first.status, 200); assert.equal(first.body.token, token);
  assert.equal(first.body.protocol, 'tina-mobile/1');
  assert.equal((await request('/v1/ios/pair', { code }, false)).status, 401, 'ticket cannot be replayed');
  assert.equal((await request('/v1/ios/pair', { code: 'not-a-code' }, false)).status, 401);
  await assert.rejects(() => world.handle({ method: 'GET', url: '/_coo/ios-pair', socket: { remoteAddress: '192.168.1.8', localAddress: '192.168.1.2' } }, {}), /LOCAL_PAIRING_ONLY/);
});

test('one World presents both client paths and the unsigned iOS test package locally', async t => {
  const { world } = await fixture(t);
  const origin = `http://127.0.0.1:${world.address().port}`;
  const links = world.webUi().links;
  const android = links.find(link => link.href === `${origin}/_coo/install.apk`);
  const ios = links.find(link => link.href === `${origin}/_coo/ios-unsigned.ipa`);
  assert.match(android?.label ?? '', /安卓.*APK/);
  assert.match(ios?.label ?? '', /iOS.*IPA.*未签名/);
  assert.equal((await fetch(android.href)).status, 200, 'the World card Android link downloads a package');
  assert.equal((await fetch(ios.href)).status, 200, 'the World card iOS link downloads a package');
  const panel = await fetch(`${origin}/_coo/devices`);
  assert.equal(panel.status, 200);
  const html = await panel.text();
  assert.match(html, /安卓手机/); assert.match(html, /苹果手机/);
  assert.match(html, /未签名/); assert.match(html, /尚未完成真机验证/);
  assert.match(html, /\/_coo\/install\.apk/); assert.match(html, /\/_coo\/ios-pair/);
  assert.ok(!html.includes(token), 'panel must not contain the private credential');
  for (const [route, file] of [
    ['/_coo/android-guide', 'Android-Guide.html'],
    ['/_coo/ios-guide', 'iOS-Guide.html'],
    ['/_coo/ios-source.zip', 'MilkCoo-iOS-0.2.2-source.zip'],
    ['/_coo/ios-altstore-guide', 'iOS-AltStore-Guide.html'],
    ['/_coo/ios-unsigned.ipa', 'MilkCoo-unsigned-0.2.2.ipa'],
  ]) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 200, route);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(new URL('../client/' + file, import.meta.url)));
    await assert.rejects(() => world.handle({ method: 'GET', url: route, socket: { remoteAddress: '192.168.1.8', localAddress: '192.168.1.2' } }, {}), /LOCAL_CLIENT_PANEL_ONLY/);
  }
  await assert.rejects(() => world.handle({ method: 'GET', url: '/_coo/devices', socket: { remoteAddress: '192.168.1.8', localAddress: '192.168.1.2' } }, {}), /LOCAL_CLIENT_PANEL_ONLY/);
});

test('Android and iOS share one World event stream while device conversation feeds remain separate', async t => {
  const { world, host, request, flush } = await fixture(t);
  const origin = `http://127.0.0.1:${world.address().port}`;
  const html = await (await fetch(`${origin}/_coo/ios-pair`)).text();
  const code = html.match(/<code id="code">([A-Za-z0-9_-]{43})<\/code>/)?.[1];
  assert.ok(code);
  assert.equal((await request('/v1/ios/pair', { code }, false)).body.token, token);
  assert.equal((await request('/v1/messages', input('android-test', 'android-device', '安卓合成消息'))).status, 201);
  assert.equal((await request('/v1/messages', input('ios-test', 'ios-device', '苹果合成消息'))).status, 201);
  await flush();
  assert.deepEqual(host.events.map(event => event.senderKey).sort(), ['android-test', 'ios-test']);
  const android = (await request('/v1/feed?device_id=android-device')).body.items;
  const ios = (await request('/v1/feed?device_id=ios-device')).body.items;
  assert.ok(android.some(row => row.id === 'android-test') && !android.some(row => row.id === 'ios-test'));
  assert.ok(ios.some(row => row.id === 'ios-test') && !ios.some(row => row.id === 'android-test'));
  const events = (await request('/v1/coo-events?after=0')).body.events;
  assert.equal(events.length, 2, 'shared host event stream exposes both accepted events');
});

test('pairing expires, is invalidated by refresh, and is removed on shutdown', () => {
  let now = 1000; const pairing = new MobilePairing({ now: () => now, lifetimeMs: 500 });
  const one = pairing.create('http://192.168.1.2:7800');
  assert.ok(one.uri.startsWith('coomilk://pair?'));
  const two = pairing.create('http://192.168.1.2:7800');
  assert.equal(pairing.consume(one.code), false);
  now = 1500; assert.equal(pairing.consume(two.code), false);
  const three = pairing.create('http://192.168.1.2:7800');
  pairing.clear(); assert.equal(pairing.consume(three.code), false);
});

test('screen frames stay on demand unless the owner enables proactive viewing and the model supports images', async t => {
  const { world, host, request, flush } = await fixture(t);
  host.modelFacts = { accepts: () => true };
  world.canAcceptImage = async () => host.modelFacts.accepts();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const frame = { device_id: 'phone-a', session_id: 'first-session', captured_at: new Date().toISOString(), mime: 'image/jpeg', data: jpeg.toString('base64'), proactive: false };
  assert.equal((await request('/v1/screen', frame, false)).status, 401);
  assert.equal((await request('/v1/screen', frame)).body.proactive_delivered, false);
  assert.equal(host.events.length, 0);
  const read = dockTool(world, 'screen');
  const outcome = await read.handler({}, {});
  assert.deepEqual(outcome.blobs[0].bytes, jpeg);
  assert.match(outcome.text, /采集时间/);
  await request('/v1/screen', { ...frame, session_id: 'second-session', proactive: true });
  assert.equal(host.events.length, 1);
  assert.equal(host.events[0].type, 'coo_mobile.screen');
  const peek = await request('/v1/screen', { ...frame, session_id: 'second-session', proactive: false, peek: true });
  assert.equal(peek.body.peek_queued, true); await flush();
  assert.equal(host.events.length, 2);
  assert.equal(host.events[1].type, 'coo_mobile.message');
  assert.equal(host.events[1].meta.message_id, peek.body.message_id);
  assert.deepEqual(host.events[1].blobs[0].bytes, jpeg);
  assert.match(host.events[1].text, /看一眼/);
  const reply = dockTool(world, 'reply');
  await reply.handler({ device_id: 'phone-a', in_reply_to: peek.body.message_id, text: '看到了' }, { role: 'assistant', callId: 'peek-reply' });
  assert.ok((await request('/v1/feed?device_id=phone-a')).body.items.some(row => row.kind === 'assistant_message' && row.text === '看到了'));
  host.modelFacts.accepts = () => false;
  assert.equal((await request('/v1/screen', { ...frame, session_id: 'second-session', proactive: true })).body.proactive_delivered, false);
  assert.equal(host.events.length, 2);
  assert.equal((await read.handler({}, {})).failed, true);
  const endpoint = `http://127.0.0.1:${world.address().port}/v1/screen?device_id=phone-a`;
  const del = session => fetch(`${endpoint}&session_id=${session}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  assert.equal((await del('first-session')).status, 200);
  assert.ok(world.screenFrames.has('phone-a'), 'an old session cannot delete the new session');
  await del('second-session');
  assert.equal(world.screenFrames.has('phone-a'), false);
});

test('camera sessions keep frames separate, allow joint quality control, and never start from a model tool', async t => {
  const { world, host, request } = await fixture(t);
  world.canAcceptImage = async () => true;
  const control = dockTool(world, 'camera_control');
  const look = dockTool(world, 'camera');
  assert.equal((await control.handler({ device_id: 'phone-a', quality: 'high' }, {})).failed, true);
  const session = { device_id: 'phone-a', session_id: 'cam-a', quality: 'balanced', interval_sec: 10, adaptive: true, proactive: false };
  assert.equal((await request('/v1/camera/session', session, false)).status, 401);
  assert.equal((await request('/v1/camera/session', session)).status, 200);
  assert.equal((await look.handler({ device_id: 'phone-a' }, {})).failed, true);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const frame = { device_id: 'phone-a', session_id: 'cam-a', captured_at: new Date().toISOString(), mime: 'image/jpeg', data: jpeg.toString('base64') };
  assert.equal((await request('/v1/camera/frame', { ...frame, session_id: 'old' })).status, 409);
  const observed = await request('/v1/camera/frame', frame);
  assert.equal(observed.body.proactive_delivered, false); assert.equal(host.events.length, 0);
  assert.deepEqual((await look.handler({ device_id: 'phone-a' }, {})).blobs[0].bytes, jpeg);
  assert.equal(world.screenFrames.size, 0, 'camera frames are not phone screenshots');
  const changed = JSON.parse(await control.handler({ device_id: 'phone-a', quality: 'high', interval_sec: 4 }, {}));
  assert.equal(changed.quality, 'high'); assert.equal(changed.interval_sec, 4); assert.equal(changed.proactive, false);
  const poll = await request('/v1/camera/control?device_id=phone-a&session_id=cam-a');
  assert.equal(poll.body.quality, 'high'); assert.equal(poll.body.revision, changed.revision);
  await request('/v1/camera/control', { device_id: 'phone-a', session_id: 'cam-a', proactive: true, quality: 'low' });
  assert.equal((await request('/v1/camera/frame', frame)).body.proactive_delivered, true);
  assert.equal(host.events.length, 1); assert.equal(host.events[0].type, 'coo_mobile.camera');
  const say = dockTool(world, 'camera_say');
  const reply = JSON.parse(await say.handler({ device_id: 'phone-a', text: '看到了。' }, { role: 'assistant', callId: 'camera-call' }));
  assert.equal(reply.state, 'queued_for_phone');
  const repeat = JSON.parse(await say.handler({ device_id: 'phone-a', text: '看到了。' }, { role: 'assistant', callId: 'camera-call' }));
  assert.equal(repeat.id, reply.id, 'the same tool call does not duplicate a reply');
  const feed = (await request('/v1/feed?device_id=phone-a')).body.items;
  assert.equal(feed.filter(item => item.id === reply.id).length, 1);
  assert.equal(world.store.get(reply.id).in_reply_to, null, 'camera replies are never fabricated as a user message');
  assert.equal((await request('/v1/camera/frame', frame)).body.proactive_delivered, false, 'rapid frames do not queue model calls');
  world.cameraSessions.get('phone-a').last_wake = Date.now() - 20000;
  assert.equal((await request('/v1/camera/frame', frame)).body.proactive_delivered, false, 'an unsettled frame applies backpressure even after the time interval');
  world.onEventsSettled([host.events[0]], 'delivered');
  assert.equal((await request('/v1/camera/frame', { ...frame, changed: false })).body.proactive_delivered, false, 'unchanged frames do not repeatedly wake the model');
  assert.equal((await request('/v1/camera/frame', { ...frame, changed: true })).body.proactive_delivered, true, 'a changed frame can be sent after the earlier event settles');
  const url = `http://127.0.0.1:${world.address().port}/v1/camera/session?device_id=phone-a&session_id=cam-a`;
  assert.equal((await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await look.handler({ device_id: 'phone-a' }, {})).failed, true);
  assert.equal((await say.handler({ device_id: 'phone-a', text: '已停止' }, { callId: 'after-stop' })).failed, true);
});

test('phone pet menu writes only supported shared preferences to its paired desktop pet', async t => {
  const received = [];
  const upstream = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/prefs') { res.writeHead(404).end(); return; }
    let data = ''; for await (const chunk of req) data += chunk;
    received.push(JSON.parse(data)); res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const { context, request } = await fixture(t); context.cfg.petPort = upstream.address().port;
  assert.equal((await request('/v1/pet/prefs', { sound: false }, false)).status, 401);
  assert.equal((await request('/v1/pet/prefs', { sound: false, theme: 'dark' })).status, 200);
  assert.deepEqual(received, [{ sound: false, theme: 'dark' }]);
  assert.equal((await request('/v1/pet/prefs', { mic: true })).status, 400);
  assert.equal(received.length, 1);
});

test('new arrivals during a slow push dispatch immediately without the retry timer', async t => {
  const host = fakeHost(), push = host.pushEvent;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  host.pushEvent = async function(event, options) {
    if (event.senderKey === 'slow-first') await gate;
    return push.call(this, event, options);
  };
  const { world, request, flush } = await fixture(t, host);
  clearInterval(world.timer);
  await request('/v1/messages', input('slow-first'));
  await request('/v1/messages', input('arrived-during-push'));
  assert.equal(host.events.length, 0);
  release(); await flush();
  assert.deepEqual(host.events.map(e => e.senderKey), ['slow-first', 'arrived-during-push']);
  assert.equal(world.store.pending().length, 0);
});

test('coalesced dispatch failure does not hot-loop and stop does not restart dispatch', async t => {
  const host = fakeHost();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  host.pushEvent = async function() {
    this.attempts++;
    if (this.attempts === 1) await gate;
    throw new Error('persistent failure');
  };
  const { world, request, flush } = await fixture(t, host);
  clearInterval(world.timer);
  await request('/v1/messages', input('failure-first'));
  await request('/v1/messages', input('failure-second'));
  world.kick(); world.kick();
  release(); await flush();
  assert.equal(host.attempts, 2, 'only a coalesced new request retries immediately, not the failed row count');
  assert.equal(world.store.pending().length, 2);

  let releaseStop;
  const stopGate = new Promise(resolve => { releaseStop = resolve; });
  host.pushEvent = async function(event) { this.attempts++; await stopGate; return { ...event, cursor: 1 }; };
  world.kick(); world.kick();
  const stopping = world.stop();
  releaseStop(); await stopping;
  assert.equal(host.attempts, 3, 'stop must prevent the requested follow-up run');
  assert.equal(world.pending, null);
});

test('World prompt document includes the API 6 description field', () => {
  const world = new TinaMobileWorld({});
  const doc = world.webUi().promptDocs[0];
  assert.equal(typeof doc.description, 'string');
  assert.ok(doc.description.length > 0);
  const manifest = JSON.parse(readFileSync(new URL('../describe.json', import.meta.url), 'utf8'));
  const prompt = manifest.prompts.find(item => item.key === doc.key);
  assert.equal(doc.key, 'worlds.milkcoo-app.envPrompt');
  assert.equal(prompt.content, readFileSync(new URL('../ENV_PROMPT.md', import.meta.url), 'utf8'), 'manifest prompt must match the live World prompt');
  assert.deepEqual(manifest.tools, toolSchemas);
  assert.deepEqual(manifest.tools.map(tool => tool.name), ['coodock_use']);
});

test('auto-generated connection secret survives World restart and personalized APK is local-only', { skip: !appTemplatePresent }, async t => {
  const { world, host, context } = await fixture(t);
  await world.stop();
  let saved = '', writes = 0;
  context.secret = () => saved;
  context.storeSecret = (_, value) => { saved = value; writes++; };
  await world.start(host);
  assert.equal(writes, 1); assert.ok(saved.length >= 32);
  assert.ok(world.personalApk?.length > 0, world.appError);
  for (const [route, variant] of [['install.apk', ''], ['install-workbench.apk', '-workbench']]) {
    const response = await fetch(`http://127.0.0.1:${world.address().port}/_coo/${route}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-disposition'), `attachment; filename="CooDock${variant}-personal.apk"`);
    const apk = Buffer.from(await response.arrayBuffer());
    assert.ok(apk.includes(Buffer.from(saved)), 'only the private instance APK receives the secret');
    const generic = readFileSync(new URL(`../client/Coo-Mobile-0.6.0-dev.2${variant}-debug.apk`, import.meta.url));
    assert.ok(!generic.includes(Buffer.from(saved)));
  }
  await assert.rejects(() => world.handle({ method: 'GET', url: '/_coo/install.apk', socket: { remoteAddress: '192.168.1.8' } }, {}), /LOCAL_DOWNLOAD_ONLY/);
  const original = saved;
  await world.stop(); await world.start(host);
  assert.equal(writes, 1); assert.equal(saved, original);
});

test('APK connection payload replaces previous payload without changing original template', { skip: !appTemplatePresent }, () => {
  const template = readFileSync(new URL('../client/Coo-Mobile-0.6.0-dev.2-debug.apk', import.meta.url));
  const first = addBootstrap(template, { endpoint: 'http://192.168.2.3:7800', token: 'first-secret' });
  const second = addBootstrap(first, { endpoint: 'http://192.168.2.4:7800', token: 'second-secret' });
  assert.ok(first.includes(Buffer.from('first-secret')));
  assert.ok(second.includes(Buffer.from('second-secret')));
  assert.ok(!second.includes(Buffer.from('first-secret')));
  assert.ok(!template.includes(Buffer.from('first-secret')));
  assert.throws(() => addBootstrap(Buffer.from('not-apk'), {}), /APK_EOCD_NOT_FOUND/);
});

test('public APK requires the local form, binds the submitted key and embeds only relay setup', { skip: !appTemplatePresent }, async t => {
  const { world } = await fixture(t);
  const origin = `http://127.0.0.1:${world.address().port}`;
  const key = `mck_${'x'.repeat(43)}`;
  const bound = [];
  world.publicRelay.bind = async value => { bound.push(value); };
  const panel = await fetch(`${origin}/_coo/relay-apk`);
  assert.equal(panel.status, 200);
  assert.equal(panel.headers.get('referrer-policy'), 'same-origin');
  const html = await panel.text();
  assert.match(html, /https:\/\/htina\.top\//);
  assert.match(html, /type="password"/);
  assert.ok(!html.includes(token));
  const body = new URLSearchParams({ nonce: world.panelNonce, key, variant: 'companion' });
  const post = (source, values = body) => fetch(`${origin}/_coo/relay-apk`, { method: 'POST', headers: { origin: source }, body: values });
  assert.equal((await post('https://elsewhere.invalid')).status, 403);
  assert.equal((await post('null')).status, 403);
  assert.equal((await post(origin, new URLSearchParams({ key, variant: 'companion' }))).status, 403);
  assert.equal((await post(origin, new URLSearchParams({ nonce: world.panelNonce, variant: 'companion' }))).status, 400);
  assert.deepEqual(bound, []);
  const generated = await post(origin);
  assert.equal(generated.status, 200);
  assert.equal(generated.headers.get('cache-control'), 'no-store');
  const apk = Buffer.from(await generated.arrayBuffer());
  const setup = { v: 1, relay: { origin: 'https://8.137.59.209', key } };
  const bootstrap = readBootstrap(apk);
  assert.deepEqual({ v: bootstrap.v, relay: bootstrap.relay }, setup);
  assert.equal(bootstrap.ecosystem.version, 1);
  assert.deepEqual(bootstrap.ecosystem.services.map(s => s.id), ['starpost', 'flower-town', 'bottle']);
  assert.equal(bootstrap.ecosystem.handoff, undefined, 'No service credential means no fabricated login ticket');
  assert.ok(!apk.includes(Buffer.from(token)));
  assert.deepEqual(bound, [key]);
});

test('global event pages include all sources in cursor order without skipping bursts', async t => {
  const { request, host } = await fixture(t);
  for (let i = 1; i <= 205; i++) host.events.push({ cursor: i, source: i % 2 ? 'qq' : 'desktop-pet', type: 'test', text: `event-${i}`, ts: '2026-10-28T00:00:00Z' });
  assert.equal((await request('/v1/coo-events?after=0', undefined, false)).status, 401);
  let after = 0; const seen = [];
  for (let i = 0; i < 3; i++) {
    const response = await request(`/v1/coo-events?after=${after}&limit=100`);
    assert.equal(response.status, 200); seen.push(...response.body.events); after = response.body.next_cursor;
  }
  assert.deepEqual(seen.map(e => e.cursor), Array.from({ length: 205 }, (_, i) => i + 1));
  assert.deepEqual(new Set(seen.map(e => e.source)), new Set(['qq', 'desktop-pet']));
  assert.equal((await request('/v1/coo-events?after=300')).status, 409);
  assert.equal((await request('/v1/coo-events?limit=101')).status, 400);
});

test('phone World directory uses only the documented runtime list and requires a token', async t => {
  const { world, request } = await fixture(t);
  world.modelControl.request = async path => {
    assert.equal(path, '/api/worlds');
    return { worlds: [
      { id: 'weather', label: '天气', status: 'active', workspace: '/private', envPrompt: 'secret-prompt' },
      { id: 'timer', status: 'inactive' }, { id: 'missing', status: 'missing' },
    ] };
  };
  assert.equal((await request('/v1/worlds', undefined, false)).status, 401);
  const result = await request('/v1/worlds');
  assert.deepEqual(result.body.worlds, [
    { id: 'weather', label: '天气', enabled: true }, { id: 'timer', label: 'timer', enabled: false },
    { id: 'missing', label: 'missing', enabled: null },
  ]);
  assert.ok(!JSON.stringify(result.body).includes('secret-prompt'));
});

test('World library is explicitly partial and the undocumented market route is not used', async t => {
  const { world, request } = await fixture(t);
  world.modelControl.request = async path => {
    assert.equal(path, '/api/worlds');
    return { worlds: [ { id: 'desktop-pet', label: '桌宠', status: 'active', visible: true, workspace: '/private', envPrompt: 'secret-prompt' } ] };
  };
  assert.equal((await request('/v1/world-library', undefined, false)).status, 401);
  assert.equal((await request('/v1/world-market', undefined, false)).status, 401);
  const library = await request('/v1/world-library');
  assert.equal(library.status, 200); assert.equal(library.body.partial, true);
  assert.deepEqual(library.body.worlds.map(w => w.id), ['desktop-pet']);
  assert.ok(!JSON.stringify(library.body).includes('secret-prompt'));
  const market = await request('/v1/world-market');
  assert.equal(market.status, 503); assert.match(market.body.error, /电脑 Coo/);
});

test('phone touch is durable and joins the shared event stream without a new model call', async t => {
  const { request, host, flush, world } = await fixture(t);
  const touch = { id: 'touch-1', device_id: 'phone-a', kind: 'pet', created_at: '2026-10-28T01:00:00+08:00' };
  assert.equal((await request('/v1/pet/touch', touch)).status, 201);
  await flush();
  assert.equal(host.events.length, 1);
  assert.equal(host.events[0].type, 'coo_mobile.pet_touch');
  assert.equal(host.events[0].meta.touch, 'pet');
  assert.equal((await request('/v1/pet/touch', touch)).status, 200);
  await flush(); assert.equal(host.events.length, 1);
  assert.equal((await request('/v1/pet/touch', { ...touch, kind: 'invented' })).status, 400);
  world.onEventsSettled(host.events, 'delivered');
  assert.equal(world.store.get('touch-1').delivery_state, 'delivered');
});

test('pet resources are authenticated, read only, and restricted to figure assets', async t => {
  const upstream = createServer((req, res) => {
    if (req.url === '/web/figure.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('export const figure=1'); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const { world, context } = await fixture(t);
  context.cfg.petPort = upstream.address().port;
  const base = `http://127.0.0.1:${world.address().port}/v1/pet/resource?path=`;
  const url = base + encodeURIComponent('/web/figure.js');
  assert.equal((await fetch(url)).status, 401);
  let response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'text/javascript');
  assert.equal(await response.text(), 'export const figure=1');
  response = await fetch(base + encodeURIComponent('/api/prefs'), { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 404);
  response = await fetch(base + encodeURIComponent('/web/../api/state'), { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 400);
  response = await fetch(base + encodeURIComponent('/web/%252e%252e/api/state'), { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 400);
});

test('archive-only host receipt is explicitly discarded without guessing delivered or waking again', async t => {
  const host = fakeHost(), push = host.pushEvent;
  host.pushEvent = async function(event, options) {
    const saved = await push.call(this, event, options);
    saved.contextDelivery = 'archive-only';
    return saved;
  };
  const { world, request, flush } = await fixture(t, host);
  await request('/v1/messages', input('hidden-input')); await flush();
  const feed = (await request('/v1/feed?device_id=phone-a')).body;
  assert.deepEqual(feed.items.map(item => item.kind), ['user_message', 'message_state']);
  assert.equal(feed.items[1].state, 'discarded');
  assert.match(feed.items[1].text, /仅归档未进入对话/);
  assert.equal(world.store.get('hidden-input').delivery_state, 'discarded');
  assert.equal((await request('/v1/source?id=hidden-input')).body.record.text, input('hidden-input').text);
  await request('/v1/messages', input('hidden-input')); await flush();
  assert.equal(host.events.length, 1);
  await world.stop(); await world.start(host); await flush();
  assert.equal(host.events.length, 1);
  assert.equal((await request('/v1/feed?device_id=phone-a')).body.items.length, 2);
});

test('facts are sourced, silent and idempotent; feed pagination is stable and device-specific', async t => {
  const { host, request } = await fixture(t);
  const fact = { ...input('fact-1'), source_ref: 'ref://dsh/session-a/event-2' };
  assert.equal((await request('/v1/facts', input('bad-fact'))).status, 400);
  assert.equal((await request('/v1/facts', fact)).status, 201);
  assert.equal((await request('/v1/facts', fact)).status, 200);
  assert.equal((await request('/v1/facts', { ...fact, source_ref: 'ref://different' })).status, 409);
  await request('/v1/facts', { ...input('fact-2', 'phone-b'), source_ref: 'ref://other' });
  await request('/v1/facts', { ...input('fact-3'), source_ref: 'ref://third' });
  assert.equal(host.events.length, 0, 'fact receipt must not wake Cortico');
  const first = (await request('/v1/feed?device_id=phone-a&limit=1')).body;
  assert.equal(first.items[0].id, 'fact-1'); assert.equal(first.has_more, true);
  const next = (await request(`/v1/feed?device_id=phone-a&limit=1&after=${first.next_cursor}`)).body;
  assert.equal(next.items[0].id, 'fact-3'); assert.equal(next.has_more, false);
  const empty = (await request(`/v1/feed?device_id=phone-a&after=${next.next_cursor}`)).body;
  assert.equal(empty.next_cursor, next.next_cursor); assert.deepEqual(empty.items, []);
  const source = (await request('/v1/source?id=fact-1')).body;
  assert.equal(source.record.source_ref, fact.source_ref); assert.equal(source.external_source_retrieved, false);
  assert.equal((await request('/v1/feed?device_id=phone-a&limit=101')).status, 400);
});

test('reply uses stable native call identity, retains original and does not wake another model', async t => {
  const { world, host, request, flush } = await fixture(t);
  await request('/v1/messages', input('msg-r')); await flush();
  const reply = dockTool(world, 'reply').handler;
  const args = { device_id: 'phone-a', in_reply_to: 'msg-r', text: '哥哥，已接通。' };
  const call = { role: 'tina', callId: 'native-call-1' };
  const a = JSON.parse(await reply(args, call));
  const b = JSON.parse(await reply(args, call));
  assert.equal(a.id, b.id); assert.equal(a.server_seq, b.server_seq); assert.equal(a.phone_read, 'unknown');
  const conflict = await reply({ ...args, text: 'changed reply' }, call);
  assert.equal(conflict.failed, true); assert.match(conflict.text, /ID_PAYLOAD_CONFLICT/);
  const missingId = await reply(args, { role: 'tina' });
  assert.equal(missingId.failed, true); assert.match(missingId.text, /STABLE_CALL_ID_REQUIRED/);
  const otherDevice = await reply({ ...args, device_id: 'phone-b' }, { ...call, callId: 'different' });
  assert.equal(otherDevice.failed, true);
  assert.equal(host.events.length, 1);
  const feed = (await request('/v1/feed?device_id=phone-a')).body;
  assert.equal(feed.items.filter(item => item.kind === 'assistant_message').length, 1);
  const source = (await request(`/v1/source?id=${a.id}`)).body.record;
  assert.equal(source.text, args.text); assert.equal(source.in_reply_to, 'msg-r');
});

test('restart recovers dispatch after failure and does not duplicate a host-persisted event', async t => {
  const { world, host, request, flush } = await fixture(t);
  host.fail = true;
  await request('/v1/messages', input('pending')); await flush();
  assert.equal(world.store.pending().length, 1);
  const originalServerId = (await request('/v1/health')).body.server_id;
  await world.stop(); host.fail = false; await world.start(host); await flush();
  assert.equal(host.events.length, 1);
  assert.equal((await request('/v1/health')).body.server_id, originalServerId);
  // Model a crash gap: host persisted the event, local cursor write did not happen.
  world.store.db.prepare('UPDATE records SET host_cursor=NULL WHERE id=?').run('pending');
  await world.stop(); await world.start(host); await flush();
  assert.equal(host.events.length, 1);
  assert.equal(world.store.get('pending').host_cursor, 1);
  world.onEventsSettled(host.events, 'discarded');
  await world.stop(); await world.start(host); await flush();
  await request('/v1/messages', input('pending')); await flush();
  assert.equal(host.events.length, 1, 'duplicate POST cannot resurrect discarded input');
  assert.equal((await request('/v1/feed?device_id=phone-a')).body.items.at(-1).state, 'discarded');
});

test('upgrading the World recovers the legacy event cursor without sending the message twice', async t => {
  const { world, host, request, flush } = await fixture(t);
  const original = input('before-id-upgrade');
  host.events.push({
    cursor: 1, source: 'milkcoo_app', type: 'coo_mobile.message', senderKey: original.id,
    meta: { device_id: original.device_id, message_id: original.id }, contextDelivery: 'archive-only',
  });
  assert.equal((await request('/v1/messages', original)).status, 201);
  await flush();
  assert.equal(host.attempts, 0);
  const stored = world.store.get(original.id);
  assert.equal(stored.host_cursor, 1);
  assert.equal(stored.delivery_state, 'discarded');
});

test('authenticated discovery keeps the same database identity across address and credential changes', async t => {
  const first = await fixture(t);
  const other = await fixture(t);
  const before = (await first.request('/v1/health')).body.server_id;
  assert.match(before, /^[0-9a-f-]{36}$/i);
  assert.notEqual((await other.request('/v1/health')).body.server_id, before,
    'the same credential on a different database is not the same server');
  await first.request('/v1/messages', input('identity-message'));
  const portBefore = first.world.address().port;
  await first.world.stop();
  const rotatedToken = 'rotated-test-token-no-production-secret';
  first.context.secret = () => rotatedToken;
  // Keep the old ephemeral port occupied so the new endpoint cannot reuse it.
  const oldPort = createServer();
  await new Promise((resolve, reject) => oldPort.once('error', reject).listen(portBefore, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => oldPort.close(resolve)));
  await first.world.start(first.host);
  assert.notEqual(first.world.address().port, portBefore);
  const origin = `http://127.0.0.1:${first.world.address().port}`;
  const get = (path, auth) => fetch(origin + path, { headers: { authorization: `Bearer ${auth}` } });
  assert.equal((await get('/v1/health', token)).status, 401, 'the old credential no longer authenticates');
  const health = await get('/v1/health', rotatedToken);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).server_id, before);
  const feed = await (await get('/v1/feed?device_id=phone-a', rotatedToken)).json();
  assert.equal(feed.server_id, before);
  assert.ok(feed.items.some(item => item.id === 'identity-message'));
});

test('one transaction rolls back both original and feed when feed insertion fails', () => {
  const store = new MobileStore(':memory:');
  try {
    store.db.exec("CREATE TRIGGER fail_feed BEFORE INSERT ON feed BEGIN SELECT RAISE(ABORT, 'simulated disk error'); END;");
    assert.throws(() => store.insert(input('rollback'), 'user_message'));
    assert.equal(store.get('rollback'), null);
    assert.equal(store.feed('phone-a', 0, 100).items.length, 0);
  } finally { store.close(); }
});

test('stop releases HTTP and SQLite for restart; startup failure cleans up', async t => {
  const { world, context, host } = await fixture(t);
  const port = world.address().port;
  const second = new TinaMobileWorld({ ...context, cfg: { ...context.cfg, port } });
  await assert.rejects(second.start(host), { code: 'EADDRINUSE' });
  assert.equal(second.store, null); assert.equal(second.server, null);
  await world.stop();
  await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/health`));
  await second.start(host); await second.stop();
  await world.start(host);
});
