import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const QRCode = require('./vendor/qrcode-terminal/QRCode/index.js');
const QRLevel = require('./vendor/qrcode-terminal/QRCode/QRErrorCorrectLevel.js');
const codeHash = code => createHash('sha256').update(code).digest('hex');
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** One-time pairing tickets are ephemeral and never contain the World secret. */
export class MobilePairing {
  constructor({ now = () => Date.now(), lifetimeMs = 5 * 60_000 } = {}) {
    this.now = now; this.lifetimeMs = lifetimeMs; this.tickets = new Map();
  }
  create(endpoint) {
    const now = this.now();
    for (const [key, expires] of this.tickets) if (expires <= now) this.tickets.delete(key);
    // Opening another page invalidates its predecessor rather than accumulating tickets.
    this.tickets.clear();
    const code = randomBytes(32).toString('base64url');
    this.tickets.set(codeHash(code), now + this.lifetimeMs);
    const uri = new URL('coomilk://pair');
    uri.searchParams.set('endpoint', endpoint); uri.searchParams.set('code', code);
    return { code, uri: uri.toString(), expiresAt: now + this.lifetimeMs };
  }
  consume(code) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) return false;
    const key = codeHash(code), expires = this.tickets.get(key);
    if (!expires) return false;
    this.tickets.delete(key);
    return expires > this.now();
  }
  clear() { this.tickets.clear(); }
}

export function qrSvg(value, label = '苹果设备配对码') {
  const qr = new QRCode(-1, QRLevel.M);
  qr.addData(value); qr.make();
  const count = qr.getModuleCount(), quiet = 4;
  let path = '';
  for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) {
    if (qr.isDark(y, x)) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  }
  const size = count + quiet * 2;
  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="${escapeHtml(label)}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="white"/><path d="${path}" fill="#111"/></svg>`;
}

export function pairingPage(endpoint, ticket) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接奶coo</title>
<style>body{font:16px system-ui,sans-serif;background:#101715;color:#e8f1eb;margin:0;padding:32px}main{max-width:560px;margin:auto}h1{font-size:28px}p{line-height:1.65;color:#bacfc2}.qr{background:white;padding:12px;border-radius:18px;width:min(300px,80vw)}svg{display:block;width:100%;height:auto}code{display:block;overflow-wrap:anywhere;background:#213129;padding:12px;border-radius:10px}small{color:#93ae9f}</style></head>
<body><main><h1>让苹果设备连接 Coo</h1><p>打开奶coo，选择扫码连接。此码只可用一次，五分钟后失效；请勿分享给其他人。</p><div class="qr">${qrSvg(ticket.uri)}</div><p>也可在手机里手动填写：</p><small>连接地址</small><code id="endpoint">${escapeHtml(endpoint)}</code><small>一次性配对码</small><code id="code">${escapeHtml(ticket.code)}</code><p>扫码后此页面不会自动更新；如需连接另一台设备，刷新页面取得新码。</p></main></body></html>`;
}
