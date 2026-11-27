/** Forward the official loopback mailbox through the already authenticated mobile channel. */
export class BottleBridge {
  constructor(modelControl, fetchImpl = globalThis.fetch) {
    this.modelControl = modelControl;
    this.fetch = fetchImpl;
    this.cached = null;
    this.discovering = null;
  }

  async mailbox(force = false) {
    if (!force && this.cached && this.cached.until > Date.now()) return this.cached.url;
    if (this.discovering) return this.discovering;
    this.discovering = (async () => {
      const value = await this.modelControl.request('/api/webui/providers/world%3Abottle/panels/mailbox/status', { args: [] }, 12000);
      const url = new URL(value?.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password ||
          url.pathname !== '/' || url.search || url.hash) throw new Error('BOTTLE_MAILBOX_UNAVAILABLE');
      this.cached = { url, until: Date.now() + 30000 };
      return url;
    })();
    try { return await this.discovering; } finally { this.discovering = null; }
  }

  /** Native service modules call JSON actions without loading a browser page. */
  async invoke(method, path, body) {
    if (!['GET', 'POST'].includes(method) || typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') ||
        /[\\\0#]/.test(path)) throw Object.assign(new Error('BOTTLE_ACTION_INVALID'), { status: 400 });
    const limits = bottleTransferLimits(path);
    const bytes = method === 'POST' ? Buffer.from(JSON.stringify(body ?? {})) : undefined;
    if (bytes && bytes.length > limits.request) throw Object.assign(new Error('BOTTLE_BODY_TOO_LARGE'), { status: 413 });
    const perform = async force => {
      const base = await this.mailbox(force);
      const target = new URL(path, base);
      if (target.origin !== base.origin) throw new Error('BOTTLE_DESTINATION_CHANGED');
      return this.fetch(target, { method, ...(bytes ? { body: bytes } : {}), headers: method === 'POST'
        ? { 'content-type': 'application/json', 'x-bottle': '1' } : {}, redirect: 'manual', signal: AbortSignal.timeout(limits.timeout) });
    };
    let response;
    try { response = await perform(false); }
    catch (error) {
      this.cached = null;
      if (method !== 'GET') throw error;
      response = await perform(true);
    }
    const raw = await readResponse(response, limits.response);
    let result;
    try { result = JSON.parse(raw.toString('utf8')); }
    catch { throw Object.assign(new Error('BOTTLE_JSON_UNAVAILABLE'), { status: response.status >= 400 ? response.status : 502 }); }
    if (!response.ok) throw Object.assign(new Error(result?.message || 'BOTTLE_ACTION_FAILED'), { status: response.status, result });
    return result;
  }

  async handle(req, res, url) {
    const relative = url.pathname.slice('/v1/bottle'.length) || '/';
    if (!['GET', 'POST'].includes(req.method) || !relative.startsWith('/') || relative.startsWith('//') ||
        relative.includes('\\') || relative.includes('\0')) return reply(res, 404, '信箱里没有这个页面。');
    if (req.method === 'POST' && req.headers['x-bottle'] !== '1') return reply(res, 403, '请从信箱页面操作。');
    let body;
    const limits = bottleTransferLimits(relative);
    try { body = req.method === 'POST' ? await readBody(req, limits.request) : undefined; }
    catch { return reply(res, 413, '信箱请求过大或未能读取。'); }

    const forward = async force => {
      const base = await this.mailbox(force);
      const target = new URL(relative + url.search, base);
      if (target.origin !== base.origin) throw new Error('BOTTLE_DESTINATION_CHANGED');
      const headers = {};
      for (const name of ['x-bottle-surface', 'x-bottle-cached-fonts']) {
        if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
      }
      if (req.method === 'POST') {
        headers['x-bottle'] = '1';
        headers['content-type'] = String(req.headers['content-type'] || 'application/json');
      }
      return this.fetch(target, { method: req.method, headers, ...(body === undefined ? {} : { body }),
        redirect: 'manual', signal: AbortSignal.timeout(limits.timeout) });
    };

    try {
      let response;
      try { response = await forward(false); }
      catch (error) {
        this.cached = null;
        // A POST might have reached the mailbox; retrying could send a letter twice.
        if (req.method !== 'GET') throw error;
        response = await forward(true);
      }
      const bytes = await readResponse(response, limits.response);
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/octet-stream',
        'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(bytes);
    } catch {
      reply(res, 503, req.method === 'POST' ? '未能确认操作结果，请刷新信箱查看后再操作。' : '信箱暂时无法连接，请检查漂流瓶 World。');
    }
  }
}

// Match the upstream 0.8.x mailbox's own per-route contracts. Ordinary actions
// stay small; customization and archive features retain their original limits.
export function bottleTransferLimits(path) {
  const route = path.split('?')[0].replace(/\/+$/, '') || '/';
  const mib = 1024 * 1024;
  let request = 4096;
  if (route === '/background') request = Math.ceil(8 * mib / 3) * 4 + 128;
  if (route === '/my-font') request = Math.ceil(32 * mib / 3) * 4 + 2048;
  if (route === '/archive/import') request = 32 * mib;
  let response = 4 * mib;
  if (route.startsWith('/background/')) response = 8 * mib;
  if (route === '/archive/export' || /^\/(my-font|fonts|sounds)\//.test(route)) response = 32 * mib;
  return { request, response, timeout: request > 4096 || response > 4 * mib ? 120000 : 30000 };
}

async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('BOTTLE_BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readResponse(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('BOTTLE_RESPONSE_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function reply(res, status, message) {
  const bytes = Buffer.from(JSON.stringify({ ok: false, message }));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length, 'cache-control': 'no-store' });
  res.end(bytes);
}
