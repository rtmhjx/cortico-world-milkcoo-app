// Loaded only by the phone-local renderer, never into the desktop World.
function phoneReadyTimeout(fail, env = {}) {
  const now = env.now || (() => performance.now());
  const schedule = env.schedule || setInterval;
  const cancel = env.cancel || clearInterval;
  const probe = env.probe || (() => fetch('/phone-load-state', { cache: 'no-store', signal: AbortSignal.timeout(3000) }).then(r => r.json()));
  let last = now(), busy = false;
  const timer = schedule(async () => {
    if (busy) return;
    busy = true;
    try {
      const state = await probe();
      // Native side reports active only while bytes make progress (90s idle cap).
      if (state.active) last = now();
    } catch { /* A failed probe cannot extend the deadline. */ }
    finally { busy = false; }
    if (now() - last >= 90_000) { cancel(timer); fail(); }
  }, 1000);
  return timer;
}
