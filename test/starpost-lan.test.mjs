import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, X509Certificate } from 'node:crypto';
import { Readable } from 'node:stream';
import { connect } from 'node:tls';
import { request } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { CooDockStarpostLan, lanEndpoints, makeLanIdentity } from '../src/starpost-lan.mjs';
import { starpostPairResult, starpostTemplate } from '../src/starpost-hub-panel.mjs';
import { addBootstrap } from '../src/apk-bootstrap.mjs';
import { MobileStore } from '../src/store.mjs';
import { TinaMobileWorld } from '../src/world.mjs';
import { DesktopBridge } from '../src/workbench/desktop.mjs';
import { ModelControl } from '../src/model-control.mjs';

test('LAN identity is a verifiable TLS leaf and interface candidates omit software adapters', () => {
  const identity = makeLanIdentity();
  const cert = new X509Certificate(identity.cert);
  assert.ok(cert.verify(cert.publicKey));
  assert.equal(cert.fingerprint256.toLowerCase().replaceAll(':', ''), identity.fingerprint);
  const ip = address => [{ family: 'IPv4', address, internal: false }];
  assert.deepEqual(lanEndpoints(9000, { 'Virtual Adapter': ip('192.168.3.4'), 'Wi-Fi': ip('10.0.0.2'), Ethernet: ip('172.29.1.9'),
    special: ip('9.0.0.1') }).map(row => row.url), ['https://172.29.1.9:9000', 'https://10.0.0.2:9000']);
});

test('LAN media is content-hashed, byte bounded and scoped by bot and deployment', async t => {
  const home = await mkdtemp(join(tmpdir(), 'coodock-media-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dock = new CooDockStarpostLan({}, home, home);
  const input = Buffer.from('same bytes in the owner channel');
  const sha = createHash('sha256').update(input).digest('hex');
  const value = await dock.write('10001', 'installation-one', Readable.from([input]), input.length, 'application/octet-stream', sha);
  assert.deepEqual(await dock.read('10001', value), input);
  assert.equal(await dock.read('10002', value), null);
  assert.equal(await dock.read('10001', { ...value, installationId: 'installation-two' }), null);
  await assert.rejects(dock.write('10001', 'installation-one', Readable.from([input]), input.length, 'application/octet-stream', 'f'.repeat(64)),
    { status: 422 });
  assert.deepEqual(await dock.read('10001', value), input);
});

test('real LAN HTTPS enforces auth and keeps direct and relayed media on the same deployment', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coodock-lan-wire-'));
  const dock = new CooDockStarpostLan({}, directory, directory);
  t.after(async () => { await dock.close(); await rm(directory, { recursive: true, force: true }); });
  await dock.start();
  const lane = dock.prepare({ botId: '10001', installationId: 'same-deployment', routeEpoch: 3, expiresAt: Date.now() + 60_000 });
  if (!lane) { t.skip('测试机没有活动的私网 IPv4'); return; }
  dock.identity = { botId: '10001', installationId: 'same-deployment' };
  const endpoint = new URL(lane.endpoints[0].url);
  const ca = await new Promise((resolve, reject) => {
    // This first TLS connection obtains the public certificate only. It sends
    // no HTTP headers and checks the fingerprint before trusting the leaf.
    const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port), rejectUnauthorized: false });
    socket.setTimeout(3000, () => socket.destroy(new Error('TLS probe timeout')));
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      const leaf = new X509Certificate(socket.getPeerCertificate().raw);
      socket.end();
      if (leaf.fingerprint256.toLowerCase().replaceAll(':', '') !== lane.serverFingerprint) reject(new Error('Wrong LAN identity'));
      else resolve(leaf.toString());
    });
  });
  const call = (path, method = 'GET', bearer = lane.lanToken, body, mime = 'application/octet-stream') =>
    new Promise((resolve, reject) => {
      const req = request(new URL(path, endpoint), { method, ca, checkServerIdentity: (_host, cert) =>
        cert.fingerprint256.toLowerCase().replaceAll(':', '') === lane.serverFingerprint ? undefined : new Error('Wrong LAN identity'),
      headers: { authorization: 'Bearer ' + bearer, ...(body ? { 'content-type': mime, 'content-length': body.length,
        'x-content-sha256': createHash('sha256').update(body).digest('hex') } : {}) } }, async res => {
        const parts = [];
        for await (const chunk of res) parts.push(chunk);
        resolve({ status: res.statusCode, bytes: Buffer.concat(parts) });
      });
      req.setTimeout(3000, () => req.destroy(new Error('HTTPS test timeout')));
      req.once('error', reject);
      req.end(body);
    });
  assert.equal((await call('/v1/lan/health', 'GET', 'a'.repeat(43))).status, 401);
  const health = await call('/v1/lan/health');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.bytes).serverFingerprint, lane.serverFingerprint);
  assert.equal((await call('/v1/world-library')).status, 404);
  assert.equal((await call('/v1/services', 'GET', 'a'.repeat(43))).status, 401);
  const payload = Buffer.from('direct media bytes');
  const upload = await call('/v1/owner/media', 'POST', lane.lanToken, payload);
  assert.equal(upload.status, 201);
  const receipt = JSON.parse(upload.bytes);
  assert.deepEqual((await call('/v1/owner/media/' + receipt.mediaId)).bytes, payload);
  const relayed = await dock.relay('10001', 'same-deployment', { method: 'GET', path: '/v1/owner/media/' + receipt.mediaId + '?offset=0' });
  assert.equal(relayed.result.data, payload.toString('base64'));
  await assert.rejects(dock.relay('10001', 'different-installation', { method: 'GET', path: '/v1/owner/media/' + receipt.mediaId + '?offset=0' }),
    { status: 503 });
  dock.revoke();
  assert.equal((await call('/v1/lan/health')).status, 401);
});

