import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { selectedSkin, changeWardrobe } from '../src/pet-wardrobe.mjs';
import { verifyDeployment } from '../src/workbench/deployment-backup.mjs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { validateCheckpoint } from '../src/workbench/checkpoint.mjs';
import { TinaMobileWorld } from '../src/world.mjs';

const pack = { id: 'whale', axes: [{ id: 'outfit', options: [{ id: 'maid' }, { id: 'cape' }] }], presets: [{ id: 'winter', pick: { outfit: 'cape' } }] };
test('outfits use Coo manifest axes and presets; built-in Coo uses native skin fields', () => {
  assert.equal(selectedSkin(pack, { outfit: 'cape' }).scheme, 'winter');
  assert.equal(selectedSkin(pack, { outfit: 'maid' }).scheme, 'maid');
  assert.throws(() => selectedSkin(pack, { outfit: 'missing' }), /PET_OPTION_INVALID/);
  assert.throws(() => selectedSkin(pack, { outfit: 'maid', surprise: 'bad' }), /PET_OPTION_INVALID/);
  const native = { ...pack, id: 'coo' };
  assert.deepEqual(selectedSkin(native, { outfit: 'maid' }, { palette: 'mint' }), { palette: 'mint', figure: 'coo', outfit: 'maid' });
});

test('wardrobe edits the real local HTTP contract and rejects stale desktop state', async t => {
  let skin = { figure: 'whale', scheme: 'maid' }; const paths = [];
  const server = createServer(async (req, res) => {
    paths.push(req.method + ' ' + req.url); let text = ''; for await (const part of req) text += part;
    if (req.url === '/api/skin') skin = JSON.parse(text).skin;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/state' ? { skin } : req.url === '/api/figures' ? [pack] : { ok: true }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const port = server.address().port;
  const result = await changeWardrobe(port, { figure: 'whale', picks: { outfit: 'cape' }, expected: { ...skin } });
  assert.equal(result.state.skin.scheme, 'winter');
  assert.ok(paths.includes('POST /api/skin'));
  await assert.rejects(changeWardrobe(port, { figure: 'whale', picks: { outfit: 'maid' }, expected: { figure: 'whale', scheme: 'maid' } }), /PET_CHANGED_REFRESH/);
});

test('Coo channel provides authenticated, source-preserving computer checkpoints', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coo-workbench-test-'));
  // Keep this bounded fixture for diagnosis; it contains synthetic data only.
  mkdirSync(join(dir, 'data')); mkdirSync(join(dir, 'workspace'));
  const session = JSON.stringify({ item: { type: 'message', role: 'system', content: 'synthetic fixture persona' } }) + '\n';
  writeFileSync(join(dir, 'data/session-main.jsonl'), session);
  writeFileSync(join(dir, 'workspace/fact.txt'), 'source bytes retained');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ activeProvider: 'fixture' }));
  const world = new TinaMobileWorld({ cfg: { host: '127.0.0.1', port: 0 }, dataDir: dir, botDir: dir, secret: () => 'fixture-only' });
  await world.start({ store: { range: () => [], latestCursor: () => 0 }, pushEvent: async () => { throw new Error('No model wake expected'); } });
  t.after(() => world.stop());
  const url = `http://127.0.0.1:${world.address().port}/v1/checkpoint`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { authorization: 'Bearer fixture-only' } });
  assert.equal(response.status, 200);
  const value = await response.json(); validateCheckpoint(value);
  assert.equal(Buffer.from(value.session.data, 'base64').toString(), session);
  assert.equal(Buffer.from(value.files[0].data, 'base64').toString(), 'source bytes retained');
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer fixture-only', 'if-none-match': response.headers.get('etag') } })).status, 304);
});

