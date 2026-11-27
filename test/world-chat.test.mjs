import { dockTool } from './dock-tool-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PublicRelayConnector, PUBLIC_RELAY_ORIGIN } from '../src/public-relay.mjs';
import { checkGroupSticker, WorldChatListener } from '../src/world-chat.mjs';
import { TinaMobileWorld } from '../src/world.mjs';

const token = `mcd_${'x'.repeat(43)}`;
const bot = { id: 'bot-1234567890abcdef', kind: 'bot' };
const other = { id: 'bot-aaaaaaaaaaaaaaaa', kind: 'bot' };
const human = { id: 'human-1234567890abcdef', kind: 'human' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const sticker = checkGroupSticker(png, 'image/png');
const stickerWire = { id: sticker.id, mime: sticker.mime };
const message = (seq, author, text, extra = {}) => ({
  seq, author, text, id: 'm_' + seq.toString(16).padStart(32, '0'), created_at: 1000 + seq, ...extra,
});
const feed = (rows, after, enabled = true, revision = 1, limit = 8, start = 0) => {
  const visible = enabled ? (after === undefined ? rows.slice(-limit) : rows.filter(row => row.seq > after).slice(0, limit)) : [];
  return { me: bot, messages: visible, next_cursor: visible.at(-1)?.seq ?? after ?? 0,
    has_more: false, bot_listen_enabled: enabled, bot_listen_revision: revision, bot_listen_start_cursor: start };
};

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'coodock-world-chat-'));
  t.after(() => {
    const target = resolve(dir);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.match(basename(target), /^coodock-world-chat-/);
    rmSync(target, { recursive: true, force: true });
  });
  const context = { dataDir: dir, botDir: dir };
  return { context, world: new TinaMobileWorld(context) };
}

test('public sticker reading, explicit saving and sticker-only posting are separate operations', async t => {
  const { world, context } = fixture(t);
  let enabled = false, returnedData = png, issued;
  const requests = [];
  const relay = new PublicRelayConnector(context, () => assert.fail('Group must not use private channel'), async (url, options) => {
    const { origin, pathname } = new URL(url);
    assert.equal(origin, PUBLIC_RELAY_ORIGIN);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    const input = JSON.parse(options.body);
    requests.push({ pathname, input });
    if (pathname.endsWith('/sticker-read')) {
      assert.deepEqual(input, { id: sticker.id });
      return enabled ? Response.json({ ...stickerWire, data: returnedData.toString('base64') })
        : Response.json({ error: 'world_chat_bot_listen_disabled' }, { status: 403 });
    }
    if (pathname.endsWith('/sticker-upload')) {
      assert.deepEqual(input, { mime: 'image/png', data: png.toString('base64') });
      return Response.json({ sticker: stickerWire });
    }
    assert.ok(pathname.endsWith('/post'));
    issued = input;
    return Response.json({ message: message(10, bot, input.text, { sticker: stickerWire }) });
  });
  relay.profile = { token };
  t.after(() => relay.stop());
  world.publicRelay = relay; world.store = {};
  world.host = { modelFacts: { accepts: mime => mime === 'image/png' } };
  const { actions } = JSON.parse(await dockTool(world, 'help').handler({}));
  assert.equal(actions.some(name => name.includes('listen')), false, 'model must not control listening');
  const read = dockTool(world, 'room_sticker_read').handler, save = dockTool(world, 'room_sticker_save').handler;
  const post = dockTool(world, 'room_post').handler, stats = dockTool(world, 'stickers').handler;
  const args = { sticker_id: sticker.id };
  assert.equal(JSON.parse((await read(args)).text).error, 'world_chat_bot_listen_disabled');
  assert.match(await stats({}), /共 0 张/);
  enabled = true;
  assert.deepEqual((await read(args)).blobs[0].bytes, png);
  assert.match(await stats({}), /共 0 张/, 'viewing does not save');
  world.host.modelFacts.accepts = () => false;
  assert.equal((await read(args)).blobs, undefined, 'unsupported vision returns descriptive metadata');
  returnedData = Buffer.concat([png, Buffer.from('tampered')]);
  assert.equal(JSON.parse((await save(args)).text).error, 'WORLD_CHAT_STICKER_INVALID');
  assert.match(await stats({}), /共 0 张/, 'failed digest never saves');
  returnedData = png;
  const saved = JSON.parse(await save({ ...args, label: '小贴纸' }));
  assert.equal(saved.label, '小贴纸');
  assert.match(await stats({}), /共 1 张/);
  assert.equal(JSON.parse(await save(args)).file, saved.file);
  assert.equal(world.stickerLibrary.list()[0].count, 1, 'repeat save is idempotent');
  enabled = false;
  const receipt = JSON.parse(await post({ sticker_file: saved.file }, { callId: 'share-saved' }));
  assert.deepEqual(issued, { client_id: receipt.client_id, sticker_id: sticker.id, text: '' });
  assert.equal(receipt.message.sticker.id, sticker.id);
  assert.equal(JSON.parse((await post({ sticker_id: sticker.id, sticker_file: saved.file }, { callId: 'bad' })).text).error, 'INVALID_WORLD_CHAT_STICKER');
  assert.equal(JSON.parse((await post({ sticker_file: '..\\private.png' }, { callId: 'traverse' })).text).error, 'WORLD_CHAT_STICKER_NOT_FOUND');
  assert.equal(requests.filter(item => item.pathname.endsWith('/post')).length, 1);
});

