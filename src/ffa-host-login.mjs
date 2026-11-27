import { createHash, randomBytes } from 'node:crypto';

export const FFA_HOST_LOGIN = 'ffa-hub.login';

export function createFfaHostLogin({ issuer, worlds, fetcher = fetch, credentialStore, interactiveWorld, hostLabel }) {
  const hub = new URL(issuer);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(hub.hostname);
  if ((hub.protocol !== 'https:' && !(loopback && hub.protocol === 'http:')) || hub.username || hub.password || hub.search || hub.hash) {
    throw new TypeError('Invalid FFA Hub issuer');
  }
  const endpoint = hub.href.replace(/\/$/, '');
  const bindings = new Map(Object.entries(worlds));
  const audiences = new Set(bindings.values());
  if (audiences.size !== bindings.size || [...audiences].some(value => typeof value !== 'string' || !value.trim())) {
    throw new TypeError('Each World must have a distinct registered FFA Hub service');
  }
  if (interactiveWorld && (!bindings.has(interactiveWorld) || typeof hostLabel !== 'string' || !hostLabel.trim())) {
    throw new TypeError('A registered login World and host name are required');
  }
  if (credentialStore && (typeof credentialStore.load !== 'function' || typeof credentialStore.save !== 'function')) {
    throw new TypeError('The host credential store must support load and save');
  }
  let pending = null;
  let current = null;
  const exchanges = new Map();
  const saved = credentialStore?.load();
  if (saved?.version === 1 && saved.issuer === endpoint && typeof saved.subject === 'string' &&
      typeof saved.verifier === 'string' && /^[A-Za-z0-9_-]{43}$/.test(saved.verifier)) {
    const accounts = Object.entries(saved.businessAccounts ?? {}).filter(([service, id]) => audiences.has(service) && typeof id === 'string');
    current = { verifier: saved.verifier, subject: saved.subject, businessAccounts: new Map(accounts) };
  }

  function save(session) {
    credentialStore?.save(session && { version: 1, issuer: endpoint, verifier: session.verifier,
      subject: session.subject, businessAccounts: Object.fromEntries(session.businessAccounts) });
  }

  async function request(action, body = {}, verifier) {
    const headers = { 'content-type': 'application/json' };
    if (verifier) headers.authorization = `Bearer ${verifier}`;
    const response = await fetcher(`${endpoint}/v1/host-login/${action}`, {
      method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(8_000),
    });
    const out = await response.json();
    if (response.status === 401 && out.error === 'login_required') return { status: 'login_required' };
    if (!response.ok || !out.ok) throw new Error(`FFA Hub host login failed (${response.status})`);
    return out.result;
  }

  function publicIdentity(result) {
    return result.status === 'ready'
      ? { status: 'ready', issuer: result.issuer, subject: result.subject, displayName: result.displayName, expiresAt: result.expiresAt }
      : { status: result.status };
  }

  async function identify() {
    const session = current;
    if (!session) return { status: 'login_required' };
    const result = await request('identity', {}, session.verifier);
    if (current?.verifier !== session.verifier) return { status: 'login_required' };
    return publicIdentity(result);
  }

  async function exchange(service) {
    const session = current;
    if (!session) return { status: 'login_required' };
    const businessId = session.businessAccounts.get(service);
    const result = await request('acquire', { service, businessId }, session.verifier);
    if (current?.verifier !== session.verifier) return { status: 'login_required' };
    if (current.businessAccounts.get(service) !== businessId) return { status: 'business_account_changed' };
    if (result.status === 'ready' && (result.session?.audience !== service || result.session?.issuer !== endpoint ||
        result.session?.subject !== session.subject || result.session?.scope !== 'login')) {
      throw new Error('FFA Hub returned a mismatched service session');
    }
    return result;
  }

  async function signIn(service) {
    const previous = exchanges.get(service) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => exchange(service));
    exchanges.set(service, next);
    try { return await next; }
    finally { if (exchanges.get(service) === next) exchanges.delete(service); }
  }

  function forWorld(worldId) {
    const service = bindings.get(worldId);
    if (!service) return undefined;
    const interactive = worldId === interactiveWorld ? Object.freeze({
      begin: () => authority.begin(hostLabel), complete: () => authority.complete(), logout: () => authority.logout(),
      chooseBusinessAccount: businessId => authority.chooseBusinessAccount(worldId, businessId),
    }) : undefined;
    const login = Object.freeze({ identity: identify, signIn: () => signIn(service), ...(interactive ? { interactive } : {}) });
    return Object.freeze({ get: name => name === FFA_HOST_LOGIN ? login : undefined });
  }

  const authority = Object.freeze({
    forWorld,
    async begin(label) {
      const verifier = randomBytes(32).toString('base64url');
      const requestState = { verifier };
      pending = requestState;
      const challenge = createHash('sha256').update(verifier).digest('hex');
      const flow = await request('begin', { label, challenge });
      const destination = new URL(flow.authorizationUrl);
      if (pending !== requestState) throw new Error('Host account changed during login');
      if (destination.origin !== hub.origin || destination.pathname !== `${hub.pathname.replace(/\/$/, '')}/` ||
          destination.searchParams.get('hostLogin') !== flow.hostLoginId) throw new Error('Unexpected FFA Hub login address');
      return flow;
    },
    async complete() {
      const next = pending;
      if (!next) return identify();
      const result = await request('identity', {}, next.verifier);
      if (pending !== next) return { status: 'login_required' };
      if (result.status === 'ready') {
        const previous = current;
        if (previous) await request('logout', {}, previous.verifier);
        if (pending !== next) return { status: 'login_required' };
        const authorized = { verifier: next.verifier, subject: result.subject, businessAccounts: new Map() };
        save(authorized);
        current = authorized;
        pending = null;
      }
      return publicIdentity(result);
    },
    chooseBusinessAccount(worldId, businessId) {
      const service = bindings.get(worldId);
      if (!current || !service || typeof businessId !== 'string' || !businessId || businessId.length > 128) {
        throw new TypeError('Invalid World business account choice');
      }
      const chosen = { ...current, businessAccounts: new Map(current.businessAccounts).set(service, businessId) };
      save(chosen);
      current = chosen;
    },
    async logout() {
      const previous = current;
      if (previous) await request('logout', {}, previous.verifier);
      if (current?.verifier === previous?.verifier) {
        current = null;
        pending = null;
        save(null);
      }
    },
  });
  return authority;
}
