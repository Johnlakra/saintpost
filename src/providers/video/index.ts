import { classify, cooldown, coolingFor, recordFail, recordOk } from '../cooldown.js';
import { describeError } from '../http.js';
import type { VideoProvider, VideoRequest } from '../types.js';
import { falVideo } from './fal.js';

/** THE video provider list. Add one VideoProvider here to support a new image-to-video service. */
export const VIDEO_PROVIDERS: VideoProvider[] = [falVideo];

export const aiVideoAvailable = () => VIDEO_PROVIDERS.some(p => p.enabled() && !coolingFor(p.id));

/** Returns an MP4 buffer, or null when no provider is available/working (caller falls back to Ken Burns). */
export async function generateVideo(req: VideoRequest): Promise<{ buffer: Buffer; provider: VideoProvider } | null> {
  for (const p of VIDEO_PROVIDERS) {
    if (!p.enabled() || coolingFor(p.id)) continue;
    try {
      const buffer = await p.generate(req);
      if (buffer.length < 20000) throw new Error('video response too small');
      recordOk(p.id);
      return { buffer, provider: p };
    } catch (e: any) {
      const msg = describeError(e);
      recordFail(p.id, msg);
      console.warn(`     ✗ ${p.label}: ${msg}`);
      const c = classify(e, msg);
      if (c.kind !== 'transient') cooldown(p.id, c.ms, c.kind === 'hard' ? 'credit/auth problem' : c.kind === 'outage' ? 'provider outage' : 'quota reached');
    }
  }
  return null;
}
