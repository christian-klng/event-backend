export interface RateLimiter {
  /** Counts one attempt and tells whether it is still within the limit. */
  allow(key: string, now?: number): boolean;
}

/** Sliding window per key, kept in memory. Enough for a single small service. */
export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const attempts = new Map<string, number[]>();
  let lastSweep = 0;

  return {
    allow(key, now = Date.now()) {
      if (now - lastSweep > windowMs) {
        lastSweep = now;
        for (const [entry, times] of attempts) {
          if ((times.at(-1) ?? 0) <= now - windowMs) attempts.delete(entry);
        }
      }
      const recent = (attempts.get(key) ?? []).filter((time) => time > now - windowMs);
      if (recent.length >= limit) {
        attempts.set(key, recent);
        return false;
      }
      recent.push(now);
      attempts.set(key, recent);
      return true;
    },
  };
}
