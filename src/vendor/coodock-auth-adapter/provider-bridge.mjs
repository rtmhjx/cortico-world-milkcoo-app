import { AuthError } from './auth-sessions.mjs';

/**
 * The driver proves an authorization using the chosen protocol; exchange maps
 * it to credentials actually accepted by one or more service backends. URLs,
 * HTTP clients, login pages and authorization policy are supplied by the host.
 * begin() must return only public flow information, never service credentials.
 */
export function createProviderBridge({ id, title = id, driver, exchange } = {}) {
  if (typeof id !== 'string' || !id.trim()) throw new AuthError('AUTH_PROVIDER_ID_REQUIRED');
  const ready = driver?.state !== 'pending' && typeof driver?.begin === 'function'
    && typeof driver.complete === 'function' && typeof exchange === 'function';
  if (!ready) return { id, title, state: 'pending' };
  return {
    id, title, state: 'ready',
    async begin(input) { return driver.begin(structuredClone(input)); },
    async complete(input) {
      const authorization = await driver.complete(structuredClone(input));
      const result = await exchange({ serviceId: input.serviceId, authorization, input: structuredClone(input) });
      return Array.isArray(result) ? { sessions: result } : result;
    },
  };
}
