// Connection alias only. Persisted issuer/subjects and custom issuers remain unchanged.
export function ffaTransport(value) {
  const u = new URL(value);
  if (!u.username && !u.password && u.origin === 'https://ffahub.net') {
    u.hostname = '8.148.13.225'; u.port = '8443';
  }
  return u.href;
}
