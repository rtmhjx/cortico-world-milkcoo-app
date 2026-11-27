import { createCooDockFfaAccount } from './ffa-account.mjs';
import { createFfaHostLogin } from './ffa-host-login.mjs';
import { ffaTransport } from './ffa-transport.mjs';

const sessionKey = 'MILKCOO_FFA_HOST_SESSION';
const worldId = 'milkcoo-app';

export function createStandaloneFfaAccount(context, fetchImpl = fetch) {
  if (typeof context.secret !== 'function' || typeof context.storeSecret !== 'function') return null;

  const authority = createFfaHostLogin({
    issuer: 'https://ffahub.net',
    worlds: { [worldId]: 'coodock' },
    interactiveWorld: worldId,
    hostLabel: 'Tina · CooDock',
    fetcher: (url, options) => fetchImpl(ffaTransport(url), options),
    credentialStore: {
      load() {
        const saved = context.secret(sessionKey);
        if (!saved || saved === 'none') return null;
        try { return JSON.parse(Buffer.from(saved, 'base64url').toString('utf8')); }
        catch { return null; }
      },
      save(session) {
        context.storeSecret(sessionKey, session
          ? Buffer.from(JSON.stringify(session)).toString('base64url')
          : 'none');
      },
    },
  });
  const account = createCooDockFfaAccount(authority.forWorld(worldId));
  return {
    ...account,
    async control(action, businessId) {
      const result = await account.control(action, businessId);
      return action === 'begin'
        ? { ...result, authorizationUrl: ffaTransport(result.authorizationUrl) }
        : result;
    },
  };
}
