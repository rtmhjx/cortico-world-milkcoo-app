import { createServer } from 'node:http';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MobileError, MobileStore } from './store.mjs';
import { addBootstrap } from './apk-bootstrap.mjs';
import { readPetResource, writePetPreferences } from './pet-resources.mjs';
import { DesktopScreenSampler } from './desktop-screen.mjs';
import { ModelControl } from './model-control.mjs';
import { MobilePairing, pairingPage } from './pairing.mjs';
import { FfaWorldPairing, ffaPanel } from './ffa-world.mjs';
import { fetchEasyTierAsset } from './easytier-assets.mjs';
import { BottleBridge } from './bottle-bridge.mjs';
import { requestPetInterrupt } from './pet-control.mjs';
import { WorkbenchBridge } from './workbench-bridge.mjs';
import { wardrobeState, changeWardrobe, figureOperation, importFigureZip } from './pet-wardrobe.mjs';
import { consoleEntry } from './console-entry.mjs';
import { NativeDeviceChannel } from './native-device.mjs';
import { SharedStickerLibrary } from './sticker-bridge.mjs';
import { PUBLIC_HOME, PUBLIC_RELAY_ORIGIN, PublicRelayConnector, isPublicRelayKey } from './public-relay.mjs';
import { checkGroupSticker, groupStickerBlob, MESSAGE_ID, readGroupSticker, STICKER_ID, WorldChatListener } from './world-chat.mjs';
import { LEGACY_WORLD_ID, WORLD_ID, WORLD_LABEL, migrateWorldIdentity } from './world-identity.mjs';

const promptPath = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));
const worldSetting = 'worlds.' + WORLD_ID;
const worldPage = 'world:' + WORLD_ID;
const phoneWorldId = (id) => id === WORLD_ID ? LEGACY_WORLD_ID : id;
function localControlRequest(req, port) {
  const remote = req.socket.remoteAddress;
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)
    || (remote && remote === req.socket.localAddress);
  const host = req.headers?.host?.toLowerCase();
  return Boolean(local && [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host));
}
const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
export const toolSchemas = [
  { name: 'milkcoo_app_devices', tags: ['read'], description: 'Read connected phone devices, capabilities, and last contact time.', parameters: object({}) },
  { name: 'milkcoo_app_device_request', tags: ['flow'], description: 'Queue a native operation for a connected phone device; use milkcoo_app_device_result with the same operation_id to read the completion receipt.',
    parameters: object({ device_id: {type:'string'}, operation_id: {type:'string'}, path: {type:'string', enum:['/native/capabilities','/native/capture','/native/tts','/native/notification','/native/audio']}, args: {type:'object'} }, ['device_id','path']) },
  { name: 'milkcoo_app_device_result', tags: ['read'], description: 'Read the execution receipt for a native operation. Captured media is returned as a real blob with its capture timestamp.', parameters: object({ operation_id: {type:'string'} }, ['operation_id']) },
  { name: 'milkcoo_app_reply', tags: ['speak'], description: 'Send a text reply to a phone message using its exact device_id and message_id as in_reply_to.',
    parameters: object({ device_id: { type: 'string' }, in_reply_to: { type: 'string' }, text: { type: 'string', minLength: 1, maxLength: 32000 } }, ['device_id', 'in_reply_to', 'text']) },
  { name: 'milkcoo_app_world_chat_read', tags: ['read'], description: 'Read the shared CooDock room, pinned notice and sticker IDs using the enrolled bot identity when the owner has enabled listening. Omit after for recent messages or pass next_cursor to continue.',
    parameters: object({ after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }) },
  { name: 'milkcoo_app_world_chat_post', tags: ['speak'], description: 'Publish explicitly authorized text and/or one sticker in the public room. Use @ and the exact public ID or reply_to. For a sticker, use its public sticker_id or the exact sticker_file from the local library. Retry unknown delivery with the same client_id and content.',
    parameters: object({ text: { type: 'string', maxLength: 2000 }, sticker_id: { type: 'string', pattern: STICKER_ID.source }, sticker_file: { type: 'string', minLength: 1, maxLength: 255 }, reply_to: { type: 'string', pattern: MESSAGE_ID.source }, client_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } }) },
  { name: 'milkcoo_app_world_chat_sticker_read', tags: ['read'], description: 'Look at a public group sticker by its sticker ID while listening is enabled. This never adds it to the private library.',
    parameters: object({ sticker_id: { type: 'string', pattern: STICKER_ID.source } }, ['sticker_id']) },
  { name: 'milkcoo_app_world_chat_sticker_save', tags: ['flow'], description: 'Explicitly save a selected public group sticker to the local shared sticker library. Use your own judgment; seeing a sticker does not automatically collect it.',
    parameters: object({ sticker_id: { type: 'string', pattern: STICKER_ID.source }, label: { type: 'string', minLength: 1, maxLength: 80 } }, ['sticker_id']) },
  { name: 'milkcoo_app_send_media', tags: ['speak'], description: 'Send an existing log: or mem: image, audio, video, or file blob handle to the phone.',
    parameters: object({ device_id: { type: 'string' }, in_reply_to: { type: 'string' }, handle: { type: 'string' }, text: { type: 'string', maxLength: 32000 }, file_name: { type: 'string', minLength: 1, maxLength: 255 } }, ['device_id', 'in_reply_to', 'handle']) },
  { name: 'milkcoo_app_status', tags: ['read'], description: 'Read current mobile channel and delivery status for connected devices.',
    parameters: object({ device_id: { type: 'string' } }) },
  { name: 'milkcoo_app_pet_interrupt', tags: ['flow'], description: 'Interrupt the current animation of the specified phone pet using its device_id.',
    parameters: object({ device_id: { type: 'string', minLength: 1, maxLength: 128 } }, ['device_id']) },
  { name: 'milkcoo_app_read_screen', tags: ['read'], description: 'Read the latest screen frame and capture timestamp from a phone with screen sharing enabled.',
    parameters: object({ device_id: { type: 'string' } }) },
  { name: 'milkcoo_app_read_camera', tags: ['read'], description: 'Read the latest camera frame and capture timestamp from a phone with an active camera session.',
    parameters: object({ device_id: { type: 'string' } }) },
  { name: 'milkcoo_app_camera_control', tags: ['flow'], description: 'Adjust image quality, sampling interval, or adaptive cadence of an active phone camera session.',
    parameters: object({ device_id: { type: 'string' }, quality: { type: 'string', enum: ['low', 'balanced', 'high'] }, interval_sec: { type: 'integer', minimum: 2, maximum: 120 }, adaptive: { type: 'boolean' } }) },
  { name: 'milkcoo_app_camera_say', tags: ['speak'], description: 'Send a direct message to the phone during an active camera session.',
    parameters: object({ device_id: { type: 'string' }, text: { type: 'string', minLength: 1, maxLength: 32000 } }, ['device_id', 'text']) },
  { name: 'milkcoo_app_sticker_stats', tags: ['read'], description: '查看手机与本 World 共用的 CooDock 表情包库：返回总数、按情感分布与可用 [表情包:文件名] 列表。在 milkcoo_app_reply 正文中直接写 [表情包:文件名] 即可作为独立表情包发往手机（表情包不算作普通图片附件）。',
    parameters: object({ limit: { type: 'integer', minimum: 1, maximum: 50 } }) },
];
const MEDIA_LIMIT = 8 * 1024 * 1024;
// A MIME identifies the stored bytes; it does not imply model support or that a
// recipient may execute the file. Legacy image/audio values remain valid.
const mediaMime = mime => typeof mime === 'string' && mime.length <= 100 && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mime);
function mediaName(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[\\/\u0000-\u001f]/.test(value)) throw new MobileError('INVALID_MEDIA_NAME');
  return value;
}
function cameraSettings(input, modelOnly = false) {
  const out = {};
  if (input.quality !== undefined) {
    if (!['low', 'balanced', 'high'].includes(input.quality)) throw new MobileError('INVALID_CAMERA_QUALITY');
    out.quality = input.quality;
  }
  if (input.interval_sec !== undefined) {
    if (!Number.isInteger(input.interval_sec) || input.interval_sec < 2 || input.interval_sec > 120) throw new MobileError('INVALID_CAMERA_INTERVAL');
    out.interval_sec = input.interval_sec;
  }
  if (input.adaptive !== undefined) {
    if (typeof input.adaptive !== 'boolean') throw new MobileError('INVALID_CAMERA_ADAPTIVE');
    out.adaptive = input.adaptive;
  }
  if (!modelOnly && input.proactive !== undefined) {
    if (typeof input.proactive !== 'boolean') throw new MobileError('INVALID_CAMERA_PROACTIVE');
    out.proactive = input.proactive;
  }
  return out;
}
const apkPath = fileURLToPath(new URL('../client/CooDock-0.6.0-dev.7-debug.apk', import.meta.url));
const workbenchApkPath = fileURLToPath(new URL('../client/CooDock-0.6.0-dev.7-workbench-debug.apk', import.meta.url));
const modelPanelPath = fileURLToPath(new URL('../client/ModelPanel.html', import.meta.url));
const clientFiles = {
  '/_coo/devices': ['../client/DevicePanel.html', 'text/html; charset=utf-8'],
  '/_coo/android-guide': ['../client/Android-Guide.html', 'text/html; charset=utf-8'],
  '/_coo/ios-guide': ['../client/iOS-Guide.html', 'text/html; charset=utf-8'],
  '/_coo/ios-source.zip': ['../client/MilkCoo-iOS-0.2.2-source.zip', 'application/zip'],
  '/_coo/ios-altstore-guide': ['../client/iOS-AltStore-Guide.html', 'text/html; charset=utf-8'],
  '/_coo/ios-unsigned.ipa': ['../client/MilkCoo-unsigned-0.2.2.ipa', 'application/octet-stream'],
};
function advertisedHost(configured, bind) {
  if (configured && configured !== 'auto') return configured;
  if (bind && bind !== '0.0.0.0' && bind !== '::') return bind;
  const interfaces = Object.entries(networkInterfaces()).sort(([a], [b]) => {
    const rank = name => /wlan|wi-?fi|wireless|无线/i.test(name) ? 0 : /ethernet|以太/i.test(name) ? 1 : 2;
    return rank(a) - rank(b);
  });
  for (const [, addresses] of interfaces) for (const item of addresses ?? []) {
    if (item.family === 'IPv4' && !item.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)) return item.address;
  }
  return '127.0.0.1';
}

