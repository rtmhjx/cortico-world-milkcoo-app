import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { qrSvg } from './pairing.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function starpostTemplate(configured) {
  const candidate = configured?.trim() || process.env.STARPOST_APK_TEMPLATE?.trim();
  const path = candidate ? resolve(candidate) : fileURLToPath(new URL('../client/Starpost.apk', import.meta.url));
  return statSync(path, { throwIfNoEntry: false })?.isFile() ? path : null;
}

export function starpostPairResult(identity, grant, lan) {
  const lanHint = lan ? { endpoints: lan.endpoints.map(item => item.url), installationId: lan.installationId, serverFingerprint: lan.serverFingerprint } : undefined;
  const bootstrap = { v: 2, app: 'starpost', hubIssuer: identity.hubIssuer, starpostOrigin: identity.starpostOrigin,
    botId: identity.botId, botName: identity.botName, autoEnableCooDock: true, pairTicket: grant.ticket, lanHint };
  const uri = new URL('starpost://pair');
  uri.search = new URLSearchParams({ botId: identity.botId, ticket: grant.ticket, coodock: '1',
    ...(lanHint ? { lanHint: JSON.stringify(lanHint) } : {}) }).toString();
  return { bootstrap, uri: uri.href, expiresAt: grant.expiresAt, svg: qrSvg(uri.href, '星邮 Bot 一次性配对码') };
}

export function starpostHubPanel(nonce, template, deployment) {
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>星邮与 CooDock</title><style>' +
    'body{margin:0;background:#f5eee5;color:#302523;font:16px/1.6 system-ui,sans-serif}main{max-width:710px;margin:auto;padding:clamp(18px,6vw,50px)}' +
    'h1{font:700 clamp(32px,8vw,54px)/1.15 Georgia,serif;letter-spacing:-.025em;margin:0}header p{color:#6a5050}section{background:#fffaf3;border:1px solid #decbbd;border-radius:16px;margin:18px 0;padding:18px 22px}h2{font-size:19px;margin:0 0 10px}' +
    'button,select,a{color:#6e2244}button{border:1px solid #6e2244;border-radius:9px;background:#6e2244;color:white;padding:8px 14px;font:inherit;cursor:pointer}' +
    'button:disabled{opacity:.6;cursor:default}a{margin-right:12px}code{overflow-wrap:anywhere}svg{width:min(260px,100%);display:block;margin:12px 0}form{display:inline}p[role=status]{min-height:1.6em}</style>' +
    '<main><header><h1>星邮与 CooDock</h1><p>选定桌面上的 Bot，连接手机。文字在星邮留档，附件在同一局域网优先直传。</p></header>' +
    '<section><h2>连接状态</h2><p id="handshake">' + escape(deployment ? '星邮部署 Bot · ' + deployment.botId : '等待同进程星邮 Bot 握手') + '</p>' +
    '<p id="account">正在查询 FFA Hub 登录…</p><p id="cloud">正在查询阿里云通道…</p>' +
    '<select id="business" aria-label="FFA Hub 业务号" hidden></select> <button id="choose" hidden>选用业务号</button> ' +
    '<button id="signin" hidden>同宿主登录</button> <button id="complete" hidden>完成桌面登录</button> ' +
    '<button id="resume-host" hidden>使用当前宿主登录</button> <a href="/_coo/ecosystem">共同登录设置</a>' +
    '<p><button id="begin-proof" type="button">获取 CooDock 授权证明</button> <a id="proof-link" target="_blank" rel="noopener noreferrer" hidden>在 FFA Hub 生成证明</a></p>' +
    '<p><label for="proof">粘贴一次性证明</label> <input id="proof" type="password" autocomplete="off" maxlength="8192"> ' +
    '<button id="complete-proof" type="button">连接阿里云</button> <button id="cloud-logout" type="button">退出阿里云通道</button></p></section>' +
    '<section><h2>2. 手机扫码配对</h2><p>在星邮里扫码或粘贴配对链接，然后用已获 Bot 权限的 FFA Hub 人类账号登录。二维码五分钟有效。</p>' +
    '<button id="pair">生成二维码</button><div id="qr"></div><a id="link" hidden>打开配对链接</a><code id="code"></code></section>' +
    '<section><h2>3. 打印包含 CooDock 的星邮 App</h2>' +
    (template ? '<form method="post" action="/_coo/install-starpost.apk"><input type="hidden" name="nonce" value="' + escape(nonce) + '"><button>生成专属安装包</button></form>' :
      '<p>尚未配置已签名的星邮模板。可在 World 设置中指定模板，或放置在 client/Starpost.apk。</p>') +
    '</section><p id="status" role="status"></p><footer><a href="/_coo/devices">旧版手机安装与连接</a></footer></main>' +
    '<script>const nonce=' + JSON.stringify(nonce) + ';' + panelScript + '</script></html>';
}

