import { AuthSessions, AuthError as EcosystemError } from './vendor/coodock-auth-adapter/index.mjs';
export { EcosystemError };
export { createProviderBridge } from './vendor/coodock-auth-adapter/index.mjs';

export const ECOSYSTEM_VERSION = 1;
export const ECOSYSTEM_SECRET = 'COODOCK_ECOSYSTEM_SESSIONS_V1';
export const DEFAULT_SERVICE_CATALOG = Object.freeze([
  Object.freeze({ id: 'starpost', title: '星邮', description: '私聊、群聊与人机交互', worldId: 'starpost', authProvider: 'ins-identity' }),
Object.freeze({ id: 'flower-town', title: '花语乡', description: '小镇、场景与活动', worldId: 'bloom', authProvider: 'ins-identity' }),
  Object.freeze({ id: 'bottle', title: '漂流瓶', description: '海边信箱、捞瓶与回信', worldId: 'bottle', authProvider: 'ins-identity' }),
]);

/** Compatibility facade: the host owns Core secrets, catalog and HTTP routes. */
export class EcosystemSessions extends AuthSessions {
  constructor({ context = {}, services = DEFAULT_SERVICE_CATALOG, providers = [],
    now = () => Date.now(), ticketLifetimeMs = 15 * 60_000 } = {}) {
    super({
      storage: {
        read: typeof context.secret === 'function' ? key => context.secret(key) : undefined,
        write: typeof context.storeSecret === 'function' ? (key, value) => context.storeSecret(key, value) : undefined,
      },
      storageKey: ECOSYSTEM_SECRET, services,
      defaultProviderId: 'ins-identity',
      providers: [{ id: 'ins-identity', title: '共同账号 · 等待星邮接入', state: 'pending' }, ...providers],
      handoffEndpoint: '/v1/ecosystem/handoff', errorPrefix: 'ECOSYSTEM', now, ticketLifetimeMs,
    });
    this.context = context;
  }
}

/** Authentication stays at the existing World HTTP boundary. No public route is added here. */
export async function dispatchEcosystemRequest(memory, method, pathname, input = {}) {
  const route = {
    'GET /v1/ecosystem': 'catalog',
    'GET /v1/ecosystem/sessions': 'sessions',
    'POST /v1/ecosystem/login': 'login',
    'POST /v1/ecosystem/select': 'selectSession',
    'POST /v1/ecosystem/logout': 'logout',
    'POST /v1/ecosystem/handoff': 'consumeHandoff',
  }[`${method} ${pathname}`];
  if (!route) return null;
  try { return { status: 200, body: await memory.invoke(route, input) }; }
  catch (error) {
    if (!(error instanceof EcosystemError)) throw error;
    return { status: error.status, body: { error: error.message } };
  }
}
