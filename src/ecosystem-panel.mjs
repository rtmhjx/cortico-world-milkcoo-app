const esc = text => String(text ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

/** Owner control page on the existing World listener, separate from native App service frontends. */
export function ecosystemPanel(catalog, nonce, ffaAccount) {
  const ready = catalog.providers.some(provider => provider.id === 'ins-identity' && provider.state === 'ready');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CooDock · 服务账号</title><style>body{margin:0;background:#101a23;color:#e5edef;font:16px/1.65 sans-serif}main{max-width:820px;margin:auto;padding:32px 22px}h1{font-size:30px}section{background:#192630;border:1px solid #34464e;border-radius:18px;padding:20px;margin:16px 0}small{color:#a9bcb9}button,a{background:#c3dbca;color:#14291d;border:0;border-radius:10px;padding:12px 18px;font-size:15px;text-decoration:none;cursor:pointer}button:disabled{opacity:.45}pre{white-space:pre-wrap}</style>
<main><small>COODOCK · SERVICE ACCOUNTS</small><h1>账号跟着连接走</h1><p>App 预载服务的原生界面；服务继续使用各自的后端。这里保存真实登录结果，并在打印 App 时交接。</p>
${catalog.services.map(service => `<section><h2>${esc(service.title)}</h2><p>${service.authState === 'connected' ? '已保存服务账号' : '尚未登录'}</p><small>${service.accounts.map(account => esc(account.displayName ?? account.subject)).join(' · ') || '可在 App 中使用原有登录；共同登录接通后也可由此交接。'}</small></section>`).join('')}
${ffaAccount ? `<section><h2>FFA Hub 社区账号</h2><p id="ffa-status" role="status">正在查询登录状态…</p>
${ffaAccount.canManage ? '<button id="ffa-begin">登录 FFA Hub</button> <button id="ffa-logout" hidden>退出宿主账号</button><div id="ffa-choices"></div><p id="ffa-verify" hidden><a id="ffa-link" target="_blank" rel="noopener noreferrer">打开 FFA Hub 确认</a> 短码 <strong id="ffa-code"></strong></p>' : ''}</section>` : ''}
<section><h2>共同登录</h2><p>${ready ? '认证提供方已接入。' : '等待星邮提供方接入；当前仍使用各服务自己的真实会话。'}</p><button id="login" ${ready ? '' : 'disabled'}>开始登录</button><pre id="status" role="status"></pre></section>
<p><a href="/_coo/install.apk">打印原生服务 App</a> <a href="/_coo/install-workbench.apk">打印完整工作台</a></p></main>
<script>document.getElementById('login').onclick=async()=>{const out=document.getElementById('status');out.textContent='正在连接…';try{const r=await fetch('/_coo/ecosystem-control',{method:'POST',headers:{'Content-Type':'application/json','x-coo-panel':${JSON.stringify(nonce)}},body:JSON.stringify({method:'login',input:{providerId:'ins-identity',action:'begin'}})});const data=await r.json();if(!r.ok)throw Error(data.error||'登录暂不可用');if(data.authorizationUrl){const url=new URL(data.authorizationUrl);if(url.protocol!=='https:')throw Error('认证地址不可用');location.assign(url.href);}else out.textContent='认证已开始，请按认证提供方完成登录。';}catch(e){out.textContent=e.message;}};
${ffaAccount ? `(() => {
  const get=id=>document.getElementById('ffa-'+id), status=get('status'), begin=get('begin'), logout=get('logout');
  let timer;
  async function request(action, businessId) {
    const response=await fetch('/_coo/ecosystem-control',{method:'POST',headers:{'Content-Type':'application/json','x-coo-panel':${JSON.stringify(nonce)}},body:JSON.stringify({method:'ffaHub',input:{action,businessId}})});
    const out=await response.json();if(!response.ok)throw Error(out.error||'暂时无法查询登录状态');return out;
  }
  function show(data) {
    if(begin)begin.hidden=data.status==='ready';if(logout)logout.hidden=data.status!=='ready';
    status.textContent=data.status==='ready' ? (data.displayName||data.subject)+(data.serviceStatus==='ready'?' · CooDock 服务已登录':data.serviceStatus==='business_account_required'?' · 请选择业务号':' · CooDock 服务需要单独授权') : '尚未登录 FFA Hub';
    if(!get('choices'))return;get('choices').replaceChildren();
    for(const account of data.businessAccounts||[]){const b=document.createElement('button');b.textContent=account;b.onclick=async()=>{try{show(await request('choose',account));}catch(e){status.textContent=e.message;}};get('choices').append(b);}
  }
  request('status').then(show).catch(e=>{status.textContent=e.message;});
  if(logout)logout.onclick=async()=>{try{clearTimeout(timer);show(await request('logout'));}catch(e){status.textContent=e.message;}};
  if(begin)begin.onclick=async()=>{try{
    clearTimeout(timer);const flow=await request('begin');const target=new URL(flow.authorizationUrl);
    if(target.protocol!=='https:'&&!(target.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(target.hostname)))throw Error('FFA Hub 授权地址不可用');
    get('link').href=target.href;get('code').textContent=flow.shortCode;get('verify').hidden=false;status.textContent='请在 FFA Hub 核对短码并确认。';
    const poll=async()=>{try{if(Date.now()>=flow.expiresAt){get('verify').hidden=true;status.textContent='确认已过期，请重新登录。';return;}const out=await request('complete');if(out.status==='pending'){timer=setTimeout(poll,3000);return;}get('verify').hidden=true;show(out);}catch(e){get('verify').hidden=true;status.textContent=e.message;}};
    timer=setTimeout(poll,3000);
  }catch(e){status.textContent=e.message;}};
})();` : ''}</script></html>`;
}