const panelScript = `
const get = id => document.getElementById(id);
async function post(path, value) {
  const res = await fetch(path,{method:'POST',headers:{'content-type':'application/json','x-coo-panel':nonce},body:JSON.stringify(value)});
  const result = await res.json();
  if (!res.ok) throw Error(result.error || '请求未完成');
  return result;
}
const ffa = (action,businessId) => post('/_coo/ecosystem-control',{method:'ffaHub',input:{action,businessId}});
const cloudAuth = (action, proof) => post('/_coo/dock-cloud-auth', {action, proof});
let canManageHost = false;
let hostAccount;
const cloudStates = { online:'已连接', waiting_for_bot:'等待星邮 Bot 握手', login_required:'需要登录',
  connecting:'连接中', retrying:'正在重试', unavailable:'不可用', stopped:'已停止' };
async function showCloud() {
  const {cloud, handshakeBotId, canManageHost: available} = await cloudAuth('status');
  canManageHost = available;
  get('handshake').textContent = handshakeBotId ? '同进程星邮握手 · Bot ' + handshakeBotId : '等待同进程星邮 Bot 握手';
  get('cloud').textContent = '阿里云 ' + (cloud.cloudOrigin || '8.137.59.209') + ' · ' + (cloudStates[cloud.state] || '查询中') +
    (cloud.lastError ? ' · ' + cloud.lastError : '');
  get('account').textContent = cloud.authSource === 'ffa_local' ? 'FFA Hub · CooDock 授权证明登录' :
    cloud.authSource === 'host_login' || hostAccount?.serviceStatus === 'ready' ? 'FFA Hub · 同宿主 CooDock 已登录' :
    hostAccount?.status === 'ready' ? 'FFA Hub · 宿主已登录，请确认 CooDock 授权或使用一次性证明' : 'FFA Hub · 等待登录';
  get('signin').hidden = !canManageHost || hostAccount?.serviceStatus === 'ready';
  get('resume-host').hidden = !canManageHost || hostAccount?.serviceStatus !== 'ready' || cloud.state !== 'login_required';
  get('begin-proof').disabled = !cloud.botId;
  get('complete-proof').disabled = !cloud.botId;
  get('cloud-logout').disabled = cloud.state === 'unavailable';
}
async function show() {
  const state = hostAccount = await ffa('status').catch(() => null);
  const choices = Array.isArray(state?.businessAccounts) ? state.businessAccounts.map(item =>
    typeof item === 'string' ? { id: item } : item).filter(item => item?.businessId || item?.id) : [];
  get('business').replaceChildren(...choices.map(item => new Option(item.nickname || item.businessId || item.id, item.businessId || item.id)));
  get('business').hidden = get('choose').hidden = !choices.length;
  await showCloud();
}
function click(id, action) {
  get(id).onclick = async () => {
    get(id).disabled = true; get('status').textContent = '';
    try { await action(); } catch(error) { get('status').textContent = error.message; }
    finally { get(id).disabled = false; }
  };
}
click('signin', async () => {
  const result = await ffa('begin');
  const href = new URL(result.authorizationUrl);
  if(href.protocol !== 'https:' && !(href.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(href.hostname))) throw Error('请从共同登录设置完成认证');
  const link = document.createElement('a'); link.href = href.href; link.target = '_blank'; link.rel = 'noreferrer noopener'; link.textContent = '前往 FFA Hub 认证';
  get('status').replaceChildren(link, ' · 核对短码 ' + result.shortCode); get('complete').hidden = false;
});
click('complete', async () => {
  const result = await ffa('complete');
  if(result.status === 'pending') { get('status').textContent = '等待 FFA Hub 确认，请完成认证后重试'; return; }
  get('complete').hidden = true; await show();
});
click('choose', async () => { await ffa('choose',get('business').value); await show(); });
click('resume-host', async () => { await ffa('complete'); await show(); });
click('begin-proof', async () => {
  const {authorizationUrl} = await cloudAuth('beginProof');
  const link = get('proof-link');
  link.href = authorizationUrl; link.hidden = false;
});
click('complete-proof', async () => {
  const proof = get('proof').value;
  get('proof').value = '';
  await cloudAuth('completeProof', proof);
  await showCloud();
});
click('cloud-logout', async () => {
  get('proof').value = ''; get('proof-link').hidden = true;
  await cloudAuth('logout'); await showCloud();
});
click('pair', async () => {
  const result = await post('/_coo/starpost-pair',{});
  const parsed = new DOMParser().parseFromString(result.svg,'image/svg+xml');
  get('qr').replaceChildren(parsed.documentElement);
  const link = get('link'); link.href = result.uri; link.hidden = false;
  get('code').textContent = result.uri;
  setTimeout(() => {
    if (link.href !== result.uri) return;
    get('qr').replaceChildren(); link.hidden = true; get('code').textContent = '';
  }, Math.max(0, result.expiresAt - Date.now()));
});
show().catch(error => { get('status').textContent = error.message; });
setInterval(() => { void showCloud().catch(() => {}); }, 3000);
`;

