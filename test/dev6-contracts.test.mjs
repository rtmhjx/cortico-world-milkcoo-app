import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeControlOperation } from '../src/coodock-native-controls.mjs';
import { WorkbenchBridge } from '../src/workbench-bridge.mjs';
import { addBootstrap } from '../src/apk-bootstrap.mjs';
import { readBootstrap } from './apk-bootstrap-reader.mjs';

test('nativeControlOperation allows /api/prompts/prefix, /api/worlds/visibility, and /api/session/reload-prefix', () => {
  assert.equal(nativeControlOperation('POST', '/v1/desktop/public', { method: 'GET', path: '/api/prompts/prefix' }), true);
  assert.equal(nativeControlOperation('POST', '/v1/desktop/public', {
    method: 'POST', path: '/api/worlds/visibility', body: { id: 'websearch', visible: false },
  }), true);
  assert.equal(nativeControlOperation('POST', '/v1/desktop/public', {
    method: 'POST', path: '/api/session/reload-prefix', body: {},
  }), true);
});

test('WorkbenchBridge confirms /api/worlds/activation against Cortico status: active|inactive', async t => {
  const dir = join(tmpdir(), 'dev6-wb-' + Date.now());
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const deployment = createHash('sha256').update(dir).digest('hex');
  let worldStatus = 'inactive';
  let worldVisible = true;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    let out = { ok: true };
    if (req.url === '/api/run/lifecycle') out = { deployment, bootId: 'b1', ready: true };
    else if (req.url === '/api/worlds' && req.method === 'GET') out = { worlds: [{ id: 'qq', status: worldStatus, visible: worldVisible }] };
    else if (req.url === '/api/worlds/activation' && req.method === 'POST') { worldStatus = body.enabled ? 'active' : 'inactive'; out = { ok: true }; }
    else if (req.url === '/api/worlds/visibility' && req.method === 'POST') { worldVisible = body.visible; out = { ok: true }; }
    else if (req.url === '/api/prompts/prefix' && req.method === 'GET') out = { segments: [{ title: '部署种子', sourceKey: 'selfMem.seed', text: '# I am tina' }] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const bridge = new WorkbenchBridge({ botDir: dir, dataDir: dir, cfg: { consolePort: server.address().port } }, 'tok');
  const invoke = async payload => {
    let status, value;
    await bridge.handle(
      { method: 'POST', headers: {} },
      {},
      new URL('http://127.0.0.1/v1/desktop/public'),
      async () => payload,
      (r, s, v) => { status = s; value = v; },
    );
    return { status, value };
  };

  const actOn = await invoke({ method: 'POST', path: '/api/worlds/activation', body: { id: 'qq', enabled: true } });
  assert.equal(actOn.status, 200);
  assert.equal(actOn.value.readback, true);

  const actOff = await invoke({ method: 'POST', path: '/api/worlds/activation', body: { id: 'qq', enabled: false } });
  assert.equal(actOff.status, 200);
  assert.equal(actOff.value.readback, true);

  const visOff = await invoke({ method: 'POST', path: '/api/worlds/visibility', body: { id: 'qq', visible: false } });
  assert.equal(visOff.status, 200);
  assert.equal(visOff.value.readback, true);

  const pfx = await invoke({ method: 'GET', path: '/api/prompts/prefix' });
  assert.equal(pfx.status, 200);
  assert.equal(pfx.value.segments[0].sourceKey, 'selfMem.seed');
});

test('addBootstrap preserves lanEndpoint and hostLabel alongside endpoint', () => {
  const apk = readFileSync(new URL('../client/CooDock-0.6.0-dev.15-companion-debug.apk', import.meta.url));
  const out = addBootstrap(apk, {
    endpoint: 'https://mental-weight-retro-pee.trycloudflare.com',
    lanEndpoint: 'http://192.168.1.3:7801',
    hostLabel: '电脑 Tina',
    token: 'test-token',
  });
  const parsed = readBootstrap(out);
  assert.equal(parsed.endpoint, 'https://mental-weight-retro-pee.trycloudflare.com');
  assert.equal(parsed.lanEndpoint, 'http://192.168.1.3:7801');
  assert.equal(parsed.hostLabel, '电脑 Tina');
  assert.equal(parsed.token, 'test-token');
});
