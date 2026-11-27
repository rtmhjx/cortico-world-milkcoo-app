import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { LEGACY_WORLD_ID, migrateWorldIdentity, WORLD_ID } from '../src/world-identity.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'coodock-migrate-'));
  const config = join(dir, 'config.json');
  const state = join(dir, 'core-state.json');
  const load = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));
  const save = (path, value) => writeFileSync(path, JSON.stringify(value), 'utf8');
  const context = {
    id: WORLD_ID,
    botDir: dir,
    dataDir: dir,
    cfg: { enabled: false, port: 7801 },
    persist(patch) {
      Object.assign(this.cfg, patch);
      const stored = load(config);
      stored.worlds[WORLD_ID] = patch;
      save(config, stored);
    },
  };
  t.after(() => {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.match(basename(dir), /^coodock-migrate-/);
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, config, state, context, load, save };
}

test('migration keeps legacy config, activation, private visibility and unrelated state', (t) => {
  const { context, config, state, load, save } = fixture(t);
  const legacy = { enabled: true, port: 7821, envPrompt: 'example', tokenSecret: 'CUSTOM_SECRET_NAME' };
  const settings = { language: 'zh', worlds: { [LEGACY_WORLD_ID]: legacy, console: { enabled: true } } };
  writeFileSync(config, '\uFEFF' + JSON.stringify(settings), 'utf8');
  const originalState = { lastDeliveredCursor: 34, worldVisibility: { [LEGACY_WORLD_ID]: false, console: true } };
  save(state, originalState);
  const persist = context.persist.bind(context);
  context.persist = (patch) => {
    assert.equal(load(state).worldVisibility[WORLD_ID], false);
    persist(patch);
  };
  migrateWorldIdentity(context);
  assert.deepEqual(load(config), {
    ...settings,
    worlds: { ...settings.worlds, [WORLD_ID]: legacy },
  });
  assert.deepEqual(load(state), {
    ...originalState,
    worldVisibility: { ...originalState.worldVisibility, [WORLD_ID]: false },
  });
  assert.equal(context.cfg.enabled, true);
  assert.equal(context.cfg.port, 7821);
  context.persist = () => assert.fail('Repeated migration must not save');
  migrateWorldIdentity(context);
});

test('new configuration wins over a legacy enabled section', (t) => {
  const { context, config, state, load, save } = fixture(t);
  const settings = { worlds: { [LEGACY_WORLD_ID]: { enabled: true }, [WORLD_ID]: { enabled: false } } };
  const originalState = { worldVisibility: { [LEGACY_WORLD_ID]: false, [WORLD_ID]: true } };
  save(config, settings);
  save(state, originalState);
  context.persist = () => assert.fail('Explicit new configuration must not be overwritten');
  migrateWorldIdentity(context);
  assert.deepEqual(load(config), settings);
  assert.deepEqual(load(state), originalState);
});

test('a failed config write can be retried without reopening a private World', (t) => {
  const { context, config, state, load, save } = fixture(t);
  save(config, { worlds: { [LEGACY_WORLD_ID]: { enabled: true } } });
  save(state, { worldVisibility: { [LEGACY_WORLD_ID]: false } });
  const persist = context.persist;
  context.persist = () => { throw new Error('simulated write failure'); };
  assert.throws(() => migrateWorldIdentity(context), /未能安全迁移/);
  assert.equal(load(state).worldVisibility[WORLD_ID], false);
  assert.equal(Object.hasOwn(load(config).worlds, WORLD_ID), false);
  context.persist = persist;
  migrateWorldIdentity(context);
  assert.equal(context.cfg.enabled, true);
  assert.equal(load(state).worldVisibility[WORLD_ID], false);
});

