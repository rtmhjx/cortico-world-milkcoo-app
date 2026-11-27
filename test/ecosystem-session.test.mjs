import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EcosystemSessions, ECOSYSTEM_SECRET, dispatchEcosystemRequest } from '../src/ecosystem-session.mjs';

function fixture(options = {}) {
  const secrets = new Map();
  const context = { secret: name => secrets.get(name), storeSecret: (name, value) => secrets.set(name, value) };
  return { context, secrets, memory: new EcosystemSessions({ context, ...options }) };
}

function session(serviceId = 'starpost', overrides = {}) {
  return { serviceId, issuer: 'https://fixture.invalid', subject: 'human-1', botId: 'bot-1',
    credential: { kind: 'bearer', accessToken: `private-${serviceId}` }, ...overrides };
}

test('three service catalog is explicit about pending common login and never contains credentials', () => {
  const { memory } = fixture();
  assert.deepEqual(memory.catalog().services.map(item => item.id), ['starpost', 'flower-town', 'bottle']);
  assert.equal(memory.catalog().providers[0].state, 'pending');
  assert.equal(memory.createBootstrapHandoff(), null);
  memory.adoptSession(session());
  const manifest = memory.catalog();
  assert.equal(manifest.services[0].authState, 'connected');
  assert.equal(manifest.services[0].accounts[0].mode, 'per-service');
  assert.equal(manifest.providers[0].state, 'pending');
  assert.equal(manifest.services[1].authState, 'signed-out');
  assert.doesNotMatch(JSON.stringify(manifest), /private-starpost|accessToken|credential/);
});

test('service, issuer, subject and bot identities stay isolated across persistence and selection', () => {
  const { memory, context } = fixture();
  memory.adoptSession(session());
  memory.adoptSession(session('flower-town'));
  memory.adoptSession(session('starpost', { issuer: 'https://other.invalid' }));
  memory.adoptSession(session('starpost', { botId: 'bot-2' }));
  memory.adoptSession(session('starpost', { subject: 'human-2' }));
  const restored = new EcosystemSessions({ context });
  assert.equal(restored.sessions().length, 5);
  assert.equal(restored.sessions('starpost').filter(item => item.active).length, 1);
  restored.selectSession(session());
  assert.equal(restored.sessions('starpost').find(item => item.active).botId, 'bot-1');
  restored.logout({ serviceId: 'starpost', issuer: 'https://fixture.invalid', subject: 'human-1', botId: 'bot-1' });
  assert.equal(restored.sessions().length, 4);
  assert.equal(restored.sessions('flower-town')[0].state, 'connected');
  assert.equal(restored.sessions('starpost').filter(item => item.active).length, 0);
});

test('ins provider is independently replaceable and successful exchange persists real per-service sessions', async () => {
  const { memory, context } = fixture();
  await assert.rejects(memory.login({}), /ECOSYSTEM_PROVIDER_PENDING/);
  memory.registerProvider({ id: 'ins-identity', title: '星邮共同账号',
    begin: async ({ serviceId }) => ({ flowId: 'fixture-flow', serviceId, authorizationUrl: 'https://identity.invalid/authorize' }),
    complete: async ({ code }) => {
      assert.equal(code, 'fixture-code');
      return { sessions: [session(), session('flower-town'), session('bottle')] };
    },
  });
  const begin = await memory.login({ action: 'begin', serviceId: 'starpost' });
  assert.equal(begin.flowId, 'fixture-flow');
  const complete = await memory.login({ action: 'complete', code: 'fixture-code' });
  assert.equal(complete.sessions.length, 3);
  assert.ok(complete.sessions.every(item => item.mode === 'provider'));
  assert.doesNotMatch(JSON.stringify(complete), /private-|accessToken|credential/);
  assert.ok(new EcosystemSessions({ context }).catalog().services.every(item => item.authState === 'connected'));
});

test('invalid provider batch does not partially log in or persist a fake shared identity', async () => {
  const { memory, secrets } = fixture({ providers: [{ id: 'broken', begin: async () => ({}),
    complete: async () => ({ sessions: [session(), session('unregistered-game')] }) }] });
  await assert.rejects(memory.login({ providerId: 'broken', action: 'complete' }), /ECOSYSTEM_SERVICE_UNKNOWN/);
  assert.equal(memory.sessions().length, 0);
  assert.equal(secrets.has(ECOSYSTEM_SECRET), false);
});

