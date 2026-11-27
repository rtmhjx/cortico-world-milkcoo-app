import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import legacyDefinition, { TinaMobileWorld as LegacyWorld } from '../../coo-world/src/world.mjs';
import newDefinition, { TinaMobileWorld as NewWorld } from '../src/world.mjs';

test('old and new Worlds keep identity, data, tools and event sources distinct under one host data directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'milkcoo-coexistence-'));
  const events = [];
  const host = {
    store: {
      latestCursor: () => events.at(-1)?.cursor ?? 0,
      range: q => events.filter(e => (q.source === undefined || e.source === q.source)
        && (q.senderKey === undefined || e.senderKey === q.senderKey)
        && (q.fromCursor === undefined || e.cursor >= q.fromCursor)
        && (q.toCursor === undefined || e.cursor <= q.toCursor)),
    },
    async pushEvent(event) { const saved = { ...event, cursor: events.length + 1 }; events.push(saved); return saved; },
  };
  const context = id => ({ id, cfg: { host: '127.0.0.1', port: 0, tokenSecret: 'FIXTURE' },
    dataDir: dir, botDir: dir, secret: () => 'fixture-token' });
  const old = new LegacyWorld(context('coo_mobile'));
  const current = new NewWorld(context('milkcoo_app'));
  try {
    assert.equal(legacyDefinition.id, old.id);
    assert.equal(newDefinition.id, current.id);
    assert.notEqual(legacyDefinition.id, newDefinition.id);
    assert.equal(legacyDefinition.defaults().port, 7800);
    assert.equal(newDefinition.defaults().port, 7801);
    assert.notEqual(legacyDefinition.defaults().tokenSecret, newDefinition.defaults().tokenSecret);
    const oldTools = new Set(old.tools().map(tool => tool.name));
    assert.ok(current.tools().every(tool => !oldTools.has(tool.name)));
    await old.start(host);
    await current.start(host);
    assert.ok(existsSync(join(dir, 'mobile.sqlite')));
    assert.ok(existsSync(join(dir, 'milkcoo_app', 'mobile.sqlite')));
    assert.notEqual(old.store.serverId, current.store.serverId);
    const message = { id: 'same-message-id', device_id: 'fixture-phone', text: 'fixture', created_at: '2026-10-31T00:00:00Z' };
    for (const world of [old, current]) {
      const res = await fetch(`http://127.0.0.1:${world.address().port}/v1/messages`, { method:'POST',
        headers: { authorization:'Bearer fixture-token', 'content-type':'application/json' }, body:JSON.stringify(message) });
      assert.equal(res.status, 201);
      while (world.pending) await world.pending;
    }
    assert.deepEqual(events.map(e => e.source), ['coo_mobile', 'milkcoo-app']);
    assert.ok(events.every(e => e.type === 'coo_mobile.message'));
    const response = await fetch(`http://127.0.0.1:${current.address().port}/v1/coo-events`, { headers: { authorization:'Bearer fixture-token' } });
    const feed = await response.json();
    assert.deepEqual(feed.events.map(e => e.source), ['coo_mobile', 'milkcoo_app']);
  } finally {
    await current.stop(); await old.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
