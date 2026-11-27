// Identical policy is shipped alongside the partner-operated World connector.
// This does not grant a lease: both callers must authenticate the active Bot first.
const deny = (message = 'CooDock 原生操作参数无效', status = 400) => { throw Object.assign(new Error(message), { status }); };
const routes = new Map([
  ['/v1/health', ['GET']], ['/v1/worlds', ['GET']], ['/v1/feed', ['GET']],
  ['/v1/model/status', ['GET']], ['/v1/model', ['GET', 'POST']],
  ['/v1/console-input', ['POST']], ['/v1/desktop/public', ['POST']],
  ['/v1/pet/prefs', ['POST']], ['/v1/camera/session', ['POST', 'DELETE']],
  ['/v1/camera/control', ['GET', 'POST']], ['/v1/camera/frame', ['POST']], ['/v1/screen', ['POST', 'DELETE']],
]);
export const NATIVE_FRAME_LIMIT = 1024 * 1024;
export const isNativeControlPath = path => routes.has(path);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const only = (body, keys) => body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(key => keys.includes(key));
const record = value => value && typeof value === 'object' && !Array.isArray(value);
function safeJson(value, depth = 0) {
  if (depth > 16) return false;
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(item => safeJson(item, depth + 1));
  return record(value) && Object.keys(value).every(key => !['__proto__', 'prototype', 'constructor'].includes(key) && safeJson(value[key], depth + 1));
}
/** This is the old host control plane, limited to the operations used by its native pages. */
function management(body) {
  const unsupported = () => deny('原生管理操作未开放', 403);
  if (!only(body, ['path', 'method', 'body', 'expectedDeployment']) || !['GET', 'POST'].includes(body.method) ||
      typeof body.path !== 'string' || !safeJson(body) ||
      body.expectedDeployment !== undefined && !/^[a-f0-9]{64}$/.test(body.expectedDeployment)) unsupported();
  const url = new URL(body.path, 'https://host.invalid');
  if (url.origin !== 'https://host.invalid' || url.hash || url.pathname + url.search !== body.path) unsupported();
  const data = body.body;
  if (body.method === 'GET') {
    if (data != null) unsupported();
    if (url.pathname === '/api/extensions/search') {
      if ([...url.searchParams.keys()].some(key => key !== 'kind') || url.searchParams.getAll('kind').length !== 1 ||
          !['world', 'bot', 'provider'].includes(url.searchParams.get('kind'))) unsupported();
    } else if (url.search || !new Set(['/api/status', '/api/run/lifecycle', '/api/worlds', '/api/webui/manifest',
        '/api/config', '/api/providers', '/api/prompts', '/api/prompts/prefix', '/api/extensions']).has(url.pathname)) unsupported();
    return;
  }
  if (url.search) unsupported();
  if (url.pathname === '/api/config') {
    if (!only(data, ['group', 'values', 'expected']) || !text(data.group, 256) || !record(data.values) ||
        data.expected !== undefined && !record(data.expected)) unsupported();
  } else if (url.pathname === '/api/prompts') {
    if (!only(data, ['key', 'content', 'baseRevision']) || !text(data.key, 256) || typeof data.content !== 'string' ||
        data.content.length > 24000 || !text(data.baseRevision, 256)) unsupported();
  } else if (url.pathname === '/api/session/reload-prefix') {
    if (!only(data, []) || Object.keys(data).length) unsupported();
  } else if (/^\/api\/providers\/[^/?]+\/activate$/.test(url.pathname)) {
    let name; try { name = decodeURIComponent(url.pathname.split('/')[3]); } catch { unsupported(); }
    if (!text(name, 128) || /[\\/]/.test(name) || !only(data, []) || Object.keys(data).length) unsupported();
  } else if (url.pathname === '/api/worlds/activation' || url.pathname === '/api/worlds/visibility' || url.pathname === '/api/worlds/restart') {
    const field = url.pathname.endsWith('activation') ? 'enabled' : url.pathname.endsWith('visibility') ? 'visible' : null;
    if (!only(data, field ? ['id', field] : ['id']) || !id(data.id) ||
        field && typeof data[field] !== 'boolean') unsupported();
    if (url.pathname.endsWith('restart') && !body.expectedDeployment) unsupported();
  } else if (url.pathname === '/api/extensions/install') {
    if (!only(data, ['name', 'version']) || !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(data.name ?? '') ||
        data.version !== undefined && !/^[A-Za-z0-9.*^~+<>=| -]{1,100}$/.test(data.version) || !body.expectedDeployment) unsupported();
  } else unsupported();
}
function query(url, keys, required = []) {
  if ([...url.searchParams.keys()].some(key => !keys.includes(key) || url.searchParams.getAll(key).length !== 1) ||
      required.some(key => !id(url.searchParams.get(key)))) deny();
}
function settings(body) {
  if (body.quality !== undefined && !['low', 'balanced', 'high'].includes(body.quality) ||
      body.interval_sec !== undefined && (!Number.isInteger(body.interval_sec) || body.interval_sec < 2 || body.interval_sec > 120) ||
      ['adaptive', 'proactive'].some(key => body[key] !== undefined && typeof body[key] !== 'boolean')) deny();
}
function frame(body, screen) {
  const keys = ['device_id', 'session_id', 'captured_at', 'mime', 'data', ...(screen ? ['proactive', 'peek'] : ['changed'])];
  if (!only(body, keys) || !id(body.device_id) || !id(body.session_id) || !text(body.captured_at, 80) ||
      !Number.isFinite(Date.parse(body.captured_at)) || body.mime !== 'image/jpeg' || typeof body.data !== 'string' ||
      body.data.length > 1398104 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data) || body.data.length % 4 !== 0 ||
      ['changed', 'proactive', 'peek'].some(key => body[key] !== undefined && typeof body[key] !== 'boolean')) deny();
  const bytes = Buffer.from(body.data, 'base64');
  if (bytes.toString('base64') !== body.data || bytes.length < 4 || bytes.length > NATIVE_FRAME_LIMIT || bytes[0] !== 255 || bytes[1] !== 216 ||
      bytes.at(-2) !== 255 || bytes.at(-1) !== 217) deny('仅支持不超过 1 MiB 的 JPEG 画面', 413);
}
/** true: supported native route; false: caller must apply its separate fixed route policy. */
export function nativeControlOperation(method, path, body) {
  const url = new URL(path, 'https://coodock.invalid');
  if (url.origin !== 'https://coodock.invalid' || url.hash || url.pathname + url.search !== path) deny('原生路由无效', 403);
  const methods = routes.get(url.pathname);
  if (!methods) return false;
  if (!methods.includes(method)) deny('原生路由未开放该方法', 403);
  if (Buffer.byteLength(JSON.stringify(body ?? null)) > (['/v1/screen', '/v1/camera/frame'].includes(url.pathname) ? 1500000 : 32768)) deny('原生请求过大', 413);
  if (method !== 'POST') {
    if (body != null) deny();
    if (url.pathname === '/v1/feed') {
      query(url, ['device_id', 'after', 'limit'], ['device_id']);
      for (const [name, max] of [['after', Number.MAX_SAFE_INTEGER], ['limit', 100]]) {
        const raw = url.searchParams.get(name);
        if (raw !== null && (!/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max || name === 'limit' && Number(raw) < 1)) deny();
      }
    } else if (url.pathname === '/v1/camera/control' || method === 'DELETE') query(url, ['device_id', 'session_id'], ['device_id', 'session_id']);
    else if (url.pathname === '/v1/model') {
      query(url, ['provider']); if (url.searchParams.has('provider') && !text(url.searchParams.get('provider'), 128)) deny();
    } else query(url, []);
    return true;
  }
  query(url, []);
  if (url.pathname === '/v1/desktop/public') management(body);
  else if (url.pathname === '/v1/console-input') {
    if (!only(body, ['device_id', 'text']) || !id(body.device_id) || typeof body.text !== 'string' ||
        !body.text.trim() || body.text.length > 16000 || body.text.includes('\0')) deny();
  } else if (url.pathname === '/v1/screen' || url.pathname === '/v1/camera/frame') frame(body, url.pathname === '/v1/screen');
  else if (url.pathname === '/v1/pet/prefs') {
    if (!only(body, ['theme', 'sound']) || !Object.keys(body).length || body.theme !== undefined && !['dark', 'light'].includes(body.theme) ||
        body.sound !== undefined && typeof body.sound !== 'boolean') deny();
  } else if (url.pathname === '/v1/model') {
    if (!only(body, ['provider', 'model', 'effort', 'revision']) || !text(body.provider, 128) || !text(body.model, 200) ||
        !text(body.revision, 256) || !['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(body.effort)) deny();
  } else {
    if (!only(body, ['device_id', 'session_id', 'quality', 'interval_sec', 'adaptive', 'proactive']) || !id(body.device_id) || !id(body.session_id)) deny();
    settings(body);
  }
  return true;
}
