import { readBootstrap } from './apk-bootstrap-reader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { TinaMobileWorld } from '../src/world.mjs';

const TOKEN = 'synthetic-ecosystem-world-token';
const TEMPLATE = new URL('../client/Coo-Mobile-0.6.0-dev.2-debug.apk', import.meta.url);
const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

async function fixture(t, providers = []) {
  const dir = mkdtempSync(join(tmpdir(), 'coodock-ecosystem-world-'));
  const secrets = new Map([['TEST', TOKEN]]);
  const host = {
    store: { range: () => [], latestCursor: () => 0 },
    async pushEvent() { assert.fail('Service navigation and authentication must not wake a model'); },
  };
  const world = new TinaMobileWorld({
    cfg: { host: '127.0.0.1', port: 0, tokenSecret: 'TEST', advertiseHost: '127.0.0.1' },
    dataDir: dir, botDir: dir,
    secret: key => secrets.get(key), storeSecret: (key, value) => secrets.set(key, value),
    ecosystemAuthProviders: providers,
  });
  await world.start(host);
  // Printing must not query an actual Cortico installation on this machine.
  world.workbenchBridge.desktop.request = async path => {
    assert.equal(path, '/api/worlds');
    return { worlds: [] };
  };
  t.after(async () => {
    await world.stop();
    const target = resolve(dir);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.match(basename(target), /^coodock-ecosystem-world-/);
    rmSync(target, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${world.address().port}`;
  const api = (path, body, authenticated = true) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST', headers: authenticated ? headers : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const owner = (method, input = {}, options = {}) => fetch(base + '/_coo/ecosystem-control', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: options.origin ?? base,
      'x-coo-panel': options.nonce ?? world.panelNonce }, body: JSON.stringify({ method, input }),
  });
  return { world, secrets, base, api, owner };
}

function identityProvider() {
  return {
    id: 'ins-identity', title: 'Fixture identity provider',
    begin: async () => ({ flowId: 'fixture-flow', authorizationUrl: 'https://fixture.invalid/authorize' }),
    complete: async input => {
      assert.equal(input.code, 'fixture-verified');
      return { sessions: ['starpost', 'flower-town', 'bottle'].map(serviceId => ({
        serviceId, issuer: 'https://fixture.invalid', subject: 'human-fixture', botId: 'tina-fixture',
        displayName: '合成账号', credential: { kind: 'bearer', accessToken: `private-${serviceId}-fixture` },
      })) };
    },
  };
}

async function login(owner) {
  const begun = await owner('login', { action: 'begin', providerId: 'ins-identity' });
  assert.equal(begun.status, 200);
  assert.equal((await begun.json()).flowId, 'fixture-flow');
  const completed = await owner('login', { action: 'complete', providerId: 'ins-identity', flowId: 'fixture-flow', code: 'fixture-verified' });
  assert.equal(completed.status, 200);
  const result = await completed.json();
  assert.equal(result.sessions.length, 3);
  assert.doesNotMatch(JSON.stringify(result), /accessToken|private-starpost/);
}


test('real World protects ecosystem APIs and reports the unprovided Flower Town frontend honestly', async t => {
  const { api } = await fixture(t);
  for (const path of ['/v1/ecosystem', '/v1/ecosystem/frontends', '/v1/ecosystem/sessions']) {
    assert.equal((await api(path, undefined, false)).status, 401);
  }
  assert.equal((await api('/v1/ecosystem/invoke', { serviceId: 'bottle', method: 'GET', path: '/status' }, false)).status, 401);
  const manifest = await (await api('/v1/ecosystem/frontends')).json();
  assert.equal(manifest.services.find(item => item.id === 'flower-town').platforms.android.state, 'awaiting-upstream');
  const catalog = await (await api('/v1/ecosystem')).json();
  assert.equal(catalog.providers.find(item => item.id === 'ins-identity').state, 'pending');
  assert.ok(catalog.services.every(item => item.authState === 'signed-out'));
  const unavailable = await api('/v1/ecosystem/invoke', { serviceId: 'flower-town', method: 'GET', path: '/status' });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error, 'SERVICE_FRONTEND_AWAITING_AUTHOR');
});

test('real World native Bottle invoke returns upstream JSON and refuses to deliver an HTML page', async t => {
  const { world, api } = await fixture(t);
  const upstreamCalls = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamCalls.push({ method: req.method, path: req.url,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null, bottle: req.headers['x-bottle'] });
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>Original Bottle UI fixture</body></html>');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bottles: [{ id: 'fixture-letter', text: '合成来信' }], upstream: 'unchanged' }));
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  world.modelControl.request = async path => {
    assert.equal(path, '/api/webui/providers/world%3Abottle/panels/mailbox/status');
    return { url: `http://127.0.0.1:${upstream.address().port}/` };
  };
  const response = await api('/v1/ecosystem/invoke', { serviceId: 'bottle', method: 'POST', path: '/pick', body: { count: 1 } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, bottles: [{ id: 'fixture-letter', text: '合成来信' }], upstream: 'unchanged' });
  assert.deepEqual(upstreamCalls[0], { method: 'POST', path: '/pick', body: { count: 1 }, bottle: '1' });
  const html = await api('/v1/ecosystem/invoke', { serviceId: 'bottle', method: 'GET', path: '/' });
  assert.equal(html.status, 502);
  assert.equal((await html.json()).error, 'BOTTLE_JSON_UNAVAILABLE');
});

const androidRequests = JSON.parse(readFileSync(new URL('../../paid-relay/fixtures/android-service-frontend-requests.json', import.meta.url), 'utf8'));
for (const sample of androidRequests.requests) {
  test(`real World carries Android ${sample.name} operation and scene to its service adapter`, async t => {
    const { world, api } = await fixture(t);
    const calls = [];
    world.frontends.register('bottle', { async invoke(input) {
      calls.push(input);
      return { status: 200, body: { accepted: true } };
    } });
    const direct = structuredClone(sample.payload);
    const viaRelay = structuredClone(sample.payload);
    if (viaRelay.body === null) delete viaRelay.body;
    // Both an installed client's direct call and the relay's no-body form work.
    for (const payload of [direct, viaRelay]) {
      const response = await api('/v1/ecosystem/invoke', payload);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { accepted: true });
    }
    assert.equal(calls.length, 2);
    for (const [index, call] of calls.entries()) {
      const sent = [direct, viaRelay][index];
      assert.equal(call.method, sent.method);
      assert.equal(call.path, sent.path);
      assert.deepEqual(call.body, sent.body);
      assert.deepEqual(call.context, { ...sent.context, serviceId: sent.serviceId, operationId: sent.operationId });
    }
  });
}

