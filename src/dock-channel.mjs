import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { MobileError } from './store.mjs';

const SESSION_KEY = 'MILKCOO_FFA_CLOUD_SESSION';
const CLOUD = 'https://8.137.59.209';
const TOKEN = /^ffa_local_[A-Za-z0-9_-]{43}$/;
const REFRESH_EARLY = 60_000;
const RENEW_EVERY = 25_000;

export class CooDockCloudChannel {
  constructor(lan, context, account, { origin = process.env.MILKCOO_DOCK_CLOUD_ORIGIN || CLOUD,
    fetcher = fetch, clock = Date.now } = {}) {
    const url = new URL(origin);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new TypeError('Invalid CooDock cloud origin');
    this.lan = lan;
    this.context = context;
    this.account = account;
    this.origin = url.origin;
    this.fetcher = fetcher;
    this.clock = clock;
    const device = createHash('sha256').update(lan.botDir).digest('hex').slice(0, 32);
    this.deviceId = 'coodock-pc-' + device;
    this.state = 'waiting_for_bot';
    this.lastError = null;
    this.local = this.loadSession();
    this.paused = this.local?.paused === true;
    this.lan.dockChannel = this;
  }

  loadSession() {
    try {
      const saved = JSON.parse(this.context.secret?.(SESSION_KEY) ?? 'null');
      if (saved?.origin === this.origin &&
          (saved.paused === true || (TOKEN.test(saved.token ?? '') && typeof saved.subject === 'string' &&
            Number.isSafeInteger(saved.expiresAt) && saved.expiresAt > this.clock()))) return saved;
    } catch { /* A missing or legacy value requires a fresh proof. */ }
    return null;
  }

  saveSession(session) {
    try {
      const value = JSON.stringify({ origin: this.origin, ...session });
      this.context.storeSecret(SESSION_KEY, value);
      if (this.context.secret(SESSION_KEY) !== value) throw new Error();
    } catch { throw new MobileError('DOCK_CLOUD_SECRET_STORAGE_UNAVAILABLE', 503); }
  }

  routeIdentity() {
    if (this.lan.deployment) {
      return this.lan.deployment.expiresAt > this.clock() ? this.lan.deployment : null;
    }
    if (this.lan.deploymentSeen) return null;
    const botId = this.context.cfg.starpostBotId;
    if (typeof botId !== 'string' || !/^\d{5,12}$/.test(botId)) return null;
    return { botId, installationId: this.deviceId, routeEpoch: 0 };
  }

  routeKey(identity = this.routeIdentity()) {
    return identity ? JSON.stringify([identity.botId, identity.botSubject, identity.installationId, identity.routeEpoch]) : null;
  }

  status() {
    const identity = this.routeIdentity();
    const active = this.active;
    return { state: this.state, cloudOrigin: this.origin, authSource: active?.auth.source ?? this.authSource ?? null,
      ownerSubject: active?.auth.subject ?? null, botId: identity?.botId ?? null,
      installationId: identity?.installationId ?? null, leaseId: active?.leaseId ?? null,
      lastError: this.lastError, connectedAt: active?.connectedAt ?? null };
  }

  proofLink() {
    const identity = this.routeIdentity();
    if (!identity) throw new MobileError('DOCK_CLOUD_BOT_REQUIRED', 409);
    const url = new URL('https://8.148.13.225:8443/');
    url.search = new URLSearchParams({ grant: 'coodock', scope: 'login',
      installationId: identity.installationId, deviceId: this.deviceId }).toString();
    return { authorizationUrl: url.href, installationId: identity.installationId, deviceId: this.deviceId };
  }

  async loginWithProof(proof) {
    if (typeof proof !== 'string' || !proof.trim() || proof.length > 8192)
      throw new MobileError('DOCK_CLOUD_PROOF_INVALID', 400);
    if (typeof this.context.storeSecret !== 'function' || typeof this.context.secret !== 'function')
      throw new MobileError('DOCK_CLOUD_SECRET_STORAGE_UNAVAILABLE', 503);
    if (this.proofPending) throw new MobileError('DOCK_CLOUD_LOGIN_IN_PROGRESS', 409);
    this.proofPending = true;
    try { return await this.exchangeProof(proof); }
    finally { this.proofPending = false; }
  }

  async exchangeProof(proof) {
    const { installationId, deviceId } = this.proofLink();
    const key = this.routeKey();
    const attempt = this.loginAttempt = {};
    const result = await this.post('/relay/ffa/login', { proof: proof.trim(), installation_id: installationId, device_id: deviceId });
    const token = result.credential?.accessToken;
    if (!TOKEN.test(token ?? '') || result.principalType !== 'human' || typeof result.subject !== 'string' ||
        result.installationId !== installationId || result.deviceId !== deviceId ||
        !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= this.clock())
      throw new MobileError('DOCK_CLOUD_LOGIN_RESPONSE_INVALID', 502);
    if (attempt !== this.loginAttempt || key !== this.routeKey()) {
      await this.revokeLocal(token);
      throw new MobileError('DOCK_CLOUD_LOGIN_CHANGED', 409);
    }
    const previous = this.local;
    const session = { token, subject: result.subject, expiresAt: result.expiresAt };
    try { this.saveSession(session); }
    catch (error) { await this.revokeLocal(token); throw error; }
    this.local = session;
    this.paused = false;
    this.authSource = 'ffa_local';
    await this.reconfigure(true);
    if (previous?.token && previous.token !== token) await this.revokeLocal(previous.token);
    return this.status();
  }

