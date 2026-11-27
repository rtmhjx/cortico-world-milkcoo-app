import assert from 'node:assert/strict';
export function readBootstrap(apk) {
  let eocd = -1;
  for (let offset = apk.length - 22; offset >= Math.max(0, apk.length - 65557); offset--) {
    if (apk.readUInt32LE(offset) === 0x06054b50 && offset + 22 + apk.readUInt16LE(offset + 20) === apk.length) {
      eocd = offset; break;
    }
  }
  assert.notEqual(eocd, -1);
  const central = apk.readUInt32LE(eocd + 16), size = Number(apk.readBigUInt64LE(central - 24));
  assert.equal(apk.subarray(central - 16, central).toString(), 'APK Sig Block 42');
  for (let offset = central - size; offset < central - 24;) {
    const length = Number(apk.readBigUInt64LE(offset));
    if (apk.readUInt32LE(offset + 8) === 0x54434f4f) return JSON.parse(apk.subarray(offset + 12, offset + 8 + length));
    offset += 8 + length;
  }
  assert.fail('Printed APK did not contain the CooDock bootstrap');
}

