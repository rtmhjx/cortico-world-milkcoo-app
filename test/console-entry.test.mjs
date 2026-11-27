import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consoleEntry } from '../src/console-entry.mjs';
import { TinaMobileWorld } from '../src/world.mjs';

test('console UI preserves the supplied origin, reverse-proxy prefix and route instead of deriving another port', () => {
  assert.deepEqual(consoleEntry(''), { configured: false, url: '' });
  assert.equal(consoleEntry('https://example.test/tina/console/#/worlds').url, 'https://example.test/tina/console/#/worlds');
  assert.equal(consoleEntry('http://[::1]:17788/').url, 'http://[::1]:17788/');
  assert.throws(() => consoleEntry('http://user:private@example.test/'));
  assert.throws(() => consoleEntry('javascript:alert(1)'));
});

test('console entry is authenticated, optional and reads current configuration without model calls or credential injection', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coo-console-entry-')), cfg = { host: '127.0.0.1', port: 0 };
  const world = new TinaMobileWorld({ cfg, dataDir: dir, botDir: dir, secret: () => 'fixture-phone-token' });
  await world.start({ store: { range: () => [], latestCursor: () => 0 }, pushEvent: async () => { throw new Error('Unexpected model wake'); } });
  t.after(() => world.stop()); const base = `http://127.0.0.1:${world.address().port}`;
  assert.equal((await fetch(base + '/v1/console-entry')).status, 401);
  const get = () => fetch(base + '/v1/console-entry', { headers: { authorization: 'Bearer fixture-phone-token' } });
  assert.deepEqual(await (await get()).json(), { configured: false, url: '' });
  cfg.consoleUiUrl = 'https://example.test/tina/console/#/worlds';
  const first = await (await get()).json(); assert.equal(first.url, cfg.consoleUiUrl);
  assert.ok(!JSON.stringify(first).includes('fixture-phone-token'));
  cfg.consoleUiUrl = 'https://second.example.test/deployments/tina/';
  assert.equal((await (await get()).json()).url, cfg.consoleUiUrl);
  cfg.consoleUiUrl = 'file:///private'; assert.equal((await get()).status, 400);
});

test('World offers companion and full-workbench APKs through the existing local download boundary', {
  skip: !existsSync(new URL('../client/Coo-Mobile-0.6.0-dev.2-debug.apk', import.meta.url)) || !existsSync(new URL('../client/Coo-Mobile-0.6.0-dev.2-workbench-debug.apk', import.meta.url)),
}, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coo-dual-app-'));
  const world = new TinaMobileWorld({ cfg: { host: '127.0.0.1', port: 0 }, dataDir: dir, botDir: dir, secret: () => 'fixture-dual-app-token' });
  await world.start({ store: { range: () => [], latestCursor: () => 0 }, pushEvent: async () => {} });
  t.after(() => world.stop()); const full = world.console().links.find(link => link.href.endsWith('/install-workbench.apk'));
  assert.ok(full); const response = await fetch(full.href); assert.equal(response.status, 200);
  assert.ok(Buffer.from(await response.arrayBuffer()).includes(Buffer.from('fixture-dual-app-token')));
  await assert.rejects(world.handle({ method: 'GET', url: '/_coo/install-workbench.apk', headers: { host: `127.0.0.1:${world.address().port}` }, socket: { remoteAddress: '192.168.1.8' } }, {}), /LOCAL_DOWNLOAD_ONLY/);
});
