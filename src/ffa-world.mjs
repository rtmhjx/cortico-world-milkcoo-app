import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { linkSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const origin = 'https://8.148.13.225:8443';
const service = 'coodock';
const credentialKey = 'MILKCOO_APP_FFA_INSTALLATION';
const uuid = /^[a-f0-9-]{36}$/;
const botId = /^ffa_[a-f0-9-]{36}$/;
const token = /^[A-Za-z0-9_-]{43}$/;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

async function hub(path, body, signal, request = fetch) {
  const res = await request(origin + path, {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw Error(res.status === 410 ? '配对已过期，请重新发起。' : 'FFA Hub 暂不可用，请稍后重试。');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of res.body ?? []) {
    length += chunk.byteLength;
    if (length > 16384) throw Error('FFA Hub 返回过大。');
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (result.ok !== true || !result.result) throw Error('FFA Hub 配对响应无效。');
  return result.result;
}

function validInstallation(value) {
  return value && value.audience === service && value.issuer === 'https://ffahub.net' &&
    uuid.test(value.installationId) && uuid.test(value.deviceId) && botId.test(value.subject) &&
    token.test(value.accessToken) && Number.isFinite(value.expiresAt);
}

export class FfaWorldPairing {
  constructor(context, { request = fetch, now = Date.now, connect = null } = {}) {
    this.context = context;
    this.request = request;
    this.now = now;
    this.connect = connect;
    this.life = new AbortController();
  }

  installation() {
    try {
      const data = JSON.parse(this.context.secret(credentialKey) || 'null');
      return validInstallation(data) ? data : null;
    } catch { return null; }
  }

  view() {
    const saved = this.installation();
    const pending = this.pending?.expires > this.now() ? this.pending : null;
    return {
      pending: pending ? {link:pending.link, shortCode:pending.shortCode} : null,
      installation: saved ? {subject:saved.subject, expiresAt:saved.expiresAt, expired:saved.expiresAt<=this.now()} : null,
      workerFile: Boolean(this.context.cfg?.ffaWorkerCredentialsFile),
      busy: Boolean(this.busy)
    };
  }

  async take(action) {
    if (this.busy || this.life.signal.aborted) throw Error('正在处理，请稍后重试。');
    this.busy = true;
    const call = (path, body) => hub(path, body, this.life.signal, this.request);
    try {
      if (action === 'start') {
        if (this.pending?.expires > this.now()) return '请继续当前配对。';
        if (this.installation()?.expiresAt > this.now()) throw Error('当前部署已有授权，请在 Hub 撤销旧安装后清除本机记录。');
        const installationId = randomUUID(), deviceId = randomUUID();
        const {publicKey, privateKey} = generateKeyPairSync('ed25519');
        const out = await call('/v1/pairings', {
          service, label: 'CooDock World', installationId, deviceId, publicKey:publicKey.export({format:'jwk'})
        });
        if (!uuid.test(out.pairingId) || !token.test(out.pollingSecret) || !token.test(out.challenge) ||
            !/^[A-Z0-9_-]{8}$/.test(out.shortCode)) throw Error('FFA Hub 配对响应无效。');
        const url = new URL(out.verificationUri);
        if (url.origin !== origin || url.pathname !== '/' || url.searchParams.get('pair') !== out.pairingId) throw Error('FFA Hub 授权地址无效。');
        const jws = encode({alg:'EdDSA'}) + '.' + encode({pairingId:out.pairingId,challenge:out.challenge,installationId,service});
        const signature = jws + '.' + sign(null,Buffer.from(jws),privateKey).toString('base64url');
        await call('/v1/pairings/prove',{pairingId:out.pairingId,pollingSecret:out.pollingSecret,signature});
        this.pending = {id:out.pairingId,secret:out.pollingSecret,link:origin+'/?pair='+out.pairingId,shortCode:out.shortCode,
          installationId,deviceId,expires:this.now()+300000,pollAfter:0};
        return '在 FFA Hub 核对短码，选择你管理的 bot 并授权。';
      }
      if (action === 'poll') {
        const p = this.pending;
        if (!p || p.expires <= this.now()) throw Error('配对已过期，请重新发起。');
        if (p.pollAfter > this.now()) throw Error('请间隔至少三秒。');
        p.pollAfter = this.now() + 3000;
        const current = await call('/v1/pairings/poll',{pairingId:p.id,pollingSecret:p.secret});
        if (current.status === 'pending') return '等待在 FFA Hub 确认授权。';
        const {audience,issuer,subject,installationId,accessToken,expiresAt} = current;
        const record = {audience,issuer,subject,installationId,accessToken,expiresAt,deviceId:p.deviceId};
        if (current.status !== 'approved' || installationId !== p.installationId || !validInstallation(record) ||
            record.expiresAt <= this.now()) throw Error('授权与这次配对不匹配。');
        const serialized = JSON.stringify(record);
        this.life.signal.throwIfAborted();
        this.context.storeSecret(credentialKey,serialized);
        if (this.context.secret(credentialKey) !== serialized) throw Error('本机凭据保存失败。');
        this.pending = null;
        return '已保存 CooDock World 的 Hub 授权。运行端由管理员在 Hub 中选择。';
      }
      if (action === 'worker') {
        const file = this.context.cfg?.ffaWorkerCredentialsFile;
        const saved = this.installation();
        if (!file || !isAbsolute(file) || !saved || saved.expiresAt <= this.now()) throw Error('请先完成配对，并配置私有 worker 凭据文件的绝对路径。');
        if (!this.connect) throw Error('请先设置 CooDock 公网中转连接。');
        const result = await this.connect(saved);
        if (result?.serviceState !== 'connected' || result.botId !== saved.subject || typeof result.accessToken !== 'string' ||
            result.accessToken.length < 24 || !Number.isFinite(result.expiresAt) || result.expiresAt <= this.now()) {
          throw Error('中转服务返回的运行端身份无效。');
        }
        this.life.signal.throwIfAborted();
        const temporary = file + '.' + randomUUID();
        try {
          writeFileSync(temporary,JSON.stringify(result)+'\n',{flag:'wx',mode:0o600});
          // Refuse to overwrite an existing deployment credential.
          linkSync(temporary,file);
        } catch(error) {
          if (error.code === 'EEXIST') throw Error('凭据文件已存在。撤销旧运行端后再换用新文件。');
          throw error;
        } finally { rmSync(temporary,{force:true}); }
        return '已为原有独立会话 worker 保存凭据。';
      }
      if (action === 'clear') {
        this.context.storeSecret(credentialKey,'');
        if (this.context.secret(credentialKey)) throw Error('本机凭据清除失败。');
        this.pending = null;
        return '已清除本机授权记录。';
      }
      throw Error('无效操作。');
    } finally { this.busy = false; }
  }
  stop() {
    this.life.abort();
    this.pending = null;
  }
}

export function ffaPanel(view, nonce, message = '') {
  const form = (action, label) => `<form method="post"><input name="nonce" type="hidden" value="${escape(nonce)}"><button name="action" value="${action}">${label}</button></form>`;
  const saved = view.installation;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>CooDock · FFA Hub</title></head><body>
  <nav><a href="/_coo/devices">手机连接</a> · <a href="${origin}/?page=bots" rel="noreferrer">在 FFA Hub 管理 bot</a></nav>
  <main><h1>CooDock World 配对</h1><p>为这个部署授权 FFA bot。手机直连、公共房间和工作台仍可使用原连接。</p>
  ${message ? `<p role="status">${escape(message)}</p>` : ''}
  ${saved ? `<p>已配对 bot <code>${escape(saved.subject)}</code>${saved.expired?' · 授权已过期':''}</p>
     ${view.workerFile && !saved.expired ? form('worker','为独立会话工作台生成凭据') : ''}
     <p>如需撤销授权，请先在 FFA Hub 撤销此安装，再清除本机记录。</p>${form('clear','清除本机记录')}` : ''}
  ${view.pending ? `<p>核对短码 <strong>${escape(view.pending.shortCode)}</strong></p><p><a href="${escape(view.pending.link)}" target="_blank" rel="noopener noreferrer">打开 FFA Hub 授权</a></p>${form('poll','完成配对')}` :
    (!saved || saved.expired ? form('start','发起配对') : '')}
  </main></body></html>`;
}
