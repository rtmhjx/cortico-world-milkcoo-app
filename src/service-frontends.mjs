/** Transport adapters for preloaded native service UIs. No HTML page is loaded by this API. */
export class ServiceFrontends {
  constructor() { this.adapters = new Map(); }
  register(id, adapter) { this.adapters.set(id, adapter); return this; }
  async invoke(input) {
    const { serviceId, method, path, body, context = {} } = input ?? {};
    const adapter = this.adapters.get(serviceId);
    if (!adapter) return { status: 503, body: { error: 'SERVICE_FRONTEND_AWAITING_AUTHOR', serviceId } };
    if (!['GET', 'POST'].includes(method) || typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('://'))
      return { status: 400, body: { error: 'SERVICE_REQUEST_INVALID' } };
    const frame = { ...context, serviceId, operationId: input.operationId ?? null };
    return adapter.invoke({ method, path, body, context: frame });
  }
}

/** ins supplies a provider here; authentication remains independent of every service frontend. */
export function registerEcosystemProviders(sessions, context) {
  for (const provider of context.ecosystemAuthProviders ?? []) sessions.registerProvider(provider);
}

export const frontendManifest = Object.freeze({
  schemaVersion: 1,
  services: [
    { id: 'starpost', displayName: '星邮', world: { id: 'starpost' }, auth: { providerId: 'ins-identity', sessionKey: 'serviceId+issuer+subject+botId' },
      platforms: { android: { state: 'bundled', kind: 'native-activity', entrypoint: 'net.tina.mobile.starpost.StarpostActivity' }, ios: { state: 'planned', kind: 'native-scene' } } },
    { id: 'flower-town', displayName: '花语乡', world: { id: 'bloom' }, auth: { providerId: 'ins-identity', sessionKey: 'serviceId+issuer+subject+botId' },
      platforms: { android: { state: 'awaiting-upstream', kind: 'native-view', entrypoint: 'net.tina.mobile.FlowerTownFrontend' }, ios: { state: 'planned', kind: 'native-scene' } } },
    { id: 'bottle', displayName: '漂流瓶', world: { id: 'bottle' }, auth: { providerId: 'ins-identity', sessionKey: 'serviceId+issuer+subject+botId' },
      platforms: { android: { state: 'bundled', kind: 'native-view', entrypoint: 'net.tina.mobile.services.bottle.BottleFrontend' }, ios: { state: 'planned', kind: 'native-scene' } } },
  ],
});
