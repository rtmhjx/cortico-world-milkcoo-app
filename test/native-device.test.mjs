import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MobileStore } from '../src/store.mjs';
import { NativeDeviceChannel } from '../src/native-device.mjs';

test('targeted native operations preserve IDs, isolate devices, survive restart and deduplicate results/media', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'native-device-')), 'mobile.sqlite');
  let store = new MobileStore(file), channel = new NativeDeviceChannel(store);
  const request = { device_id: 'phone', operation_id: 'capture-1', world_id: 'screen-observer', path: '/native/capture', args: { source: 'screen' } };
  assert.equal(channel.enqueue(request).state, 'queued');
  assert.equal(channel.enqueue(request).state, 'queued');
  assert.throws(() => channel.enqueue({ ...request, device_id: 'other' }), /CONFLICT/);
  assert.equal(channel.poll({ device_id: 'other' }).operations.length, 0);
  assert.equal(channel.poll({ device_id: 'phone' }).operations[0].state, 'claimed');
  store.close(); store = new MobileStore(file); channel = new NativeDeviceChannel(store);
  assert.equal(channel.poll({ device_id: 'phone' }).operations[0].state, 'claimed');
  const bytes = Buffer.from('synthetic-frame'), hash = createHash('sha256').update(bytes).digest('hex');
  const complete = { operation_id: 'capture-1', device_id: 'phone', result: { ok: true, state: 'succeeded', media_id: hash, captured_at: '2026-11-07T00:00:00Z' },
    media: { data: bytes.toString('base64'), mime: 'image/jpeg' } };
  assert.throws(() => channel.complete({ ...complete, device_id: 'other' }), /NOT_FOUND/);
  assert.equal(channel.complete(complete).state, 'succeeded');
  assert.equal(channel.complete(complete).state, 'succeeded');
  assert.deepEqual(Buffer.from(channel.media('phone', hash).data), bytes);
  assert.equal(channel.poll({ device_id: 'phone' }).operations.length, 0);
  assert.throws(() => channel.complete({ ...complete, result: { state: 'unavailable' } }), /CONFLICT/);
  channel.enqueue({...request,operation_id:'capture-2',device_id:'other'});
  channel.complete({...complete,operation_id:'capture-2',device_id:'other'});
  assert.deepEqual(Buffer.from(channel.media('other',hash).data),bytes);
  store.close();
});

test('permission denial is an actual terminal receipt and never becomes a fabricated media success', () => {
  const store = new MobileStore(':memory:'), channel = new NativeDeviceChannel(store);
  channel.enqueue({ device_id: 'p', world_id: 'w', operation_id: 'a', path: '/native/capture' });
  channel.complete({ device_id: 'p', operation_id: 'a', result: { ok: false, state: 'needs_permission', permission: 'media_projection' } });
  assert.equal(channel.row('a').result.state, 'needs_permission');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM media').get().n, 0);
  assert.throws(() => channel.enqueue({ device_id: 'p', world_id: 'w', operation_id: 'b', path: '/arbitrary-path' }), /INVALID/);
  store.close();
});
