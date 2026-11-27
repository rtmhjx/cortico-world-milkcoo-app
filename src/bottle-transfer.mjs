import { createHash } from 'node:crypto';
import { bottleTransferLimits } from './bottle-bridge.mjs';

const CHUNK = 128 * 1024, MIB = 1024 * 1024;
const MAX_IN_FLIGHT = 96 * MIB, MAX_SESSIONS = 32, TTL = 10 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const GET = new Set(['/', '/theme', '/draft', '/appearance', '/announcement', '/notes', '/sounds', '/archive/export', '/icon.png', '/favicon.ico', '/feedback-qr.png']);
const POST = new Set(['/appearance', '/note', '/note/request', '/note/rewrite', '/note/read', '/note/discard', '/note/ack', '/repost', '/archive/import', '/star', '/star-memory', '/star-memory-setting', '/forget', '/wake', '/write', '/catch', '/send', '/rewrite', '/discard', '/dismiss', '/keep', '/peruse', '/open', '/read', '/reply', '/background', '/my-font']);
const GET_PREFIX = ['/my-font/', '/fonts/', '/doodle/', '/background/', '/sounds/'];

function problem(code, status = 400) { return Object.assign(new Error(code), { status }); }
function validPath(method, path, tier) {
  if (typeof path !== 'string' || path.length > 2048 || !path.startsWith('/') || path.startsWith('//') || /[\\\0\r\n#]/.test(path)) throw problem('BOTTLE_PATH_INVALID');
  const rawPath = path.split('?', 1)[0];
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { throw problem('BOTTLE_PATH_INVALID'); }
  if (/%(?:2f|5c|00|2e)/i.test(rawPath) || decoded.includes('\\') || decoded.includes('//') || /[\0\r\n]/.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..')) throw problem('BOTTLE_PATH_INVALID');
  if (method === 'GET' ? !GET.has(decoded) && !GET_PREFIX.some(prefix => decoded.startsWith(prefix) && decoded.length > prefix.length) && !/^\/palette\/[a-f0-9]{6}$/i.test(decoded) : method === 'POST' ? !POST.has(decoded) : true) throw problem('BOTTLE_PATH_INVALID');
  if (tier === 'text' && (decoded === '/my-font' || decoded.startsWith('/my-font/') || decoded.startsWith('/archive/'))) throw problem('BOTTLE_TIER_RESTRICTED', 403);
  return decoded;
}
function text(value, max, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max || /[\r\n\0]/.test(value)) throw problem('BOTTLE_FIELD_INVALID');
  return value;
}
function decode(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(CHUNK / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw problem('BOTTLE_CHUNK_INVALID');
  const data = Buffer.from(value, 'base64');
  if (!data.length || data.length > CHUNK || data.toString('base64') !== value) throw problem('BOTTLE_CHUNK_INVALID');
  return data;
}
async function bounded(response, max) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > max) throw problem('BOTTLE_RESPONSE_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/** In-process connector only; cloud relay supplies authenticated principal and policy. */
export class BottleTransfer {
  constructor(bridge, fetchImpl = globalThis.fetch) { this.bridge = bridge; this.fetch = fetchImpl; this.sessions = new Map(); this.closed = false; }
  close() { this.closed = true; for (const s of this.sessions.values()) s.abort?.abort(); this.sessions.clear(); }
  clean() {
    const now = Date.now();
    for (const [key, s] of this.sessions) if (s.expires < now) { s.abort?.abort(); this.sessions.delete(key); }
  }
  total() { let total = 0; for (const s of this.sessions.values()) total += s.reserved; return total; }
  identity(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !ID.test(input.transfer_id ?? '') || !ID.test(input.device_id ?? '') || !ID.test(input.connector_id ?? '') || !['text', 'paid'].includes(input.relay_tier)) throw problem('BOTTLE_PRINCIPAL_INVALID', 403);
    return `${input.connector_id}\0${input.device_id}\0${input.transfer_id}`;
  }
  async call(input) {
    if (this.closed) throw problem('BOTTLE_STOPPED', 503);
    this.clean();
    const key = this.identity(input), action = input.action;
    let s = this.sessions.get(key);
    if (action === 'begin') {
      const method = input.method, path = text(input.path, 2048), pathname = validPath(method, path, input.relay_tier);
      const contentType = text(input.content_type, 160, 'application/json');
      const surface = text(input.surface, 16), cachedFonts = text(input.cached_fonts, 2079);
      if (surface && !['page', 'card'].includes(surface)) throw problem('BOTTLE_FIELD_INVALID');
      if (cachedFonts && !/^[a-f0-9]{64}(?:,[a-f0-9]{64}){0,31}$/.test(cachedFonts)) throw problem('BOTTLE_FIELD_INVALID');
      const bodyLength = input.body_length;
      const limits = bottleTransferLimits(path);
      if (!Number.isSafeInteger(bodyLength) || bodyLength < 0 || bodyLength > limits.request || method === 'GET' && bodyLength !== 0) throw problem('BOTTLE_BODY_TOO_LARGE', 413);
      const meta = JSON.stringify({ method, path, contentType, surface, cachedFonts, bodyLength, tier: input.relay_tier });
      if (s) { if (s.meta !== meta) throw problem('BOTTLE_TRANSFER_CONFLICT', 409); return this.status(s); }
      const reserve = bodyLength + limits.response;
      if (this.sessions.size >= MAX_SESSIONS || reserve + this.total() > MAX_IN_FLIGHT) throw problem('BOTTLE_CAPACITY', 429);
      s = { meta, method, path, pathname, tier: input.relay_tier, contentType, surface, cachedFonts, bodyLength, limits, reserved: reserve, chunks: [], received: 0, phase: 'upload', expires: Date.now() + TTL };
      this.sessions.set(key, s);
      return this.status(s);
    }
    if (!s || s.tier !== input.relay_tier) throw problem('BOTTLE_TRANSFER_UNKNOWN', 404);
    s.expires = Date.now() + TTL;
    if (action === 'append') {
      if (s.phase !== 'upload') throw problem('BOTTLE_TRANSFER_STATE', 409);
      const offset = input.offset, data = decode(input.data_base64);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + data.length > s.bodyLength) throw problem('BOTTLE_CHUNK_INVALID');
      if (offset < s.received) {
        const existing = s.chunks.find(chunk => chunk.offset === offset);
        if (!existing || !existing.data.equals(data)) throw problem('BOTTLE_TRANSFER_CONFLICT', 409);
      } else {
        if (offset !== s.received) throw problem('BOTTLE_OFFSET_INVALID', 409);
        s.chunks.push({ offset, data }); s.received += data.length;
      }
      return this.status(s);
    }
    if (action === 'execute') {
      if (s.phase === 'upload') {
        if (s.received !== s.bodyLength) throw problem('BOTTLE_UPLOAD_INCOMPLETE', 409);
        s.phase = 'executing'; s.abort = new AbortController();
        void this.perform(s);
      }
      return this.status(s);
    }
    if (action === 'discard') {
      s.abort?.abort(); s.phase = 'discarded'; s.chunks = []; s.result = undefined; s.reserved = 0;
      return this.status(s);
    }
    if (action !== 'read') throw problem('BOTTLE_ACTION_INVALID');
    if (s.phase !== 'ready') return this.status(s);
    const offset = input.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > s.result.length) throw problem('BOTTLE_OFFSET_INVALID');
    const checkedImage = s.tier === 'text' && s.method === 'GET' && s.pathname.startsWith('/background/');
    if (checkedImage && (offset !== 0 || s.result.length > 8 * MIB)) throw problem('BOTTLE_OFFSET_INVALID');
    const length = checkedImage ? s.result.length : Math.min(CHUNK, s.result.length - offset);
    return { ...this.status(s), offset, data_base64: s.result.subarray(offset, offset + length).toString('base64'), done: offset + length === s.result.length };
  }
  status(s) {
    if (s.phase === 'upload') return { phase: s.phase, next_offset: s.received };
    if (s.phase === 'ready') return { phase: s.phase, status: s.status, content_type: s.responseType, total_bytes: s.result.length, sha256: s.sha256 };
    if (s.phase === 'failed') return { phase: s.phase, status: s.status, error: s.error };
    return { phase: s.phase };
  }
  async perform(s) {
    try {
      const base = await this.bridge.mailbox();
      const target = new URL(s.path, base);
      if (target.origin !== base.origin) throw problem('BOTTLE_DESTINATION_CHANGED');
      const headers = {};
      if (s.surface) headers['x-bottle-surface'] = s.surface;
      if (s.cachedFonts) headers['x-bottle-cached-fonts'] = s.cachedFonts;
      let body;
      if (s.method === 'POST') { headers['x-bottle'] = '1'; headers['content-type'] = s.contentType; body = Buffer.concat(s.chunks.map(x => x.data), s.bodyLength); }
      s.chunks = [];
      const signal = AbortSignal.any([s.abort.signal, AbortSignal.timeout(s.limits.timeout)]);
      const response = await this.fetch(target, { method: s.method, headers, ...(body === undefined ? {} : { body }), redirect: 'manual', signal });
      const bytes = await bounded(response, s.limits.response);
      if (s.phase !== 'executing') return;
      s.status = response.status; s.responseType = text(response.headers.get('content-type') || 'application/octet-stream', 160); s.result = bytes;
      s.sha256 = createHash('sha256').update(bytes).digest('hex'); s.phase = 'ready'; s.reserved = bytes.length;
    } catch (error) {
      if (s.phase !== 'executing') return;
      s.phase = 'failed'; s.status = error.status ?? 503; s.error = s.method === 'POST' ? 'BOTTLE_RESULT_UNKNOWN' : 'BOTTLE_UNAVAILABLE'; s.reserved = 0; s.chunks = [];
    }
  }
}
