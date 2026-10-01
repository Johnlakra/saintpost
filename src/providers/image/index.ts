import { isImage, describeError } from '../http.js';
import { classify, cooldown, coolingFor, recordFail, recordOk, providerStats } from '../cooldown.js';
import type { ImageProvider, ImageRequest, Tier } from '../types.js';
import { falSchnell, falKontext } from './fal.js';
import { geminiImage } from './gemini.js';
import { cloudflareFlux, cloudflareSdxl } from './cloudflare.js';
import { together, hfNscale, hfTogether, replicateFlux, replicateKontext, pollinationsFlux, pollinationsKontext } from './others.js';

/**
 * THE image provider list. To add a service: write one ImageProvider (see others.ts) and add it here.
 * Order = preference inside a tier. Tiers: premium > standard > basic.
 */
export const IMAGE_PROVIDERS: ImageProvider[] = [
  geminiImage, falSchnell, falKontext, replicateKontext,
  cloudflareFlux, together, hfNscale, hfTogether, replicateFlux, cloudflareSdxl,
  pollinationsFlux, pollinationsKontext,
];

const TIER_RANK: Record<Tier, number> = { premium: 0, standard: 1, basic: 2 };
const FLAKY_PAUSE_MS = 10 * 60_000;
const MIN_BASIC_BYTES = parseInt(process.env.MIN_BASIC_IMAGE_KB || '250', 10) * 1024;

export interface ImageResult { buffer: Buffer; provider: ImageProvider; usedReference: boolean }

export class ImageProvidersExhausted extends Error {
  constructor(public failures: string[]) {
    super(`All good image providers failed -> ${failures.join(' | ')}`);
  }
}

function plan(req: ImageRequest, allowBasic: boolean): Array<{ p: ImageProvider; withRef: boolean }> {
  const usable = IMAGE_PROVIDERS.filter(p => p.enabled() && (allowBasic || p.tier !== 'basic'));
  const byTier = (a: ImageProvider, b: ImageProvider) => TIER_RANK[a.tier] - TIER_RANK[b.tier];
  const out: Array<{ p: ImageProvider; withRef: boolean }> = [];
  if (req.refUrl || req.refPath) {
    // 1) providers that can use the reference (best chance of the right face), 2) everything else text-only
    usable.filter(p => p.mode !== 'text').sort(byTier).forEach(p => out.push({ p, withRef: true }));
    usable.filter(p => p.mode !== 'ref').sort(byTier).forEach(p => out.push({ p, withRef: false }));
  } else {
    usable.filter(p => p.mode !== 'ref').sort(byTier).forEach(p => out.push({ p, withRef: false }));
  }
  return out;
}

/**
 * Generate one image. Walks the provider plan; pauses providers that are out of credit/quota;
 * retries the remaining ones after a wait when failures look temporary; NEVER returns a low-quality image
 * unless basic-tier providers are explicitly allowed and the result passes a size gate.
 */
export async function generateImage(req: ImageRequest, opts: { allowBasic?: boolean } = {}): Promise<ImageResult> {
  const allowBasic = opts.allowBasic ?? process.env.ALLOW_BASIC_IMAGES === 'true';
  const order = plan(req, allowBasic);
  if (order.length === 0) throw new ImageProvidersExhausted(['no image provider is configured (set GEMINI_API_KEY, CLOUDFLARE_*, HUGGINGFACE_API_KEY ...)']);

  const failures: string[] = [];
  const rounds = 3;
  let flaky = new Set<string>(); // providers that failed temporarily in the latest round
  for (let round = 1; round <= rounds; round++) {
    let transient = false;
    flaky = new Set<string>();
    for (const { p, withRef } of order) {
      const cool = coolingFor(p.id);
      if (cool) { if (round === 1) failures.push(`${p.label}: paused (${cool.reason})`); continue; }
      for (let attempt = 1; attempt <= (p.tries ?? 1); attempt++) {
        try {
          const buffer = await p.generate(withRef ? req : { ...req, refUrl: undefined, refPath: undefined });
          if (!isImage(buffer)) throw new Error('response was not a valid image');
          if (p.tier === 'basic' && buffer.length < MIN_BASIC_BYTES) {
            throw Object.assign(new Error(`rejected: too low quality (${Math.round(buffer.length / 1024)} KB)`), { quality: true });
          }
          recordOk(p.id);
          console.log(`     ✓ ${p.label}${withRef ? ' (with reference)' : ''} (${Math.round(buffer.length / 1024)} KB)`);
          return { buffer, provider: p, usedReference: withRef };
        } catch (e: any) {
          const msg = describeError(e);
          recordFail(p.id, msg);
          console.warn(`     ✗ ${p.label} [${attempt}/${p.tries ?? 1}]: ${msg}`);
          if (e.quality) { failures.push(`${p.label}: ${msg}`); break; }
          const c = classify(e, msg);
          if (c.kind !== 'transient') {
            cooldown(p.id, c.ms, c.kind === 'hard' ? 'credit/auth problem' : c.kind === 'quota' ? 'quota reached' : 'needs an account key');
            failures.push(`${p.label}: ${msg}`);
            break;
          }
          transient = true;
          if (attempt === (p.tries ?? 1)) { flaky.add(p.id); failures.push(`${p.label}: ${msg}`); }
          else await new Promise(r => setTimeout(r, 6000 * attempt));
        }
      }
    }
    if (!transient) break;
    if (round === rounds) {
      // Still failing after every retry round: rest it, so the next scenes don't each wait out the same retries.
      flaky.forEach(id => cooldown(id, FLAKY_PAUSE_MS, 'kept failing'));
      break;
    }
    const wait = 15000 * round;
    console.warn(`     … temporary failures everywhere; waiting ${wait / 1000}s then retrying good providers (round ${round + 1}/${rounds})`);
    await new Promise(r => setTimeout(r, wait));
  }
  throw new ImageProvidersExhausted(failures);
}

/** For the bot's Status screen. */
export function imageProviderStatus(): Array<{ label: string; tier: Tier; state: 'ready' | 'paused' | 'off'; note: string }> {
  return IMAGE_PROVIDERS.map(p => {
    if (!p.enabled()) return { label: p.label, tier: p.tier, state: 'off' as const, note: 'no key' };
    if (p.tier === 'basic' && process.env.ALLOW_BASIC_IMAGES !== 'true') return { label: p.label, tier: p.tier, state: 'off' as const, note: 'disabled: low quality' };
    const c = coolingFor(p.id);
    const s = providerStats(p.id);
    return c
      ? { label: p.label, tier: p.tier, state: 'paused' as const, note: `${c.reason}, ${Math.ceil(c.secondsLeft / 60)} min` }
      : { label: p.label, tier: p.tier, state: 'ready' as const, note: `${s.ok} ok / ${s.fail} failed` };
  });
}
