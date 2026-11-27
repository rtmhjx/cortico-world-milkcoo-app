import { createHash, randomBytes } from 'node:crypto';
import { listenState, MAX_GROUP_STICKER, STICKER_ID } from './world-chat.mjs';

export const PUBLIC_RELAY_ORIGIN = 'https://8.137.59.209';
export const PUBLIC_HOME = 'https://htina.top/';
const CONNECTOR_SECRET = 'MILKCOO_APP_PUBLIC_RELAY_CONNECTOR';
const OWNER_KEY = /^mck_[A-Za-z0-9_-]{43}$/;
const DEVICE_TOKEN = /^mcd_[A-Za-z0-9_-]{43}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const ALLOWED = new Set(['POST /v1/messages', 'GET /v1/feed', 'POST /v1/media', 'GET /v1/media',
  'GET /v1/ecosystem', 'POST /v1/ecosystem/handoff', 'POST /v1/ecosystem/invoke', 'POST /v1/bottle/transfer',
  'GET /v1/pet/resource', 'POST /v1/screen', 'DELETE /v1/screen']);
const MAX_WORLD_RESPONSE = 12 * 1024 * 1024;
const WORLD_CHAT_OPERATIONS = new Set(['feed', 'post', 'bot-listen', 'sticker-read', 'sticker-upload']);
const WORLD_CHAT_ERRORS = new Set(['world_chat_muted', 'world_chat_invalid_request', 'world_chat_reply_not_found',
  'world_chat_mention_not_found', 'world_chat_unavailable', 'world_chat_client_id_conflict', 'world_chat_rate_limited',
  'world_chat_sticker_not_found', 'world_chat_invalid_sticker', 'world_chat_sticker_too_large', 'world_chat_bot_listen_disabled']);

