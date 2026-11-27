import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ModelControl } from '../src/model-control.mjs';

test('model settings use Coo revisions, keep credentials server-side, and honor image capability for DeepSeek', async t => {
  let revision = 'r1', entry = { kind: 'openai-responses-compat', baseUrl: 'https://api.deepseek.com', secret: 'PRIVATE_VARIABLE',
    spec: { model: 'deepseek-v4-pro', thinking: true, reasoningEffort: 'high', contextWindow: 1000000 }, multimodal: false };
  const paths = [];
  const server = createServer(async (req, res) => {
    const body = []; for await (const part of req) body.push(part);
    const data = body.length ? JSON.parse(Buffer.concat(body).toString()) : {};
    const path = new URL(req.url, 'http://test').pathname; paths.push(path);
    let out;
    if (path === '/api/providers') out = { active: 'main', providers: [{ name: 'main', model: entry.spec.model, active: true, readiness: { state: 'ready' } }] };
    else if (path === '/api/provider-modules') out = [{ id: entry.kind, reasoningTiers: [], effortSuggestions: ['none', 'low', 'medium', 'high'] }];
    else if (path === '/api/providers/main/models') out = { models: [{ id: 'deepseek-flash', displayName: 'DeepSeek-V4.1-Flash' }, { id: 'deepseek-v4-pro', displayName: 'DeepSeek-V4-Pro' }] };
    else if (path === '/api/providers/main/save') { assert.equal(data.expectedRevision, revision); entry = data.entry; revision = 'r2'; out = { name: 'main' }; }
    else if (path === '/api/providers/main') out = { name: 'main', revision, entry };
    else { res.writeHead(404).end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const control = new ModelControl({ cfg: { consolePort: server.address().port } });
  const before = await control.state();
  assert.equal(JSON.stringify(before).includes('PRIVATE_VARIABLE'), false);
  assert.deepEqual(before.models, []);
  assert.deepEqual(before.efforts, ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.match(before.model_error, /公开接口/);
  const after = await control.apply({ provider: 'main', model: 'deepseek-flash', effort: 'max', revision: before.revision });
  assert.equal(after.model, 'deepseek-flash'); assert.equal(after.effort, 'max'); assert.equal(after.multimodal, true);
  assert.equal(entry.secret, 'PRIVATE_VARIABLE'); assert.equal(entry.spec.contextWindow, 1000000);
  await assert.rejects(() => control.apply({ provider: 'main', model: 'deepseek-v4-pro', effort: 'none', revision: 'r1' }), /别处改变/);
  const pro = await control.apply({ provider: 'main', model: 'deepseek-v4-pro', effort: 'none', revision: 'r2' });
  assert.equal(pro.multimodal, false); assert.equal(pro.effort, 'none'); assert.equal(entry.spec.reasoningEffort, undefined);
  assert.ok(paths.every(path => !path.includes('/models') && path !== '/api/provider-modules'));
});