test('printed handoff is short-lived, scoped and contains no credentials before redemption', () => {
  let now = 1_000;
  const { memory } = fixture({ now: () => now, ticketLifetimeMs: 200 });
  memory.adoptSession(session());
  memory.adoptSession(session('flower-town'));
  memory.adoptSession(session('bottle', { expiresAt: now - 1 }));
  const handoff = memory.createBootstrapHandoff({ serviceIds: ['starpost', 'bottle'], deviceId: 'phone-a' });
  assert.equal(handoff.endpoint, '/v1/ecosystem/handoff');
  assert.equal(handoff.expiresAt, 1_200);
  assert.doesNotMatch(JSON.stringify(handoff), /private-|accessToken|credential/);
  assert.throws(() => memory.consumeHandoff({ ...handoff, deviceId: 'phone-b', operationId: 'install-1' }), /DEVICE_MISMATCH/);
  const result = memory.consumeHandoff({ ...handoff, deviceId: 'phone-a', operationId: 'install-1' });
  assert.deepEqual(result.sessions.map(item => item.serviceId), ['starpost']);
  assert.equal(result.sessions[0].credential.accessToken, 'private-starpost');
  now = 1_201;
  assert.throws(() => memory.consumeHandoff({ ...handoff, deviceId: 'phone-a', operationId: 'install-1' }), /EXPIRED/);
});

test('lost handoff response can be retried for the same device and operation without importing another identity', () => {
  const { memory } = fixture();
  memory.adoptSession(session());
  const handoff = memory.createBootstrapHandoff();
  const request = { ticket: handoff.ticket, deviceId: 'phone-a', operationId: 'stable-install-operation' };
  const response = memory.consumeHandoff(request);
  // A caller mutating its response cannot mutate the retry receipt.
  response.sessions[0].credential.accessToken = 'changed-by-client';
  assert.equal(memory.consumeHandoff(request).sessions[0].credential.accessToken, 'private-starpost');
  assert.throws(() => memory.consumeHandoff({ ...request, operationId: 'second-operation' }), /ALREADY_CONSUMED/);
  assert.throws(() => memory.consumeHandoff({ ...request, deviceId: 'phone-b' }), /DEVICE_MISMATCH/);
});

test('logout revokes pending tickets and consumed retry receipts, while preserving other service accounts', () => {
  const { memory } = fixture();
  memory.adoptSession(session());
  memory.adoptSession(session('flower-town'));
  const pending = memory.createBootstrapHandoff({ serviceIds: ['starpost'] });
  const consumed = memory.createBootstrapHandoff({ serviceIds: ['starpost'] });
  memory.consumeHandoff({ ticket: consumed.ticket, deviceId: 'phone-a', operationId: 'install' });
  memory.logout({ serviceId: 'starpost' });
  for (const ticket of [pending.ticket, consumed.ticket]) {
    assert.throws(() => memory.consumeHandoff({ ticket, deviceId: 'phone-a', operationId: 'install' }), /INVALID_OR_EXPIRED/);
  }
  assert.equal(memory.sessions('flower-town')[0].state, 'connected');
});

test('session storage failure does not report a successful login or overwrite existing unreadable state', () => {
  const memory = new EcosystemSessions({ context: { secret: () => undefined, storeSecret() {} } });
  assert.throws(() => memory.adoptSession(session()), /READBACK_FAILED/);
  assert.equal(memory.sessions().length, 0);
  const invalid = fixture();
  invalid.secrets.set(ECOSYSTEM_SECRET, 'invalid-state');
  const restored = new EcosystemSessions({ context: invalid.context });
  assert.equal(restored.catalog().storage, 'invalid');
  assert.throws(() => restored.adoptSession(session()), /STORAGE_INVALID/);
  assert.equal(invalid.secrets.get(ECOSYSTEM_SECRET), 'invalid-state');
});

test('HTTP route adapter and panel RPC share catalog, login, logout and handoff methods', async () => {
  const { memory } = fixture();
  memory.adoptSession(session());
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer fixture-only') { res.writeHead(401).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    const reply = await dispatchEcosystemRequest(memory, req.method, new URL(req.url, 'http://fixture').pathname, body);
    res.writeHead(reply?.status ?? 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply?.body ?? {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, body) => fetch(base + path, { method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer fixture-only', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await fetch(base + '/v1/ecosystem')).status, 401);
    const manifest = await (await call('/v1/ecosystem')).json();
    assert.deepEqual(manifest, await memory.invoke('overview'));
    assert.equal((await call('/v1/ecosystem/login', {})).status, 409);
    const { handoff } = await memory.invoke('createHandoff', { serviceIds: ['starpost'] });
    const body = { ticket: handoff.ticket, deviceId: 'phone-http', operationId: 'install-http' };
    const first = await (await call('/v1/ecosystem/handoff', body)).json();
    assert.equal(first.sessions[0].serviceId, 'starpost');
    assert.deepEqual(await (await call('/v1/ecosystem/handoff', body)).json(), first);
    assert.equal((await call('/v1/ecosystem/logout', { serviceId: 'starpost' })).status, 200);
    assert.equal((await call('/v1/ecosystem/handoff', body)).status, 410);
    assert.equal(await dispatchEcosystemRequest(memory, 'GET', '/unrelated'), null);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