test('listener skips old history, catches the first post after phone opt-in, and never wakes for bot-only batches', async () => {
  let enabled = false, revision = 0, start = 0;
  const rows = [message(1, human, 'old'), message(2, bot, 'own old')];
  const readCalls = [], events = [];
  const relay = {
    abort: new AbortController(),
    async worldChat(operation, body) {
      if (operation === 'feed') return feed(rows, body.after, enabled, revision, body.limit, start);
      if (operation === 'sticker-read') {
        readCalls.push(body.id);
        return { ...stickerWire, data: png.toString('base64') };
      }
      assert.equal(operation, 'bot-listen');
      return { bot_listen_enabled: enabled, bot_listen_revision: revision, bot_listen_start_cursor: start };
    },
  };
  const host = { modelFacts: { accepts: mime => mime === 'image/png' },
    async pushEvent(value, options) { events.push({ value, trigger: options.trigger }); } };
  const listener = new WorldChatListener(relay, () => host, 'milkcoo-app');
  await listener.poll();
  enabled = true; revision++; start = 2;
  rows.push(message(3, bot, 'own new'), message(4, human, 'new human', { sticker: stickerWire }), message(5, other, 'other bot'));
  await listener.poll();
  await listener.poll();
  assert.equal(events.length, 1);
  const first = events[0];
  assert.equal(first.trigger, 'flush');
  assert.equal(first.value.origin, 'external');
  assert.match(first.value.text, /new human/);
  assert.match(first.value.text, /other bot/);
  assert.doesNotMatch(first.value.text, /old|own new/);
  assert.deepEqual(first.value.blobs[0].bytes, png);
  assert.deepEqual(readCalls, [sticker.id]);
  rows.push(message(6, other, 'other bot only'));
  await listener.poll();
  assert.equal(events.at(-1).trigger, 'piggyback');
  rows.push(message(7, human, 'while toggle cycles'));
  revision += 2; start = 7; // Phone disabled then enabled before the next World poll.
  rows.push(message(8, human, 'after rebase'));
  await listener.poll();
  assert.equal(events.length, 3);
  assert.match(events.at(-1).value.text, /after rebase/);
  assert.doesNotMatch(events.at(-1).value.text, /while toggle cycles/);
});

