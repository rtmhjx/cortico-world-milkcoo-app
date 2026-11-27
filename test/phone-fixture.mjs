import { dockTool } from './dock-tool-fixture.mjs';
// Isolated Android acceptance fixture: echoes only the synthetic media it receives.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TinaMobileWorld } from '../src/world.mjs';
const dir = mkdtempSync(join(tmpdir(),'coo-phone-fixture-'));
const events = [], blobs = new Map();
let world;
const host = {
  store: { latestCursor: () => events.at(-1)?.cursor ?? 0,
    range: q => events.filter(e => (q.source === undefined || e.source === q.source) && (q.senderKey === undefined || e.senderKey === q.senderKey)
      && (q.fromCursor === undefined || e.cursor >= q.fromCursor) && (q.toCursor === undefined || e.cursor <= q.toCursor)).slice(-(q.limit ?? events.length)) },
  blob: handle => blobs.get(handle) ?? null,
  async pushEvent(event) {
    const result = {...event,cursor:events.length+1}; events.push(result);
    if (event.blobs?.length) {
      const handle = `mem:fixture:${event.senderKey}`, attachment = event.blobs[0];
      blobs.set(handle,{bytes:attachment.bytes,mime:attachment.mime});
      setTimeout(async () => {
        const tool=dockTool(world, 'reply');
        await tool.handler({device_id:event.meta.device_id,in_reply_to:event.meta.message_id,handle,text:'[测试回显]'}, {role:'fixture',callId:`fixture-${event.senderKey}`});
      },30);
    }
    return result;
  },
};
world = new TinaMobileWorld({cfg:{host:'127.0.0.1',port:0,tokenSecret:'TEST'},dataDir:dir,botDir:dir,secret:()=> 'fixture-only'});
await world.start(host);
console.log(JSON.stringify({port:world.address().port,fixture:true}));
process.on('SIGINT',async()=>{await world.stop();process.exit(0);});
