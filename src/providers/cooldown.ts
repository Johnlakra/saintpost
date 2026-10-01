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
export function classify(e: any, msg: string): { kind: 'hard' | 'quota' | 'keyless' | 'transient'; ms: number } {
  const st = e?.response?.status;
  if (/only available on enter\.pollinations\.ai/i.test(msg)) return { kind: 'keyless', ms: 24 * 3600_000 };
  if (st === 401 || st === 402 || st === 403) return { kind: 'hard', ms: 30 * 60_000 }; // locked key / no credit
  if (st === 429) return { kind: 'quota', ms: 5 * 60_000 };
  return { kind: 'transient', ms: 0 };
}
