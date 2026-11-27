import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PetTransfer, PET_CHUNK_BYTES } from '../src/pet-transfer.mjs';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('64 MiB resource over real HTTP: bounded chunks, shared spool, resume, digest and revision change', async () => {
  const directory=await mkdtemp(join(tmpdir(),'pet-transfer-'));
  let hits=0, fill=73;
  const total=64*1024*1024+123;
  const server=createServer(async (req,res) => {
    hits++;
    res.writeHead(200,{'content-type':'image/webp','content-length':total});
    const block=Buffer.alloc(65536,fill);
    for(let n=0;n<total;n+=block.length) {
      if(!res.write(block.subarray(0,Math.min(block.length,total-n)))) await once(res,'drain');
    }
    res.end();
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const transfer=new PetTransfer(directory,{freshMs:60_000});
  const port=server.address().port;
  const ready=async (offset=0,revision='') => {
    let chunk;
    do { chunk=await transfer.chunk(port,'/packs/test/large.webp',offset,revision); if(chunk.state==='pending')await new Promise(r=>setTimeout(r,5)); } while(chunk.state==='pending');
    return chunk;
  };
  try {
    const pending=await Promise.all([transfer.chunk(port,'/packs/test/large.webp'), transfer.chunk(port,'/packs/test/large.webp')]);
    assert.ok(pending.every(c=>c.state==='pending'));
    const first=await ready(); const hash=createHash('sha256');
    for(let offset=0;offset<total;offset+=PET_CHUNK_BYTES) {
      const c=offset===0 ? first : await ready(offset,first.revision);
      const bytes=Buffer.from(c.data,'base64');
      assert.equal(bytes.length,Math.min(PET_CHUNK_BYTES,total-offset));
      assert.equal(createHash('sha256').update(bytes).digest('hex'),c.sha256); hash.update(bytes);
    }
    assert.equal(hash.digest('hex'),first.revision); assert.equal(hits,1);
    assert.equal((await ready(7*PET_CHUNK_BYTES,first.revision)).offset,7*PET_CHUNK_BYTES);
    await assert.rejects(ready(total+1,first.revision),/PET_TRANSFER_RANGE/);
    fill=91; for(const e of transfer.entries.values()) e.finished=0; const second=await ready();
    assert.notEqual(first.revision,second.revision);
    await assert.rejects(ready(PET_CHUNK_BYTES,first.revision),/PET_TRANSFER_CHANGED/);
    assert.equal(hits,2);
  } finally { await transfer.close(); server.closeAllConnections(); await new Promise(r=>server.close(r)); await rm(directory,{recursive:true,force:true}); }
});

test('truncated upstream never becomes a complete asset', async () => {
  const directory=await mkdtemp(join(tmpdir(),'pet-transfer-broken-'));
  const transfer=new PetTransfer(directory,{fetcher:async()=>new Response('short',{headers:{'content-length':'100'}})});
  try {
    assert.equal((await transfer.chunk(1,'/packs/t/a')).state,'pending');
    await Promise.all([...transfer.entries.values()].map(e=>e.task));
    await assert.rejects(transfer.chunk(1,'/packs/t/a'),/PET_TRANSFER_UNAVAILABLE/);
    await assert.rejects(transfer.chunk(1,'/api/state'),/PET_TRANSFER_PATH_INVALID/);
    await assert.rejects(transfer.chunk(1,'/packs/../secret'),/PET_PATH_INVALID/);
  } finally { await transfer.close(); await rm(directory,{recursive:true,force:true}); }
});

test('phone readiness waits through ongoing large transfer and terminates a stall', async () => {
  const code=readFileSync(new URL('./fixtures/pet-ready-budget.js',import.meta.url),'utf8');
  const ctx=vm.createContext({}); vm.runInContext(code,ctx);
  let tick,now=0,active=true,failures=0,cancelled=0;
  ctx.phoneReadyTimeout(()=>failures++,{now:()=>now,schedule:fn=>{tick=fn;return 1},cancel:()=>cancelled++,probe:async()=>({active})});
  for(let i=0;i<120;i++){now+=5000;await tick();} // Ten minutes still making progress.
  assert.equal(failures,0);
  active=false; now+=89_000; await tick(); assert.equal(failures,0);
  now+=1001; await tick(); assert.equal(failures,1); assert.equal(cancelled,1);
});

