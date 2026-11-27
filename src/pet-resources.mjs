import { MobileError } from './store.mjs';

// Read-only access to the selected Coo pet instance. This is the figure code and
// its resources, never a desktop screenshot and never the pet's control API.
export function petResourcePath(name) {
  if (typeof name !== 'string' || name.length > 2048 || !name.startsWith('/') || name.includes('\\') || name.includes('\0')) throw new MobileError('PET_PATH_INVALID');
  let decoded;
  try { decoded = decodeURIComponent(name); } catch { throw new MobileError('PET_PATH_INVALID'); }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.includes('?') || decoded.includes('#') || decoded.includes('%') || decoded.split('/').some(part => part === '..' || part === '.')) throw new MobileError('PET_PATH_INVALID');
  if (!(['/pet', '/figure-frame', '/api/state', '/api/figures', '/api/avatar'].includes(decoded) || decoded.startsWith('/web/') || decoded.startsWith('/packs/'))) throw new MobileError('PET_PATH_NOT_AVAILABLE', 404);
  return decoded.split('/').map(encodeURIComponent).join('/');
}

export async function readPetResource(port, name) {
  const encoded = petResourcePath(name);
  let response;
  try { response = await fetch(`http://127.0.0.1:${port}${encoded}`, { redirect: 'manual', signal: AbortSignal.timeout(5000) }); }
  catch { throw new MobileError('PET_INSTANCE_UNAVAILABLE', 503); }
  if (!response.ok) throw new MobileError('PET_RESOURCE_NOT_FOUND', response.status === 404 ? 404 : 502);
  const max = 16 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > max) throw new MobileError('PET_RESOURCE_TOO_LARGE', 413);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) throw new MobileError('PET_RESOURCE_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  return { bytes: Buffer.concat(chunks), mime: response.headers.get('content-type') ?? 'application/octet-stream' };
}

/** Apply only the shared switches explicitly offered by the phone pet menu. */
export async function writePetPreferences(port, value) {
  const valid = value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length > 0 && Object.keys(value).every(k => k === 'theme' || k === 'sound')
    && (!('theme' in value) || ['dark', 'light'].includes(value.theme))
    && (!('sound' in value) || typeof value.sound === 'boolean');
  if (!valid) throw new MobileError('PET_PREFS_INVALID');
  let response;
  try { response = await fetch(`http://127.0.0.1:${port}/api/prefs`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(5000) }); }
  catch { throw new MobileError('PET_INSTANCE_UNAVAILABLE', 503); }
  if (!response.ok) throw new MobileError('PET_PREFS_UNAVAILABLE', 502);
  return { ok: true };
}
