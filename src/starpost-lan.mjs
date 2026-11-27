import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:https';
import { createReadStream, createWriteStream, realpathSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MobileError } from './store.mjs';
import { readPetResource } from './pet-resources.mjs';
import { importFigureZip } from './pet-wardrobe.mjs';
import { nativeControlOperation, isNativeControlPath } from './coodock-native-controls.mjs';
import { boundWorkbenchSettings, boundedWorlds, boundWorldMarket, saveBoundWorldSettings } from './bound-workbench.mjs';
import { consoleEntry } from './console-entry.mjs';

export const STARPOST_LAN = Symbol.for('starpost.coodock.lan.v1');
export const OWNER_MEDIA_LIMIT = 32 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const mimeType = /^[a-z0-9][a-z0-9_.+-]{0,48}\/[a-z0-9][a-z0-9_.+-]{0,79}$/i;
const caps = ['owner-media', 'pet-stream', 'pet-wardrobe', 'provider-telemetry'];
const petRoutes = new Set(['GET /v1/pet/wardrobe', 'POST /v1/pet/wardrobe', 'GET /v1/pet/resource',
  'GET /v1/coo-events', 'POST /v1/pet/import', 'POST /v1/pet/import/install', 'POST /v1/pet/import/cancel']);
const worldRoutes = new Set(['GET /v1/health', 'POST /v1/messages', 'GET /v1/feed', 'GET /v1/media', 'POST /v1/media',
  'GET /v1/ecosystem', 'GET /v1/ecosystem/sessions', 'POST /v1/ecosystem/handoff', 'POST /v1/ecosystem/invoke']);
const boundRoutes = new Set(['GET /v1/services', 'GET /v1/desktop/activity',
  'GET /v1/desktop/settings', 'POST /v1/desktop/settings', 'GET /v1/desktop/extensions', 'GET /v1/console-entry',
  'POST /v1/desktop/provider/activate', 'POST /v1/desktop/world/activation',
  'POST /v1/desktop/world/restart', 'POST /v1/pet/touch']);

async function boundInput(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new MobileError('BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new MobileError('INVALID_JSON', 400); }
}

function boundConsoleEntry(config) {
  try {
    const entry = consoleEntry(config);
    const url = entry.configured ? new URL(entry.url) : null;
    if (url?.protocol === 'https:' && !url.search && !url.hash &&
        !['localhost', '0.0.0.0', '[::1]'].includes(url.hostname) && !url.hostname.startsWith('127.')) return entry;
  } catch { /* This optional service is unavailable. */ }
  return { configured: false, url: '' };
}

export function privateIPv4(address) {
  return /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address);
}

export function lanEndpoints(port, interfaces = networkInterfaces()) {
  const result = new Map();
  for (const [name, rows] of Object.entries(interfaces)) {
    if (/loopback|vethernet|virtual|vbox|vmware|docker|^veth|^br[-0-9]|^tun|^tap|wireguard|tailscale|easytier|wsl|hyper-v|^wg\d/i.test(name)) continue;
    const kind = /wifi|wi-fi|wlan|^wl|无线/i.test(name) ? 'wifi' : 'ethernet';
    for (const address of rows) {
      if (address.family !== 'IPv4' || address.internal || !privateIPv4(address.address)) continue;
      const url = 'https://' + address.address + ':' + port;
      result.set(url, { url, kind, priority: kind === 'ethernet' ? 0 : 10 });
    }
  }
  return [...result.values()].sort((a, b) => a.priority - b.priority || a.url.localeCompare(b.url)).slice(0, 8);
}

// The Android client trusts the exact leaf fingerprint over its authenticated
// Starpost session. No local root CA or trust-store change is needed.
function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  const len = body.length < 128 ? Buffer.of(body.length) : body.length < 256 ? Buffer.of(0x81, body.length) : Buffer.of(0x82, body.length >> 8, body.length & 255);
  return Buffer.concat([Buffer.of(tag), len, body]);
}
export function makeLanIdentity(now = Date.now()) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const seq = (...parts) => der(0x30, ...parts);
  const hex = (tag, value) => der(tag, Buffer.from(value, 'hex'));
  const algorithm = seq(hex(6, '2a8648ce3d040302'));
  const name = seq(der(0x31, seq(hex(6, '550403'), der(0x0c, Buffer.from('Starpost CooDock')))));
  const time = timestamp => der(0x18, Buffer.from(new Date(timestamp).toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'));
  const tbs = seq(der(0xa0, hex(2, '02')), der(2, Buffer.of(1), randomBytes(15)), algorithm, name,
    seq(time(now - 86400000), time(now + 366 * 86400000)), name, publicKey.export({ type: 'spki', format: 'der' }));
  const certificate = seq(tbs, algorithm, der(3, Buffer.of(0), sign('sha256', tbs, privateKey)));
  const cert = '-----BEGIN CERTIFICATE-----\n' + certificate.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert, fingerprint: sha256(certificate) };
}