test('an authorized Bot discovers scoped services, saves typed settings and submits a pet gesture once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coodock-bound-'));
  const world = new TinaMobileWorld({ cfg: { petPort: 1 }, botDir: directory });
  world.store = new MobileStore(':memory:');
  let kicks = 0;
  world.kick = () => { kicks++; };
  const worldKey = 'worlds.test-world.rate';
  const secretKey = 'worlds.test-world.bridge_token';
  const group = { id: 'world:test-world', schema: { title: 'Fixture', properties: {
    [worldKey]: { type: 'number', minimum: 1, maximum: 5 },
    [secretKey]: { type: 'string', enum: ['private-fixture'], writeOnly: true },
  } } };
  const config = { groups: [{ group, values: { [worldKey]: 2, [secretKey]: 'private-fixture' } }] };
  const requested = [];
  const worlds = [{ id: 'test-world', status: 'active', label: 'Stable world' },
    { id: 'stopped', status: 'inactive' }, { id: 'missing', status: 'missing' }];
  const desktop = {
    bound() { return this; },
    async activity() { return { items: [] }; },
    async request(path, method = 'GET', body) {
      requested.push([path, method, body]);
      if (path === '/api/config') return config;
      if (path === '/api/worlds') return { worlds };
      if (path === '/api/worlds/activation') worlds.find(item => item.id === body.id).status = body.enabled ? 'active' : 'inactive';
      if (path === '/api/extensions') return { extensions: [
        { name: '@fixture/installed', worldId: 'test-world', kind: 'world', installedVersion: '1.0.0', state: 'loaded', location: 'private-fixture' },
        { name: 'non-world-fixture', kind: 'provider', state: 'loaded' },
      ] };
      if (path === '/api/extensions/search?kind=world') return { hits: [{ name: 'cortico-world-fixture', version: '1.2.3' }] };
      return { ok: true };
    },
    async save(input) { Object.assign(config.groups[0].values, input.values); },
  };
  world.workbenchBridge = { desktop };
  const dock = new CooDockStarpostLan(world, directory, directory);
  dock.identity = { botId: '10001', installationId: 'runtime-a' };
  dock.routeEpoch = 7;
  dock.provider = async () => ({ active_provider: 'current', instances: [{ name: 'current', ready: true }] });
  t.after(async () => { world.store.close(); await rm(directory, { recursive: true, force: true }); });
  const call = async (path, method = 'GET', body) => (await dock.relay('10001', 'runtime-a', { path, method, body })).result;
  const discovery = await call('/v1/services');
  assert.equal(discovery.routeEpoch, 7);
  assert.equal(discovery.services.provider.available, true);
  assert.equal(discovery.services.workbench.settings, '/v1/desktop/settings');
  assert.equal(discovery.services.pet.touch, '/v1/pet/touch');
  assert.equal(discovery.services.console, undefined);
  world.context.cfg.consoleUiUrl = 'https://tina.example.com/control/';
  assert.deepEqual((await call('/v1/services')).services.console, { available: true, entry: '/v1/console-entry' });
  assert.deepEqual(await call('/v1/console-entry'), { configured: true, url: 'https://tina.example.com/control/' });
  world.context.cfg.consoleUiUrl += '?token=private-fixture';
  assert.deepEqual(await call('/v1/console-entry'), { configured: false, url: '' });
  const settings = await call('/v1/desktop/settings');
  assert.doesNotMatch(JSON.stringify(settings), /private-fixture|bridge_token|workbenchBridge/);
  assert.deepEqual(settings.worlds.map(item => [item.id, item.enabled, item.available]),
    [['test-world', true, true], ['stopped', false, true], ['missing', false, false]]);
  const save = (values, expected) => call('/v1/desktop/settings', 'POST', { group: group.id, values, expected });
  assert.equal((await save({ [worldKey]: 3 }, { [worldKey]: 2 })).groups[0].values[worldKey], 3);
  await assert.rejects(save({ [worldKey]: 4 }, { [worldKey]: 2 }), { status: 409 });
  await assert.rejects(save({ [secretKey]: 'private-fixture' }, { [worldKey]: 3 }), { status: 400 });
  await assert.rejects(call('/v1/desktop/public', 'POST', { path: '/api/config' }), { status: 403 });
  await assert.rejects(dock.relay('10002', 'runtime-a', { path: '/v1/services', method: 'GET' }), { status: 503 });
  await call('/v1/desktop/world/restart', 'POST', { id: 'test-world' });
  assert.equal((await call('/v1/desktop/world/activation', 'POST', { id: 'stopped', enabled: true })).enabled, true);
  await assert.rejects(call('/v1/desktop/world/activation', 'POST', { id: 'starpost', enabled: false }), { status: 409 });
  const market = await call('/v1/desktop/extensions');
  assert.deepEqual(market.installed.map(item => item.name), ['@fixture/installed']);
  assert.deepEqual(market.available.map(item => item.name), ['cortico-world-fixture']);
  assert.doesNotMatch(JSON.stringify(market), /private-fixture/);
  await assert.rejects(call('/v1/desktop/extensions/install', 'POST', { name: '@fixture/installed' }), { status: 404 });
  await call('/v1/desktop/provider/activate', 'POST', { name: 'current' });
  assert.ok(requested.some(([path]) => path === '/api/providers/current/activate'));
  const gesture = { id: 'unique-gesture', kind: 'poke' };
  const touch = await call('/v1/pet/touch', 'POST', gesture);
  assert.deepEqual(await call('/v1/pet/touch', 'POST', gesture), touch);
  assert.equal(kicks, 1);
  assert.equal(world.store.get(touch.id).source_ref, 'pet-touch:poke');
});

