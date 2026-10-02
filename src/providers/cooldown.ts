/** Shared "rest this provider" memory (process-wide, so overlapping jobs and runs benefit). */
const until = new Map<string, { at: number; reason: string }>();
const stats = new Map<string, { ok: number; fail: number; last?: string }>();

export function cooldown(id: string, ms: number, reason: string) {
  until.set(id, { at: Date.now() + ms, reason });
}
export function coolingFor(id: string): { secondsLeft: number; reason: string } | null {
  const c = until.get(id);
  if (!c || c.at <= Date.now()) return null;
  return { secondsLeft: Math.ceil((c.at - Date.now()) / 1000), reason: c.reason };
}
export function recordOk(id: string) {
  const s = stats.get(id) || { ok: 0, fail: 0 };
  s.ok++;
  stats.set(id, s);
}
export function recordFail(id: string, msg: string) {
  const s = stats.get(id) || { ok: 0, fail: 0 };
  s.fail++;
  s.last = msg;
  stats.set(id, s);
}
export const providerStats = (id: string) => stats.get(id) || { ok: 0, fail: 0 };

/** Classify an error so every router treats failures the same way. */
export function msUntilUtcMidnight(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime() + 60_000;
}

export function classify(e: any, msg: string): { kind: 'hard' | 'quota' | 'keyless' | 'outage' | 'reject' | 'transient'; ms: number } {
  const st = e?.response?.status;
  if (/only available on enter\.pollinations\.ai/i.test(msg)) return { kind: 'keyless', ms: 24 * 3600_000 };
  // Cloudflare's free allowance is per UTC day: rest until it renews instead of retrying every few minutes.
  if (/daily free allocation|4006|used up your daily/i.test(msg)) return { kind: 'quota', ms: msUntilUtcMidnight() };
  if (st === 401 || st === 402 || st === 403) return { kind: 'hard', ms: 30 * 60_000 }; // locked key / no credit
  // "check your plan and billing" = this key has NO quota for this model at all (not a rate limit): rest 6 h.
  if (st === 429 && /plan and billing|billing details/i.test(msg)) return { kind: 'quota', ms: 6 * 3600_000 };
  if (st === 429) return { kind: 'quota', ms: 5 * 60_000 };
  if (st === 400 || st === 422) return { kind: 'reject', ms: 0 }; // this request was refused: try the next provider now, no waiting
  if (st === 502 || st === 503 || st === 504) return { kind: 'outage', ms: 3 * 60_000 }; // provider is down: skip it for a bit, don't wait around
  return { kind: 'transient', ms: 0 };
}
