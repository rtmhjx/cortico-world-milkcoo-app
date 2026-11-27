// An APK Signature Block can contain unknown ID/value pairs without changing
// the v2/v3 app signature. This data is NOT covered by that signature.
// Keep personalized APKs private: the payload contains a connection credential.
const ID = 0x54434f4f;
const MAGIC = Buffer.from('APK Sig Block 42');

function starpostBootstrap(input) {
  const origin = value => typeof value === 'string' && /^https:\/\/[a-z0-9.-]+(?::[1-9]\d{0,4})?$/i.test(value);
  if (input.app !== 'starpost' || !origin(input.hubIssuer) || !origin(input.starpostOrigin)
      || !/^\d{5,12}$/.test(input.botId ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(input.pairTicket ?? '')) throw new Error('STARPOST_BOOTSTRAP_INVALID');
  const hint = input.lanHint;
  const lanHint = hint ? { endpoints: Array.isArray(hint.endpoints) ? hint.endpoints.filter(origin).slice(0, 8) : [],
    installationId: String(hint.installationId ?? '').slice(0, 128), serverFingerprint: String(hint.serverFingerprint ?? '').slice(0, 64) } : undefined;
  return { v: 2, app: 'starpost', hubIssuer: input.hubIssuer, starpostOrigin: input.starpostOrigin,
    botId: input.botId, botName: String(input.botName ?? input.botId).slice(0, 100), autoEnableCooDock: true, pairTicket: input.pairTicket,
    ...(lanHint ? { lanHint } : {}) };
}

function eocdOffset(apk) {
  for (let i = apk.length - 22; i >= Math.max(0, apk.length - 22 - 65535); i--) {
    if (apk.readUInt32LE(i) === 0x06054b50 && i + 22 + apk.readUInt16LE(i + 20) === apk.length) return i;
  }
  throw new Error('APK_EOCD_NOT_FOUND');
}

export function addBootstrap(apk, connection) {
  if (!Buffer.isBuffer(apk)) throw new Error('APK_BUFFER_REQUIRED');
  const eocd = eocdOffset(apk);
  const central = apk.readUInt32LE(eocd + 16);
  if (central < 32 || central > eocd || !apk.subarray(central - 16, central).equals(MAGIC)) throw new Error('APK_SIGNING_BLOCK_REQUIRED');
  const size = Number(apk.readBigUInt64LE(central - 24));
  const start = central - size - 8;
  if (size < 24 || start < 0 || size > 16 * 1024 * 1024 || Number(apk.readBigUInt64LE(start)) !== size) throw new Error('APK_SIGNING_BLOCK_INVALID');
  const entries = [];
  for (let offset = start + 8; offset < central - 24;) {
    if (offset + 8 > central - 24) throw new Error('APK_SIGNING_ENTRY_INVALID');
    const length = Number(apk.readBigUInt64LE(offset));
    if (length < 4 || offset + 8 + length > central - 24) throw new Error('APK_SIGNING_ENTRY_INVALID');
    if (apk.readUInt32LE(offset + 8) !== ID) entries.push(apk.subarray(offset, offset + 8 + length));
    offset += 8 + length;
  }
  const payload = connection.v === 2 ? starpostBootstrap(connection) : {
    v: 1,
    endpoint: connection.endpoint,
    ...(connection.lanEndpoint ? { lanEndpoint: connection.lanEndpoint } : {}),
    ...(connection.hostLabel ? { hostLabel: connection.hostLabel } : {}),
    ...(connection.botName ? { botName: connection.botName } : {}),
    ...(connection.relay !== undefined ? { relay: connection.relay } : {}),
    ...(connection.token !== undefined ? { token: connection.token } : {}),
    ...(connection.pairCode !== undefined ? { pairCode: connection.pairCode } : {}),
    ...(connection.consoleUiUrl ? { consoleUiUrl: connection.consoleUiUrl } : {}),
    ...(connection.memoryUrl ? { memoryUrl: connection.memoryUrl } : {}),
    ...(connection.botId ? { botId: connection.botId } : {}),
    ...(Array.isArray(connection.preloadedWorlds) ? { preloadedWorlds: connection.preloadedWorlds } : {}),
    ...(connection.ecosystem ? { ecosystem: connection.ecosystem } : {}),
  };
  const value = Buffer.from(JSON.stringify(payload), 'utf8');
  if (value.length > 8192) throw new Error('BOOTSTRAP_TOO_LARGE');
  const entry = Buffer.alloc(12 + value.length);
  entry.writeBigUInt64LE(BigInt(4 + value.length)); entry.writeUInt32LE(ID, 8); value.copy(entry, 12);
  entries.push(entry);
  const newSize = entries.reduce((n, part) => n + part.length, 0) + 24;
  const header = Buffer.alloc(8), footer = Buffer.alloc(8);
  header.writeBigUInt64LE(BigInt(newSize)); footer.writeBigUInt64LE(BigInt(newSize));
  const block = Buffer.concat([header, ...entries, footer, MAGIC]);
  const out = Buffer.concat([apk.subarray(0, start), block, apk.subarray(central)]);
  const newCentral = start + block.length;
  if (newCentral > 0xffffffff) throw new Error('APK_TOO_LARGE');
  out.writeUInt32LE(newCentral, eocd + newCentral - central + 16);
  return out;
}
