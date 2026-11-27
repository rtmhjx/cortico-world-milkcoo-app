import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchEasyTierAsset, EASYTIER_ASSETS } from '../src/easytier-assets.mjs';

test('optional download checks pinned digest and never runs or overwrites existing files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'coo-easytier-'));
  t.after(async () => { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.match(basename(dir), /^coo-easytier-/); await rm(dir, { recursive: true, force: true }); });
  const bytes = Buffer.from('fixture component');
  const assets = { windows: { name: 'fixture.exe', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
  const options = { assets, fetch: async url => { assert.equal(url, 'https://github.com/EasyTier/EasyTier/releases/download/v2.6.4/fixture.exe'); return new Response(bytes); } };
  assert.equal((await fetchEasyTierAsset('windows', dir, options)).state, 'verified-new');
  assert.deepEqual(await readFile(join(dir, 'fixture.exe')), bytes);
  assert.equal((await fetchEasyTierAsset('windows', dir, { ...options, fetch: () => { throw new Error('must not download'); } })).state, 'verified-existing');
  await writeFile(join(dir, 'fixture.exe'), 'different');
  await assert.rejects(fetchEasyTierAsset('windows', dir, options), /EXISTING_FILE_HASH_MISMATCH/);
  assert.equal((await readFile(join(dir, 'fixture.exe'))).toString(), 'different');
  await assert.rejects(fetchEasyTierAsset('other', dir, options), /UNKNOWN_ASSET/);
  assert.deepEqual(await readdir(dir), ['fixture.exe']);
  assert.equal(EASYTIER_ASSETS.android.sha256.length, 64);
});

test('invalid bytes are removed before they can become an installer', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'coo-easytier-'));
  t.after(async () => { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.match(basename(dir), /^coo-easytier-/); await rm(dir, { recursive: true, force: true }); });
  const assets = { windows: { name: 'fixture.exe', size: 4, sha256: '0'.repeat(64) } };
  await assert.rejects(fetchEasyTierAsset('windows', dir, { assets, fetch: async () => new Response('fake') }), /DOWNLOAD_HASH_MISMATCH/);
  assert.deepEqual(await readdir(dir), []);
});
