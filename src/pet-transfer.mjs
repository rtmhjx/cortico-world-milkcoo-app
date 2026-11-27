import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MobileError } from './store.mjs';
import { petResourcePath } from './pet-resources.mjs';

export const PET_CHUNK_BYTES = 1024 * 1024;

// The selected desktop-pet HTTP endpoint remains the sole authority. Never read
// another World's data directory. Spooling bounds RAM independently of pack size.
export class PetTransfer {
  constructor(directory, { fetcher = fetch, idleMs = 60_000, freshMs = 60_000 } = {}) {
    this.directory = directory; this.fetcher = fetcher; this.idleMs = idleMs; this.freshMs = freshMs;
    this.entries = new Map(); this.closed = false;
  }
  async chunk(port, name, offset = 0, revision = '') {
    const path = petResourcePath(name);
    if (!path.startsWith('/packs/') && !path.startsWith('/web/')) throw new MobileError('PET_TRANSFER_PATH_INVALID');
    if (!Number.isSafeInteger(offset) || offset < 0 || (revision && !/^[a-f0-9]{64}$/.test(revision))) throw new MobileError('PET_TRANSFER_INVALID');
    if (this.closed) throw new MobileError('PET_TRANSFER_CLOSED', 503);
    const key = `${port}:${path}`;
    let entry = this.entries.get(key);
    if (!entry || (!revision && entry.state !== 'pending' && Date.now() - entry.finished > this.freshMs)) {
      const previous = entry;
      entry = { state: 'pending', received: 0, controller: new AbortController() };
      this.entries.set(key, entry);
      entry.task = this.prepare(entry, port, path).then(async () => {
        if (previous?.file) await rm(previous.file, { force: true }).catch(() => {});
      }).catch(() => {
        entry.state = 'failed'; entry.finished = Date.now();
      });
    }
    if (entry.state === 'pending') return { transfer: 1, state: 'pending', received: entry.received };
    if (entry.state === 'failed') throw new MobileError('PET_TRANSFER_UNAVAILABLE', 503);
    if (revision && revision !== entry.revision) throw new MobileError('PET_TRANSFER_CHANGED', 409);
    if (offset > entry.total) throw new MobileError('PET_TRANSFER_RANGE', 416);
    const handle = await open(entry.file, 'r');
    try {
      const bytes = Buffer.alloc(Math.min(PET_CHUNK_BYTES, entry.total - offset));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
      if (bytesRead !== bytes.length) throw new MobileError('PET_TRANSFER_TRUNCATED', 503);
      return { transfer: 1, state: 'ready', offset, total: entry.total, revision: entry.revision,
        mime: entry.mime, sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64') };
    } finally { await handle.close(); }
  }
  async prepare(entry, port, path) {
    await mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, `${randomUUID()}.part`);
    let timer;
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => entry.controller.abort(), this.idleMs); timer.unref?.(); };
    let handle;
    try {
      touch();
      const response = await this.fetcher(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', signal: entry.controller.signal });
      if (!response.ok) throw new Error('upstream unavailable');
      const digest = createHash('sha256');
      handle = await open(temporary, 'wx');
      for await (const block of response.body) {
        touch(); digest.update(block);
        // FileHandle.write may write fewer bytes than requested.
        let position = 0;
        while (position < block.length) position += (await handle.write(block, position, block.length - position)).bytesWritten;
        entry.received += block.length;
      }
      const declared = response.headers.get('content-length');
      if (declared !== null && !response.headers.get('content-encoding') && Number(declared) !== entry.received) throw new Error('truncated');
      await handle.close(); handle = null;
      entry.revision = digest.digest('hex'); entry.total = entry.received;
      entry.mime = response.headers.get('content-type') || 'application/octet-stream';
      entry.file = temporary.replace(/\.part$/, '.asset');
      await rename(temporary, entry.file);
      entry.finished = Date.now(); entry.state = 'ready';
    } finally { clearTimeout(timer); await handle?.close(); await rm(temporary, { force: true }); }
  }
  async close() {
    this.closed = true;
    for (const entry of this.entries.values()) entry.controller.abort();
    await Promise.allSettled([...this.entries.values()].map(e => e.task));
    await Promise.all([...this.entries.values()].filter(e => e.file).map(e => rm(e.file, { force: true })));
    this.entries.clear();
  }
}
