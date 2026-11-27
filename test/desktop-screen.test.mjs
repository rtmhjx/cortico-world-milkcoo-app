import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DesktopScreenSampler } from '../src/desktop-screen.mjs';

test('desktop screen observation is opt-in, never overlaps model calls in pull mode, and stops cleanly', async t => {
  let captures = 0, stopped = 0, pushed = 0;
  const host = { modelFacts: { accepts: () => true }, async pushEvent() { pushed++; } };
  const sampler = new DesktopScreenSampler(host, {}, async () => ({
    async take() { captures++; return { bytes: Buffer.from('synthetic'), pixels: new Uint8Array(32 * 32 * 3), cursor: { x: 1, y: 2 }, captured_at: new Date().toISOString() }; },
    async stop() { stopped++; },
  }));
  t.after(() => sampler.stop());
  assert.equal(sampler.state().running, false);
  await sampler.configure({ enabled: true, seconds: 10, adaptive: true, proactive: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(captures, 1);
  assert.ok(sampler.latest);
  assert.equal(pushed, 0);
  await sampler.stop();
  assert.equal(stopped, 1);
  assert.equal(sampler.latest, null);
  assert.equal(sampler.state().running, false);
});

test('a stop during startup does not let a late capture become active', async () => {
  let release, stopped = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const sampler = new DesktopScreenSampler({}, {}, async () => { await waiting; return { async stop() { stopped++; } }; });
  const starting = sampler.configure({ enabled: true, seconds: 10, adaptive: false, proactive: false });
  await sampler.stop(); release(); await starting;
  assert.equal(stopped, 1);
  assert.equal(sampler.state().running, false);
});

test('proactive screen event keeps the new World source and existing client event type', async t => {
  const events = [];
  const host = { modelFacts: { accepts: () => true }, async pushEvent(event) { events.push(event); } };
  const sampler = new DesktopScreenSampler(host, { id: 'milkcoo_app' }, async () => ({
    async take() { return { bytes: Buffer.from('fixture'), pixels: new Uint8Array(3), cursor: null, captured_at: '2026-10-31T00:00:00Z' }; },
    async stop() {},
  }));
  t.after(() => sampler.stop());
  await sampler.configure({ enabled: true, seconds: 10, adaptive: false, proactive: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'milkcoo_app');
  assert.equal(events[0].type, 'coo_mobile.desktop_screen');
});

test('the default desktop capture reports unavailable without inspecting the host', async () => {
  const sampler = new DesktopScreenSampler({}, {});
  assert.equal(sampler.state().available, false);
  assert.match(sampler.state().error, /未提供电脑读屏/);
  await assert.rejects(sampler.configure({ enabled: true, seconds: 10, adaptive: false, proactive: false }), /未提供电脑读屏/);
  assert.equal(sampler.state().running, false);
});
