import { createProviderBridge } from './provider-bridge.mjs';

/** Server/client host supplies real Starpost login and optional code/exchange calls. No endpoint is guessed. */
export function createStarpostProvider({ id = 'starpost', issuer, baseUrl, authenticate,
  requestCode, exchangeChannel, channelServiceId = 'coodock-channel' } = {}) {
  if (typeof authenticate !== 'function') return { id, title: '星邮账号', state: 'pending' };
  if (typeof issuer !== 'string' || !issuer || typeof baseUrl !== 'string' || !baseUrl)
    throw new TypeError('Explicit issuer and Starpost service origin required');
  return createProviderBridge({ id, title: '星邮账号',
    driver: {
      async begin() { return { kind: 'starpost-email', methods: ['password', 'code'], issuer }; },
      async complete(input) {
        const account = await authenticate(input);
        if (typeof account?.humanId !== 'string' || !/^\d{5,12}H$/.test(account.humanId)
          || typeof account.accessToken !== 'string' || !account.accessToken || !Number.isFinite(account.expiresAt)
          || account.expiresAt <= Date.now())
          throw new Error('STARPOST_HUMAN_SESSION_REQUIRED');
        return account;
      },
    },
    async exchange({ authorization: account, input }) {
      const social = { serviceId: 'starpost', issuer, subject: account.humanId, principalType: 'human',
        serviceSubject: account.humanId, credential: { accessToken: account.accessToken, baseUrl },
        expiresAt: account.expiresAt, ...(account.botId ? { botId: account.botId } : {}) };
      const sessions = [social];
      const serviceStates = [{ serviceId: 'starpost', state: 'connected' }];
      if (!input.connectChannel) return { sessions, serviceStates };
      if (typeof requestCode !== 'function' || typeof exchangeChannel !== 'function') {
        serviceStates.push({ serviceId: channelServiceId, state: 'pending', code: 'IDENTITY_EXCHANGE_PENDING' });
        return { sessions, serviceStates };
      }
      try {
        const fields = ['audience', 'installationId', 'deviceId', 'role', 'botId'];
        const scope = Object.fromEntries(fields.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
        // Only the authority-local requestCode callback sees its own social session.
        const proof = await requestCode({ account: { humanId: account.humanId, accessToken: account.accessToken,
          expiresAt: account.expiresAt }, input: structuredClone(scope) });
        const channelInput = { ...scope, ...Object.fromEntries(['operationId', 'localCredential']
          .filter(key => input[key] !== undefined).map(key => [key, input[key]])) };
        const channel = await exchangeChannel({ proof, input: structuredClone(channelInput) });
        if(channel?.serviceState === 'authenticated' && channel?.pairingState === 'pending'
          && channel?.identity?.issuer === issuer && channel?.identity?.subject === account.humanId
          && channel?.identity?.principalType === 'human' && !channel?.token && !channel?.credential) {
          serviceStates.push({serviceId:channelServiceId,state:'pending',code:'CHANNEL_PAIRING_REQUIRED'});
          return {sessions,serviceStates};
        }
        if (channel?.serviceId !== channelServiceId || channel?.principalType !== 'human'
          || channel?.issuer !== issuer || channel?.subject !== account.humanId
          || !channel?.credential || typeof channel.credential !== 'object' || Array.isArray(channel.credential)
          || !Object.keys(channel.credential).length
          || channel.expiresAt !== undefined && (!Number.isFinite(channel.expiresAt) || channel.expiresAt <= Date.now())
          || ['installationId', 'botId', 'serviceSubject', 'displayName'].some(key => channel[key] !== undefined
            && (typeof channel[key] !== 'string' || !channel[key].trim()))
          || ['installationId', 'botId'].some(key => scope[key] !== undefined && channel[key] !== scope[key])
          || channel.scopes !== undefined && (!Array.isArray(channel.scopes)
            || channel.scopes.some(value => typeof value !== 'string' || !value.trim()))
          || channel.audience !== undefined && !(typeof channel.audience === 'string' && channel.audience.trim()
            || Array.isArray(channel.audience) && channel.audience.length
              && channel.audience.every(value => typeof value === 'string' && value.trim())))
          throw new Error('CHANNEL_SESSION_INVALID');
        sessions.push(Object.fromEntries(['serviceId', 'issuer', 'subject', 'principalType', 'credential',
          'expiresAt', 'installationId', 'botId', 'serviceSubject', 'displayName', 'scopes', 'audience']
          .filter(key => channel[key] !== undefined).map(key => [key, structuredClone(channel[key])])));
        serviceStates.push({ serviceId: channelServiceId, state: 'connected' });
      } catch {
        // Never propagate arbitrary upstream error text; it may contain a token or password.
        serviceStates.push({ serviceId: channelServiceId, state: 'failed', code: 'CHANNEL_EXCHANGE_FAILED' });
      }
      return { sessions, serviceStates };
    },
  });
}
