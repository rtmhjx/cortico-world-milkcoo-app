import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CooDockCloudChannel } from '../src/dock-channel.mjs';
import { CooDockStarpostLan, STARPOST_LAN } from '../src/starpost-lan.mjs';
import { TinaMobileWorld } from '../src/world.mjs';

const relay = fileURLToPath(new URL('../../paid-relay/', import.meta.url));
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const botId = '12345';
const phoneToken = 'synthetic-host-phone';
const pcToken = 'synthetic-host-pc';
const fixtureSecret = 'synthetic-ffa-test-secret-only';

function startPython(t, args) {
  const child = spawn(python, ['-B', ...args], { cwd: relay, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const closed = once(child, 'close');
  const lines = createInterface({ input: child.stdout });
  t.after(async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed.catch(() => {});
  });
  return Promise.race([
    once(lines, 'line', { signal: AbortSignal.timeout(8000) }).then(([line]) => line),
    closed.then(([code]) => { throw new Error('Fixture exited (' + code + ')\n' + stderr); }),
  ]);
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

async function startRelay(t, root) {
  const hub = JSON.parse(await startPython(t, ['test_dock_channel.py', '--mock-ffa']));
  const state = join(root, 'relay-state');
  const config = join(root, 'ffa-config.json');
  const keys = join(root, 'keys.sqlite');
  await writeFile(config, JSON.stringify({ issuer: hub.issuer, service: 'coodock', secret: fixtureSecret, development: true }));
  execFileSync(python, ['-B', '-c', 'import sys; from access_keys import AccessKeys; AccessKeys(sys.argv[1]).close()', keys],
    { cwd: relay, windowsHide: true });
  const reserve = createServer();
  const port = await listen(reserve);
  await close(reserve);
  assert.match(await startPython(t, ['relay_server.py', '--keys', keys, '--state-dir', state, '--port', String(port),
    '--ffa-config', config]), /Relay listening on loopback/);
  return { ...hub, cloud: 'http://127.0.0.1:' + port };
}

async function until(action, predicate) {
  const deadline = Date.now() + 8000;
  let value;
  do {
    value = await action();
    if (predicate(value)) return value;
    await wait(30);
  } while (Date.now() < deadline);
  throw new Error('State did not converge');
}

async function post(origin, path, body, headers = {}) {
  const response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return { status: response.status, body: await response.json() };
}

function cloudCall(origin, action, body = {}, token = phoneToken) {
  return post(origin, '/dock/v1/channel/' + action, { botId, ...body }, { authorization: 'Bearer ' + token });
}

function role(issuer, status) {
  return {
    async identity() { return { status: 'ready', issuer, subject: 'owner' }; },
    async signIn() {
      if (status !== 'ready') return { status };
      return { status: 'ready', session: { issuer, audience: 'coodock', scope: 'login', subject: 'owner',
        accessToken: pcToken, expiresAt: Date.now() + 3600_000 } };
    },
    interactive: {},
  };
}

async function setup(t, status) {
  const dir = await mkdtemp(join(tmpdir(), 'coodock-channel-node-'));
  const upstream = await startRelay(t, dir);
  const oldOrigin = process.env.MILKCOO_DOCK_CLOUD_ORIGIN;
  process.env.MILKCOO_DOCK_CLOUD_ORIGIN = upstream.cloud;
  const values = new Map([['MILKCOO_APP_TOKEN', 'synthetic-world-token']]);
  const capability = role(upstream.issuer, status);
  const events = [];
  const configKey = 'worlds.fixture.rate';
  const deployment = createHash('sha256').update(dir).digest('hex');
  const core = createServer((req, res) => {
    const fixtures = {
      '/api/run/lifecycle': { deployment, ready: true },
      '/api/providers': { active: 'fixture-provider', providers: [{ name: 'fixture-provider', readiness: { state: 'ready' } }] },
      '/api/providers/fixture-provider': { entry: { spec: { model: 'fixture-model' }, multimodal: true }, revision: 'fixture-r1' },
      '/api/status': { modelConnection: { module: 'fixture-module' } },
      '/api/worlds': { worlds: [{ id: 'fixture', status: 'active' }] },
      '/api/config': { groups: [{ group: { id: 'world:fixture', schema: { properties: { [configKey]: { type: 'integer' } } } },
        values: { [configKey]: 4 } }] },
    };
    res.writeHead(fixtures[req.url] ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(fixtures[req.url] ?? {}));
  });
  const pack = { id: 'whale', axes: [{ id: 'outfit', options: [{ id: 'cape' }] }] };
  const pet = createServer((req, res) => {
    res.writeHead(req.url === '/api/state' || req.url === '/api/figures' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(req.url === '/api/state' ? '{"skin":{"figure":"whale"}}' : JSON.stringify([pack]));
  });
  const consolePort = await listen(core);
  const petPort = await listen(pet);
  const world = new TinaMobileWorld({
    botDir: dir, dataDir: dir, cfg: { host: '127.0.0.1', port: 0, consolePort, petPort },
    hostServices: { get: key => key === 'ffa-hub.login' ? capability : undefined },
    secret: key => values.get(key),
    storeSecret: (key, value) => { values.set(key, value); },
  });
  t.after(async () => {
    if (oldOrigin === undefined) delete process.env.MILKCOO_DOCK_CLOUD_ORIGIN;
    else process.env.MILKCOO_DOCK_CLOUD_ORIGIN = oldOrigin;
    await world.stop();
    await Promise.all([close(core), close(pet)]);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  await world.start({
    store: { range: () => [], latestCursor: () => 0 },
    async pushEvent(event) { events.push(event); return { cursor: events.length }; },
  });
  const lan = globalThis[STARPOST_LAN].get(world.starpostLan.botDir);
  assert.ok(lan instanceof CooDockStarpostLan);
  assert.ok(world.dockChannel instanceof CooDockCloudChannel);
  const local = 'http://127.0.0.1:' + world.address().port;
  const panel = (action, extra = {}, nonce = world.panelNonce) => post(local, '/_coo/dock-cloud-auth',
    { action, ...extra }, { origin: local, 'x-coo-panel': nonce });
  const deploymentInfo = { botId, botName: 'Fixture Bot', botSubject: 'fixture-bot-subject', hubIssuer: upstream.issuer,
    installationId: 'fixture-deployment', routeEpoch: 8, expiresAt: Date.now() + 180_000 };
  return { ...upstream, world, lan, events, deploymentInfo, local, panel, values,
    phone: (action, body) => cloudCall(upstream.cloud, action, body) };
}

test('host login, real Python relay, LAN deployment handshake and complete phone RPCs', { timeout: 35_000 }, async t => {
  const { world, lan, deploymentInfo, panel, phone, local, events } = await setup(t, 'ready');
  assert.equal((await panel('status', {}, 'bad-nonce')).status, 403);
  assert.equal((await phone('session')).body.state, 'runtime_offline');
  const html = await (await fetch(local + '/_coo/starpost-hub')).text();
  assert.match(html, /同宿主登录/);
  assert.match(html, /获取 CooDock 授权证明/);
  assert.match(html, /阿里云通道/);
  await lan.setStarpostDeployment(deploymentInfo);
  const session = (await until(() => phone('session'), result => result.body.ready === true)).body;
  assert.equal(session.channel, 'aliyun-coodock');
  assert.equal(session.botSubject, deploymentInfo.botSubject);
  assert.equal(session.installationId, deploymentInfo.installationId);
  assert.equal(session.routeEpoch, 8);
  assert.ok(session.lanDirect && session.lanDirect.endpoints.length);
  assert.match(session.lanDirect.serverFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(session.lanDirect.serverFingerprint, lan.fingerprint);
  const view = (await until(() => panel('status'), result => result.body.cloud.state === 'online')).body;
  assert.equal(view.handshakeBotId, botId);
  assert.equal(view.cloud.state, 'online');
  assert.equal(view.cloud.authSource, 'host_login');
  assert.equal(view.cloud.ownerSubject, 'owner');
  assert.equal(view.cloud.leaseId, session.leaseId);
  assert.ok(!JSON.stringify(view).includes(pcToken));

  let serial = 0;
  const rpc = async (method, path, body, status = 200) => {
    const requestId = 'call-' + (++serial);
    let { status: code, body: receipt } = await phone('submit', { requestId, method, path, body });
    if (receipt.state === 'pending') ({ status: code, body: receipt } = await until(
      () => phone('result', { requestId }), result => result.body.state !== 'pending'));
    assert.equal(code, 200, path);
    assert.equal(receipt.state, 'completed', path);
    assert.equal(receipt.status, status, path + ' ' + JSON.stringify(receipt.body));
    assert.deepEqual((await phone('result', { requestId })).body, receipt);
    return receipt.body;
  };
  const discovery = await rpc('GET', '/v1/services');
  assert.equal(discovery.botId, botId);
  assert.deepEqual(Object.values(discovery.services).map(entry => entry.available), [true, true, true, true]);
  const provider = await rpc('GET', '/v1/provider/snapshot');
  assert.equal(provider.model, 'fixture-model');
  assert.equal(provider.module, 'fixture-module');
  assert.equal((await rpc('GET', '/v1/model')).model, 'fixture-model');
  assert.equal((await rpc('GET', '/v1/pet/wardrobe')).state.skin.figure, 'whale');
  const resource = await rpc('GET', '/v1/pet/resource?path=%2Fapi%2Fstate');
  assert.deepEqual(JSON.parse(Buffer.from(resource.data, 'base64')), { skin: { figure: 'whale' } });
  assert.equal((await rpc('GET', '/v1/desktop/settings')).groups[0].values['worlds.fixture.rate'], 4);
  assert.equal((await rpc('GET', '/v1/health')).ok, true);
  assert.ok(Array.isArray((await rpc('GET', '/v1/ecosystem')).services));
  assert.ok(Array.isArray((await rpc('GET', '/v1/ecosystem/sessions')).sessions));
  await rpc('POST', '/v1/console-input', { device_id: 'fixture-phone', text: 'console from cloud' });
  const message = { id: 'fixture-message', device_id: 'fixture-phone', text: 'message from cloud',
    created_at: new Date().toISOString() };
  await rpc('POST', '/v1/messages', message, 201);
  await rpc('POST', '/v1/messages', message);
  const feed = await rpc('GET', '/v1/feed?device_id=fixture-phone&after=0');
  assert.match(JSON.stringify(feed), /fixture-message/);
  await until(() => Promise.resolve(events), current => current.some(event => event.senderKey === 'fixture-message'));
  assert.equal(events.filter(event => event.senderKey === 'fixture-message').length, 1);
  assert.ok(events.some(event => event.type === 'console.message' && event.meta.body === 'console from cloud'));

  await lan.clearStarpostDeployment();
  assert.equal((await phone('session')).body.state, 'runtime_offline');
  assert.equal((await panel('status')).body.handshakeBotId, null);
  assert.equal(lan.current(botId), undefined);
  assert.ok(world.publicRelay);
});

test('proof login works with host login disabled, persists the scoped credential and revokes on logout', { timeout: 30_000 }, async t => {
  const { world, lan, panel, deploymentInfo, values, phone, cloud } = await setup(t, 'host_login_disabled');
  await lan.setStarpostDeployment(deploymentInfo);
  assert.equal((await phone('session')).body.ready, false);
  const claim = await panel('beginProof');
  assert.equal(claim.status, 200);
  const link = new URL(claim.body.authorizationUrl);
  assert.equal(link.origin, 'https://8.148.13.225:8443');
  assert.equal(link.searchParams.get('grant'), 'coodock');
  assert.equal(link.searchParams.get('scope'), 'login');
  assert.equal(link.searchParams.get('installationId'), deploymentInfo.installationId);
  assert.equal(link.searchParams.get('deviceId'), claim.body.deviceId);
  const proof = 'fixture.' + Buffer.from(JSON.stringify(['owner', claim.body.installationId, claim.body.deviceId])).toString('base64url');
  assert.equal((await panel('completeProof', { proof })).status, 200);
  await until(() => phone('session'), result => result.body.ready === true);
  const stored = JSON.parse(values.get('MILKCOO_FFA_CLOUD_SESSION'));
  assert.match(stored.token, /^ffa_local_[A-Za-z0-9_-]{43}$/);
  let status = (await panel('status')).body.cloud;
  assert.equal(status.authSource, 'ffa_local');
  assert.ok(!JSON.stringify(status).includes(stored.token));

  const old = world.dockChannel;
  await old.stop();
  assert.equal((await phone('session')).body.ready, false);
  world.dockChannel = new CooDockCloudChannel(lan, world.context, old.account, { origin: cloud });
  world.dockChannel.start();
  await until(() => phone('session'), result => result.body.ready === true);
  assert.equal((await panel('logout')).status, 200);
  assert.equal((await phone('session')).body.state, 'runtime_offline');
  assert.equal((await cloudCall(cloud, 'session', {}, stored.token)).status, 403);
  assert.deepEqual(JSON.parse(values.get('MILKCOO_FFA_CLOUD_SESSION')), { origin: cloud, paused: true });
  status = (await panel('status')).body.cloud;
  assert.equal(status.state, 'login_required');
  assert.ok(!JSON.stringify(status).includes(stored.token));
});
