const BINDING_LOST = /绑定已更换|请重新发送|机器人连接已更换|机器人凭据已更换/;

export function retryableInject(error) {
  const code = error?.code;
  if (code === 'PERMISSION_DENIED' || code === 'INJECT_FAILED') return false;
  if (BINDING_LOST.test(String(error?.message ?? ''))) return false;
  return true;
}

export function createDispatcher({
  coalesceMs = 20,
  retryDelays = [0, 40, 80],
  rateDelay = 800,
  maxAttempts = 3,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const inflight = new Map();
  const timers = new Map();
  const chains = new Map();

  const enqueueChat = (chatKey, fn) => {
    const prev = chains.get(chatKey) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.then(() => {}, () => {});
    chains.set(chatKey, settled);
    return next;
  };

  return {
    inflight,
    enqueueChat,
    isBusy(sessionId) {
      return inflight.has(sessionId);
    },
    arm(sessionId, flush) {
      if (timers.has(sessionId) || inflight.has(sessionId)) return false;
      const timer = setTimer(() => {
        timers.delete(sessionId);
        Promise.resolve(flush(sessionId)).catch((error) => {
          console.error('[dispatch] flush failed', error?.message ?? error);
        });
      }, coalesceMs);
      timers.set(sessionId, timer);
      return true;
    },
    begin(sessionId, batchId) {
      const prev = inflight.get(sessionId);
      inflight.set(sessionId, {
        batchId,
        attempts: prev?.attempts ?? 0,
        emptyRetries: prev?.emptyRetries ?? 0,
      });
    },
    failAttempt(sessionId, error) {
      const run = inflight.get(sessionId);
      if (!run || !retryableInject(error)) {
        inflight.delete(sessionId);
        return { action: 'fail' };
      }
      run.attempts += 1;
      if (run.attempts >= maxAttempts) {
        inflight.delete(sessionId);
        return { action: 'fail' };
      }
      const delay = error?.code === 'RATE_LIMITED' ? rateDelay : (retryDelays[run.attempts - 1] ?? 80);
      return { action: 'retry', delay, batchId: run.batchId };
    },
    endRun(sessionId, text) {
      const run = inflight.get(sessionId);
      const empty = !String(text ?? '').trim();
      if (!run) return { action: 'ignore', empty };
      if (empty) {
        run.emptyRetries += 1;
        if (run.emptyRetries <= 1) return { action: 'retry-empty', batchId: run.batchId };
        inflight.delete(sessionId);
        return { action: 'give-up', batchId: run.batchId };
      }
      const batchId = run.batchId;
      inflight.delete(sessionId);
      return { action: 'settle', batchId };
    },
    clear(sessionId) {
      const timer = timers.get(sessionId);
      if (timer) clearTimer(timer);
      timers.delete(sessionId);
      inflight.delete(sessionId);
    },
    stop() {
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
      inflight.clear();
      chains.clear();
    },
  };
}
