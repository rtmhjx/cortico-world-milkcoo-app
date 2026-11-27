import { createHash, randomBytes } from 'node:crypto';

export const AUTH_VERSION = 1;
const clone = value => structuredClone(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class AuthError extends Error {
  constructor(code, status = 400) { super(code); this.status = status; }
}

export function authSessionKey(session) {
  // Preserve existing four-field records and active pointers byte-for-byte.
  const fields = [session.serviceId, session.issuer, session.subject, session.botId ?? ''];
  if (session.principalType !== undefined || session.installationId !== undefined)
    fields.push(session.principalType ?? '', session.installationId ?? '');
  return JSON.stringify(fields);
}

function publicSession(session, active, now) {
  const result = {
    serviceId: session.serviceId, issuer: session.issuer, subject: session.subject,
    providerId: session.providerId,
    mode: session.providerId === 'legacy' ? 'per-service' : 'provider',
    updatedAt: session.updatedAt,
    active, state: session.expiresAt && session.expiresAt <= now ? 'expired' : 'connected',
  };
  for (const name of ['botId', 'displayName', 'serviceSubject', 'expiresAt',
    'principalType', 'installationId', 'scopes', 'audience']) {
    if (session[name] !== undefined) result[name] = clone(session[name]);
  }
  return result;
}

/**
 * No identity server or network transport is implemented here. The host supplies
 * synchronous, atomic read/write storage and verified provider/service drivers.
 * Public catalog/login receipts omit credentials; handoff redemption is private
 * and must be exposed only through an authenticated host-owned transport.
 */
export class AuthSessions {
  constructor({ storage = {}, storageKey = 'AUTH_SESSIONS_V1', services = [], providers = [],
    defaultProviderId, handoffEndpoint, now = () => Date.now(), ticketLifetimeMs = 15 * 60_000,
    errorPrefix = 'AUTH' } = {}) {
    this.storage = storage;
    this.storageKey = storageKey;
    this.defaultProviderId = defaultProviderId;
    this.handoffEndpoint = handoffEndpoint;
    this.errorPrefix = errorPrefix;
    this.now = now;
    this.ticketLifetimeMs = ticketLifetimeMs;
    this.services = new Map(services.map(service => [service.id, clone(service)]));
    this.providers = new Map();
    this.tickets = new Map();
    this.state = { version: AUTH_VERSION, sessions: [], active: {} };
    this.storageState = typeof storage.write === 'function' ? 'ready' : 'read-only';
    if (defaultProviderId) this.registerProvider({ id: defaultProviderId, state: 'pending' });
    for (const provider of providers) this.registerProvider(provider);
    const saved = storage.read?.(storageKey);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.version !== AUTH_VERSION || !Array.isArray(parsed.sessions) || !record(parsed.active)) throw new Error();
        for (const item of parsed.sessions) this.normalizeSession(item);
        this.state = parsed;
      } catch { this.storageState = 'invalid'; }
    }
  }

  error(code, status = 400) { return new AuthError(`${this.errorPrefix}_${code}`, status); }
  text(value, name) {
    if (typeof value !== 'string' || !value.trim()) throw this.error(`${name}_REQUIRED`);
    return value;
  }

  requireService(id) {
    if (!this.services.has(id)) throw this.error('SERVICE_UNKNOWN', 404);
    return this.services.get(id);
  }

  registerProvider(provider) {
    const id = this.text(provider?.id, 'PROVIDER_ID');
    if (id === 'legacy') throw this.error('PROVIDER_RESERVED');
    this.providers.set(id, provider);
    return this;
  }

  providerInfo(provider) {
    const ready = provider.state !== 'pending' && typeof provider.begin === 'function' && typeof provider.complete === 'function';
    return { id: provider.id, title: provider.title ?? provider.id, state: ready ? 'ready' : 'pending' };
  }

  normalizeSession(input) {
    if (!record(input)) throw this.error('SESSION_REQUIRED');
    this.requireService(input.serviceId);
    const normalized = {
      serviceId: input.serviceId,
      issuer: this.text(input.issuer, 'ISSUER'),
      subject: this.text(input.subject, 'SUBJECT'),
      providerId: input.providerId ?? 'legacy',
      credential: clone(input.credential),
      updatedAt: input.updatedAt ?? this.now(),
      ...(input.botId ? { botId: this.text(input.botId, 'BOT_ID') } : {}),
      ...(input.displayName ? { displayName: this.text(input.displayName, 'DISPLAY_NAME') } : {}),
      ...(input.serviceSubject ? { serviceSubject: this.text(input.serviceSubject, 'SERVICE_SUBJECT') } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
    if (!record(normalized.credential) || !Object.keys(normalized.credential).length)
      throw this.error('CREDENTIAL_REQUIRED');
    if (normalized.expiresAt !== undefined && (!Number.isFinite(normalized.expiresAt) || normalized.expiresAt <= 0))
      throw this.error('EXPIRY_INVALID');
    if (input.principalType !== undefined) {
      if (!['human', 'bot'].includes(input.principalType)) throw this.error('PRINCIPAL_TYPE_INVALID');
      normalized.principalType = input.principalType;
    }
    if (input.installationId !== undefined) normalized.installationId = this.text(input.installationId, 'INSTALLATION_ID');
    if (input.scopes !== undefined) {
      if (!Array.isArray(input.scopes) || input.scopes.some(value => typeof value !== 'string' || !value.trim()))
        throw this.error('SCOPES_INVALID');
      normalized.scopes = clone(input.scopes);
    }
    if (input.audience !== undefined) {
      if (typeof input.audience === 'string') normalized.audience = this.text(input.audience, 'AUDIENCE');
      else if (Array.isArray(input.audience) && input.audience.length
        && input.audience.every(value => typeof value === 'string' && value.trim())) normalized.audience = clone(input.audience);
      else throw this.error('AUDIENCE_INVALID');
    }
    return normalized;
  }

  save(next) {
    if (this.storageState === 'invalid') throw this.error('STORAGE_INVALID', 409);
    if (typeof this.storage.write !== 'function') throw this.error('STORAGE_UNAVAILABLE', 503);
    const value = JSON.stringify(next);
    this.storage.write(this.storageKey, value);
    if (this.storage.read?.(this.storageKey) !== value) throw this.error('STORAGE_READBACK_FAILED', 503);
    this.state = next;
  }

  sessions(serviceId) {
    if (serviceId) this.requireService(serviceId);
    return this.state.sessions.filter(item => !serviceId || item.serviceId === serviceId)
      .map(item => publicSession(item, this.state.active[item.serviceId] === authSessionKey(item), this.now()));
  }

  catalog() {
    const sessions = this.sessions();
    return {
      version: AUTH_VERSION, storage: this.storageState,
      providers: [...this.providers.values()].map(provider => this.providerInfo(provider)),
      services: [...this.services.values()].map(service => {
        const accounts = sessions.filter(item => item.serviceId === service.id);
        return { ...clone(service), authState: accounts.some(item => item.active && item.state === 'connected') ? 'connected' : 'signed-out', accounts };
      }),
    };
  }

  adoptSession(input, { active = true } = {}) {
    const session = this.normalizeSession(input), key = authSessionKey(session);
    const next = clone(this.state);
    next.sessions = next.sessions.filter(item => authSessionKey(item) !== key);
    next.sessions.push(session);
    if (active) next.active[session.serviceId] = key;
    this.save(next);
    return publicSession(session, next.active[session.serviceId] === key, this.now());
  }

  selectSession(input) {
    this.requireService(input.serviceId);
    const key = authSessionKey(input);
    if (!this.state.sessions.some(item => authSessionKey(item) === key)) throw this.error('SESSION_UNKNOWN', 404);
    const next = clone(this.state);
    next.active[input.serviceId] = key;
    this.save(next);
    return this.sessions(input.serviceId);
  }

  logout({ serviceId, issuer, subject, botId, principalType, installationId } = {}) {
    this.requireService(serviceId);
    const next = clone(this.state);
    const matches = item => item.serviceId === serviceId
      && (issuer === undefined || item.issuer === issuer)
      && (subject === undefined || item.subject === subject)
      && (botId === undefined || item.botId === botId)
      && (principalType === undefined || item.principalType === principalType)
      && (installationId === undefined || item.installationId === installationId);
    next.sessions = next.sessions.filter(item => !matches(item));
    if (!next.sessions.some(item => authSessionKey(item) === next.active[serviceId])) delete next.active[serviceId];
    this.save(next);
    for (const [key, ticket] of this.tickets) if (ticket.serviceIds.includes(serviceId)) this.tickets.delete(key);
    return { serviceId, state: 'signed-out', accounts: this.sessions(serviceId) };
  }

  async login({ action = 'begin', providerId = this.defaultProviderId, serviceId, ...input } = {}) {
    if (serviceId) this.requireService(serviceId);
    const provider = this.providers.get(providerId);
    if (!provider) throw this.error('PROVIDER_UNKNOWN', 404);
    if (this.providerInfo(provider).state !== 'ready') throw this.error('PROVIDER_PENDING', 409);
    if (action === 'begin') return { providerId, ...await provider.begin({ serviceId, ...input }) };
    if (action !== 'complete') throw this.error('LOGIN_ACTION_INVALID');
    const result = await provider.complete({ serviceId, ...input });
    if (!Array.isArray(result?.sessions) || !result.sessions.length) throw this.error('PROVIDER_NO_SESSION', 502);
    const serviceStates = Array.isArray(result.serviceStates) ? result.serviceStates.map(item => {
      this.requireService(item?.serviceId);
      if (!['connected', 'pending', 'failed'].includes(item.state)) throw this.error('PROVIDER_STATUS_INVALID');
      return { serviceId: item.serviceId, state: item.state,
        ...(typeof item.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(item.code) ? { code: item.code } : {}) };
    }) : null;
    const sessions = result.sessions.map(item => this.normalizeSession({ ...item, providerId }));
    const next = clone(this.state);
    for (const session of sessions) {
      const key = authSessionKey(session);
      next.sessions = next.sessions.filter(item => authSessionKey(item) !== key);
      next.sessions.push(session);
      next.active[session.serviceId] = key;
    }
    this.save(next);
    return { providerId, state: serviceStates?.some(item => item.state !== 'connected') ? 'partial' : 'connected',
      ...(serviceStates ? { serviceStates } : {}),
      sessions: sessions.map(item => publicSession(item, next.active[item.serviceId] === authSessionKey(item), this.now())) };
  }

  createBootstrapHandoff({ serviceIds = [...this.services.keys()], deviceId } = {}) {
    serviceIds.forEach(id => this.requireService(id));
    if (deviceId !== undefined) this.text(deviceId, 'DEVICE_ID');
    for (const [key, item] of this.tickets) if (item.expiresAt <= this.now()) this.tickets.delete(key);
    const selected = this.state.sessions.filter(item => serviceIds.includes(item.serviceId)
      && this.state.active[item.serviceId] === authSessionKey(item) && (!item.expiresAt || item.expiresAt > this.now()));
    if (!selected.length) return null;
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ticketLifetimeMs;
    this.tickets.set(digest(ticket), { expiresAt, deviceId, serviceIds: [...new Set(serviceIds)],
      keys: selected.map(authSessionKey), consumed: false });
    return { ...(this.handoffEndpoint ? { endpoint: this.handoffEndpoint } : {}), ticket, expiresAt, ...(deviceId ? { deviceId } : {}) };
  }

  consumeHandoff({ ticket, deviceId, operationId } = {}) {
    this.text(deviceId, 'DEVICE_ID');
    this.text(operationId, 'OPERATION_ID');
    const entry = typeof ticket === 'string' ? this.tickets.get(digest(ticket)) : null;
    if (!entry || entry.expiresAt <= this.now()) throw this.error('HANDOFF_INVALID_OR_EXPIRED', 410);
    if (entry.deviceId && entry.deviceId !== deviceId) throw this.error('HANDOFF_DEVICE_MISMATCH', 409);
    if (entry.consumed) {
      if (entry.deviceId !== deviceId || entry.operationId !== operationId) throw this.error('HANDOFF_ALREADY_CONSUMED', 409);
      return clone(entry.receipt);
    }
    const sessions = entry.keys.map(key => this.state.sessions.find(item => authSessionKey(item) === key))
      .filter(item => item && (!item.expiresAt || item.expiresAt > this.now()));
    const result = { version: AUTH_VERSION, deviceId, operationId,
      sessions: sessions.map(item => ({ ...clone(item), active: true })), importedAt: this.now() };
    entry.deviceId = deviceId;
    entry.operationId = operationId;
    entry.receipt = clone(result);
    entry.consumed = true;
    return result;
  }

  async invoke(method, input = {}) {
    switch (method) {
      case 'catalog': case 'overview': return this.catalog();
      case 'sessions': return { sessions: this.sessions(input.serviceId) };
      case 'login': return this.login(input);
      case 'selectSession': return { sessions: this.selectSession(input) };
      case 'logout': return this.logout(input);
      case 'createHandoff': return { handoff: this.createBootstrapHandoff(input) };
      case 'consumeHandoff': return this.consumeHandoff(input);
      default: throw this.error('METHOD_UNKNOWN', 404);
    }
  }

  clearHandoffs() { this.tickets.clear(); }
}