function text(value, name, max = 32000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new MobileError(`INVALID_${name.toUpperCase()}`);
  return value;
}
function messageInput(body, fact = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new MobileError('JSON_OBJECT_REQUIRED');
  const input = { id: text(body.id, 'id', 160), device_id: text(body.device_id, 'device_id', 128),
    text: text(body.text, 'text'), created_at: text(body.created_at, 'created_at', 80) };
  if (!Number.isFinite(Date.parse(input.created_at))) throw new MobileError('INVALID_CREATED_AT');
  if (fact) input.source_ref = text(body.source_ref, 'source_ref', 4096);
  return input;
}
async function readJson(req, limit = 262144) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new MobileError('BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new MobileError('INVALID_JSON'); }
}
function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
const htmlEscape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const relayStatusText = {
  unbound: '尚未绑定电脑', connecting: '正在连接中转', online: '电脑连接器在线', unavailable: '中转连接暂不可用',
};
const relayLampState = { unbound: 'offline', connecting: 'loading', online: 'online', unavailable: 'error' };
const relayErrors = {
  RELAY_OTHER_KEY_BOUND: '这个 World 已绑定另一把密钥。请使用原来的密钥生成安装包。',
  RELAY_BINDING_BUSY: '正在绑定电脑，请稍后再试。',
  RELAY_AUTH_REJECTED: '中转拒绝绑定。请检查密钥是否有效，或是否已在另一处绑定电脑。',
  RELAY_SECRET_STORAGE_UNAVAILABLE: '无法保存电脑连接凭据，请检查 Coo 的本机密钥存储。',
  APP_NOT_AVAILABLE: '所选安卓安装包模板不可用。',
};
function relayApkPanel(nonce, state, message = '') {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>公网中转 · 移动前端coodock</title>
  <style>body{background:#101917;color:#eef6ee;font:16px/1.7 system-ui,sans-serif;max-width:720px;margin:auto;padding:32px 20px}section{background:#1a2823;border-radius:18px;padding:22px}p{color:#b4c6bb}input[type=password]{display:block;width:100%;max-width:420px;box-sizing:border-box;padding:11px;border:1px solid #66887b;border-radius:8px;background:#10211c;color:#eef6ee;font:inherit}button,a{display:inline-block;margin:8px 8px 8px 0;padding:10px 16px;border:0;border-radius:9px;background:#66dcaf;color:#071d15;font-weight:700;text-decoration:none}.msg{color:#ffcf91}small{color:#b4c6bb}</style>
  <a href="/_coo/devices">返回手机连接</a><a href="${PUBLIC_HOME}" rel="noreferrer">前往公网主页</a><a href="${PUBLIC_RELAY_ORIGIN}/welcome" rel="noreferrer">备用领取入口</a>
  <h1>公网中转专属 APK</h1><section><p>${relayStatusText[state] ?? relayStatusText.unbound}</p>
  <p>填写公网主页领取的密钥，先绑定当前电脑，再生成手机安装包。安装后打开 App，手机会尝试注册到同一条中转。</p>
  ${message ? `<p class="msg" role="alert">${htmlEscape(message)}</p>` : ''}
  <form method="post" action="/_coo/relay-apk" autocomplete="off"><input type="hidden" name="nonce" value="${htmlEscape(nonce)}">
  <label for="relay-key">公网中转密钥</label><input id="relay-key" name="key" type="password" placeholder="mck_…" minlength="47" maxlength="47" spellcheck="false" required>
  <button name="variant" value="companion">绑定并生成主机版 APK</button><button name="variant" value="workbench">绑定并生成工作台 APK</button></form>
  <small>安装包包含本次填写的密钥，请仅安装到自己的手机。</small></section></html>`;
}
function sendRelayApkPanel(res, nonce, state, message = '', status = 200) {
  // Native form submissions need a same-origin Origin header for the POST check below.
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'referrer-policy': 'same-origin', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(relayApkPanel(nonce, state, message));
}
function sendWorldChatPanel(res, nonce, enabled, status = 200) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'referrer-policy': 'same-origin', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>世界聊天 · Bot 收听</title><style>body{font:16px/1.7 system-ui,sans-serif;background:#101917;color:#eef6ee;margin:32px auto;max-width:600px;padding:0 20px}a{color:#89e1bf}button{font:inherit;padding:8px 14px;cursor:pointer}</style>
<a href="/_coo/devices">手机连接</a><h1>世界聊天 · Bot 收听</h1>
<p>此开关与同一中转密钥绑定的手机同步。开启后只接收开启后的群消息；来自 Bot 的群消息不会单独唤醒。关闭后 Bot 无法读取群聊，手机上的群聊不受影响。</p>
${typeof enabled === 'boolean' ? `<p role="status">当前：${enabled ? '正在收听' : '已关闭'}</p><form method="post" action="/_coo/world-chat">
<input type="hidden" name="nonce" value="${htmlEscape(nonce)}"><button name="enabled" value="${!enabled}">${enabled ? '关闭收听' : '开启收听'}</button></form>`
    : '<p role="status">暂时读不到中转设置。请先绑定公网中转，或稍后刷新。</p>'}</html>`);
}
function easyTierPanel(nonce, message = '') {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>跨网连接 · 奶coo</title>
  <style>body{background:#101917;color:#eef6ee;font:16px/1.7 system-ui,sans-serif;max-width:720px;margin:auto;padding:32px 20px}section{background:#1a2823;border-radius:18px;padding:22px}p{color:#b4c6bb}button,a{display:inline-block;margin:8px 8px 8px 0;padding:10px 16px;border:0;border-radius:9px;background:#66dcaf;color:#071d15;font-weight:700;text-decoration:none}small{color:#ddd4ac}.msg{white-space:pre-wrap;color:#a7f2d1}</style>
  <a href="/_coo/devices">返回手机连接</a><h1>跨网连接 · 可选组件</h1><section><p>EasyTier 2.6.4 由 EasyTier 项目提供；目前仅准备官方安装文件，不会自动运行或安装。原有局域网连接不受影响。</p>
  <p>跨网组网可能改变设备网络路由，产生公网连接与中继流量；请理解后自愿使用，风险自负。安卓启用 VPN 前需要系统确认，可能与现有 VPN 冲突。文件和网络密码请自行保管。</p>
  <p>下载时核验官方发布资产的 SHA-256 和长度，成功后保存在 Coo 的 World 数据目录。需要你手动安装、配置；组网及跨网可用性尚未在此处验证。</p>
  <p>安卓已有 VPN 时可尝试高级设置里的“无 TUN 模式”。使用端口转发时，请将监听地址填写为 127.0.0.1，目标填写电脑的 EasyTier 虚拟地址和 Coo 端口；在奶coo 填写对应的本机转发地址并沿用原连接密钥。请使用可信的组网与服务器；具体步骤见使用说明。</p>
  <form method="post" action="/_coo/easytier"><input type="hidden" name="nonce" value="${htmlEscape(nonce)}"><button name="kind" value="windows">下载 Windows x64 组件</button><button name="kind" value="android">下载 Android arm64 组件</button></form>
  <p class="msg">${htmlEscape(message)}</p><small>开源协议 LGPL-3.0；源码、协议和完整发布资产见 <a href="https://github.com/EasyTier/EasyTier/tree/v2.6.4">EasyTier 官方源码</a> 与 <a href="https://github.com/EasyTier/EasyTier/releases/tag/v2.6.4">官方发布页</a>。本组件未打包 EasyTier 二进制。</small></section></html>`;
}

/** Cortico World API 6. */
export class TinaMobileWorld {
  id = WORLD_ID;
  constructor(context) { this.context = context; this.host = null; this.store = null; this.server = null; this.pending = null; this.petInterrupts = new Map(); this.dispatchRequested = false; this.lastError = null; this.personalApk = null; this.appError = null; this.screenFrames = new Map(); this.cameraSessions = new Map(); this.pairing = new MobilePairing(); this.mobileEndpoint = null; }
  envPromptVars() { return {}; }
  console() { return {
    label: WORLD_LABEL,
    config: [{ id: worldPage, owner: worldPage, schema: { type: 'object', title: '手机连接',
      description: '启用后自动生成手机专属安装包和接入密钥；修改地址或端口后重启 World。', properties: {
        [worldSetting + '.host']: { type: 'string', title: '监听地址', description: '默认 0.0.0.0，手机可以通过同一局域网连接。', 'x-hot': false },
        [worldSetting + '.advertiseHost']: { type: 'string', title: '手机访问的地址', description: '默认 auto，自动选择局域网地址；也可填写 VPN 地址。', 'x-hot': false },
        [worldSetting + '.port']: { type: 'integer', title: '端口', minimum: 1, maximum: 65535, 'x-hot': false },
        [worldSetting + '.petPort']: { type: 'integer', title: '本机桌宠资源端口', description: '默认 7797；多开 Coo 时请填写此 Coo 的桌宠实际端口。', minimum: 1, maximum: 65535, 'x-hot': false },
        [worldSetting + '.consolePort']: { type: 'integer', title: 'Coo 控制台端口', description: '手机修改模型时访问同一 Coo 的本机控制台；默认 17788。', minimum: 1, maximum: 65535, 'x-hot': false },
        [worldSetting + '.consoleUiUrl']: { type: 'string', title: '手机上的完整 Coo 控制台地址', description: '填写手机可访问的完整 HTTP(S) 界面地址，保留域名与路径；留空时在手机设置。不从手机通道地址推算。', 'x-hot': true },
        [worldSetting + '.ffaWorkerCredentialsFile']: { type: 'string', title: 'FFA 独立会话 worker 凭据路径', description: '选填。使用当前部署用户专用目录下的新文件绝对路径。配对后在本机面板中生成。', 'x-hot': false },
        [worldSetting + '.tokenSecret']: { type: 'string', title: '接入密钥的名称', description: '默认 MILKCOO_APP_TOKEN；这里填写名称，不填写密钥内容。', 'x-hot': false },
      } } }],
    links: [ ...(this.address() ? [{ label: '手机安装与连接指南（安卓 / iOS）', href: `http://127.0.0.1:${this.address().port}/_coo/devices` }] : []),
       { label: '前往公网主页', href: PUBLIC_HOME },
       ...(this.address() ? [{ label: 'FFA Hub · 配对运行端', href: `http://127.0.0.1:${this.address().port}/_coo/ffa` }] : []),
       ...(this.address() ? [{ label: '填写公网密钥并生成专属 APK', href: `http://127.0.0.1:${this.address().port}/_coo/relay-apk` }] : []),
       ...(this.address() ? [{ label: '世界聊天 · Bot 收听', href: `http://127.0.0.1:${this.address().port}/_coo/world-chat` }] : []),
       ...(this.personalApk && this.address() ? [{ label: '下载安卓 APK · 主机版（直连专属）', href: this.downloadUrl() },
        ...(existsSync(workbenchApkPath) ? [{ label: '下载安卓 APK · 完整工作台（本机专属）', href: this.downloadUrl().replace('/install.apk', '/install-workbench.apk') }] : [])] : []),
      ...(this.address() ? [{ label: '下载 iOS IPA（未签名）', href: `http://127.0.0.1:${this.address().port}/_coo/ios-unsigned.ipa` },
        { label: '苹果设备扫码连接', href: `http://127.0.0.1:${this.address().port}/_coo/ios-pair` },
        { label: '跨网连接（EasyTier，可选）', href: `http://127.0.0.1:${this.address().port}/_coo/easytier` }] : []),
      ...(this.address() ? [{ label: '快速选择模型与思考', href: `http://127.0.0.1:${this.address().port}/_coo/model-panel` }] : []),
      { label: '模型连接详细设置', href: `http://127.0.0.1:${this.context.cfg?.consolePort ?? 17788}/#/providers` } ],
    lamps: [{ label: '本机通道', state: this.server ? 'online' : 'offline',
        hint: this.appError ?? (this.server ? '电脑端正在监听手机请求' : '电脑端未启动') },
      { label: '公网中转', state: relayLampState[this.publicRelay?.state] ?? 'offline',
        hint: this.server ? relayStatusText[this.publicRelay?.state] ?? relayStatusText.unbound : '电脑端未启动' },
      { label: '电脑屏幕感知', state: this.desktopScreen?.running ? 'online' : 'offline', hint: this.desktopScreen?.running ? '正在观察，可在手机中停止' : '当前版本不可用' }],
     promptDocs: [{ key: worldSetting + '.envPrompt', title: WORLD_LABEL, description: '手机输入、媒体与回复的使用约定。', role: 'envPrompt', path: promptPath }],
  }; }
  webUi() { return this.console(); }
  async canAcceptImage() {
    if (this.host?.modelFacts?.accepts?.('image/jpeg') !== true) return false;
    try { return (await this.modelControl.brief()).model_accepts_image === true; } catch { return false; }
  }
  async nativeFrame(source, input, call) {
    const devices = this.nativeDevices.devices();
    const device = input.device_id ?? (devices.length === 1 ? devices[0].device_id : null);
    if (!device || !devices.some(row => row.device_id === device)) return null;
    if (!call?.callId) throw new MobileError('STABLE_CALL_ID_REQUIRED');
    const operation_id = 'frame-' + createHash('sha256').update(JSON.stringify([call.role, call.callId, source, device])).digest('hex');
    this.nativeDevices.enqueue({ operation_id, device_id: device, world_id: this.id, path: '/native/capture', args: { source } });
    const until = Date.now() + 15000;
    let result;
    do {
      if (call.signal?.aborted) return { text: JSON.stringify({ operation_id, state: 'unknown', reason: 'caller_cancelled' }), failed: true };
      result = this.nativeDevices.row(operation_id);
      if (result.result) break;
      await new Promise(done => setTimeout(done, 150));
    } while (Date.now() < until && this.host);
    const media = result?.result?.media_id ? this.nativeDevices.media(result.device_id, result.result.media_id) : null;
    if (result?.state !== 'succeeded' || !media) return { text: JSON.stringify(result), failed: true };
    if (!await this.canAcceptImage()) return { text: JSON.stringify({ ...result, model_accepts_image: false }), failed: true };
    return { text: JSON.stringify({ operation_id, device_id: device, ...result.result }),
      blobs: [{ bytes: Buffer.from(media.data), mime: media.mime, name: 'phone-' + source + '.jpg', fallbackText: 'Captured phone frame.' }] };
  }
  async worldChatTool(input, call, operation) {
    let clientId;
    try {
      const keys = {
        read: ['after', 'limit'], post: ['text', 'reply_to', 'client_id', 'sticker_id', 'sticker_file'],
        sticker_read: ['sticker_id'], sticker_save: ['sticker_id', 'label'],
      }[operation];
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) {
        throw new MobileError('INVALID_WORLD_CHAT_INPUT');
      }
      if (!this.publicRelay) throw new MobileError('WORLD_CHAT_UNBOUND');
      if (operation === 'read') {
        const { after, limit = 10 } = input;
        if ((after !== undefined && (!Number.isSafeInteger(after) || after < 0))
            || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new MobileError('INVALID_WORLD_CHAT_PAGINATION');
        const result = await this.publicRelay.worldChat('feed', { ...(after !== undefined ? { after } : {}), limit }, call?.signal);
        return JSON.stringify(result);
      }
      if (operation.startsWith('sticker_')) {
        const label = input.label === undefined ? undefined : text(input.label, 'label', 80).trim();
        const sticker = await readGroupSticker(this.publicRelay, input.sticker_id, call?.signal);
        if (operation === 'sticker_save') {
          this.stickerLibrary ??= new SharedStickerLibrary(this.context);
          const saved = this.stickerLibrary.addFromGroup({ bytes: sticker.bytes, mime: sticker.mime, label });
          return JSON.stringify({ ok: true, sticker_id: sticker.id, file: saved.file, label: saved.label });
        }
        const accepts = this.host?.modelFacts?.accepts?.(sticker.mime) === true;
        return { text: JSON.stringify({ sticker_id: sticker.id, mime: sticker.mime, model_accepts_image: accepts }),
          ...(accepts ? { blobs: [groupStickerBlob(sticker)] } : {}) };
      }
      const message = input.text === undefined ? '' : input.text;
      if (typeof message !== 'string' || [...message].length > 2000 || Buffer.byteLength(message, 'utf8') > 8000
          || (!message.trim() && input.sticker_id === undefined && input.sticker_file === undefined)) throw new MobileError('INVALID_TEXT');
      if (input.reply_to !== undefined && (typeof input.reply_to !== 'string' || !MESSAGE_ID.test(input.reply_to))) {
        throw new MobileError('INVALID_WORLD_CHAT_REPLY');
      }
      if (input.sticker_id !== undefined && (typeof input.sticker_id !== 'string' || !STICKER_ID.test(input.sticker_id)
          || input.sticker_file !== undefined)) throw new MobileError('INVALID_WORLD_CHAT_STICKER');
      if (input.client_id !== undefined && (typeof input.client_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.client_id))) {
        throw new MobileError('INVALID_WORLD_CHAT_CLIENT_ID');
      }
      if (input.client_id === undefined && !call?.callId) throw new MobileError('STABLE_CALL_ID_REQUIRED');
      clientId = input.client_id ?? 'world-chat-' + createHash('sha256')
        .update(JSON.stringify([this.context.botDir, call.role, call.callId])).digest('hex');
      let stickerId = input.sticker_id;
      if (input.sticker_file !== undefined) {
        this.stickerLibrary ??= new SharedStickerLibrary(this.context);
        const local = this.stickerLibrary.readLibrarySticker(input.sticker_file);
        if (!local) throw new MobileError('WORLD_CHAT_STICKER_NOT_FOUND');
        const sticker = checkGroupSticker(local.bytes, local.mime);
        const uploaded = await this.publicRelay.worldChat('sticker-upload', {
          mime: sticker.mime, data: sticker.bytes.toString('base64'),
        }, call?.signal);
        if (uploaded.sticker.id !== sticker.id || uploaded.sticker.mime !== sticker.mime) throw new MobileError('WORLD_CHAT_STICKER_INVALID');
        stickerId = sticker.id;
      }
      const result = await this.publicRelay.worldChat('post', { client_id: clientId, text: message,
        ...(stickerId !== undefined ? { sticker_id: stickerId } : {}),
        ...(input.reply_to !== undefined ? { reply_to: input.reply_to } : {}) }, call?.signal);
      return JSON.stringify({ ...result, client_id: clientId });
    } catch (error) {
      const safe = /^(?:WORLD_CHAT_[A-Z_]+|world_chat_[a-z_]+|RELAY_AUTH_REJECTED|CALL_CANCELLED)$/;
      const code = error instanceof MobileError || safe.test(error?.message) ? error.message : 'WORLD_CHAT_UNAVAILABLE';
      return { text: JSON.stringify({ ok: false, error: code,
        ...(clientId ? { client_id: clientId } : {}), ...(code === 'WORLD_CHAT_POST_UNKNOWN' ? { state: 'unknown' } : {}) }), failed: true };
    }
  }

  tools() {
    return toolSchemas.map(schema => ({ ...schema, handler: async (input, call) => {
      try {
        if (!this.store || !this.host) throw new MobileError('MOBILE_STOPPED', 503);
        if (schema.name.startsWith('milkcoo_app_world_chat_')) {
          return await this.worldChatTool(input, call, schema.name.slice('milkcoo_app_world_chat_'.length));
        }
        if (schema.name === 'milkcoo_app_devices') return JSON.stringify({devices:this.nativeDevices.devices()});
        if (schema.name === 'milkcoo_app_device_request') {
          if (!input.operation_id && !call?.callId) throw new MobileError('STABLE_CALL_ID_REQUIRED');
          return JSON.stringify(this.nativeDevices.enqueue({...input, world_id:this.id, operation_id:input.operation_id || 'native-'+createHash('sha256').update(JSON.stringify([call.role,call.callId])).digest('hex')}));
        }
        if (schema.name === 'milkcoo_app_device_result') {
          const result=this.nativeDevices.row(input.operation_id);
          if(!result) return JSON.stringify({state:'unavailable',reason:'operation_not_found'});
          const media=result.result?.media_id ? this.nativeDevices.media(result.device_id,result.result.media_id) : null;
          if(media && result.state==='succeeded') return {text:JSON.stringify(result),blobs:[{bytes:Buffer.from(media.data),mime:media.mime,name:'phone-native-frame.jpg',fallbackText:'Captured phone frame.'}]};
          return JSON.stringify(result);
        }
        if (schema.name === 'milkcoo_app_pet_interrupt') return await requestPetInterrupt(this.host, this.id, this.context.botDir, input, call, this.petInterrupts);
        if (schema.name === 'milkcoo_app_sticker_stats') {
          this.stickerLibrary ??= new SharedStickerLibrary(this.context);
          const s = this.stickerLibrary.stats(input.limit ?? 20);
          const lines = s.recent.map(m => `- [表情包:${m.file}] ${m.label}（情感:${m.emotion} / 用处:${m.usage}${m.tag ? ' / 标签:' + m.tag : ''} / 出现${m.count ?? 1}次）`);
          const byEmo = Object.entries(s.byEmotion).map(([k, v]) => `${k}:${v}`).join('，') || '无';
          return `手机与 Coo 共用表情包库共 ${s.total} 张；情感分布：${byEmo}\n可用列表：\n${lines.join('\n') || '（暂无）'}`;
        }
        if (schema.name === 'milkcoo_app_status') {
          const device = input.device_id === undefined ? undefined : text(input.device_id, 'device_id', 128);
          return JSON.stringify({ ...this.store.status(device), listening: this.address(), last_error: this.lastError });
        }
        if (schema.name === 'milkcoo_app_read_screen') {
          const native = await this.nativeFrame('screen', input, call); if (native) return native;
          const device = input.device_id === undefined ? (this.screenFrames.size === 1 ? this.screenFrames.keys().next().value : undefined) : text(input.device_id, 'device_id', 128);
          if (!device) return { text: JSON.stringify({ ok: false, error: 'SPECIFY_DEVICE', devices: [...this.screenFrames.keys()] }), failed: true };
          const frame = this.screenFrames.get(device);
          if (!frame) return { text: '该手机没有开启屏幕共享或尚未送来画面。', failed: true };
          if (!await this.canAcceptImage()) return { text: '当前模型未启用图片输入能力，暂无法直接读取该屏幕画面。', failed: true };
          return { text: `手机屏幕截图，device_id=${JSON.stringify(device)}，采集时间 ${frame.captured_at}。`,
            blobs: [{ bytes: frame.bytes, mime: 'image/jpeg', name: 'phone-screen.jpg', fallbackText: '手机屏幕截图。' }] };
        }
        if (schema.name === 'milkcoo_app_read_camera' || schema.name === 'milkcoo_app_camera_control' || schema.name === 'milkcoo_app_camera_say') {
          if (schema.name === 'milkcoo_app_read_camera') { const native = await this.nativeFrame('camera', input, call); if (native) return native; }
          const live = [...this.cameraSessions.entries()].filter(([, session]) => Date.now() - session.last_seen < 30000);
          const device = input.device_id === undefined ? (live.length === 1 ? live[0][0] : undefined) : text(input.device_id, 'device_id', 128);
          if (!device) return { text: JSON.stringify({ ok: false, error: 'SPECIFY_DEVICE', devices: live.map(([id]) => id) }), failed: true };
          const session = this.cameraSessions.get(device);
          if (!session || Date.now() - session.last_seen >= 30000) return { text: '手机摄像头未开启或连接已过期。', failed: true };
          if (schema.name === 'milkcoo_app_camera_say') {
            if (call.signal?.aborted) throw new MobileError('CALL_CANCELLED');
            if (!call.callId) throw new MobileError('STABLE_CALL_ID_REQUIRED');
            const id = `camera-reply-${createHash('sha256').update(JSON.stringify([this.context.botDir, call.role, call.callId])).digest('hex')}`;
            const existing = this.store.get(id);
            const { record } = this.store.insert({ id, device_id: device, text: text(input.text, 'text'),
              source_ref: `camera-session:${session.session_id}`, created_at: existing?.created_at ?? new Date().toISOString() }, 'assistant_message');
            return JSON.stringify({ id: record.id, server_seq: record.server_seq, state: 'queued_for_phone', phone_read: 'unknown' });
          }
          if (schema.name === 'milkcoo_app_camera_control') {
            if (call.signal?.aborted) throw new MobileError('CALL_CANCELLED');
            const patch = cameraSettings(input, true);
            if (!Object.keys(patch).length) return JSON.stringify({ ok: true, ...session.config, revision: session.revision });
            session.config = { ...session.config, ...patch }; session.revision++;
            return JSON.stringify({ ok: true, ...session.config, revision: session.revision });
          }
          if (!session.frame) return { text: '手机摄像头已开启，但尚未收到画面。', failed: true };
          if (!await this.canAcceptImage()) return { text: '当前模型未启用图片输入能力，暂无法直接读取该摄像头画面。', failed: true };
          return { text: `手机摄像头画面，device_id=${JSON.stringify(device)}，采集时间 ${session.frame.captured_at}。`,
            blobs: [{ bytes: session.frame.bytes, mime: 'image/jpeg', name: 'phone-camera.jpg', fallbackText: '手机摄像头画面。' }] };
        }
        if (call.signal?.aborted) throw new MobileError('CALL_CANCELLED');
        if (!call.callId) throw new MobileError('STABLE_CALL_ID_REQUIRED');
        const device = text(input.device_id, 'device_id', 128);
        const sourceId = text(input.in_reply_to, 'in_reply_to', 160);
        const source = this.store.get(sourceId);
        if (!source || source.kind !== 'user_message' || source.device_id !== device) throw new MobileError('PHONE_MESSAGE_NOT_FOUND', 404);
        const replyId = `reply-${createHash('sha256').update(JSON.stringify([this.context.botDir, call.role, call.callId])).digest('hex')}`;
        let sourceRef;
        let messageText = input.text;
        if (schema.name === 'milkcoo_app_send_media') {
          const attachment = this.host.blob(text(input.handle, 'handle', 512));
          if (!attachment) throw new MobileError('BLOB_NOT_FOUND', 404);
          const bytes = Buffer.from(attachment.bytes);
          if (!mediaMime(attachment.mime) || bytes.length < 1 || bytes.length > MEDIA_LIMIT) throw new MobileError('MEDIA_UNSUPPORTED');
          const fileName = mediaName(input.file_name ?? (typeof attachment.name === 'string' ? attachment.name.split(/[\\/]/).at(-1) || null : null));
          this.store.putMedia(replyId, device, attachment.mime, createHash('sha256').update(bytes).digest('hex'), bytes, fileName);
          sourceRef = `coo-media:${replyId}`;
          messageText = typeof input.text === 'string' && input.text.trim() ? input.text : (attachment.mime.startsWith('image/') ? '[图片]' : attachment.mime.startsWith('audio/') ? '[语音]' : `[附件]${fileName ? ' ' + fileName : ''}`);
        }
        const existing = this.store.get(replyId);
        const { record } = this.store.insert({ id: replyId, device_id: device, text: text(messageText, 'text'), source_ref: sourceRef,
          in_reply_to: sourceId, created_at: existing?.created_at ?? new Date().toISOString() }, 'assistant_message');
        return JSON.stringify({ id: record.id, server_seq: record.server_seq, state: 'queued_for_phone', phone_read: 'unknown' });
      } catch (error) {
        return { text: JSON.stringify({ ok: false, error: error instanceof MobileError ? error.message : 'MOBILE_INTERNAL_ERROR' }), failed: true };
      }
    } }));
  }
  address() {
    const address = this.server?.address();
    return address && typeof address === 'object' ? { host: address.address, port: address.port } : null;
  }
  downloadUrl() {
    const addr = this.address();
    if (!addr) return null;
    const local = ['0.0.0.0', '::'].includes(addr.host) ? '127.0.0.1' : addr.host;
    return `http://${local.includes(':') ? `[${local}]` : local}:${addr.port}/_coo/install.apk`;
  }
  async start(host) {
    if (this.server) throw new Error('MOBILE_ALREADY_STARTED');
    const secretName = this.context.cfg.tokenSecret ?? 'MILKCOO_APP_TOKEN';
    let token = this.context.secret(secretName);
    if (!token) {
      if (typeof this.context.storeSecret !== 'function') throw new Error('MOBILE_SECRET_STORAGE_UNAVAILABLE');
      token = randomBytes(32).toString('base64url');
      this.context.storeSecret(secretName, token);
      if (this.context.secret(secretName) !== token) throw new Error('MOBILE_SECRET_READBACK_FAILED');
    }
    this.tokenHash = createHash('sha256').update(`Bearer ${token}`).digest();
    this.workbenchBridge = new WorkbenchBridge(this.context, token);
    this.panelNonce = randomBytes(24).toString('base64url');
    this.ffaPairing = new FfaWorldPairing(this.context, { connect: saved => this.publicRelay.connectFfaInstallation(saved) });
    const dataDir = join(this.context.dataDir, LEGACY_WORLD_ID);
    mkdirSync(dataDir, { recursive: true });
    this.store = new MobileStore(join(dataDir, 'mobile.sqlite'));
    this.nativeDevices = new NativeDeviceChannel(this.store);
    this.stickerLibrary = new SharedStickerLibrary(this.context);
    this.host = host; this.modelControl = new ModelControl(this.context); this.desktopScreen = new DesktopScreenSampler(host, this.context, undefined, () => this.canAcceptImage()); this.lastError = null; this.dispatchRequested = false;
    const server = createServer((req, res) => {
      this.handle(req, res).catch(error => {
        if (!res.headersSent) send(res, error instanceof MobileError ? error.status : 500,
          { error: error instanceof MobileError ? error.message : 'MOBILE_INTERNAL_ERROR' });
        else res.destroy();
      });
    });
    // A full-size mobile attachment can take longer than 15 seconds on cellular.
    server.requestTimeout = 120000; server.headersTimeout = 10000;
    this.server = server;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.context.cfg.port ?? 7801, this.context.cfg.host ?? '0.0.0.0', () => { server.off('error', reject); resolve(); });
      });
    } catch (error) {
      this.server = null; this.host = null; this.store.close(); this.store = null; throw error;
    }
    server.on('error', error => { this.lastError = error.code ?? 'HTTP_SERVER_ERROR'; });
    const bound = this.address();
    const local = bound.host === '0.0.0.0' ? '127.0.0.1' : bound.host === '::' ? '::1' : bound.host;
    const localOrigin = `http://${local.includes(':') ? `[${local}]` : local}:${bound.port}`;
    this.publicRelay = new PublicRelayConnector(this.context, () => ({ origin: localOrigin, token }));
    this.publicRelay.worldChatListener = new WorldChatListener(this.publicRelay, () => this.server && this.host, this.id);
    this.publicRelay.start();
    try {
      const addr = this.address();
      const advertised = advertisedHost(this.context.cfg.advertiseHost, this.context.cfg.host ?? '0.0.0.0');
      const endpoint = `http://${advertised.includes(':') ? `[${advertised}]` : advertised}:${addr.port}`;
      this.mobileEndpoint = endpoint;
      const bootstrap = {
        endpoint,
        token,
        ...(this.context.cfg.consoleUiUrl ? { consoleUiUrl: this.context.cfg.consoleUiUrl } : {}),
        ...(this.context.cfg.memoryUrl ? { memoryUrl: this.context.cfg.memoryUrl } : {}),
        botId: this.context.cfg.mobileBotId ?? 'tina-mobile',
        preloadedWorlds: [
          { id: 'pet', label: '随身桌宠 (Coopanion 内置)', builtin: 'pet', enabled: true },
          { id: 'screen', label: '屏幕感知 (读屏观察)', builtin: 'screen', enabled: true },
          { id: 'camera', label: '镜头观察 (前后摄采样)', builtin: 'camera', enabled: false },
          { id: 'audio', label: '麦克风与语音中继', builtin: 'audio', enabled: false },
          { id: 'bottle', label: '漂流瓶 (海边信箱)', builtin: 'bottle', enabled: true },
          { id: 'starpost', label: '星邮与公网 World', builtin: 'public_worlds', enabled: true },
        ],
      };
      this.personalApk = addBootstrap(readFileSync(apkPath), bootstrap);
      this.workbenchBootstrap = bootstrap;
      this.appError = advertised === '127.0.0.1' ? '仅找到本机地址，手机需设置可到达的地址后重启。' : null;
    } catch { this.personalApk = null; this.appError = '手机安装包生成失败，请检查 World 是否包含 client APK。'; }
    this.kick();
    this.timer = setInterval(() => this.kick(), 2000); this.timer.unref();
  }
  async stop() {
    const server = this.server; this.server = null;
    this.ffaPairing?.stop();
    const relayClosed = this.publicRelay?.stop(); this.publicRelay = null;
    this.dispatchRequested = false;
    clearInterval(this.timer);
    const close = server ? new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) : Promise.resolve();
    await this.pending; await relayClosed; await close; await this.desktopScreen?.stop(); this.desktopScreen = null; this.modelControl = null;
    this.host = null; this.store?.close(); this.store = null; this.tokenHash = null; this.personalApk = null; this.panelNonce = null; this.mobileEndpoint = null; this.bottleBridge = null; this.workbenchBootstrap = null; this.pairing.clear(); this.screenFrames.clear(); this.cameraSessions.clear();
  }
  onRunPhase(phase) { this.runPhase = phase; }
  kick() {
    if (!this.server || !this.host) return;
    if (this.pending) { this.dispatchRequested = true; return; }
    this.dispatchRequested = false;
    this.pending = this.dispatch().catch(error => { this.lastError = error.code ?? 'EVENT_DISPATCH_FAILED'; })
      .finally(() => {
        this.pending = null;
        // Coalesce arrivals during an awaited push. Failed rows alone do not cause a retry loop.
        if (this.dispatchRequested && this.server && this.host) this.kick();
      });
  }
  async dispatch() {
    for (const record of this.store.pending()) {
      if (!this.server || !this.host) break;
      const touch = record.kind === 'pet_touch';
      const eventType = touch ? 'coo_mobile.pet_touch' : 'coo_mobile.message';
      const find = (source) => this.host.store.range({ source, senderKey: record.id, limit: 2 }).find(item =>
        item.type === eventType && item.meta?.device_id === record.device_id && item.meta?.message_id === record.id);
      // An old push may have stored the event before SQLite received its cursor.
      let event = find(this.id) ?? find(LEGACY_WORLD_ID);
      const media = record.source_ref?.startsWith('coo-media:') ? this.store.getMedia(record.id) : null;
      if (!event) event = await this.host.pushEvent({ source: this.id, type: eventType, origin: 'external',
        ts: record.created_at, senderKey: record.id,
        text: `[${touch ? '手机桌宠互动' : '手机输入'} device_id=${JSON.stringify(record.device_id)} message_id=${JSON.stringify(record.id)}]\n${record.text}`,
        meta: { device_id: record.device_id, message_id: record.id, ...(touch ? { touch: record.source_ref?.slice('pet-touch:'.length) } : {}) },
        ...(media ? { blobs: [{ bytes: Buffer.from(media.data), mime: media.mime, name: media.file_name ?? record.id,
          fallbackText: `手机附件 ${record.id} (${media.mime})；若模型不支持该类型，请使用相应识别工具，不要猜测内容。` }] } : {}) }, { trigger: touch ? 'piggyback' : 'flush' });
      this.store.setHostCursor(record.id, event.cursor);
      if (event.contextDelivery === 'archive-only') this.store.settle(record.id, 'discarded', '通道隐藏，仅归档未进入对话');
    }
    this.lastError = null;
  }
  onEventsSettled(events, outcome) {
    if (!this.store || !['delivered', 'discarded'].includes(outcome)) return;
    for (const event of events) {
      if (event.source === this.id && event.type === 'coo_mobile.camera') {
        const session = this.cameraSessions.get(event.meta?.device_id);
        if (session?.session_id === event.meta?.session_id && session.pending_event === event.meta?.camera_event_id) session.pending_event = null;
      }
      if (event.source === this.id && ['coo_mobile.message', 'coo_mobile.pet_touch'].includes(event.type)) this.store.settle(event.meta?.message_id ?? event.senderKey, outcome);
    }
  }
  async handle(req, res) {
    if (!this.server || !this.store) throw new MobileError('MOBILE_STOPPED', 503);
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/_coo/ffa' && ['GET','POST'].includes(req.method)) {
      if (!localControlRequest(req,this.address().port)) throw new MobileError('LOCAL_CONTROL_ONLY',403);
      let message = '', status = 200;
      if (req.method === 'POST') {
        if (req.headers.origin !== `http://${req.headers.host.toLowerCase()}` ||
            !req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new MobileError('PANEL_UNAUTHORIZED',403);
        const parts = [];
        let size = 0;
        for await (const part of req) {
          size += part.byteLength;
          if (size > 2048) throw new MobileError('BODY_TOO_LARGE',413);
          parts.push(part);
        }
        const form = new URLSearchParams(Buffer.concat(parts).toString('utf8'));
        if (form.get('nonce') !== this.panelNonce) throw new MobileError('PANEL_UNAUTHORIZED',403);
        try { message = await this.ffaPairing.take(form.get('action')); }
        catch (error) { status = 400; message = /[\u4e00-\u9fff]/.test(error.message) ? error.message : '配对操作失败，请稍后重试。'; }
      }
      res.writeHead(status, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
        'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
      res.end(ffaPanel(this.ffaPairing.view(),this.panelNonce,message)); return;
    }
    if (url.pathname === '/_coo/world-chat' && ['GET', 'POST'].includes(req.method)) {
      if (!localControlRequest(req, this.address().port)) throw new MobileError('LOCAL_CONTROL_ONLY', 403);
      const relay = this.publicRelay;
      if (req.method === 'GET') {
        const state = await relay.worldChat('bot-listen', {}).catch(() => null);
        sendWorldChatPanel(res, this.panelNonce, state?.bot_listen_enabled); return;
      }
      if (req.headers.origin !== `http://${req.headers.host.toLowerCase()}`) throw new MobileError('PANEL_UNAUTHORIZED', 403);
      if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new MobileError('INVALID_FORM', 400);
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2048) throw new MobileError('BODY_TOO_LARGE', 413);
      }
      const form = new URLSearchParams(body);
      if (form.get('nonce') !== this.panelNonce) throw new MobileError('PANEL_UNAUTHORIZED', 403);
      const enabled = form.get('enabled');
      if (!['true', 'false'].includes(enabled)) throw new MobileError('INVALID_FORM');
      try {
        const state = await relay.worldChatListener.setListening(enabled === 'true');
        if (state.bot_listen_enabled !== (enabled === 'true')) throw new Error('WORLD_CHAT_RESPONSE_INVALID');
        res.writeHead(303, { location: '/_coo/world-chat', 'cache-control': 'no-store' });
        res.end();
      } catch { sendWorldChatPanel(res, this.panelNonce, undefined, 503); }
      return;
    }
    if (url.pathname === '/_coo/relay-apk' && ['GET', 'POST'].includes(req.method)) {
      if (!localControlRequest(req, this.address().port)) throw new MobileError('LOCAL_CONTROL_ONLY', 403);
      const relay = this.publicRelay;
      if (req.method === 'GET') {
        sendRelayApkPanel(res, this.panelNonce, relay.state); return;
      }
      if (req.headers.origin !== `http://${req.headers.host.toLowerCase()}`) throw new MobileError('PANEL_UNAUTHORIZED', 403);
      if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new MobileError('INVALID_FORM', 400);
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2048) throw new MobileError('BODY_TOO_LARGE', 413);
      }
      const form = new URLSearchParams(body);
      if (form.get('nonce') !== this.panelNonce) throw new MobileError('PANEL_UNAUTHORIZED', 403);
      const key = form.get('key')?.trim();
      const variant = form.get('variant');
      if (!isPublicRelayKey(key) || !['companion', 'workbench'].includes(variant)) {
        sendRelayApkPanel(res, this.panelNonce, relay.state, '请输入有效的公网中转密钥并选择安装包。', 400); return;
      }
      try {
        const template = variant === 'workbench' ? workbenchApkPath : apkPath;
        if (!existsSync(template)) throw new Error('APP_NOT_AVAILABLE');
        const bytes = addBootstrap(readFileSync(template), { relay: { origin: PUBLIC_RELAY_ORIGIN, key } });
        await relay.bind(key);
        res.writeHead(200, { 'content-type': 'application/vnd.android.package-archive',
          'content-disposition': `attachment; filename="CooDock-${variant}-relay-personal.apk"`,
          'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-length': bytes.length });
        res.end(bytes);
      } catch (error) {
        sendRelayApkPanel(res, this.panelNonce, relay.state,
          relayErrors[error?.message] ?? '绑定或出包未完成。请检查中转连接后重试。', 409);
      }
      return;
    }
    if (url.pathname === '/_coo/easytier' && ['GET', 'POST'].includes(req.method)) {
      if (!localControlRequest(req, this.address().port)) throw new MobileError('LOCAL_CONTROL_ONLY', 403);
      let message = '';
      if (req.method === 'POST') {
        if (req.headers.origin !== `http://${req.headers.host.toLowerCase()}`) throw new MobileError('PANEL_UNAUTHORIZED', 403);
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 2048) throw new MobileError('BODY_TOO_LARGE', 413); }
        const form = new URLSearchParams(body);
        if (form.get('nonce') !== this.panelNonce) throw new MobileError('PANEL_UNAUTHORIZED', 403);
        if (!['windows', 'android'].includes(form.get('kind'))) throw new MobileError('INVALID_ASSET', 400);
        try {
          const result = await fetchEasyTierAsset(form.get('kind'), join(this.context.dataDir, 'easytier-downloads'));
          message = `SHA-256 校验通过，未运行或安装。\n文件：${result.file}`;
        } catch (error) {
          message = error.message === 'EXISTING_FILE_HASH_MISMATCH' ? '同名文件已存在但校验不一致，未覆盖。请检查后手动处理。' : '下载或 SHA-256 校验未完成，没有安装文件；请检查网络后重试。';
        }
      }
      const html = easyTierPanel(this.panelNonce, message);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" });
      res.end(html); return;
    }
    if (req.method === 'GET' && Object.hasOwn(clientFiles, url.pathname)) {
      if (!localControlRequest(req, this.address().port)) throw new MobileError('LOCAL_CLIENT_PANEL_ONLY', 403);
      const [relative, type] = clientFiles[url.pathname];
      let bytes;
      try { bytes = readFileSync(fileURLToPath(new URL(relative, import.meta.url))); }
      catch { throw new MobileError('CLIENT_FILE_UNAVAILABLE', 503); }
      const headers = { 'content-type': type, 'content-length': bytes.length, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'" };
      if (url.pathname === '/_coo/ios-source.zip') headers['content-disposition'] = 'attachment; filename="MilkCoo-iOS-0.2.2-source.zip"';
      if (url.pathname === '/_coo/ios-unsigned.ipa') headers['content-disposition'] = 'attachment; filename="MilkCoo-unsigned-0.2.2.ipa"';
      res.writeHead(200, headers); res.end(bytes); return;
    }
    if (req.method === 'GET' && url.pathname === '/_coo/ios-pair') {
      if (!localControlRequest(req, this.address().port)) throw new MobileError('LOCAL_PAIRING_ONLY', 403);
      if (!this.mobileEndpoint) throw new MobileError('PAIRING_UNAVAILABLE', 503);
      const html = pairingPage(this.mobileEndpoint, this.pairing.create(this.mobileEndpoint));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
      res.end(html); return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/ios/pair') {
      const body = await readJson(req, 4096);
      const secret = this.context.secret(this.context.cfg.tokenSecret ?? 'MILKCOO_APP_TOKEN');
      if (!secret || !this.pairing.consume(body?.code)) throw new MobileError('PAIRING_CODE_INVALID_OR_EXPIRED', 401);
      send(res, 200, { protocol: 'tina-mobile/1', server_id: this.store.serverId, token: secret }); return;
    }
    if (url.pathname === '/_coo/model-panel' || url.pathname === '/_coo/model-control' || url.pathname === '/_coo/model-status' || url.pathname === '/_coo/desktop-screen') {
      if (!localControlRequest(req, this.address().port)) throw new MobileError('LOCAL_CONTROL_ONLY', 403);
      if (url.pathname === '/_coo/model-panel' && req.method === 'GET') {
        const html = readFileSync(modelPanelPath, 'utf8').replace('__COO_PANEL_NONCE__', this.panelNonce);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" });
        res.end(html); return;
      }
      if (url.pathname === '/_coo/model-status' && req.method === 'GET') {
        if (req.headers['x-coo-panel'] !== this.panelNonce) throw new MobileError('PANEL_UNAUTHORIZED', 403);
        try { send(res, 200, await this.modelControl.brief()); }
        catch (error) { send(res, 400, { error: String(error?.message ?? '模型状态不可用') }); }
        return;
      }
      if (url.pathname === '/_coo/desktop-screen' && ['GET', 'POST'].includes(req.method)) {
        if (req.headers['x-coo-panel'] !== this.panelNonce || (req.method === 'POST' && req.headers.origin !== `http://${req.headers.host.toLowerCase()}`)) throw new MobileError('PANEL_UNAUTHORIZED', 403);
        try {
          const state = req.method === 'GET' ? this.desktopScreen.state() : await this.desktopScreen.configure(await readJson(req));
          send(res, 200, { ...state, model_accepts_image: await this.canAcceptImage() });
        } catch (error) { send(res, 400, { error: String(error?.message ?? '电脑屏幕感知不可用') }); }
        return;
      }
      if (url.pathname === '/_coo/model-control' && ['GET', 'POST'].includes(req.method)) {
        if (req.headers['x-coo-panel'] !== this.panelNonce || (req.method === 'POST' && req.headers.origin !== `http://${req.headers.host.toLowerCase()}`)) throw new MobileError('PANEL_UNAUTHORIZED', 403);
        try { send(res, 200, req.method === 'GET' ? await this.modelControl.state(url.searchParams.get('provider') ?? undefined) : await this.modelControl.apply(await readJson(req))); }
        catch (error) { send(res, 400, { error: String(error?.message ?? '模型设置不可用') }); }
        return;
      }
      throw new MobileError('NOT_FOUND', 404);
    }
    // The personalized APK contains the private channel credential. Only the
    // Coo machine may download it; the World distribution itself stays generic.
    if (req.method === 'GET' && ['/_coo/install.apk', '/_coo/install-workbench.apk'].includes(url.pathname)) {
      if (!localControlRequest(req, this.address().port)) throw new MobileError('LOCAL_DOWNLOAD_ONLY', 403);
      if (!this.personalApk) throw new MobileError('APP_NOT_AVAILABLE', 503);
      const full = url.pathname.endsWith('install-workbench.apk');
      if (full && !existsSync(workbenchApkPath)) throw new MobileError('APP_NOT_AVAILABLE', 503);
      let bootstrap = this.workbenchBootstrap;
      try {
        const live = await this.workbenchBridge?.desktop.request('/api/worlds');
        if (Array.isArray(live?.worlds)) {
          const seen = new Set(bootstrap.preloadedWorlds.map(w => w.id));
          const merged = [...bootstrap.preloadedWorlds];
          for (const w of live.worlds) {
            const id = phoneWorldId(w?.id);
            if (id && !seen.has(id)) {
              seen.add(id);
              merged.push({ id, label: w.label ?? id, enabled: Boolean(w.enabled ?? w.active) });
            }
          }
          bootstrap = { ...bootstrap, preloadedWorlds: merged };
        }
      } catch { /* Keep built-in preloaded worlds if live desktop query is unavailable. */ }
      const bytes = addBootstrap(readFileSync(full ? workbenchApkPath : apkPath), bootstrap);
      res.writeHead(200, { 'content-type': 'application/vnd.android.package-archive', 'content-disposition': `attachment; filename="CooDock-${full ? 'workbench-' : ''}personal.apk"`, 'cache-control': 'no-store', 'content-length': bytes.length });
      res.end(bytes); return;
    }
    const auth = createHash('sha256').update(String(req.headers.authorization ?? '')).digest();
    if (!timingSafeEqual(auth, this.tokenHash)) throw new MobileError('UNAUTHORIZED', 401);
    if (req.method === 'GET' && url.pathname === '/v1/console-entry') {
      try { send(res, 200, consoleEntry(this.context.cfg.consoleUiUrl)); }
      catch { throw new MobileError('CONSOLE_UI_URL_INVALID'); }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/console-input') {
      const body = await readJson(req, 65536);
      const content = text(body.text, 'text', 16000);
      const deviceId = typeof body.device_id === 'string' && body.device_id.trim() ? body.device_id.trim() : 'coodock-console';
      const now = new Date().toISOString();
      const event = await this.host.pushEvent({
        source: 'console',
        type: 'console.message',
        origin: 'internal',
        ts: now,
        senderKey: deviceId,
        text: `[手机控制台 device_id=${JSON.stringify(deviceId)}]\n${content}`,
        meta: { from: '手机控制台', device_id: deviceId, body: content },
      }, { trigger: 'flush' });
      send(res, 200, { ok: true, cursor: event?.cursor ?? null, ts: now });
      return;
    }
    if (url.pathname === '/v1/checkpoint' || url.pathname.startsWith('/v1/desktop/')) {
      try { await this.workbenchBridge.handle(req, res, url, readJson, send); }
      catch (error) {
        if (Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) throw new MobileError(error.message, error.status);
        throw error;
      }
      return;
    }
    if (url.pathname === '/v1/bottle' || url.pathname.startsWith('/v1/bottle/')) {
      if (!this.bottleBridge) this.bottleBridge = new BottleBridge(this.modelControl);
      await this.bottleBridge.handle(req, res, url); return;
    }
    if (url.pathname === '/v1/pet/wardrobe' && ['GET', 'POST'].includes(req.method)) {
      const port = this.context.cfg.petPort ?? 7797;
      send(res, 200, req.method === 'GET' ? await wardrobeState(port) : await changeWardrobe(port, await readJson(req))); return;
    }
    if (url.pathname === '/v1/pet/import' && req.method === 'POST') {
      send(res, 200, await importFigureZip(this.context.cfg.petPort ?? 7797, req)); return;
    }
    if (req.method === 'POST' && ['/v1/pet/import/install', '/v1/pet/import/cancel', '/v1/pet/remove'].includes(url.pathname)) {
      const target = url.pathname.replace('/v1/pet/import', '/api/figures/import').replace('/v1/pet/remove', '/api/figures/remove');
      send(res, 200, await figureOperation(this.context.cfg.petPort ?? 7797, target, await readJson(req))); return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/pet/resource') {
      const resource = await readPetResource(this.context.cfg.petPort ?? 7797, url.searchParams.get('path'));
      res.writeHead(200, { 'content-type': resource.mime, 'content-length': resource.bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(resource.bytes); return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/pet/prefs') {
      send(res, 200, await writePetPreferences(this.context.cfg.petPort ?? 7797, await readJson(req))); return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/coo-events') {
      const after = Number(url.searchParams.get('after') ?? 0), limit = Number(url.searchParams.get('limit') ?? 100);
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new MobileError('INVALID_PAGINATION');
      const latest = this.host.store.latestCursor();
      if (after > latest) { send(res, 409, { error: 'EVENT_CURSOR_AHEAD', server_id: this.store.serverId, latest }); return; }
      // range(limit) returns the END of a range, not the first N rows. Bound the
      // cursor interval itself, so a busy host never silently skips events.
      const to = Math.min(latest, after + limit);
      // Existing Android versions use the old source for deduplication and notification rules.
      const events = to > after ? this.host.store.range({ fromCursor: after + 1, toCursor: to }).map(event =>
        event.source === WORLD_ID ? { ...event, source: LEGACY_WORLD_ID } : event) : [];
      send(res, 200, { server_id: this.store.serverId, events, next_cursor: to, latest, phase: this.runPhase ?? null }); return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/worlds') {
      const value = await this.modelControl.request('/api/worlds', undefined, 5000);
      const worlds = (value.worlds ?? []).filter(item => typeof item.id === 'string').map(item => ({
        id: phoneWorldId(item.id), label: typeof item.label === 'string' ? item.label : item.id,
        enabled: item.status === 'active' ? true : item.status === 'inactive' ? false : null,
      }));
      send(res, 200, { worlds }); return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/world-library') {
      const value = await this.modelControl.request('/api/worlds', undefined, 5000);
      const worlds = (value.worlds ?? []).filter(item => typeof item.id === 'string').map(item => ({
        id: phoneWorldId(item.id), label: typeof item.label === 'string' ? item.label : item.id,
        status: item.status || 'unknown', visible: item.visible === true,
        package: null, version: null, package_state: null,
      }));
      send(res, 200, { worlds, partial: true }); return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/world-market') {
      send(res, 503, { error: '手机市场目录暂不可用，请在电脑 Coo 的扩展页查看。' }); return;
    }
    if (url.pathname === '/v1/stickers') {
      this.stickerLibrary ??= new SharedStickerLibrary(this.context);
      if (req.method === 'GET') {
        const list = this.stickerLibrary.list(200);
        send(res, 200, { ok: true, total: list.length, stickers: list });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJson(req, 10 * 1024 * 1024);
        const bytes = Buffer.from(String(body.data ?? ''), 'base64');
        if (bytes.length < 1 || bytes.length > MEDIA_LIMIT) throw new MobileError('INVALID_STICKER_DATA');
        const entry = this.stickerLibrary.addFromPhone({
          bytes,
          mime: String(body.mime ?? 'image/gif'),
          label: String(body.label ?? ''),
          emotion: String(body.emotion ?? '常用'),
          usage: String(body.usage ?? '日常互动'),
          tag: String(body.tag ?? ''),
        });
        send(res, 200, { ok: true, sticker: entry });
        return;
      }
    }
    if (req.method === 'GET' && url.pathname === '/v1/stickers/file') {
      this.stickerLibrary ??= new SharedStickerLibrary(this.context);
      const item = this.stickerLibrary.readStickerFile(url.searchParams.get('name'));
      if (!item) { send(res, 404, { error: 'STICKER_NOT_FOUND' }); return; }
      send(res, 200, { ok: true, file: item.file, mime: item.mime, sha256: item.sha256, data: item.bytes.toString('base64') });
      return;
    }
    if (url.pathname === '/v1/adapter-relay') {
      const relayDir = join(this.dir, 'adapter-relay-submissions');
      mkdirSync(relayDir, { recursive: true });
      if (req.method === 'GET') {
        const files = readdirSync(relayDir).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 100);
        const submissions = files.map(f => { try { return JSON.parse(readFileSync(join(relayDir, f), 'utf8')); } catch { return null; } }).filter(Boolean);
        send(res, 200, { ok: true, count: submissions.length, submissions });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJson(req, 512 * 1024);
        const submitter = String(body.submitter ?? '').trim();
        const worldId = String(body.world_id ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '_');
        if (!submitter || !worldId) { send(res, 400, { error: 'SUBMITTER_AND_WORLD_ID_REQUIRED' }); return; }
        const submissionId = `${Date.now()}-${worldId}-${randomBytes(4).toString('hex')}`;
        const record = {
          submission_id: submissionId,
          submitted_at: new Date().toISOString(),
          submitter,
          world_id: worldId,
          world_label: String(body.world_label ?? worldId),
          repo_url: String(body.repo_url ?? ''),
          title: String(body.title ?? ''),
          markdown_body: String(body.markdown_body ?? ''),
          artifact: body.artifact ?? null,
          workflow_yaml: String(body.workflow_yaml ?? ''),
          sanitized_logs: String(body.sanitized_logs ?? ''),
          device_id: String(body.device_id ?? ''),
        };
        writeFileSync(join(relayDir, `${submissionId}.json`), JSON.stringify(record, null, 2), 'utf8');
        send(res, 200, { ok: true, submission_id: submissionId, status: 'queued_for_author_relay' });
        return;
      }
    }
    if (url.pathname.startsWith('/v1/native/')) {
      if (req.method === 'GET' && url.pathname === '/v1/native/devices') { send(res, 200, { devices: this.nativeDevices.devices() }); return; }
      if (req.method === 'GET' && url.pathname === '/v1/native/result') {
        const result = this.nativeDevices.row(url.searchParams.get('operation_id'));
        send(res, result ? 200 : 404, result ?? { error: 'NATIVE_OPERATION_NOT_FOUND' }); return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/native/media') {
        const row = this.nativeDevices.media(url.searchParams.get('device_id'),url.searchParams.get('media_id'));
        if (!row || row.device_id !== url.searchParams.get('device_id')) { send(res, 404, { error: 'NATIVE_MEDIA_NOT_FOUND' }); return; }
        send(res, 200, { mime: row.mime, sha256: row.sha256, data: Buffer.from(row.data).toString('base64') }); return;
      }
      if (req.method === 'POST') {
        const body = await readJson(req, 12 * 1024 * 1024);
        const value = url.pathname === '/v1/native/poll' ? this.nativeDevices.poll(body)
          : url.pathname === '/v1/native/request' ? this.nativeDevices.enqueue(body)
          : url.pathname === '/v1/native/result' ? this.nativeDevices.complete(body) : null;
        if (value) { send(res, 200, value); return; }
      }
      send(res, 404, { error: 'NATIVE_ROUTE_NOT_FOUND' }); return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      // This endpoint is reached only after Bearer authentication. server_id belongs
      // to mobile.sqlite and survives endpoint/credential changes; it is a stable
      // routing label, not cryptographic proof of identity. Cloned databases share it.
      send(res, 200, { protocol: 'tina-mobile/1', server_id: this.store.serverId, ok: true, native_device_channel: true, media: true, files: true, media_metadata: true, coo_events: true, world_index: true, world_market: false, model_catalog: false, pet_resources: true, screen: true, model_control: true, pet_state_mirror: false, desktop_screen: false, pet_state_reason: 'Desktop state mirroring is unavailable without a public host interface.' }); return;
    }
    if (url.pathname === '/v1/model/status' && req.method === 'GET') {
      try { send(res, 200, await this.modelControl.brief()); }
      catch (error) { send(res, 400, { error: String(error?.message ?? '模型状态不可用') }); }
      return;
    }
    if (url.pathname === '/v1/model' && req.method === 'GET') {
      try { send(res, 200, await this.modelControl.state(url.searchParams.get('provider') ?? undefined)); }
      catch (error) { send(res, 400, { error: String(error?.message ?? '无法读取模型设置') }); }
      return;
    }
    if (url.pathname === '/v1/model' && req.method === 'POST') {
      try { send(res, 200, await this.modelControl.apply(await readJson(req))); }
      catch (error) { send(res, 400, { error: String(error?.message ?? '无法应用模型设置') }); }
      return;
    }
    if (url.pathname === '/v1/desktop-screen' && req.method === 'GET') { send(res, 200, { ...this.desktopScreen.state(), model_accepts_image: await this.canAcceptImage() }); return; }
    if (url.pathname === '/v1/desktop-screen' && req.method === 'POST') {
      try { send(res, 200, await this.desktopScreen.configure(await readJson(req))); }
      catch (error) { send(res, 400, { error: String(error?.message ?? '电脑屏幕感知启动失败') }); }
      return;
    }
    if (url.pathname === '/v1/camera/session' && req.method === 'POST') {
      const body = await readJson(req), device = text(body.device_id, 'device_id', 128), id = text(body.session_id, 'session_id', 128);
      const config = { quality: 'balanced', interval_sec: 10, adaptive: true, proactive: false, ...cameraSettings(body) };
      if (!this.cameraSessions.has(device) && this.cameraSessions.size >= 16) this.cameraSessions.delete(this.cameraSessions.keys().next().value);
      this.cameraSessions.set(device, { session_id: id, config, revision: 1, last_seen: Date.now(), last_wake: 0, frame: null, pending_event: null, force_wake: config.proactive });
      send(res, 200, { ok: true, ...config, revision: 1 }); return;
    }
    if (url.pathname === '/v1/camera/session' && req.method === 'DELETE') {
      const device = text(url.searchParams.get('device_id'), 'device_id', 128), id = text(url.searchParams.get('session_id'), 'session_id', 128);
      if (this.cameraSessions.get(device)?.session_id === id) this.cameraSessions.delete(device);
      send(res, 200, { ok: true }); return;
    }
    if (url.pathname === '/v1/camera/control' && ['GET', 'POST'].includes(req.method)) {
      const body = req.method === 'POST' ? await readJson(req) : Object.fromEntries(url.searchParams);
      const device = text(body.device_id, 'device_id', 128), id = text(body.session_id, 'session_id', 128);
      const session = this.cameraSessions.get(device);
      if (!session || session.session_id !== id || Date.now() - session.last_seen >= 30000) throw new MobileError('CAMERA_SESSION_EXPIRED', 409);
      session.last_seen = Date.now();
      if (req.method === 'POST') {
        const patch = cameraSettings(body);
        if (patch.proactive === true && !session.config.proactive) session.force_wake = true;
        session.config = { ...session.config, ...patch }; session.revision++;
      }
      send(res, 200, { ok: true, ...session.config, revision: session.revision }); return;
    }
    if (url.pathname === '/v1/camera/frame' && req.method === 'POST') {
      const body = await readJson(req, 6 * 1024 * 1024), device = text(body.device_id, 'device_id', 128), id = text(body.session_id, 'session_id', 128);
      const captured = text(body.captured_at, 'captured_at', 80), session = this.cameraSessions.get(device);
      if (!session || session.session_id !== id || Date.now() - session.last_seen >= 30000) throw new MobileError('CAMERA_SESSION_EXPIRED', 409);
      if (body.changed !== undefined && typeof body.changed !== 'boolean') throw new MobileError('INVALID_CAMERA_CHANGE');
      if (!Number.isFinite(Date.parse(captured)) || body.mime !== 'image/jpeg' || typeof body.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data)) throw new MobileError('INVALID_CAMERA_FRAME');
      const bytes = Buffer.from(body.data, 'base64');
      if (bytes.length < 4 || bytes.length > 4 * 1024 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new MobileError('INVALID_CAMERA_FRAME');
      session.last_seen = Date.now(); session.frame = { bytes, captured_at: captured };
      const accepts = await this.canAcceptImage(); let delivered = false;
      if (session.config.proactive && accepts && (body.changed !== false || session.force_wake) && !session.pending_event && Date.now() - session.last_wake >= Math.max(15000, session.config.interval_sec * 1000)) {
        session.last_wake = Date.now();
        const cameraEventId = randomBytes(12).toString('hex'); session.pending_event = cameraEventId;
        try {
          await this.host.pushEvent({ source: this.id, type: 'coo_mobile.camera', origin: 'external', ts: captured,
            text: `[手机摄像头画面 device_id=${JSON.stringify(device)}，采集于 ${captured}]`, meta: { device_id: device, session_id: id, captured_at: captured, camera_event_id: cameraEventId },
            blobs: [{ bytes, mime: 'image/jpeg', name: 'phone-camera.jpg', fallbackText: '手机摄像头图片，无法识别时不要猜测。' }] }, { trigger: 'flush' });
          delivered = true; session.force_wake = false;
        } catch (error) { if (session.pending_event === cameraEventId) session.pending_event = null; throw error; }
      }
      send(res, 200, { ok: true, model_accepts_image: accepts, proactive_delivered: delivered, proactive_pending: !!session.pending_event, revision: session.revision }); return;
    }
    if (req.method === 'DELETE' && url.pathname === '/v1/screen') {
      const device = text(url.searchParams.get('device_id'), 'device_id', 128);
      const session = text(url.searchParams.get('session_id'), 'session_id', 128);
      if (this.screenFrames.get(device)?.session_id === session) this.screenFrames.delete(device);
      send(res, 200, { ok: true }); return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/screen') {
      const body = await readJson(req, 8 * 1024 * 1024);
      const device = text(body?.device_id, 'device_id', 128), captured = text(body?.captured_at, 'captured_at', 80);
      const session = text(body?.session_id, 'session_id', 128);
      if (!Number.isFinite(Date.parse(captured)) || body.mime !== 'image/jpeg' || typeof body.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data)) throw new MobileError('INVALID_SCREEN_FRAME');
      const bytes = Buffer.from(body.data, 'base64');
      if (bytes.length < 4 || bytes.length > 4 * 1024 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new MobileError('INVALID_SCREEN_FRAME');
      if (!this.screenFrames.has(device) && this.screenFrames.size >= 16) this.screenFrames.delete(this.screenFrames.keys().next().value);
      this.screenFrames.set(device, { bytes, captured_at: captured, session_id: session });
      const accepts = await this.canAcceptImage();
      let delivered = false;
      if (body.peek === true && accepts) {
        // A one-shot look is an explicit phone request. Use the same durable
        // message/attachment path so Coo can reply to its actual source device.
        const id = `peek-${createHash('sha256').update(JSON.stringify([device, session, captured])).digest('hex')}`;
        this.store.putMedia(id, device, 'image/jpeg', createHash('sha256').update(bytes).digest('hex'), bytes);
        const { record, inserted } = this.store.insert({ id, device_id: device, text: '请看一眼我当前的手机屏幕。', created_at: captured, source_ref: `coo-media:${id}` }, 'user_message');
        if (inserted || record.delivery_state === 'accepted') this.kick();
        send(res, 200, { ok: true, model_accepts_image: true, proactive_delivered: false, peek_queued: true, message_id: id }); return;
      }
      if (body.proactive === true && body.peek !== true && accepts) {
        await this.host.pushEvent({ source: this.id, type: 'coo_mobile.screen', origin: 'external', ts: captured,
          text: `[手机屏幕更新 device_id=${JSON.stringify(device)}，采集于 ${captured}]`, meta: { device_id: device, captured_at: captured },
          blobs: [{ bytes, mime: 'image/jpeg', name: 'phone-screen.jpg', fallbackText: '手机屏幕图片，无法识别时不要猜测。' }] }, { trigger: 'flush' });
        delivered = true;
      }
      send(res, 200, { ok: true, model_accepts_image: accepts, proactive_delivered: delivered }); return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/pet/touch') {
      const body = await readJson(req);
      const kind = text(body?.kind, 'kind', 20);
      const labels = { poke: '戳了戳手机上的小人', pet: '摸了摸手机上的小人', grab: '拿起了手机上的小人', drop: '放下了手机上的小人', throw: '抛了一下手机上的小人', crash: '手机上的小人碰到了边界' };
      if (!Object.hasOwn(labels, kind)) throw new MobileError('INVALID_TOUCH_KIND');
      const input = messageInput({ ...body, text: labels[kind] }); input.source_ref = `pet-touch:${kind}`;
      const result = this.store.insert(input, 'pet_touch');
      send(res, result.inserted ? 201 : 200, this.store.ack(result.record));
      if (result.inserted) this.kick();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/media') {
      const body = await readJson(req, 12 * 1024 * 1024);
      const input = messageInput(body);
      const mime = text(body.mime, 'mime', 100);
      if (!mediaMime(mime) || typeof body.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data)) throw new MobileError('MEDIA_UNSUPPORTED');
      const bytes = Buffer.from(body.data, 'base64');
      if (!bytes.length || bytes.length > MEDIA_LIMIT) throw new MobileError('MEDIA_TOO_LARGE', 413);
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (sha !== body.sha256) throw new MobileError('MEDIA_HASH_MISMATCH');
      this.store.putMedia(input.id, input.device_id, mime, sha, bytes, mediaName(body.file_name));
      input.source_ref = `coo-media:${input.id}`;
      const result = this.store.insert(input, 'user_message');
      send(res, result.inserted ? 201 : 200, this.store.ack(result.record));
      if (result.inserted) this.kick();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/media') {
      const id = text(url.searchParams.get('id'), 'id', 160), device = text(url.searchParams.get('device_id'), 'device_id', 128);
      const info = this.store.getMediaInfo(id), record = this.store.get(id);
      if (!info || !record || info.device_id !== device || record.device_id !== device) throw new MobileError('MEDIA_NOT_FOUND', 404);
      if (url.searchParams.get('metadata') === '1') {
        send(res, 200, { id, device_id: device, mime: info.mime, sha256: info.sha256, size: info.size, ...(info.file_name ? { file_name: info.file_name } : {}) }); return;
      }
      const media = this.store.getMedia(id);
      send(res, 200, { id, device_id: device, mime: media.mime, sha256: media.sha256, data: Buffer.from(media.data).toString('base64'), ...(media.file_name ? { file_name: media.file_name } : {}) }); return;
    }
    if (req.method === 'POST' && ['/v1/messages', '/v1/facts'].includes(url.pathname)) {
      const fact = url.pathname === '/v1/facts';
      const input = messageInput(await readJson(req), fact);
      const result = this.store.insert(input, fact ? 'fact' : 'user_message');
      send(res, result.inserted ? 201 : 200, fact ? { id: input.id, state: 'stored', server_seq: result.record.server_seq } : this.store.ack(result.record));
      if (!fact && result.inserted) this.kick();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/feed') {
      const device = text(url.searchParams.get('device_id'), 'device_id', 128);
      const after = Number(url.searchParams.get('after') ?? 0), limit = Number(url.searchParams.get('limit') ?? 100);
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new MobileError('INVALID_PAGINATION');
      send(res, 200, this.store.feed(device, after, limit)); return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/source') {
      const id = text(url.searchParams.get('id'), 'id', 160), record = this.store.get(id);
      if (!record) throw new MobileError('SOURCE_NOT_FOUND', 404);
      send(res, 200, { server_id: this.store.serverId, record, external_source_retrieved: false }); return;
    }
    throw new MobileError('NOT_FOUND', 404);
  }
}