test('unreadable visibility and a live foreign deployment fail closed', (t) => {
  const { context, dir, config, state, load, save } = fixture(t);
  const settings = { worlds: { [LEGACY_WORLD_ID]: { enabled: true } } };
  save(config, settings);
  writeFileSync(state, '{', 'utf8');
  assert.throws(() => migrateWorldIdentity(context), /未能安全迁移/);
  assert.deepEqual(load(config), settings);

  const originalState = { worldVisibility: { [LEGACY_WORLD_ID]: false } };
  save(state, originalState);
  save(join(dir, 'instance.lock'), { pid: process.ppid });
  assert.throws(() => migrateWorldIdentity(context), /未能安全迁移/);
  assert.deepEqual(load(config), settings);
  assert.deepEqual(load(state), originalState);
});

test('a fresh or read-only World construction does not write files', (t) => {
  const { context, config, state, load, save } = fixture(t);
  migrateWorldIdentity(context);
  assert.equal(existsSync(config), false);
  assert.equal(existsSync(state), false);
  const settings = { worlds: { [LEGACY_WORLD_ID]: { enabled: true } } };
  save(config, settings);
  delete context.persist;
  migrateWorldIdentity(context);
  assert.deepEqual(load(config), settings);
  assert.equal(existsSync(state), false);
});

test('copies only the deployment prompt byte for byte before saving the new config', (t) => {
  const { context, dir, config, load, save } = fixture(t);
  save(config, { worlds: { [LEGACY_WORLD_ID]: { enabled: true } } });
  const oldDir = join(dir, 'worlds', LEGACY_WORLD_ID);
  const newDir = join(dir, 'worlds', WORLD_ID);
  mkdirSync(oldDir, { recursive: true });
  const original = Buffer.from('\uFEFF# 用户的覆盖\r\n下一行\r\n');
  const oldFile = join(oldDir, 'ENV_PROMPT.md');
  const newFile = join(newDir, 'ENV_PROMPT.md');
  writeFileSync(oldFile, original);
  const persist = context.persist.bind(context);
  context.persist = (patch) => {
    assert.deepEqual(readFileSync(newFile), original);
    persist(patch);
  };
  migrateWorldIdentity(context);
  assert.deepEqual(readFileSync(oldFile), original);
  assert.deepEqual(readdirSync(newDir), ['ENV_PROMPT.md']);
  assert.equal(load(config).worlds[WORLD_ID].enabled, true);
});

test('keeps an existing replacement and respects deletion after migration', (t) => {
  const { context, dir, config, save } = fixture(t);
  save(config, { worlds: { [LEGACY_WORLD_ID]: { enabled: true } } });
  const oldDir = join(dir, 'worlds', LEGACY_WORLD_ID);
  const newDir = join(dir, 'worlds', WORLD_ID);
  mkdirSync(oldDir, { recursive: true });
  mkdirSync(newDir, { recursive: true });
  const oldFile = join(oldDir, 'ENV_PROMPT.md');
  const newFile = join(newDir, 'ENV_PROMPT.md');
  writeFileSync(oldFile, 'legacy');
  writeFileSync(newFile, 'custom');
  migrateWorldIdentity(context);
  assert.equal(readFileSync(newFile, 'utf8'), 'custom');
  rmSync(newFile);
  migrateWorldIdentity(context);
  assert.equal(existsSync(newFile), false);
  assert.equal(readFileSync(oldFile, 'utf8'), 'legacy');
});

test('does not copy a package template into the deployment', (t) => {
  const { context, dir, config, save } = fixture(t);
  save(config, { worlds: { [LEGACY_WORLD_ID]: { enabled: true } } });
  context.packageDir = join(dir, 'separate-package');
  const packageWorld = join(context.packageDir, 'worlds', LEGACY_WORLD_ID);
  mkdirSync(packageWorld, { recursive: true });
  writeFileSync(join(packageWorld, 'ENV_PROMPT.md'), 'package-only');
  migrateWorldIdentity(context);
  assert.equal(existsSync(join(dir, 'worlds')), false);
  assert.equal(context.cfg.enabled, true);
});