async function readBounded(response, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('RELAY_RESPONSE_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export function isPublicRelayKey(value) {
  return typeof value === 'string' && OWNER_KEY.test(value);
}

export class PublicRelayConnector {
  constructor(context, localWorld, request = fetch, internalDispatch = null) {
    this.context = context;
    this.localWorld = localWorld;
    this.internalDispatch = internalDispatch;
    this.request = request;
    this.abort = new AbortController();
    this.state = 'unbound';
  }

  start() {
    let saved;
    try { saved = JSON.parse(this.context.secret(CONNECTOR_SECRET) || 'null'); }
    catch { return; }
    if (saved?.origin === PUBLIC_RELAY_ORIGIN && DEVICE_TOKEN.test(saved.token ?? '') && ID.test(saved.id ?? '')
        && /^[a-f0-9]{64}$/.test(saved.fingerprint ?? '')) {
      this.profile = saved;
      this.schedule(0);
    }
  }

  save(profile) {
    const value = JSON.stringify(profile);
    try {
      this.context.storeSecret(CONNECTOR_SECRET, value);
      if (this.context.secret(CONNECTOR_SECRET) !== value) throw new Error();
    } catch { throw new Error('RELAY_SECRET_STORAGE_UNAVAILABLE'); }
  }

  async bind(key) {
    if (!isPublicRelayKey(key)) throw new Error('RELAY_KEY_INVALID');
    const fingerprint = createHash('sha256').update(key, 'ascii').digest('hex');
    if (this.profile) {
      if (this.profile.fingerprint !== fingerprint) throw new Error('RELAY_OTHER_KEY_BOUND');
      return;
    }
    if (this.binding) throw new Error('RELAY_BINDING_BUSY');
    this.binding = true;
    try {
      const profile = { origin: PUBLIC_RELAY_ORIGIN, id: `pc_${randomBytes(16).toString('hex')}`, fingerprint };
      this.save(profile);
      const result = await this.post('/relay/enroll', { key, role: 'connector', device_id: profile.id });
      if (result.role !== 'connector' || result.device_id !== profile.id || !DEVICE_TOKEN.test(result.token ?? '')) {
        throw new Error('RELAY_ENROLLMENT_INVALID');
      }
      profile.token = result.token;
      this.save(profile);
      this.profile = profile;
      this.schedule(0);
    } finally {
      this.binding = false;
    }
  }

  requestPost(path, body, token, signal) {
    return this.request(PUBLIC_RELAY_ORIGIN + path, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
    });
  }

  async post(path, body, token) {
    const response = await this.requestPost(path, body, token);
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(response.status === 403 ? 'RELAY_AUTH_REJECTED' : 'RELAY_UNAVAILABLE');
    }
    const bytes = await readBounded(response, path === '/relay/poll' ? 16 * 1024 * 1024 : 16384);
    const result = JSON.parse(bytes.toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('RELAY_RESPONSE_INVALID');
    return result;
  }

  async worldChat(operation, body, signal) {
    if (!WORLD_CHAT_OPERATIONS.has(operation)) throw new Error('WORLD_CHAT_INVALID_OPERATION');
    if (!DEVICE_TOKEN.test(this.profile?.token ?? '')) throw new Error('WORLD_CHAT_UNBOUND');
    if (signal?.aborted || this.abort.signal.aborted) throw new Error('CALL_CANCELLED');
    let response, result;
    try {
      response = await this.requestPost(`/relay/world-chat/${operation}`, body, this.profile.token, signal);
      const limit = response.ok && operation === 'feed' ? 1024 * 1024
        : response.ok && operation === 'sticker-read' ? 4 * Math.ceil(MAX_GROUP_STICKER / 3) + 1024 : 16384;
      const bytes = await readBounded(response, limit);
      // HTTP authentication errors from an intermediary may not have a JSON body.
      try { result = JSON.parse(bytes.toString('utf8')); }
      catch (error) { if (![401, 403].includes(response.status)) throw error; }
    } catch {
      // The room may already have accepted a post if its response was lost.
      throw new Error(operation === 'post' && (!response || response.ok || response.status >= 500)
        ? 'WORLD_CHAT_POST_UNKNOWN' : 'WORLD_CHAT_UNAVAILABLE');
    }
    if (!response.ok) {
      if (WORLD_CHAT_ERRORS.has(result?.error)) throw new Error(result.error);
      if (response.status === 401 || response.status === 403) throw new Error('RELAY_AUTH_REJECTED');
      throw new Error(operation === 'post' && response.status >= 500 ? 'WORLD_CHAT_POST_UNKNOWN' : 'WORLD_CHAT_UNAVAILABLE');
    }
    if (operation === 'post' && (typeof result?.message?.id !== 'string' || result.message.author?.kind !== 'bot')) {
      throw new Error('WORLD_CHAT_POST_UNKNOWN');
    }
    if (operation === 'feed' && (!listenState(result) || result?.me?.kind !== 'bot' || !Array.isArray(result.messages)
        || !Number.isSafeInteger(result.next_cursor) || result.next_cursor < 0 || typeof result.has_more !== 'boolean'
        || (!result.bot_listen_enabled && result.messages.length))) {
      throw new Error('WORLD_CHAT_RESPONSE_INVALID');
    }
    if (operation === 'bot-listen' && !listenState(result)) throw new Error('WORLD_CHAT_RESPONSE_INVALID');
    if (operation === 'sticker-upload' && !STICKER_ID.test(result?.sticker?.id ?? '')) throw new Error('WORLD_CHAT_RESPONSE_INVALID');
    return result;
  }

  schedule(delay) {
    if (this.abort.signal.aborted) return;
    this.state = delay === 0 ? 'connecting' : this.state;
    this.timer = setTimeout(() => { void this.poll(); }, delay);
    this.timer.unref();
  }

  async poll() {
    let job;
    let delay = 2000;
    try {
      const { token } = this.profile;
      ({ job } = await this.post('/relay/poll', {}, token));
      this.state = 'online';
      this.pollWorldChat();
      if (job) {
        const result = await this.dispatch(job);
        await this.post('/relay/complete', { request_id: job.request_id, ...result }, token);
        delay = 200;
      }
    } catch {
      if (this.abort.signal.aborted) return;
      this.state = 'unavailable';
      delay = 5000;
      // A dispatched operation may have succeeded. Never replay it on timeout.
      if (job) await this.post('/relay/disconnect', {}, this.profile.token).catch(() => {});
    }
    this.schedule(delay);
  }

  pollWorldChat() {
    if (!this.worldChatListener || this.groupPoll || Date.now() < (this.nextGroupPoll ?? 0)) return;
    this.nextGroupPoll = Date.now() + 5000;
    this.groupPoll = this.worldChatListener.poll().catch(() => {}).finally(() => { this.groupPoll = null; });
  }

  async dispatch(job) {
    const target = job.target;
    const limit = job.max_response_bytes;
    if (!ID.test(job.request_id ?? '') || !target || !ALLOWED.has(`${target.method} ${target.path}`)
        || !Number.isInteger(limit) || limit < 1 || limit > MAX_WORLD_RESPONSE) throw new Error('RELAY_JOB_INVALID');
    // This operation receives its principal from the authenticated cloud job and
    // runs entirely in this process; there is no HTTP endpoint accepting a tier.
    if (target.method === 'POST' && target.path === '/v1/bottle/transfer') {
      let status = 200, result;
      try {
        if (!this.internalDispatch) throw Object.assign(new Error('BOTTLE_UNAVAILABLE'), { status: 503 });
        result = await this.internalDispatch(target.body);
      } catch (error) {
        status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
        result = { error: typeof error?.message === 'string' && /^BOTTLE_[A-Z_]+$/.test(error.message) ? error.message : 'BOTTLE_UNAVAILABLE' };
      }
      const bytes = Buffer.from(JSON.stringify(result));
      if (bytes.length > limit) throw new Error('RELAY_RESPONSE_TOO_LARGE');
      return { status, body_base64: bytes.toString('base64') };
    }
    const { origin, token } = this.localWorld();
    const url = new URL(target.path, origin);
    if (target.query) {
      for (const [name, value] of Object.entries(target.query)) url.searchParams.set(name, String(value));
    }
    const body = target.method === 'POST' ? JSON.stringify(target.body) : undefined;
    const petResource = target.path === '/v1/pet/resource';
    let response, bytes;
    try {
      response = await this.request(url, {
        method: target.method, redirect: 'error',
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10000)]),
      });
      bytes = await readBounded(response, petResource ? Math.floor((limit - 1024) * 3 / 4) : limit);
    } catch (error) {
      if (!petResource || this.abort.signal.aborted) throw error;
      const large = error?.message === 'RELAY_RESPONSE_TOO_LARGE';
      return { status: large ? 413 : 504,
        body_base64: Buffer.from(JSON.stringify({ error: large ? 'pet_resource_too_large' : 'pet_resource_unavailable' })).toString('base64') };
    }
    if (target.path === '/v1/pet/resource' && response.ok && target.query?.transfer !== 'chunks') {
      bytes = Buffer.from(JSON.stringify({ mime: response.headers.get('content-type') || 'application/octet-stream', data: bytes.toString('base64') }));
    }
    return { status: response.status, body_base64: bytes.toString('base64') };
  }

  stop() {
    clearTimeout(this.timer);
    this.abort.abort();
    return this.groupPoll;
  }
}