export default {
  id: WORLD_ID, label: WORLD_LABEL,
  defaults: () => ({ enabled: false, host: '0.0.0.0', port: 7801, advertiseHost: 'auto', petPort: 7797, consolePort: 17788, tokenSecret: 'MILKCOO_APP_TOKEN' }),
  create(context) {
    migrateWorldIdentity(context);
    return new TinaMobileWorld(context);
  },
  describe: { tools: toolSchemas, events: [
    { type: 'coo_mobile.message', description: { zh: '手机原始输入和可选媒体，保留设备与消息来源。', en: 'Original phone input and optional media with device identity.' }, trigger: 'flush' },
    { type: 'coo_mobile.pet_touch', description: { zh: '手机上的实际桌宠互动。', en: 'A real touch on the phone pet.' }, trigger: 'piggyback' },
    { type: 'coo_mobile.pet_control', description: { zh: 'Cortico 明确请求中断指定手机的桌宠动作。', en: 'An explicit Cortico request to interrupt a specific phone pet.' } },
    { type: 'coo_mobile.screen', description: { zh: '用户开启主动查看时的手机屏幕画面。', en: 'Phone screen frame when proactive viewing is enabled.' }, trigger: 'flush' },
    { type: 'coo_mobile.camera', description: { zh: '用户开启主动观察时的手机摄像头画面。', en: 'Phone camera frame when proactive viewing is enabled.' }, trigger: 'flush' },
    { type: 'coo_mobile.world_chat', description: { zh: '主动开启收听后的公开世界群聊，外部参与者内容。', en: 'External public-room participant messages after owner opt-in.' }, trigger: 'piggyback' },
  ] },
};