test('Owner page shows pending common login and requires local host, origin and nonce for mutations', async t => {
  const { world, base, owner } = await fixture(t);
  const page = await fetch(base + '/_coo/ecosystem');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /等待星邮提供方接入/);
  assert.match(html, /id="login" disabled/);
  assert.doesNotMatch(html, new RegExp(TOKEN));
  const wrongHost = path => new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: world.address().port, path,
      headers: { host: `unrelated.invalid:${world.address().port}` } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.end();
  });
  assert.equal(await wrongHost('/_coo/ecosystem'), 403);
  assert.equal(await wrongHost('/_coo/ecosystem-control'), 403);
  assert.equal((await owner('login', {}, { origin: 'https://unrelated.invalid' })).status, 403);
  assert.equal((await owner('login', {}, { nonce: 'wrong-nonce' })).status, 403);
  const pending = await owner('login', { action: 'begin' });
  assert.equal(pending.status, 409);
  assert.equal((await pending.json()).error, 'ECOSYSTEM_PROVIDER_PENDING');
  const overview = await owner('overview');
  assert.equal(overview.status, 200);
  assert.equal((await overview.json()).providers[0].state, 'pending');
});

test('registered identity provider logs in through the World Owner route without exposing service tokens', async t => {
  const { owner, api, base } = await fixture(t, [identityProvider()]);
  await login(owner);
  const catalog = await (await api('/v1/ecosystem')).json();
  assert.ok(catalog.services.every(item => item.authState === 'connected'));
  assert.ok(catalog.services.every(item => item.accounts[0].subject === 'human-fixture'));
  assert.doesNotMatch(JSON.stringify(catalog), /private-|accessToken|credential/);
  const page = await (await fetch(base + '/_coo/ecosystem')).text();
  assert.match(page, /认证提供方已接入/);
  assert.match(page, /已保存服务账号/);
  assert.doesNotMatch(page, /private-|accessToken/);
});

test('World handoff rejects expired and logged-out tickets even without APK template availability', async t => {
  const { world, owner, api } = await fixture(t, [identityProvider()]);
  let now = Date.now();
  world.ecosystem.now = () => now;
  await login(owner);
  const expired = (await (await owner('createHandoff', { serviceIds: ['starpost'] })).json()).handoff;
  now = expired.expiresAt + 1;
  const request = ticket => api('/v1/ecosystem/handoff', { ticket, deviceId: 'phone-fixture', operationId: 'install-stable' });
  assert.equal((await request(expired.ticket)).status, 410);
  const revoked = (await (await owner('createHandoff', { serviceIds: ['starpost'] })).json()).handoff;
  assert.equal((await owner('logout', { serviceId: 'starpost' })).status, 200);
  assert.equal((await request(revoked.ticket)).status, 410);
  const catalog = await (await api('/v1/ecosystem')).json();
  assert.equal(catalog.services.find(item => item.id === 'starpost').authState, 'signed-out');
  assert.equal(catalog.services.find(item => item.id === 'flower-town').authState, 'connected');
});

test('World printing creates fresh APK tickets and device-scoped redemption is replayable for one operation', {
  skip: !existsSync(TEMPLATE),
}, async t => {
  const { base, owner, api } = await fixture(t, [identityProvider()]);
  await login(owner);
  const print = async () => {
    const response = await fetch(base + '/_coo/install.apk');
    assert.equal(response.status, 200);
    return readBootstrap(Buffer.from(await response.arrayBuffer()));
  };
  const first = await print(), second = await print();
  assert.equal(first.ecosystem.version, 1);
  assert.deepEqual(first.ecosystem.services.map(item => item.id), ['starpost', 'flower-town', 'bottle']);
  assert.notEqual(first.ecosystem.handoff.ticket, second.ecosystem.handoff.ticket);
  assert.doesNotMatch(JSON.stringify(first.ecosystem), /private-|accessToken|credential/);
  const redemption = { ticket: first.ecosystem.handoff.ticket, deviceId: 'phone-fixture', operationId: 'install-stable' };
  assert.equal((await api('/v1/ecosystem/handoff', redemption, false)).status, 401);
  const response = await api('/v1/ecosystem/handoff', redemption);
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.sessions.length, 3);
  assert.equal(receipt.sessions.find(item => item.serviceId === 'starpost').credential.accessToken, 'private-starpost-fixture');
  assert.deepEqual(await (await api('/v1/ecosystem/handoff', redemption)).json(), receipt);
  assert.equal((await api('/v1/ecosystem/handoff', { ...redemption, operationId: 'another-install' })).status, 409);
  assert.equal((await api('/v1/ecosystem/handoff', { ...redemption, deviceId: 'another-phone' })).status, 409);
});
