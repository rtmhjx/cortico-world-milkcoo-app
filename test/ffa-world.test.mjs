import assert from 'node:assert/strict';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FfaWorldPairing, ffaPanel } from '../src/ffa-world.mjs';
import { TinaMobileWorld } from '../src/world.mjs';

const origin = 'https://8.148.13.225:8443';
const bot = 'ffa_' + randomUUID();
const token = 't'.repeat(43), polling = 'p'.repeat(43), challenge = 'c'.repeat(43);

test('World signs its Hub installation, scopes the result and keeps credentials out of HTML',async t => {
  const pairingId=randomUUID(), secrets=new Map();
  const dir=mkdtempSync(join(tmpdir(),'coodock-ffa-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const credentials=join(dir,'worker.json');
  const context={cfg:{ffaWorkerCredentialsFile:credentials},secret:key=>secrets.get(key),storeSecret:(k,v)=>secrets.set(k,v)};
  let now=Date.now(), start, approved=false, invalid=false;
  const request=async(url,settings)=>{
    const body=JSON.parse(settings.body);
    assert.equal(new URL(url).origin,origin);
    assert.equal(settings.redirect,'error');
    const path=new URL(url).pathname;
    let result={};
    if(path==='/v1/pairings'){
      start=body;
      assert.equal(start.service,'coodock');
      assert.equal(start.publicKey.d,undefined);
      result={pairingId,pollingSecret:polling,challenge,shortCode:'AABBCC12',verificationUri:origin+'/?pair='+pairingId};
    } else if(path==='/v1/pairings/prove'){
      assert.equal(body.pollingSecret,polling);
      const [header,payload,signature]=body.signature.split('.');
      const proof=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
      assert.deepEqual(proof,{pairingId,challenge,installationId:start.installationId,service:'coodock'});
      assert.ok(verify(null,Buffer.from(header+'.'+payload),createPublicKey({key:start.publicKey,format:'jwk'}),Buffer.from(signature,'base64url')));
      result={proved:true};
    } else if(path==='/v1/pairings/poll'){
      assert.equal(body.pollingSecret,polling);
      result=approved?{status:'approved',issuer:'https://ffahub.net',subject:bot,audience:invalid?'other':'coodock',
        accessToken:token,expiresAt:now+600000,installationId:start.installationId}:{status:'pending'};
    } else assert.fail(path);
    return Response.json({ok:true,result});
  };
  const workerToken='private-worker-token-never-in-html';
  const pair=new FfaWorldPairing(context,{request,now:()=>now,connect:async installation=>{
    assert.equal(installation.subject,bot);
    assert.equal(installation.accessToken,token);
    return {serviceState:'connected',botId:bot,accessToken:workerToken,expiresAt:now+60000};
  }});
  await pair.take('start');
  assert.match(ffaPanel(pair.view(),'nonce'),/AABBCC12/);
  assert.doesNotMatch(ffaPanel(pair.view(),'nonce'),new RegExp(polling));
  await pair.take('poll');
  await assert.rejects(pair.take('poll'),/三秒/);
  approved=true;
  invalid=true;
  now+=3000;
  await assert.rejects(pair.take('poll'),/不匹配/);
  assert.equal(pair.installation(),null);
  invalid=false;
  now+=3000;
  await pair.take('poll');
  assert.equal(new FfaWorldPairing(context).installation().subject,bot);
  await pair.take('worker');
  assert.equal(JSON.parse(readFileSync(credentials,'utf8')).accessToken,workerToken);
  await assert.rejects(pair.take('worker'),/已存在/);
  assert.doesNotMatch(ffaPanel(pair.view(),'nonce'),new RegExp(token+'|'+workerToken));
  await pair.take('clear');
  assert.equal(pair.installation(),null);
});

test('World pairing controls enforce loopback, origin and CSRF while preserving phone routes',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'coodock-ffa-panel-')), secrets=new Map();
  const context={id:'milkcoo-app',cfg:{host:'127.0.0.1',port:0},dataDir:dir,
    secret:key=>secrets.get(key),storeSecret:(k,v)=>secrets.set(k,v)};
  const world=new TinaMobileWorld(context);
  await world.start({});
  t.after(async()=>{await world.stop();rmSync(dir,{recursive:true,force:true});});
  const current='http://127.0.0.1:'+world.address().port;
  const page=await fetch(current+'/_coo/ffa');
  assert.equal(page.status,200);
  assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  const nonce=(await page.text()).match(/name="nonce" type="hidden" value="([^"]+)"/)[1];
  const post=(origin,n)=>fetch(current+'/_coo/ffa',{method:'POST',headers:{origin},body:new URLSearchParams({nonce:n,action:'poll'})});
  assert.equal((await post('https://other.example',nonce)).status,403);
  assert.equal((await post(current,'invalid')).status,403);
  assert.equal((await post(current,nonce)).status,400);
  assert.equal((await fetch(current+'/_coo/devices')).status,200);
});
