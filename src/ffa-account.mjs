import { MobileError } from './store.mjs';

export function createCooDockFfaAccount(hostServices) {
  const capability = hostServices?.get('ffa-hub.login');
  if (!capability) return null;
  let serviceSession = null;

  async function refresh() {
    const identity = await capability.identity();
    if (identity.status !== 'ready') {
      serviceSession = null;
      return identity;
    }
    const service = await capability.signIn();
    serviceSession = service.status === 'ready' ? service.session : null;
    return { ...identity, serviceStatus: service.status, businessId: serviceSession?.businessId,
      ...(service.accounts ? { businessAccounts: service.accounts } : {}) };
  }

  return {
    canManage: Boolean(capability.interactive), refresh,
    serviceSession: () => serviceSession,
    async control(action, businessId) {
      if (action === 'status') return refresh();
      const owner = capability.interactive;
      if (!owner) throw new MobileError('FFA_HOST_LOGIN_OWNER_REQUIRED', 403);
      if (action === 'begin') return owner.begin();
      if (action === 'complete') {
        const result = await owner.complete();
        return result.status === 'ready' ? refresh() : result;
      }
      if (action === 'logout') {
        await owner.logout();
        return refresh();
      }
      if (action === 'choose') {
        owner.chooseBusinessAccount(businessId);
        return refresh();
      }
      throw new MobileError('FFA_HOST_LOGIN_ACTION_UNKNOWN', 400);
    },
  };
}
