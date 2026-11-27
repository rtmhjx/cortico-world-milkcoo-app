// Run through the isolated copy helper against the existing API-5 Cortico checkout.
import { test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

test('real API-5 Core accepts phone media as a durable blob and returns it via World', async () => {
  const checkout = process.env.COO_TEST_CORTICO_ROOT!;
  const worldSource = process.env.COO_TEST_WORLD_SOURCE!;
  console.log('fixture: loading isolated Core');
  const { Core } = await import(pathToFileURL(join(checkout,'tests/core/fixture-core.ts')).href);
  console.log('fixture: loading Core helpers');
  const { makeCfg, makeLoaded, makeFakePersona, FakeLLM } = await import(pathToFileURL(join(checkout,'tests/core/helpers.ts')).href);
  // Vite accepts the Windows filesystem path; percent-encoded file URLs do not.
  console.log('fixture: loading World');
  const { TinaMobileWorld } = await import(worldSource.replace(/\\/g, '/'));
  const directory = mkdtempSync(join(tmpdir(),'coo-real-core-'));
  const cfg = makeCfg();
  const loaded = makeLoaded({ config:cfg, rootDir:directory, memoryDir:join(directory,'memory'), dataDir:join(directory,'core') });
  const world = new TinaMobileWorld({ cfg:{host:'127.0.0.1',port:0,tokenSecret:'FIXTURE'}, dataDir:join(directory,'world'), botDir:directory, secret:()=> 'fixture' });
  const persona = makeFakePersona([], {cfg,worlds:[world],silent:true});
  const llm = new FakeLLM();
  const core = new Core(loaded,{persona,worlds:[world],llm});
  try {
    console.log('fixture: starting core');
    await core.start(); core.bus.setPaused(true);
    console.log('fixture: core started');
    const data=Buffer.from('only synthetic media'), hash=createHash('sha256').update(data).digest('hex');
    const endpoint=`http://127.0.0.1:${world.address().port}`;
    const result=await fetch(endpoint+'/v1/media',{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},
      body:JSON.stringify({id:'photo-real-core',device_id:'fixture-phone',created_at:'2026-10-28T00:00:00Z',text:'[图片]',mime:'image/png',sha256:hash,data:data.toString('base64')})});
    expect(result.status).toBe(201);
    console.log('fixture: image accepted');
    while (world.pending) await world.pending;
    const event=core.store.range({source:'milkcoo-app',senderKey:'photo-real-core'}).find((item:any)=>item.senderKey==='photo-real-core');
    expect(event?.blobs?.[0]?.handle).toMatch(/^log:/);
    const handle=event.blobs[0].handle;
    expect(Buffer.from(core.resolveBlob(handle).bytes)).toEqual(data);
    const send=world.tools().find((tool:any)=>tool.name==='milkcoo_app_send_media').handler;
    const receipt=JSON.parse(await send({device_id:'fixture-phone',in_reply_to:'photo-real-core',handle,text:'[回图]'}, {role:'fixture',callId:'actual-core-1'}));
    const reply=await (await fetch(endpoint+`/v1/media?id=${encodeURIComponent(receipt.id)}&device_id=fixture-phone`,{headers:{authorization:'Bearer fixture'}})).json();
    expect(Buffer.from(reply.data,'base64')).toEqual(data);
    console.log('fixture: image roundtrip complete');
    const pdf = Buffer.from('only synthetic document');
    const pdfHash = createHash('sha256').update(pdf).digest('hex');
    const fileResult = await fetch(endpoint+'/v1/media',{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},
      body:JSON.stringify({id:'file-real-core',device_id:'fixture-phone',created_at:'2026-10-28T00:00:01Z',text:'[文件] sample.pdf',mime:'application/pdf',file_name:'sample.pdf',sha256:pdfHash,data:pdf.toString('base64')})});
    expect(fileResult.status).toBe(201);
    while (world.pending) await world.pending;
    const fileEvent=core.store.range({source:'milkcoo-app',senderKey:'file-real-core'}).find((item:any)=>item.senderKey==='file-real-core');
    expect(fileEvent?.blobs?.[0]?.handle).toMatch(/^log:/);
    expect(Buffer.from(core.resolveBlob(fileEvent.blobs[0].handle).bytes)).toEqual(pdf);
    console.log('fixture: file roundtrip complete');
    expect(llm.calls.length).toBe(0);
  } finally {
    console.log('fixture: stopping core');
    await core.stop();
    console.log('fixture: core stopped');
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    expect(basename(directory)).toMatch(/^coo-real-core-/);
    rmSync(directory,{recursive:true,force:true});
  }
}, 120000);
