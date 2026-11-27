import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const digest = value => createHash('sha256').update(value).digest('hex');
const hostError = (status, message) => Object.assign(new Error(message), { status });
const textOf = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.map(part => part.text ?? '').join('') : JSON.stringify(value ?? '');

/** Use Cortico's own settings contracts; no second configuration authority. */
export class DesktopBridge {
  constructor({ deployment, dataDir, password = '', url = 'http://127.0.0.1:7789' }) {
    this.deployment = deployment; this.password = password; this.url = url; this.cookie = ''; this.loginFlight = null;
    this.deploymentFingerprint = dataDir ? digest(dataDir) : null;
  }
  async login() {
    if (!this.loginFlight) this.loginFlight = (async () => {
      const res = await fetch(this.url + '/api/auth/login', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/json', origin: this.url }, body: JSON.stringify({ password: this.password }) });
      if (!res.ok) throw new Error('电脑设置登录未完成');
      this.cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]; await res.body?.cancel();
    })().finally(() => { this.loginFlight = null; });
    return this.loginFlight;
  }
  async request(path, method = 'GET', body, expectedDeployment) {
    // Allow full Coopanion control surfaces: worlds, extensions/market, providers, prompts, config, webui panels, run control.
    if (!/^\/api\/(status|capabilities|events|webui\/manifest|webui\/providers\/[^?]+|config(?:\/options\/[^/?]+)?|worlds(?:\/(activation|visibility|restart))?|providers(?:\/[^/?]+(?:\/(save|delete|activate|test|models))?)?|provider-modules(?:\/(config|preview))?|extensions(?:\/(updates|search|registry|package|check|install|uninstall|index-base|vote|comments))?(?:\?.*)?|prompts(?:\/(prefix|reset))?|session\/reload-prefix|run\/(pause|resume|restart|lifecycle))$/.test(path)
      || !['GET', 'POST'].includes(method)) throw Object.assign(new Error('不支持的电脑设置接口: ' + path), { status: 400 });
    if (expectedDeployment !== undefined && expectedDeployment !== this.deploymentFingerprint)
      throw hostError(409, '电脑控制台与 CooDock 当前部署不匹配，请重新选择目标');
    if (path === '/api/run/lifecycle' && method === 'GET') {
      const lifecycle = await this.fetchPublic(path, method);
      this.requireDeployment(lifecycle);
      return lifecycle;
    }
    if (expectedDeployment !== undefined || (method === 'POST' && /^\/api\/(?:worlds|extensions|run)\//.test(path))) {
      const lifecycle = await this.fetchPublic('/api/run/lifecycle', 'GET');
      this.requireDeployment(lifecycle);
      if (lifecycle.ready !== true) throw hostError(503, '电脑正在启动，请先刷新状态');
    }
    return this.fetchPublic(path, method, body);
  }
  requireDeployment(lifecycle) {
    if (!this.deploymentFingerprint || lifecycle?.deployment !== this.deploymentFingerprint)
      throw hostError(409, '电脑控制台与 CooDock 当前部署不匹配，请重新选择目标');
  }
  bound() {
    const expected = this.deploymentFingerprint;
    return {
      request: (path, method, body) => this.request(path, method, body, expected),
      activity: after => this.activity(after, expected),
      save: body => this.save(body, expected),
    };
  }
  async fetchPublic(path, method, body, retry = true) {
    let response;
    try {
      if (!this.cookie && this.password) await this.login();
      response = await fetch(this.url + path, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { cookie: this.cookie, origin: this.url, 'content-type': 'application/json', 'x-cortico-language': 'zh' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      if (error.status) throw error;
      throw method === 'GET' ? hostError(503, '电脑控制台暂不可达，请刷新状态')
        : hostError(502, '未收到电脑动作回执，请刷新状态后核对结果');
    }
    if (response.status === 401) {
      this.cookie = '';
      if (method === 'GET' && retry && this.password) {
        await response.body?.cancel();
        return this.fetchPublic(path, method, body, false);
      }
    }
    if (!response.ok) { await response.body?.cancel(); throw hostError(response.status, '电脑设置返回 HTTP ' + response.status); }
    try { return await response.json(); }
    catch { throw hostError(502, method === 'GET' ? '电脑控制台状态回执无效' : '电脑动作回执无效，请刷新状态后核对结果'); }
  }
  async settings() {
    const [config, worlds, providers] = await Promise.all([this.request('/api/config'), this.request('/api/worlds'), this.request('/api/providers')]);
    return { format: 'tina-computer-settings/1', at: new Date().toISOString(), ...config, ...worlds, ...providers };
  }
  async save(body, expectedDeployment) {
    const before = await this.request('/api/config', 'GET', undefined, expectedDeployment);
    const entry = before.groups.find(row => row.group.id === body.group);
    if (!entry) throw Object.assign(new Error('电脑没有该配置组'), { status: 400 });
    if (body.expected && !isDeepStrictEqual(body.expected, entry.values))
      throw Object.assign(new Error('电脑配置已改变，请刷新后再保存'), { status: 409 });
    const directory = join(this.deployment, 'data', 'mobile-config-history'); mkdirSync(directory, { recursive: true });
    const path = join(directory, Date.now() + '-' + digest(JSON.stringify(entry.values)).slice(0, 12) + '.json');
    const bytes = JSON.stringify({ at: new Date().toISOString(), group: body.group, values: entry.values });
    writeFileSync(path, bytes, { mode: 0o600 });
    if (readFileSync(path, 'utf8') !== bytes) throw new Error('电脑设置备份回读失败');
    await this.request('/api/config', 'POST', { group: body.group, values: body.values }, expectedDeployment);
    const after = await this.request('/api/config', 'GET', undefined, expectedDeployment);
    const actual = after.groups.find(row => row.group.id === body.group);
    if (!actual || Object.keys(body.values ?? {}).some(key => Object.hasOwn(entry.group.schema.properties, key) && !isDeepStrictEqual(actual.values[key], body.values[key])))
      throw Object.assign(new Error('电脑配置回读与提交值不一致，请刷新检查'), { status: 502 });
    return { ok: true, readback: true, saved: actual, groups: after.groups, backup: path.split('/').at(-1) };
  }
  async activity(after = '', expectedDeployment) {
    const raw = await this.request('/api/status', 'GET', undefined, expectedDeployment);
    const path = join(this.deployment, 'data/session-main.jsonl');
    const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
    const items = [];
    for (let index = Math.max(0, lines.length - 160); index < lines.length; index++) {
      let record; try { record = JSON.parse(lines[index]); } catch { continue; }
      const item = record.item ?? {}, type = item.type;
      if (type === 'message' && !['user', 'assistant'].includes(item.role)) continue;
      if (!['message', 'function_call', 'function_call_output'].includes(type)) continue;
      const full = type === 'message' ? textOf(item.content) : type === 'function_call' ? textOf(item.arguments) : textOf(item.output);
      items.push({ id: digest(index + ':' + lines[index]), at: record.context?.ts ?? record.ts ?? null,
        kind: type === 'message' ? item.role : type === 'function_call' ? 'tool_call' : 'tool_result',
        name: item.name ?? item.call_id ?? '', text: full.slice(0, 1400), truncated: full.length > 1400 });
    }
    const position = after ? items.findIndex(row => row.id === after) : -1;
    const reset = !after || position < 0;
    const pending = reset ? items.slice(-24) : items.slice(position + 1);
    const batch = []; let bytes = 0;
    for (const item of pending.slice(0, 24)) {
      const size = Buffer.byteLength(JSON.stringify(item)); if (batch.length && bytes + size > 16000) break;
      batch.push(item); bytes += size;
    }
    const phase = raw.loop?.phase;
    const status = { model: raw.modelConnection, phase: typeof phase === 'string' ? phase : phase?.state ?? raw.loop?.state ?? null,
      paused: raw.loop?.paused === true, uptimeSec: raw.uptimeSec };
    return { format: 'tina-computer-activity/1', at: new Date().toISOString(), reset, items: batch, status,
      cursor: batch.at(-1)?.id ?? after, has_more: pending.length > batch.length, source: 'computer/session-main',
      note: '电脑当前工作上下文；折叠后刷新当前视图，原始归档不由本页面删除' };
  }
}