test('listener checks phone state after a late feed and suppresses in-flight events on a local switch', async () => {
  let enabled = true, revision = 1, start = 0;
  const rows = [message(1, human, 'initial')];
  let release, hold = null;
  const relay = {
    abort: new AbortController(),
    async worldChat(operation, body) {
      if (operation === 'feed') {
        const page = feed(rows, body.after, enabled, revision, body.limit, start);
        if (hold) await hold;
        return page;
      }
      if ('enabled' in body && enabled !== body.enabled) {
        enabled = body.enabled; revision++;
        if (enabled) start = rows.at(-1)?.seq ?? 0;
      }
      return { bot_listen_enabled: enabled, bot_listen_revision: revision, bot_listen_start_cursor: start };
    },
  };
  const host = { pushEvent: () => assert.fail('a late response must not deliver after disabling') };
  const listener = new WorldChatListener(relay, () => host, 'milkcoo-app');
  await listener.poll();
  rows.push(message(2, human, 'stale'));
  hold = new Promise(resolve => { release = resolve; });
  const phoneRace = listener.poll();
  enabled = false; revision++;
  release(); await phoneRace;
  hold = null;
  enabled = true; revision++; start = 2;
  await listener.poll();
  rows.push(message(3, human, 'also stale'));
  hold = new Promise(resolve => { release = resolve; });
  const localRace = listener.poll();
  await listener.setListening(false);
  release(); await localRace;
  assert.equal(listener.cursor, undefined);
});

test('WebUI activation keeps posts after cutover, and a stale policy cannot re-enable old data', async () => {
  let enabled = false, revision = 2, start = 0, stale;
  const rows = [message(1, human, 'historical')], events = [];
  const relay = {
    abort: new AbortController(),
    async worldChat(operation, body) {
      if (operation === 'feed') return stale ?? feed(rows, body.after, enabled, revision, body.limit, start);
      if ('enabled' in body && enabled !== body.enabled) {
        enabled = body.enabled; revision++;
        if (enabled) start = rows.at(-1).seq;
      }
      return { bot_listen_enabled: enabled, bot_listen_revision: revision, bot_listen_start_cursor: start };
    },
  };
  const host = { pushEvent(event) { events.push(event); } };
  const listener = new WorldChatListener(relay, () => host, 'milkcoo-app');
  await listener.setListening(true); // Before any background poll.
  rows.push(message(2, human, 'posted after WebUI enable'));
  stale = feed(rows, 0, false, 2, 8, 0);
  await listener.poll();
  assert.equal(listener.cursor, 1, 'stale policy must not undo the cutover');
  stale = undefined;
  await listener.poll();
  assert.equal(events.length, 1);
  assert.match(events[0].text, /posted after WebUI enable/);
  assert.doesNotMatch(events[0].text, /historical/);
});

test('connector leaves room polling independent of private relay work and bounds response by operation', async t => {
  let called = false, resolveGroup;
  const group = new Promise(resolve => { resolveGroup = resolve; });
  const relay = new PublicRelayConnector({}, () => {}, async (url) => {
    if (url.endsWith('/relay/poll')) return Response.json({ job: null });
    if (url.endsWith('/feed')) return Response.json({ ...feed([], undefined), extra: 'a'.repeat(100_000) });
    if (url.endsWith('/sticker-read')) return Response.json({ ...stickerWire, data: 'a'.repeat(800_000) });
    assert.fail('unexpected call');
  });
  relay.profile = { token };
  t.after(() => relay.stop());
  relay.worldChatListener = { async poll() { called = true; await group; } };
  await relay.poll();
  assert.equal(called, true);
  assert.equal(relay.state, 'online');
  assert.equal((await relay.worldChat('feed', {})).extra.length, 100_000);
  await assert.rejects(relay.worldChat('sticker-read', {}), /WORLD_CHAT_UNAVAILABLE/);
  const stopped = relay.stop();
  resolveGroup();
  await stopped;
});
