import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { TinaMobileWorld } from '../src/world.mjs';
import { BottleBridge, bottleTransferLimits } from '../src/bottle-bridge.mjs';

async function mailbox() {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seen.push({ path: req.url, method: req.method, auth: req.headers.authorization, bottle: req.headers['x-bottle'], surface: req.headers['x-bottle-surface'], fonts: req.headers['x-bottle-cached-fonts'], body: Buffer.concat(chunks).toString() });
      if (req.url === '/send' && seen.at(-1).body.includes('lost-receipt')) { req.socket.destroy(); return; }
      if (req.url === '/my-font/fixture') { res.writeHead(200, { 'content-type': 'font/woff2' }); res.end(Buffer.alloc(5 * 1024 * 1024, 7)); return; }
      res.writeHead(200, { 'content-type': req.url === '/' ? 'text/html; charset=utf-8' : 'application/json' });
      res.end(req.url === '/' ? '<title>漂流瓶 · 信箱</title>' : JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

test('authenticated phone mailbox bridge preserves page actions and never retries an uncertain POST', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coo-bottle-bridge-'));
  let sea = await mailbox();
  const events = [];
  const host = { store: { range: () => [] }, pushEvent: async e => { events.push(e); return { ...e, cursor: events.length }; } };
  const world = new TinaMobileWorld({ cfg: { host: '127.0.0.1', port: 0, tokenSecret: 'TEST' }, dataDir: dir, botDir: dir, secret: () => 'fixture-only' });
  await world.start(host);
  t.after(async () => { await world.stop(); await sea.close(); assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.match(basename(dir), /^coo-bottle-bridge-/); rmSync(dir, { recursive: true, force: true }); });
  let lookups = 0;
  world.modelControl = { request: async (path, body) => {
    assert.equal(path, '/api/webui/providers/world%3Abottle/panels/mailbox/status'); assert.deepEqual(body, { args: [] });
    lookups++; return { url: sea.url };
  } };
  const base = `http://127.0.0.1:${world.address().port}`;
  const auth = { authorization: 'Bearer fixture-only' };
  assert.equal((await fetch(base + '/v1/bottle/')).status, 401);
  const home = await fetch(base + '/v1/bottle/', { headers: auth });
  assert.equal(home.status, 200); assert.match(await home.text(), /漂流瓶/);
  assert.equal((await fetch(base + '/v1/bottle/draft', { headers: auth })).status, 200);
  assert.equal((await fetch(base + '/v1/bottle/send', { method: 'POST', headers: auth, body: '{}' })).status, 403);
  const postHeaders = { ...auth, 'content-type': 'application/json', 'x-bottle': '1' };
  assert.equal((await fetch(base + '/v1/bottle/send', { method: 'POST', headers: postHeaders, body: '{"kind":"letter"}' })).status, 200);
  assert.equal(sea.seen.filter(x => x.path === '/send').length, 1);
  assert.ok(sea.seen.every(x => x.auth === undefined), 'mobile credential must never be forwarded to the mailbox');
  assert.equal(sea.seen.find(x => x.path === '/send').bottle, '1');
  assert.equal((await fetch(base + '/v1/bottle/send', { method: 'POST', headers: postHeaders, body: '{"kind":"lost-receipt"}' })).status, 503);
  assert.equal(sea.seen.filter(x => x.path === '/send').length, 2, 'an uncertain POST is sent exactly once');
  await sea.close(); sea = await mailbox();
  assert.equal((await fetch(base + '/v1/bottle/draft', { headers: auth })).status, 200);
  assert.ok(lookups >= 2, 'a stopped mailbox is rediscovered');
  assert.equal(events.length, 0, 'opening a mailbox does not inject a conversation event');
});

test('mailbox transfer budgets match upstream customization and archive routes', () => {
  const mib = 1024 * 1024;
  assert.equal(bottleTransferLimits('/send').request, 4096);
  assert.equal(bottleTransferLimits('/background').request, Math.ceil(8 * mib / 3) * 4 + 128);
  assert.equal(bottleTransferLimits('/my-font').request, Math.ceil(32 * mib / 3) * 4 + 2048);
  assert.equal(bottleTransferLimits('/archive/import').request, 32 * mib);
  assert.equal(bottleTransferLimits('/archive/export').response, 32 * mib);
  assert.equal(bottleTransferLimits('/my-font/fixture?view=1').response, 32 * mib);
  assert.equal(bottleTransferLimits('/fonts/fixture').response, 32 * mib);
  assert.equal(bottleTransferLimits('/background/fixture').response, 8 * mib);
});

test('native JSON mailbox RPC retains original actions and never retries an uncertain mutation', async t => {
  const sea = await mailbox(); t.after(() => sea.close());
  const bridge = new BottleBridge({ request: async () => ({ url: sea.url }) });
  assert.equal((await bridge.invoke('GET', '/draft')).path, '/draft');
  assert.equal((await bridge.invoke('POST', '/star', { letterId: 'letter-a', starred: true })).ok, true);
  assert.equal(sea.seen.at(-1).bottle, '1');
  assert.deepEqual(JSON.parse(sea.seen.at(-1).body), { letterId: 'letter-a', starred: true });
  assert.equal((await bridge.invoke('POST', '/my-font', { data: 'A'.repeat(6000) })).ok, true);
  await assert.rejects(bridge.invoke('POST', '/send', { data: 'A'.repeat(6000) }), error => error.status === 413);
  const count = sea.seen.length;
  await assert.rejects(bridge.invoke('POST', '/send', { kind: 'lost-receipt' }));
  assert.equal(sea.seen.length, count + 1);
  assert.ok(sea.seen.every(item => item.auth === undefined));
  await assert.rejects(bridge.invoke('GET', 'http://example.invalid/draft'), error => error.status === 400);
});

test('mailbox proxy forwards font cache and surface hints and delivers large font assets', async t => {
  const sea = await mailbox(); t.after(() => sea.close());
  const bridge = new BottleBridge({ request: async () => ({ url: sea.url }) });
  const proxy = createServer((req, res) => bridge.handle(req, res, new URL(req.url, 'http://fixture.invalid')));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { proxy.closeAllConnections(); proxy.close(resolve); }));
  const base = `http://127.0.0.1:${proxy.address().port}/v1/bottle`;
  const response = await fetch(base + '/draft', { headers: { 'x-bottle-surface': 'card', 'x-bottle-cached-fonts': 'a'.repeat(64) } });
  assert.equal(response.status, 200); await response.arrayBuffer();
  assert.equal(sea.seen.at(-1).surface, 'card'); assert.equal(sea.seen.at(-1).fonts, 'a'.repeat(64));
  const font = await fetch(base + '/my-font/fixture');
  assert.equal(font.status, 200); assert.equal((await font.arrayBuffer()).byteLength, 5 * 1024 * 1024);
});