  async logoutCloud() {
    this.loginAttempt = null;
    const previous = this.local;
    this.saveSession({ paused: true });
    this.local = null;
    this.paused = true;
    this.authSource = null;
    this.state = 'login_required';
    await this.reconfigure(true);
    if (previous?.token) await this.post('/relay/ffa/logout', {}, previous.token);
    return this.status();
  }

  async useHostLogin() {
    if (this.paused) this.saveSession({});
    this.paused = false;
    this.hostSession = null;
    this.hostRetryAt = 0;
    await this.reconfigure(true);
  }

  async revokeLocal(token) {
    await this.post('/relay/ffa/logout', {}, token).catch(() => {});
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.worker = this.run();
  }

  async stop() {
    this.running = false;
    this.loginAttempt = null;
    await this.reconfigure(true);
    await this.worker;
    if (this.lan.dockChannel === this) this.lan.dockChannel = null;
  }

  deploymentChanged() {
    if (!this.routeKey()) {
      this.state = 'waiting_for_bot';
      this.lastError = null;
    }
    return this.reconfigure(this.routeKey() !== this.active?.key);
  }

  async reconfigure(release) {
    const active = this.active;
    if (release) {
      // Fence in-progress connects too. Their response is still read so the lease can be released.
      this.generation = (this.generation ?? 0) + 1;
      active?.controller.abort();
      if (this.active === active) this.active = null;
      if (active || this.connecting) this.lan.revoke();
    }
    this.waiter?.abort();
    if (release && active) await this.disconnect(active);
    if (release && this.connecting) await this.connecting;
  }

