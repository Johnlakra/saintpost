import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../../config/env.js';
import { capped, fetchBytes } from '../http.js';
import { ffmpeg } from '../../utils/media.js';
import type { ImageProvider, ImageRequest } from '../types.js';

/**
 * Cloudflare Workers AI. Free plan: 10,000 "Neurons" per UTC day, renewing at 00:00 UTC, no credit card.
 * Prices (Cloudflare docs, per 512x512 tile): FLUX.2 klein 4B = 26.05 output + 5.37 per input image;
 * FLUX.1 schnell = 4.8 + 9.6 per step. We keep a running estimate so the bot can show what is left today.
 */
const base = () => `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/ai/run`;
const auth = () => ({ Authorization: `Bearer ${config.cloudflareApiToken}` });
const on = () => !!(config.cloudflareApiToken && config.cloudflareAccountId);

export const CF_DAILY_NEURONS = 10_000;
let budget = { day: '', used: 0 };
const today = () => new Date().toISOString().slice(0, 10);
function spend(n: number) {
  if (budget.day !== today()) budget = { day: today(), used: 0 };
  budget.used += n;
}
export function cloudflareBudget() {
  if (budget.day !== today()) budget = { day: today(), used: 0 };
  return { used: Math.round(budget.used), left: Math.max(0, Math.round(CF_DAILY_NEURONS - budget.used)), total: CF_DAILY_NEURONS };
}
const tiles = (w: number, h: number) => (w / 512) * (h / 512);
export const kleinCost = (w: number, h: number, refs = 0) => tiles(w, h) * 26.05 + refs * 5.37;
export const schnellCost = (w: number, h: number, steps = 4) => tiles(w, h) * 4.8 + steps * 9.6;

/** Image bytes from whatever shape Workers AI answers with (JSON base64, or the raw image). */
function extractImage(res: { data: any; headers: any }): Buffer {
  const buf = Buffer.from(res.data);
  const ct = String(res.headers?.['content-type'] || '');
  if (ct.includes('json') || buf[0] === 0x7b) {
    const j = JSON.parse(buf.toString('utf8'));
    const b64 = j?.result?.image || j?.result?.images?.[0] || j?.image || j?.images?.[0];
    if (!b64) throw new Error(`no image in response: ${JSON.stringify(j?.errors || j).slice(0, 160)}`);
    return Buffer.from(typeof b64 === 'string' ? b64 : b64?.image || '', 'base64');
  }
  return buf;
}

/** Reference photo -> small JPEG (max 512 px side: cheap, and within Workers AI input limits). */
async function smallReference(req: ImageRequest, max = 512): Promise<Buffer | null> {
  try {
    let bytes: Buffer;
    if (req.refPath && fs.existsSync(req.refPath)) bytes = fs.readFileSync(req.refPath);
    else if (req.refUrl) bytes = await fetchBytes(req.refUrl, 30000);
    else return null;
    const tmpIn = path.join(os.tmpdir(), `cfref_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    const tmpOut = `${tmpIn}.jpg`;
    fs.writeFileSync(tmpIn, bytes);
    try {
      await ffmpeg(['-i', tmpIn, '-vf', `scale=${max}:${max}:force_original_aspect_ratio=decrease`, '-frames:v', '1', '-q:v', '3', tmpOut]);
      return fs.readFileSync(tmpOut);
    } finally {
      fs.rmSync(tmpIn, { force: true });
      fs.rmSync(tmpOut, { force: true });
    }
  } catch (e: any) {
    console.warn('     ⚠️ Could not prepare the reference image for Cloudflare:', e.message);
    return null;
  }
}

/**
 * FLUX.2 [klein] 4B on Workers AI: native width/height, and it can take reference images (face/outfit consistency).
 * Request is multipart/form-data. This is the main free-daily provider.
 */
export const cloudflareKlein: ImageProvider = {
  id: 'cf-klein', label: 'Cloudflare FLUX.2 klein', tier: 'premium', mode: 'both',
  enabled: on,
  async generate(req) {
    const { w, h } = capped(req.shape, 1792);
    const wantsRef = !!(req.refUrl || req.refPath);
    // identity references are small (512 px, cheap); edits send more detail so the unchanged parts stay faithful
    let refMax = req.refMax ?? 512;
    for (;;) {
      const form = new FormData();
      form.append('prompt', req.prompt.slice(0, 3000));
      form.append('width', String(w));
      form.append('height', String(h));
      let refs = 0;
      if (wantsRef) {
        const ref = await smallReference(req, refMax);
        if (ref) {
          form.append('input_image_0', new Blob([new Uint8Array(ref)], { type: 'image/jpeg' }), 'ref.jpg');
          refs = 1;
        }
      }
      try {
        const res = await axios.post(`${base()}/@cf/black-forest-labs/flux-2-klein-4b`, form, { headers: auth(), responseType: 'arraybuffer', timeout: 120000 });
        const img = extractImage(res);
        spend(kleinCost(w, h, refs));
        return img;
      } catch (e: any) {
        // a bigger reference than the model accepts is rejected (400/422): retry once at the safe size
        if (refMax > 512 && (e.response?.status === 400 || e.response?.status === 422)) { refMax = 512; continue; }
        throw e;
      }
    }
  },
};

/** Workers AI FLUX.1 schnell: cheaper per image (~70 neurons for a 9:16 frame), text-to-image only. */
export const cloudflareFlux: ImageProvider = {
  id: 'cf-flux', label: 'Cloudflare FLUX.1 schnell', tier: 'standard', mode: 'text',
  enabled: on,
  async generate({ prompt, shape, seed }) {
    const { w, h } = capped(shape, 1344);
    const post = (body: any) => axios.post(`${base()}/@cf/black-forest-labs/flux-1-schnell`, body, { headers: auth(), responseType: 'arraybuffer', timeout: 90000 });
    let res;
    try {
      res = await post({ prompt: prompt.slice(0, 2000), steps: 4, seed, width: w, height: h });
    } catch (e: any) {
      // Some model builds reject width/height: they can then only make square images.
      if (e.response?.status === 400 && shape.aspect === '1:1') res = await post({ prompt: prompt.slice(0, 2000), steps: 4, seed });
      else throw e;
    }
    const img = extractImage(res);
    spend(schnellCost(w, h, 4));
    return img;
  },
};

/** Workers AI SDXL-Lightning: lower detail than FLUX but still free (returns raw PNG bytes). */
export const cloudflareSdxl: ImageProvider = {
  id: 'cf-sdxl', label: 'Cloudflare SDXL-Lightning', tier: 'standard', mode: 'text',
  enabled: on,
  async generate({ prompt, shape, seed }) {
    const { w, h } = capped(shape, 1024);
    const res = await axios.post(
      `${base()}/@cf/bytedance/stable-diffusion-xl-lightning`,
      { prompt: prompt.slice(0, 1500), width: w, height: h, num_steps: 8, guidance: 3, seed },
      { headers: auth(), responseType: 'arraybuffer', timeout: 90000 }
    );
    return extractImage(res);
  },
};
