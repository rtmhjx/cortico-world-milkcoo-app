import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { EcosystemSessions, EcosystemError, ECOSYSTEM_SECRET, dispatchEcosystemRequest } from '../src/ecosystem-session.mjs';

test('host compatibility facade reads unchanged v1 secrets and active pointers and preserves old route errors', async () => {
  const legacy = { serviceId: 'starpost', issuer: 'https://old.invalid', subject: 'old-human', botId: 'old-bot',
    providerId: 'legacy', credential: { accessToken: 'synthetic-old-token' }, updatedAt: 1 };
  const key = JSON.stringify(['starpost', 'https://old.invalid', 'old-human', 'old-bot']);
  const stored = new Map([[ECOSYSTEM_SECRET, JSON.stringify({ version: 1, sessions: [legacy], active: { starpost: key } })]]);
  const auth = new EcosystemSessions({ context: { secret: key => stored.get(key), storeSecret: (key, value) => stored.set(key, value) } });
  assert.equal(auth.sessions('starpost')[0].active, true);
  assert.deepEqual((await dispatchEcosystemRequest(auth, 'GET', '/v1/ecosystem/sessions', { serviceId: 'starpost' })).body.sessions, auth.sessions('starpost'));
  assert.deepEqual(await dispatchEcosystemRequest(auth, 'POST', '/v1/ecosystem/login'), { status: 409, body: { error: 'ECOSYSTEM_PROVIDER_PENDING' } });
  assert.throws(() => auth.requireService('unregistered'), error => error instanceof EcosystemError && error.message === 'ECOSYSTEM_SERVICE_UNKNOWN');
  auth.adoptSession({ ...legacy, subject: 'new-human' });
  assert.ok(JSON.parse(stored.get(ECOSYSTEM_SECRET)).sessions.some(item => item.subject === 'old-human'));
  assert.equal(JSON.parse(stored.get(ECOSYSTEM_SECRET)).version, 1);
});

test('World vendored generic source matches standalone package byte-for-byte', () => {
  const root = new URL('../src/vendor/coodock-auth-adapter/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('UPSTREAM.json', root), 'utf8'));
  for (const entry of manifest.files) {
    const actual = readFileSync(new URL(entry.file, root));
    const original = readFileSync(new URL(`../../${entry.source}`, import.meta.url));
    assert.deepEqual(actual, original);
    assert.equal(createHash('sha256').update(actual).digest('hex'), entry.sha256);
  }
});