test('bound reads and writes never contact another local Cortico deployment', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coodock-identity-'));
  const dataDir = join(directory, 'data');
  const expected = createHash('sha256').update(dataDir).digest('hex');
  let fingerprint = 'f'.repeat(64);
  let ready = true;
  const touched = [];
  const api = createHttpServer((request, reply) => {
    reply.setHeader('content-type', 'application/json');
    if (request.url === '/api/run/lifecycle') {
      reply.end(JSON.stringify({ deployment: fingerprint, ready }));
      return;
    }
    touched.push(request.method + ' ' + request.url);
    const fixtures = {
      '/api/worlds': { worlds: [] },
      '/api/config': { groups: [] },
      '/api/providers': { active: 'fixture-provider', providers: [{ name: 'fixture-provider', readiness: { state: 'ready' } }] },
      '/api/providers/fixture-provider': { entry: { spec: { model: 'fixture-model' } } },
      '/api/providers/fixture-provider/activate': { ok: true },
      '/api/status': {},
    };
    reply.end(JSON.stringify(fixtures[request.url] ?? {}));
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    api.closeAllConnections();
    await new Promise(resolve => api.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const world = { context: { cfg: {} }, workbenchBridge: {
    desktop: new DesktopBridge({ deployment: directory, dataDir, url: 'http://127.0.0.1:' + api.address().port }),
  } };
  world.modelControl = new ModelControl(world.context);
  const dock = new CooDockStarpostLan(world, directory, directory);
  dock.identity = { botId: '10001', installationId: 'paired' };
  const call = (path, method = 'GET', body) => dock.relay('10001', 'paired', { path, method, body });
  for (const path of ['/v1/desktop/settings', '/v1/desktop/activity', '/v1/provider/snapshot', '/v1/desktop/extensions'])
    await assert.rejects(call(path), { status: 409 });
  await assert.rejects(call('/v1/desktop/settings', 'POST', { group: 'world:fixture', values: {}, expected: {} }), { status: 409 });
  await assert.rejects(call('/v1/desktop/provider/activate', 'POST', { name: 'fixture-provider' }), { status: 409 });
  assert.deepEqual(touched, []);
  fingerprint = expected;
  ready = false;
  await assert.rejects(call('/v1/desktop/provider/activate', 'POST', { name: 'fixture-provider' }), { status: 503 });
  assert.deepEqual(touched, []);
  ready = true;
  const snapshot = await call('/v1/provider/snapshot');
  assert.equal(snapshot.result.model, 'fixture-model');
  assert.equal((await call('/v1/desktop/provider/activate', 'POST', { name: 'fixture-provider' })).result.provider, 'fixture-provider');
  assert.ok(touched.includes('POST /api/providers/fixture-provider/activate'));
});

test('Starpost signed-block extension preserves other signing entries and excludes human and LAN tokens', () => {
  const header = Buffer.alloc(8), entry = Buffer.alloc(16), footer = Buffer.alloc(8), eocd = Buffer.alloc(22);
  entry.writeBigUInt64LE(8n);
  entry.writeUInt32LE(0x7109871a, 8);
  entry.writeUInt32LE(0xaabbccdd, 12);
  header.writeBigUInt64LE(40n); footer.writeBigUInt64LE(40n);
  eocd.writeUInt32LE(0x06054b50);
  eocd.writeUInt32LE(48, 16);
  const template = Buffer.concat([header, entry, footer, Buffer.from('APK Sig Block 42'), eocd]);
  const grant = { ticket: 'x'.repeat(43), expiresAt: Date.now() + 300000 };
  const result = starpostPairResult({ hubIssuer: 'https://ffahub.net', starpostOrigin: 'https://starpost.com.cn',
    botId: '12345', botName: '开发机' }, grant, { endpoints: [{ url: 'https://192.168.1.3:8790' }],
      installationId: 'install-123', serverFingerprint: 'a'.repeat(64), lanToken: 'must-not-print' });
  assert.equal(new URL(result.uri).searchParams.get('ticket'), grant.ticket);
  assert.match(result.svg, /^<svg/);
  const apk = addBootstrap(template, { ...result.bootstrap, token: 'human-master', lanToken: 'must-not-print' });
  assert.deepEqual(apk.subarray(8, 24), entry);
  assert.equal(apk.readUInt32LE(32), 0x54434f4f);
  const decoded = JSON.parse(apk.subarray(36, 24 + 8 + Number(apk.readBigUInt64LE(24))).toString('utf8'));
  assert.equal(decoded.v, 2);
  assert.equal(decoded.pairTicket, grant.ticket);
  assert.equal(decoded.lanHint.endpoints[0], 'https://192.168.1.3:8790');
  assert.doesNotMatch(apk.toString(), /must-not-print|human-master|lanToken/);
});

test('an explicitly selected Starpost template must exist as a file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coodock-template-'));
  const apk = join(directory, 'preview.apk');
  await writeFile(apk, 'template fixture');
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(starpostTemplate(apk), apk);
  assert.equal(starpostTemplate(directory), null);
  assert.equal(starpostTemplate(join(directory, 'missing.apk')), null);
});