function reply(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

export class CooDockStarpostLan {
  constructor(world, dataDir, botDir, clock = Date.now) {
    this.world = world;
    this.clock = clock;
    this.root = join(dataDir, 'starpost-owner-media');
    this.botDir = realpathSync(botDir);
    this.instanceId = randomUUID();
    this.grants = [];
    this.imports = new Map();
    this.nativeSessions = new Map();
  }

  async start() {
    const identity = makeLanIdentity();
    this.fingerprint = identity.fingerprint;
    this.server = createServer({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.2' },
      (req, res) => this.handle(req, res).catch(error => {
        if (res.headersSent) res.destroy();
        else reply(res, error instanceof MobileError ? error.status : 500, { error: error instanceof MobileError ? error.message : 'LAN_REQUEST_FAILED' });
      }));
    this.server.requestTimeout = 90_000;
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '0.0.0.0', () => { this.server.off('error', reject); resolve(); });
    });
    this.server.on('error', () => this.revoke());
    this.server.unref();
    const registry = globalThis[STARPOST_LAN] ??= new Map();
    const previous = registry.get(this.botDir);
    if (previous && previous !== this) { await this.close(); throw new Error('STARPOST_LAN_ALREADY_REGISTERED'); }
    registry.set(this.botDir, this);
  }

  setStarpostDeployment(info) {
    const { botId, installationId, routeEpoch, expiresAt } = info ?? {};
    if (typeof botId !== 'string' || !/^\d{5,12}$/.test(botId) ||
        typeof installationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(installationId) ||
        !Number.isSafeInteger(routeEpoch) || routeEpoch < 0 || !Number.isSafeInteger(expiresAt) || expiresAt <= this.clock())
      throw new MobileError('STARPOST_DEPLOYMENT_INVALID', 400);
    const previous = this.deployment;
    if (previous && (previous.botId !== botId || previous.installationId !== installationId || previous.routeEpoch !== routeEpoch)) this.revoke();
    this.routeEpoch = routeEpoch;
    this.deploymentSeen = true;
    this.identity = this.deployment = { ...info };
    return this.dockChannel?.deploymentChanged();
  }

  clearStarpostDeployment() {
    this.deploymentSeen = true;
    this.deployment = undefined;
    this.identity = undefined;
    this.issuePair = undefined;
    this.revoke();
    return this.dockChannel?.deploymentChanged();
  }

  prepare({ botId, installationId, routeEpoch, expiresAt }) {
    this.routeEpoch = routeEpoch;
    const endpoints = lanEndpoints(this.server.address().port);
    const now = this.clock();
    if (!endpoints.length || expiresAt <= now) { this.revoke(); return null; }
    const previous = this.grants.find(item => item.botId === botId && item.descriptor.installationId === installationId
      && item.descriptor.routeEpoch === routeEpoch && item.descriptor.expiresAt > now);
    if (previous && previous.descriptor.expiresAt - now > 38_000) return previous.descriptor;
    const descriptor = { version: 1, installationId, routeEpoch, hostName: hostname().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64) || 'CooDock',
      endpoints, capabilities: caps, lanToken: randomBytes(32).toString('base64url'), serverFingerprint: this.fingerprint, expiresAt };
    this.grants = [{ botId, descriptor, hash: Buffer.from(sha256(descriptor.lanToken), 'hex') }, ...(previous ? [previous] : [])];
    return descriptor;
  }

  revoke() {
    this.grants = []; this.lastProbe = null;
    for (const entry of this.nativeSessions.values()) this.clearNativeSession(entry);
  }
  clearNativeSession(entry) {
    clearTimeout(entry.timer);
    const frames = entry.kind === 'camera' ? this.world.cameraSessions : this.world.screenFrames;
    if (frames?.get(entry.device)?.session_id === entry.session) frames.delete(entry.device);
    this.nativeSessions.delete(entry.key);
  }
  trackNativeSession(method, url, body) {
    const kind = url.pathname.startsWith('/v1/camera/') ? 'camera' : url.pathname === '/v1/screen' ? 'screen' : null;
    if (!kind) return;
    const device = body?.device_id ?? url.searchParams.get('device_id');
    const session = body?.session_id ?? url.searchParams.get('session_id');
    const key = `${kind}:${device}:${session}`;
    const prior = this.nativeSessions.get(key);
    if (prior) clearTimeout(prior.timer);
    if (method === 'DELETE') { if (prior) this.clearNativeSession(prior); return; }
    for (const other of this.nativeSessions.values())
      if (other.kind === kind && other.device === device && other.key !== key) this.clearNativeSession(other);
    if (!prior && this.nativeSessions.size >= 32) this.clearNativeSession(this.nativeSessions.values().next().value);
    const entry = {kind, device, session, key};
    // Phone service shutdown can lose its DELETE during account revocation.
    // Clear only frames accepted through this scoped connector, never another client's session.
    entry.timer = setTimeout(() => this.clearNativeSession(entry), 35_000);
    entry.timer.unref?.();
    this.nativeSessions.set(key, entry);
  }
  current(botId) { return this.grants.find(item => item.botId === botId && item.descriptor.expiresAt > this.clock())?.descriptor; }
  phoneOnline(botId) {
    const current = this.current(botId), prior = this.lastProbe;
    return Boolean(current && prior?.botId === botId && prior.installationId === current.installationId &&
      prior.routeEpoch === current.routeEpoch && this.clock() - prior.at < 45_000);
  }
  async close() {
    this.revoke();
    const registry = globalThis[STARPOST_LAN];
    if (registry?.get(this.botDir) === this) registry.delete(this.botDir);
    await Promise.all([...this.imports].map(([key, entry]) => this.clearImport(key, entry)));
    if (!this.server?.listening) return;
    this.server.closeAllConnections();
    return new Promise(resolve => this.server.close(resolve));
  }

  path(botId, installationId, id) {
    if (!/^\d{5,12}$/.test(botId) || !/^[a-z0-9_-]{1,128}$/i.test(installationId) || typeof id !== 'string' || !digest.test(id))
      throw new MobileError('LAN_MEDIA_REFERENCE_INVALID', 400);
    return join(this.root, botId, installationId, id);
  }

  async read(botId, reference) {
    if (!reference || !digest.test(reference.sha256) || reference.mediaId !== reference.sha256) return null;
    try {
      const path = this.path(botId, reference.installationId, reference.mediaId);
      if ((await stat(path)).size !== reference.size || reference.size > OWNER_MEDIA_LIMIT) return null;
      const bytes = await readFile(path);
      return sha256(bytes) === reference.sha256 ? bytes : null;
    } catch { return null; }
  }

  async write(botId, installationId, upload, size, mime, expected) {
    if (typeof mime !== 'string' || !mimeType.test(mime) || !Number.isSafeInteger(size) || size < 1 || size > OWNER_MEDIA_LIMIT)
      throw new MobileError('LAN_MEDIA_TYPE_OR_SIZE_INVALID', 413);
    const path = this.path(botId, installationId, expected);
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    const tmp = path + '.' + randomUUID() + '.part';
    let seen = 0;
    const hash = createHash('sha256');
    const check = new Transform({ transform(chunk, encoding, callback) {
      seen += chunk.length;
      if (seen > size) return callback(new MobileError('LAN_MEDIA_TOO_LARGE', 413));
      hash.update(chunk);
      callback(null, chunk);
    } });
    try {
      await pipeline(upload, check, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
      if (seen !== size || hash.digest('hex') !== expected) throw new MobileError('LAN_MEDIA_HASH_MISMATCH', 422);
      await rename(tmp, path);
    } finally { await unlink(tmp).catch(() => {}); }
    return { mediaId: expected, sha256: expected, size, mime, installationId };
  }

  async handle(req, res) {
    const { method } = req;
    const url = new URL(req.url, 'https://localhost');
    if (!privateIPv4(req.socket.remoteAddress ?? '') || !privateIPv4(req.socket.localAddress ?? '')) throw new MobileError('LAN_ONLY', 403);
    const auth = Buffer.from(sha256(String(req.headers.authorization ?? '').replace(/^Bearer /, '')), 'hex');
    const grant = this.grants.find(item => item.descriptor.expiresAt > this.clock() && timingSafeEqual(item.hash, auth));
    if (!grant || !/^Bearer [A-Za-z0-9_-]{43}$/.test(req.headers.authorization ?? '')) throw new MobileError('LAN_UNAUTHORIZED', 401);
    const { botId, descriptor } = grant;
    const { installationId, serverFingerprint, routeEpoch, hostName, capabilities } = descriptor;
    if (method === 'GET' && url.pathname === '/v1/lan/health') {
      this.lastProbe = { botId, installationId, routeEpoch, at: this.clock() };
      reply(res, 200, { ok: true, botId, installationId, routeEpoch, serverFingerprint, hostName, capabilities }); return;
    }
    if (method === 'POST' && url.pathname === '/v1/owner/media') {
      const result = await this.write(botId, installationId, req, Number(req.headers['content-length']),
        req.headers['content-type'], req.headers['x-content-sha256']);
      reply(res, 201, result); return;
    }
    if (method === 'GET' && url.pathname.startsWith('/v1/owner/media/')) {
      const path = this.path(botId, installationId, url.pathname.slice('/v1/owner/media/'.length));
      const size = await stat(path).then(result => result.size, () => null);
      if (!size) throw new MobileError('LAN_MEDIA_NOT_FOUND', 404);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size, 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'content-disposition': 'attachment' });
      await pipeline(createReadStream(path), res); return;
    }
    if (method === 'GET' && url.pathname === '/v1/provider/snapshot') {
      reply(res, 200, await this.provider()); return;
    }
    if (boundRoutes.has(method + ' ' + url.pathname)) {
      if (descriptor.routeEpoch !== this.routeEpoch) throw new MobileError('LAN_WORLD_STOPPED', 503);
      const result = await this.boundService(botId, installationId, url, method, method === 'POST' ? await boundInput(req) : undefined);
      reply(res, 200, result); return;
    }
    if (isNativeControlPath(url.pathname)) {
      await this.forwardNative(req, res, method, url); return;
    }
    const route = method + ' ' + url.pathname;
    if (petRoutes.has(route) || worldRoutes.has(route)) { await this.world.handle(req, res, true); return; }
    throw new MobileError('LAN_ROUTE_NOT_FOUND', 404);
  }

  async boundService(botId, installationId, url, method, input) {
    if (!this.matchesDeployment(botId, installationId))
      throw new MobileError('LAN_WORLD_STOPPED', 503);
    const desktop = this.world.workbenchBridge?.desktop.bound();
    if (url.pathname === '/v1/console-entry') return boundConsoleEntry(this.world.context.cfg.consoleUiUrl);
    if (url.pathname === '/v1/services') {
      const results = await Promise.allSettled([
        this.provider(desktop),
        readPetResource(this.world.context.cfg.petPort ?? 7797, '/api/state'),
        desktop ? desktop.request('/api/worlds') : Promise.reject(new Error('Workbench unavailable')),
      ]);
      const [provider, pet, workbench] = results.map(item => item.status === 'fulfilled');
      const console = boundConsoleEntry(this.world.context.cfg.consoleUiUrl);
      return {
        version: 1, botId, installationId, routeEpoch: this.routeEpoch,
        services: {
          provider: { available: provider, snapshot: '/v1/provider/snapshot',
            ...(workbench ? { activate: '/v1/desktop/provider/activate' } : {}) },
          pet: { available: pet, wardrobe: '/v1/pet/wardrobe', resource: '/v1/pet/resource',
            events: '/v1/coo-events', touch: '/v1/pet/touch' },
          workbench: { available: workbench, activity: '/v1/desktop/activity', settings: '/v1/desktop/settings' },
          worlds: { available: workbench, settings: '/v1/desktop/settings', restart: '/v1/desktop/world/restart',
            activation: '/v1/desktop/world/activation', extensions: '/v1/desktop/extensions' },
          ...(console.configured ? { console: { available: true, entry: '/v1/console-entry' } } : {}),
        },
      };
    }
    if (url.pathname === '/v1/pet/touch') {
      if (!input || typeof input !== 'object' || Object.keys(input).length !== 2 ||
          typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.id) || !['poke', 'pet'].includes(input.kind))
        throw new MobileError('INVALID_TOUCH_INPUT', 400);
      if (!this.world.store) throw new MobileError('LAN_WORLD_STOPPED', 503);
      const scope = sha256(JSON.stringify([botId, installationId]));
      const device_id = 'starpost-' + scope.slice(0, 32);
      const id = 'starpost-touch-' + sha256(JSON.stringify([scope, input.id]));
      const created_at = this.world.store.get(id)?.created_at ?? new Date(this.clock()).toISOString();
      return this.world.recordPetTouch({ id, device_id, created_at, kind: input.kind }).acknowledgement;
    }
    if (!desktop) throw new MobileError('WORKBENCH_NOT_AVAILABLE', 503);
    if (url.pathname === '/v1/desktop/activity') {
      const after = url.searchParams.get('after') ?? '';
      if (after && !digest.test(after)) throw new MobileError('WORKBENCH_CURSOR_INVALID', 400);
      return desktop.activity(after);
    }
    if (url.pathname === '/v1/desktop/settings') {
      const provider = () => this.provider(desktop);
      if (method === 'GET') return boundWorkbenchSettings(desktop, provider);
      return saveBoundWorldSettings(desktop, input, provider);
    }
    if (url.pathname === '/v1/desktop/extensions') return boundWorldMarket(desktop);
    const isProvider = url.pathname === '/v1/desktop/provider/activate';
    const isActivation = url.pathname === '/v1/desktop/world/activation';
    const key = isProvider ? 'name' : 'id';
    if (!input || typeof input !== 'object' || Object.keys(input).length !== (isActivation ? 2 : 1) ||
        (isActivation && typeof input.enabled !== 'boolean') ||
        typeof input[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input[key]))
      throw new MobileError('WORKBENCH_ACTION_INVALID', 400);
    if (isProvider) {
      const { instances } = await this.provider(desktop);
      if (!instances.some(item => item.name === input.name && item.ready))
        throw new MobileError('WORKBENCH_PROVIDER_NOT_READY', 409);
      await desktop.request('/api/providers/' + encodeURIComponent(input.name) + '/activate', 'POST');
      return { ok: true, provider: (await this.provider(desktop)).active_provider };
    }
    const worlds = boundedWorlds(await desktop.request('/api/worlds'));
    if (['milkcoo-app', 'starpost'].includes(input.id))
      throw new MobileError('WORKBENCH_TRANSPORT_WORLD', 409);
    if (isActivation) {
      if (!worlds.some(item => item.id === input.id && item.available))
        throw new MobileError('WORKBENCH_WORLD_NOT_AVAILABLE', 404);
      await desktop.request('/api/worlds/activation', 'POST', { id: input.id, enabled: input.enabled });
      const actual = boundedWorlds(await desktop.request('/api/worlds')).find(item => item.id === input.id);
      if (actual?.enabled !== input.enabled) throw new MobileError('WORKBENCH_WORLD_ACTIVATION_MISMATCH', 502);
      return { ok: true, worldId: input.id, enabled: actual.enabled };
    }
    if (!worlds.some(item => item.id === input.id && item.enabled))
      throw new MobileError('WORKBENCH_WORLD_NOT_ACTIVE', 409);
    await desktop.request('/api/worlds/restart', 'POST', { id: input.id });
    return { ok: true, worldId: input.id };
  }

  async provider(desktop = this.world.workbenchBridge?.desktop.bound()) {
    if (!desktop) throw new MobileError('WORKBENCH_NOT_AVAILABLE', 503);
    const [directory, status] = await Promise.all([
      desktop.request('/api/providers'),
      desktop.request('/api/status').catch(() => null),
    ]);
    const brief = await this.world.modelControl.brief(desktop.request, directory);
    const { active_provider, model, effort, model_accepts_image } = brief;
    const module = typeof status?.modelConnection?.module === 'string' ? status.modelConnection.module.slice(0, 128) : '';
    const providers = directory.providers ?? [];
    const instances = providers.filter(item => typeof item.name === 'string').slice(0, 64).map(item => ({
      id: item.name.slice(0, 128), name: item.name.slice(0, 128), selected: item.name === active_provider,
      ready: item.readiness?.state === 'ready',
    }));
    return { active_provider, module, model, effort, model_accepts_image, instances, observedAt: this.clock() };
  }

  async forwardNative(req, res, method, url, suppliedBody) {
    let body = suppliedBody;
    if (method === 'POST' && body === undefined) {
      if (String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json')
        throw new MobileError('NATIVE_JSON_CONTENT_TYPE_REQUIRED', 415);
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1500000) throw new MobileError('NATIVE_REQUEST_TOO_LARGE', 413); chunks.push(chunk); }
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new MobileError('NATIVE_JSON_INVALID'); }
    }
    nativeControlOperation(method, url.pathname + url.search, body);
    const forwarded = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))]);
    forwarded.method = method; forwarded.url = url.pathname + url.search;
    forwarded.headers = { 'content-type': 'application/json' };
    let responseStatus = 502;
    await this.world.handle(forwarded, {
      writeHead: (status, headers) => { responseStatus = status; res.writeHead(status, headers); },
      end: value => {
        if (responseStatus >= 200 && responseStatus < 300) this.trackNativeSession(method, url, body);
        if (url.pathname === '/v1/health') {
          const health = JSON.parse(String(value)); health.native_device_channel = false;
          value = JSON.stringify(health);
        }
        res.end(value);
      },
    }, true);
  }
  matchesDeployment(botId, installationId) {
    const matches = identity => identity?.botId === botId && identity.installationId === installationId;
    if (this.deployment) return this.deployment.expiresAt > this.clock() && matches(this.deployment);
    return matches(this.identity) || matches(this.dockChannel?.routeIdentity());
  }

  async relay(botId, installationId, call) {
    if (!this.matchesDeployment(botId, installationId))
      throw new MobileError('LAN_WORLD_STOPPED', 503);
    const url = new URL(call.path, 'https://coodock.invalid');
    if (typeof call.path !== 'string' || !call.path.startsWith('/v1/') || call.path.includes('\\') || call.path.includes('#') ||
        url.origin !== 'https://coodock.invalid') throw new MobileError('LAN_ROUTE_NOT_FOUND', 404);
    const result = body => ({ status: 200, result: body });
    if (isNativeControlPath(url.pathname)) {
      let status = 502, payload = null;
      await this.forwardNative(null, { writeHead: code => { status = code; }, end: value => { payload = JSON.parse(String(value)); } }, call.method, url, call.body);
      return { status, result: payload };
    }
    if (call.method === 'GET' && url.pathname === '/v1/provider/snapshot') return result(await this.provider());
    if (boundRoutes.has(call.method + ' ' + url.pathname)) {
      if (call.method === 'POST' && Buffer.byteLength(JSON.stringify(call.body ?? null)) > 32768)
        throw new MobileError('BODY_TOO_LARGE', 413);
      return result(await this.boundService(botId, installationId, url, call.method, call.body));
    }
    if (call.method === 'POST' && ['/v1/pet/import/chunk', '/v1/pet/import/finish', '/v1/owner/media/chunk', '/v1/owner/media/finish'].includes(url.pathname))
      return result(await this.cloudUpload(botId, installationId, url.pathname, call.body));
    if (call.method === 'GET' && url.pathname === '/v1/pet/resource' && url.searchParams.get('transfer') !== 'chunks') {
      const path = url.searchParams.get('path');
      if (!['/pet', '/figure-frame', '/api/state', '/api/figures', '/api/avatar'].includes(path)) throw new MobileError('LAN_RESOURCE_PATH_INVALID');
      const { bytes, mime } = await readPetResource(this.world.context.cfg.petPort ?? 7797, path);
      if (bytes.length > 1024 * 1024) throw new MobileError('LAN_RESOURCE_TOO_LARGE', 413);
      return result({ mime, data: bytes.toString('base64'), sha256: sha256(bytes) });
    }
    const media = /^\/v1\/owner\/media\/([a-f0-9]{64})$/.exec(url.pathname);
    if (call.method === 'GET' && media) {
      const path = this.path(botId, installationId, media[1]);
      const offset = Number(url.searchParams.get('offset'));
      const file = await open(path, 'r').catch(() => { throw new MobileError('LAN_MEDIA_NOT_FOUND', 404); });
      try {
        const { size: total } = await file.stat();
        if (!Number.isInteger(offset) || offset < 0 || offset >= total || total > OWNER_MEDIA_LIMIT) throw new MobileError('LAN_MEDIA_RANGE_INVALID', 416);
        const bytes = Buffer.alloc(Math.min(total - offset, 1024 * 1024));
        const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
        if (bytesRead !== bytes.length) throw new MobileError('LAN_MEDIA_TRUNCATED', 503);
        return result({ offset, total, sha256: sha256(bytes), data: bytes.toString('base64') });
      } finally { await file.close(); }
    }
    const route = call.method + ' ' + url.pathname;
    if (!petRoutes.has(route) && !worldRoutes.has(route))
      throw new MobileError('LAN_ROUTE_NOT_FOUND', 404);
    const isArchive = url.pathname === '/v1/pet/import';
    const body = call.body == null ? [] : [isArchive ? Buffer.from(call.body.base64 ?? '', 'base64') : Buffer.from(JSON.stringify(call.body))];
    const req = Readable.from(body);
    req.method = call.method;
    req.url = url.pathname + url.search;
    req.headers = { 'content-type': isArchive ? 'application/zip' : 'application/json' };
    let status = 502, payload = null;
    await this.world.handle(req, {
      writeHead: code => { status = code; },
      end: value => { payload = JSON.parse(String(value)); },
    }, true);
    return { status, result: payload };
  }
  async clearImport(key, entry) {
    clearTimeout(entry.timer);
    if (this.imports.get(key) === entry) this.imports.delete(key);
    await unlink(entry.path).catch(() => {});
  }
  async cloudUpload(botId, installationId, route, value) {
    const media = route.startsWith('/v1/owner/');
    const finish = route.endsWith('/finish');
    const transfer = value?.transfer;
    const total = value?.total;
    if (typeof transfer !== 'string' || !/^[a-f0-9-]{36}$/.test(transfer) ||
        !Number.isInteger(total) || total < 1 || total > (media ? OWNER_MEDIA_LIMIT : 128 * 1024 * 1024)) throw new MobileError('COODOCK_UPLOAD_INVALID');
    const key = [botId, installationId, media ? 'media' : 'pet', transfer].join(':');
    let entry = this.imports.get(key);
    if (!entry) {
      if (finish || value.offset !== 0 || this.imports.size >= 4) throw new MobileError('PET_IMPORT_NOT_READY', 409);
      const file = this.path(botId, installationId, sha256(key)) + '.relay.part';
      entry = { path: file, total, offset: 0, busy: false };
      this.imports.set(key, entry);
    }
    if (entry.busy || entry.total !== total || (finish ? entry.offset !== total : entry.offset !== value.offset))
      throw new MobileError('PET_IMPORT_OFFSET_INVALID', 409);
    entry.busy = true;
    clearTimeout(entry.timer);
    try {
      if (finish) {
        if (media) return await this.write(botId, installationId, createReadStream(entry.path), total, value.mime, value.sha256);
        return await importFigureZip(this.world.context.cfg.petPort ?? 7797, createReadStream(entry.path));
      }
      if (typeof value.data !== 'string' || value.data.length > 1_398_104) throw new MobileError('PET_IMPORT_CHUNK_TOO_LARGE', 413);
      const bytes = Buffer.from(value.data, 'base64');
      if (!bytes.length || bytes.length > 1024 * 1024 || entry.offset + bytes.length > total || sha256(bytes) !== value.sha256)
        throw new MobileError('PET_IMPORT_CHUNK_INVALID');
      await mkdir(join(entry.path, '..'), { recursive: true, mode: 0o700 });
      await appendFile(entry.path, bytes, { flag: entry.offset === 0 ? 'wx' : 'a', mode: 0o600 });
      entry.offset += bytes.length;
      return { received: entry.offset };
    } finally {
      entry.busy = false;
      if (finish) await this.clearImport(key, entry);
      else {
        entry.timer = setTimeout(() => { void this.clearImport(key, entry); }, 120_000);
        entry.timer.unref?.();
      }
    }
  }
}