  async post(path, body, token, signal, timeout = 12_000) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    const deadline = AbortSignal.timeout(timeout);
    let response;
    try {
      response = await this.fetcher(this.origin + path, { method: 'POST', headers, body: JSON.stringify(body),
        redirect: 'error', signal: signal ? AbortSignal.any([deadline, signal]) : deadline });
    } catch { throw new MobileError('DOCK_CLOUD_UNREACHABLE', 503); }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.ok === false) {
      const code = response.status === 401 || response.status === 403 ? 'DOCK_CLOUD_AUTH_DENIED' : 'DOCK_CLOUD_REQUEST_FAILED';
      throw new MobileError(code, response.ok ? 502 : response.status);
    }
    return payload.result ?? payload;
  }

  channel(action, body, auth, signal, timeout) {
    return this.post('/dock/v1/channel/' + action, body, auth.token, signal, timeout);
  }

  async credentials() {
    if (this.paused) return null;
    const now = this.clock();
    if (this.account && (!this.hostSession || this.hostSession.expiresAt - now <= REFRESH_EARLY) &&
        now >= (this.hostRetryAt ?? 0)) {
      this.hostRetryAt = now + RENEW_EVERY;
      const state = await this.account.refresh().catch(() => null);
      const session = this.account.serviceSession();
      if (state?.serviceStatus === 'ready' && session?.audience === 'coodock' && session.scope === 'login' &&
          typeof session.accessToken === 'string' && typeof session.subject === 'string' && session.expiresAt > this.clock()) {
        this.hostSession = { source: 'host_login', token: session.accessToken, subject: session.subject, expiresAt: session.expiresAt };
      } else this.hostSession = null;
    }
    if (this.hostSession?.expiresAt > this.clock()) return this.hostSession;
    if (this.local?.expiresAt > this.clock()) return { ...this.local, source: 'ffa_local' };
    return null;
  }

  async disconnect(active) {
    if (active.release) return active.release;
    active.release = this.channel('disconnect', { botId: active.botId, leaseId: active.leaseId }, active.auth, undefined, 3_000)
      .catch(() => {});
    return active.release;
  }

  async connect(identity, key, auth, existing, generation) {
    const expiresAt = Math.min(identity.expiresAt ?? Infinity, auth.expiresAt, this.clock() + 65_000);
    const lanDirect = this.lan.prepare({ ...identity, expiresAt });
    const connected = await this.channel('connect', {
      botId: identity.botId, botSubject: identity.botSubject, installationId: identity.installationId,
      routeEpoch: identity.routeEpoch, instanceId: this.lan.instanceId + '-' + (generation ?? 0), hostName: hostname().slice(0, 64),
      capabilities: lanDirect?.capabilities ?? [], lanDirect,
    }, auth);
    if (typeof connected.leaseId !== 'string' || connected.botId !== identity.botId || connected.ownerSubject !== auth.subject)
      throw new MobileError('DOCK_CLOUD_LEASE_RESPONSE_INVALID', 502);
    const stable = existing?.leaseId === connected.leaseId;
    const active = stable ? existing : { key, botId: identity.botId, installationId: identity.installationId,
      leaseId: connected.leaseId, connectedAt: this.clock(), controller: new AbortController() };
    active.auth = auth;
    active.renewAt = this.clock() + RENEW_EVERY;
    if (!this.running || generation !== this.generation || key !== this.routeKey() || this.paused) {
      await this.disconnect({ ...active, release: null });
      return null;
    }
    this.active = active;
    this.state = 'online';
    this.lastError = null;
    return active;
  }

  async serve(active) {
    const signal = active.controller.signal;
    const lease = { botId: active.botId, leaseId: active.leaseId };
    const polled = await this.channel('poll', lease, active.auth, signal);
    if (signal.aborted || this.active !== active || this.routeKey() !== active.key) return;
    if (polled.leaseId !== active.leaseId || !Array.isArray(polled.items) || polled.items.length > 4)
      throw new MobileError('DOCK_CLOUD_POLL_RESPONSE_INVALID', 502);
    const batch = Promise.allSettled(polled.items.map(async call => {
      if (signal.aborted || this.active !== active || this.routeKey() !== active.key) return;
      let outcome;
      try {
        outcome = await this.lan.relay(active.botId, active.installationId, call);
      } catch (error) {
        outcome = { status: error instanceof MobileError ? error.status : 502,
          result: { error: error instanceof MobileError && /^[A-Z0-9_]{1,128}$/.test(error.message)
            ? error.message : 'DOCK_CLOUD_LOCAL_OPERATION_FAILED' } };
      }
      if (signal.aborted || this.active !== active || this.routeKey() !== active.key) return;
      const encoded = JSON.stringify(outcome.result ?? null);
      const complete = Buffer.byteLength(encoded) > 1_650_000
        ? { status: 413, body: { error: 'DOCK_CLOUD_RESULT_TOO_LARGE' } }
        : { status: outcome.status, body: outcome.result ?? null };
      const receipt = { ...lease, requestId: call.requestId, ...complete };
      for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
        try {
          await this.channel('complete', receipt, active.auth, signal);
          break;
        } catch (error) {
          if (attempt || error.status !== 503) throw error;
        }
      }
    }));
    if (!polled.items.length || signal.aborted) return;
    let abort;
    const stopped = new Promise(resolve => {
      abort = () => resolve([]);
      signal.addEventListener('abort', abort, { once: true });
    });
    const outcomes = await Promise.race([batch, stopped]);
    signal.removeEventListener('abort', abort);
    const denied = outcomes.find(item => item.status === 'rejected' && [401, 403].includes(item.reason?.status));
    if (denied) throw denied.reason;
  }

  async run() {
    while (this.running) {
      const identity = this.routeIdentity();
      const key = this.routeKey(identity);
      const generation = this.generation;
      let auth;
      this.waiter = new AbortController();
      try {
        if (identity && !this.paused) auth = await this.credentials();
        if (!this.running || this.generation !== generation || key !== this.routeKey()) continue;
        this.authSource = auth?.source;
        let active = this.active;
        if (active && (active.key !== key || active.auth.subject !== auth?.subject || active.auth.source !== auth?.source)) {
          active.controller.abort();
          this.active = null;
          this.lan.revoke();
          await this.disconnect(active);
          active = null;
        }
        if (!identity || !auth) {
          this.state = identity || this.paused ? 'login_required' : 'waiting_for_bot';
          await delay(3_000, undefined, { signal: this.waiter.signal, ref: false }).catch(() => {});
          continue;
        }
        if (!active || active.renewAt <= this.clock() || auth.token !== active.auth.token) {
          if (!active) this.state = 'connecting';
          const connecting = this.connect(identity, key, auth, active, generation);
          this.connecting = connecting.catch(() => {});
          try { active = await connecting; }
          finally { this.connecting = null; }
        }
        if (active) await this.serve(active);
      } catch (error) {
        if (!this.running || this.generation !== generation || key !== this.routeKey()) continue;
        this.lastError = error instanceof MobileError ? error.message : 'DOCK_CLOUD_CONNECTOR_FAILED';
        this.state = 'retrying';
        this.lan.revoke();
        if ([401, 403].includes(error?.status)) {
          if (auth?.source === 'host_login') {
            this.hostSession = null;
            this.hostRetryAt = this.clock() + REFRESH_EARLY;
          } else if (auth?.token === this.local?.token) this.local = null;
        }
        if (this.active) {
          const active = this.active;
          active.controller.abort();
          this.active = null;
          await this.disconnect(active);
        }
        await delay(1_000, undefined, { signal: this.waiter.signal, ref: false }).catch(() => {});
      }
    }
    this.state = 'stopped';
  }
}