test('computer settings preserve upstream ownership; backup is encrypted and retains shared provider state', async t => {
  const home = mkdtempSync(join(tmpdir(), 'coo-settings-test-')), dir = join(home, 'bot');
  mkdirSync(join(dir, 'data'), { recursive: true }); mkdirSync(join(home, 'providers/fixture'), { recursive: true });
  writeFileSync(join(dir, 'config.json'), '{"fixture":true}');
  writeFileSync(join(home, 'providers/fixture/state.json'), '{"fixture":"synthetic-provider-state"}');
  const live = new DatabaseSync(join(dir, 'data/live.sqlite'));
  live.exec("PRAGMA journal_mode=WAL; CREATE TABLE source(text); INSERT INTO source VALUES ('原文 WAL 未检查点');");
  t.after(() => live.close());
  const group = { id: 'world:fixture', schema: { properties: { rate: { type: 'integer' } } } };
  let values = { rate: 3 }, writes = 0;
  const desktop = createServer(async (req, res) => {
    let data = ''; for await (const part of req) data += part;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/config') {
      if (req.method === 'POST') { values = JSON.parse(data).values; writes++; }
      res.end(JSON.stringify({ groups: [{ group, values }] }));
    } else if (req.url === '/api/worlds') res.end(JSON.stringify({ worlds: [{ id: 'fixture', active: true }] }));
    else if (req.url === '/api/providers') res.end(JSON.stringify({ providers: [] }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  desktop.listen(0, '127.0.0.1'); await once(desktop, 'listening'); t.after(() => desktop.close());
  const world = new TinaMobileWorld({ cfg: { host: '127.0.0.1', port: 0, consolePort: desktop.address().port }, dataDir: dir, botDir: dir, secret: () => 'fixture-only' });
  await world.start({ store: { range: () => [], latestCursor: () => 0 }, pushEvent: async () => { throw new Error('No model expected'); } });
  t.after(() => world.stop());
  const base = `http://127.0.0.1:${world.address().port}`;
  const call = async (path, body) => fetch(base + path, { headers: { authorization: 'Bearer fixture-only', 'content-type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  assert.equal((await fetch(base + '/v1/desktop/settings')).status, 401);
  assert.equal((await (await call('/v1/desktop/settings')).json()).groups[0].values.rate, 3);
  assert.equal(writes, 0);
  const result = await (await call('/v1/desktop/settings', { group: group.id, expected: { rate: 3 }, values: { rate: 5 } })).json();
  assert.equal(result.readback, true); assert.equal(values.rate, 5); assert.equal(writes, 1);
  assert.equal((await call('/v1/desktop/settings', { group: group.id, expected: { rate: 3 }, values: { rate: 7 } })).status, 409);
  assert.equal(writes, 1); // A stale form never writes over the computer's newer value.
  const response = await call('/v1/desktop/backup', {}); assert.equal(response.status, 200);
  const sealed = await response.json(); assert.equal(sealed.encrypted, undefined); assert.ok(sealed.data);
  assert.throws(() => verifyDeployment(sealed, 'different-device-key'));
  const zip = verifyDeployment(sealed, 'fixture-only'), archive = join(home, 'verify.zip'); writeFileSync(archive, zip);
  const report = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c',
    'import json,zipfile,sys,hashlib; from pathlib import Path; z=zipfile.ZipFile(sys.argv[1]); m=json.loads(z.read("SNAPSHOT-MANIFEST.json")); assert z.testzip() is None; assert all(hashlib.sha256(z.read(f["path"])).hexdigest()==f["sha256"] for f in m["files"]); Path(sys.argv[1]+".sqlite").write_bytes(z.read("deployment/data/live.sqlite")); print(json.dumps({"names":z.namelist(),"files":len(m["files"])}))', archive], { encoding: 'utf8' }));
  assert.ok(report.names.includes('runtime/providers/fixture/state.json')); assert.ok(report.names.includes('deployment/config.json'));
  assert.ok(report.files >= 2);
  const recovered = new DatabaseSync(archive + '.sqlite', { readOnly: true });
  try { assert.equal(recovered.prepare('SELECT text FROM source').get().text, '原文 WAL 未检查点'); }
  finally { recovered.close(); }
  assert.equal(live.prepare('SELECT count(*) AS n FROM source').get().n, 1);
});
