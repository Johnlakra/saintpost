import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/env.js';
import { SaintRecord } from '../data/sanctusFetcher.js';
import { SceneScript } from './llmService.js';
import { ffmpeg } from '../utils/media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ImageAssetResult {
  localPath: string;
  url: string;
}

type Shape = { w: number; h: number; genW: number; genH: number; aspect: '1:1' | '9:16' | '16:9' };
// Generate at a model-friendly size (multiples of 16), then scale/crop to the exact delivery size.
const SHAPES: Record<'square' | 'story' | 'sheet', Shape> = {
  square: { w: 1080, h: 1080, genW: 1024, genH: 1024, aspect: '1:1' },
  story: { w: 1080, h: 1920, genW: 1024, genH: 1792, aspect: '9:16' },
  sheet: { w: 1280, h: 720, genW: 1280, genH: 720, aspect: '16:9' },
};

const STYLE =
  'classical devotional oil painting, reverent, warm natural light, sharp focus, intricate fine detail, high resolution, painterly, dignified, ' +
  'beautiful composition, no text, no letters, no watermark, no logo, anatomically correct hands and face';

const STYLE_MODERN =
  'warm realistic illustration, soft golden light, gentle uplifting mood, natural features, sharp focus, intricate fine detail, high resolution, ' +
  'no text, no letters, no watermark, no logo, anatomically correct hands and face';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '_');

function isImage(buf: Buffer): boolean {
  if (buf.length < 4000) return false;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const jpg = buf[0] === 0xff && buf[1] === 0xd8;
  const webp = buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  return png || jpg || webp;
}

export class VisualAssetService {
  private outputDir: string;

  constructor() {
    this.outputDir = path.join(__dirname, '..', '..', 'public', 'assets');
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  /** Stable per-saint seed: same saint => same base look across every image and every video. */
  private seedFor(saint: SaintRecord): number {
    let h = 2166136261;
    for (const c of saint.name) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return Math.abs(h) % 1000000;
  }

  /**
   * The text "character sheet": one fixed description of the saint reused verbatim in EVERY prompt.
   * This (plus a fixed seed) is what keeps the face/outfit stable with text-to-image models.
   */
  private characterDescriptor(saint: SaintRecord): string {
    const halo = config.saintHalo ? ', a subtle thin golden halo' : ', no halo';
    if (saint.appearance) return `${saint.appearance}${halo}`;
    const where = [saint.region, saint.era].filter(Boolean).join(', ');
    return `${saint.name}${where ? ` (${where})` : ''}, ordinary clothing accurate for their real time and place, no invented props${halo}`;
  }

  /** Modern saints get a realistic illustration style, ancient ones a classical painting. */
  private styleFor(saint: SaintRecord): string {
    const modern = /jeans|sneakers|polo|hoodie|t-shirt|modern|20th|21st|suit and tie/i.test(saint.appearance || '');
    return modern ? STYLE_MODERN : STYLE;
  }

  async generateCharacterSheet(saint: SaintRecord): Promise<ImageAssetResult> {
    console.log(`🎨 Generating Character Sheet for Saint: ${saint.name}...`);
    const prompt = `Character reference sheet, three panels side by side: front view, side profile, full body. ${this.characterDescriptor(saint)}. Plain light neutral background, ${this.styleFor(saint)}`;
    return this.makeImage('character_sheet', saint, prompt, SHAPES.sheet, this.seedFor(saint));
  }

  async generateCoverImage(saint: SaintRecord, _characterSheetUrl?: string, detailedPrompt?: string): Promise<ImageAssetResult> {
    this.anchor = null;
    console.log(`🖼️ Generating 1:1 Cover Image for ${saint.name}...`);
    const prompt = detailedPrompt
      ? `${this.characterDescriptor(saint)}. ${detailedPrompt}. ${this.styleFor(saint)}`
      : `Square devotional portrait, head and shoulders, calm dignified expression, centered with space around. ${this.characterDescriptor(saint)}. ${this.styleFor(saint)}`;
    return this.makeImage('cover', saint, prompt, SHAPES.square, this.seedFor(saint));
  }

  async generateSceneImages(saint: SaintRecord, scenes: SceneScript[], _characterSheetUrl?: string): Promise<ImageAssetResult[]> {
    console.log(`🎬 Generating 9:16 Scene Images for ${scenes.length} scenes...`);
    const results: ImageAssetResult[] = [];
    const seed = this.seedFor(saint);

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      console.log(`   └ Generating scene ${i + 1}/${scenes.length}...`);
      const prompt = `Main figure: ${this.characterDescriptor(saint)}. Scene: ${scene.image_prompt || scene.visual}. The main figure must match that description exactly in every scene. Vertical cinematic composition, subject in the middle third. ${this.styleFor(saint)}`;
      try {
        results.push(await this.makeImage(`scene_${i + 1}`, saint, prompt, SHAPES.story, seed + i));
      } catch (err: any) {
        // Never ship a blank card: reuse the closest real image (prior scene) with a different crop.
        const prev = results[results.length - 1];
        if (!prev) throw err;
        console.warn(`   ⚠️ Scene ${i + 1} failed (${err.message}); reusing previous scene image.`);
        results.push(prev);
      }
    }
    return results;
  }

  private async makeImage(kind: string, saint: SaintRecord, prompt: string, shape: Shape, seed: number): Promise<ImageAssetResult> {
    const fileName = `${kind}_${slug(saint.name)}_${Date.now()}.png`;
    const localPath = path.join(this.outputDir, fileName);
    const documented = saint.reference_image_url;
    const ref = documented || (kind !== 'cover' ? this.anchor?.url : undefined);
    const finalPrompt = documented
      ? `Keep the EXACT same real person as in the reference photo: identical face, age, skin tone, hair and clothing. Do not add robes, halos, crosses or props that are not in the photo. ${prompt}`
      : ref
        ? `Keep the exact same character as in the reference image: identical face, age, skin tone, hair and clothing style. ${prompt}`
        : prompt;
    const raw = await this.queryImageAPI(finalPrompt, shape, seed, ref);

    const tmp = `${localPath}.raw`;
    fs.writeFileSync(tmp, raw);
    try {
      await ffmpeg(['-i', tmp, '-vf', `scale=${shape.w}:${shape.h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${shape.w}:${shape.h}`, '-frames:v', '1', localPath]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    const result = { localPath, url: `${config.renderExternalUrl}/assets/${fileName}` };
    if (kind === 'cover' && !documented) this.anchor = { url: result.url, path: localPath };
    return result;
  }

  /** Tries each configured provider in order, validating that real image bytes came back. */
  private async queryImageAPI(prompt: string, shape: Shape, seed: number, refUrl?: string): Promise<Buffer> {
    const providers: Array<[string, () => Promise<Buffer>, number]> = [];
    // Documented photo available: use reference-conditioned models first so the face stays true and consistent.
    if (refUrl) {
      if (config.geminiApiKey) providers.push(['Gemini image (reference photo)', () => this.gemini(prompt, shape, refUrl), 1]);
      providers.push(['Pollinations kontext (reference photo)', () => this.pollinationsQueued(prompt, shape, seed, 'kontext', refUrl), 3]);
      if (config.falApiKey) providers.push(['fal.ai FLUX Kontext (reference photo)', () => this.falKontext(prompt, shape, refUrl), 1]);
      if (config.replicateApiToken) providers.push(['Replicate FLUX Kontext (reference photo)', () => this.replicateKontext(prompt, shape, refUrl), 1]);
    }
    // Text-to-image chain, best quality first. Providers without a key are simply skipped.
    if (config.falApiKey) providers.push(['fal.ai FLUX schnell', () => this.fal(prompt, shape, seed), 1]);
    if (config.geminiApiKey && !refUrl) providers.push(['Gemini image', () => this.gemini(prompt, shape), 1]);
    if (config.cloudflareApiToken && config.cloudflareAccountId) providers.push(['Cloudflare FLUX schnell', () => this.cloudflare(prompt, shape, seed), 1]);
    if (config.togetherApiKey) providers.push(['Together FLUX schnell (free)', () => this.together(prompt, shape, seed), 1]);
    if (config.huggingfaceApiKey) {
      providers.push(['HuggingFace/nscale FLUX schnell', () => this.hfRouter('nscale', prompt, shape, seed), 1]);
      providers.push(['HuggingFace/together FLUX schnell', () => this.hfRouter('together', prompt, shape, seed), 1]);
    }
    if (config.replicateApiToken) providers.push(['Replicate FLUX schnell', () => this.replicate(prompt, shape, seed), 1]);
    // Pollinations' anonymous tier rate-limits hard (HTTP 402/429): serialize calls and back off patiently.
    providers.push(['Pollinations flux', () => this.pollinationsQueued(prompt, shape, seed, 'flux'), 4]);
    providers.push(['Pollinations turbo', () => this.pollinationsQueued(prompt, shape, seed, 'turbo'), 2]);

    const errors: string[] = [];
    for (const [name, fn, tries] of providers) {
      const off = this.disabledUntil.get(name);
      if (off && off > Date.now()) { errors.push(`${name}: disabled (auth/credit problem)`); continue; }
      for (let attempt = 1; attempt <= tries; attempt++) {
        try {
          const buf = await fn();
          if (!isImage(buf)) throw new Error('response was not a valid image');
          console.log(`     ✓ ${name} (${Math.round(buf.length / 1024)} KB)`);
          return buf;
        } catch (e: any) {
          const msg = this.describeError(e);
          console.warn(`     ✗ ${name} attempt ${attempt}/${tries}: ${msg}`);
          const st = e.response?.status;
          if (st === 429 && !name.startsWith('Pollinations')) {
            // Daily/minute quota hit: rest this provider for a few minutes instead of hammering it.
            this.disabledUntil.set(name, Date.now() + 5 * 60 * 1000);
            errors.push(`${name}: ${msg}`);
            break;
          }
          if ((st === 401 || st === 402 || st === 403) && !name.startsWith('Pollinations')) {
            // Key locked / out of credit: don't waste time (or quota) retrying for 30 minutes.
            this.disabledUntil.set(name, Date.now() + 30 * 60 * 1000);
            errors.push(`${name}: ${msg}`);
            break;
          }
          if (attempt === tries) errors.push(`${name}: ${msg}`);
          else await new Promise(r => setTimeout(r, 6000 * attempt));
        }
      }
    }
    throw new Error(`All image providers failed -> ${errors.join(' | ')}`);
  }

  private describeError(e: any): string {
    if (!e.response) return e.message;
    let body = '';
    try {
      const d = e.response.data;
      body = Buffer.isBuffer(d) || d instanceof ArrayBuffer ? Buffer.from(d as any).toString('utf8') : typeof d === 'string' ? d : JSON.stringify(d);
    } catch { /* ignore */ }
    return `HTTP ${e.response.status}${body ? ` ${body.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
  }

  /** In-run face anchor: when no documented photo exists, the first cover image is reused as the reference for every scene. */
  private anchor: { url: string; path: string } | null = null;

  private disabledUntil = new Map<string, number>();
  private pollChain: Promise<unknown> = Promise.resolve();

  /** One Pollinations request at a time (across overlapping jobs), 3s apart. */
  private pollinationsQueued(prompt: string, shape: Shape, seed: number, model: string, refUrl?: string): Promise<Buffer> {
    const run = this.pollChain.then(async () => {
      try { return await this.pollinations(prompt, shape, seed, model, refUrl); }
      finally { await new Promise(r => setTimeout(r, 3000)); }
    });
    this.pollChain = run.catch(() => undefined);
    return run;
  }

  private async fetchBytes(url: string): Promise<Buffer> {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
    return Buffer.from(res.data);
  }

  private async fal(prompt: string, shape: Shape, seed: number): Promise<Buffer> {
    const res = await axios.post(
      `https://fal.run/${process.env.FAL_IMAGE_MODEL || 'fal-ai/flux/schnell'}`,
      { prompt, image_size: { width: shape.genW, height: shape.genH }, num_inference_steps: process.env.FAL_IMAGE_MODEL ? 28 : 4, seed, enable_safety_checker: true },
      { headers: { Authorization: `Key ${config.falApiKey}` }, timeout: 90000 }
    );
    const url = res.data?.images?.[0]?.url;
    if (!url) throw new Error('no image url in fal response');
    return this.fetchBytes(url);
  }

  /** HuggingFace Inference Providers (OpenAI-style images API). The old hf-inference FLUX endpoint returns 410 Gone. */
  /** Some providers reject or choke on >~1.3k px sides: shrink (keeping aspect, multiples of 16) for them. */
  private capped(shape: Shape, max = 1344): { w: number; h: number } {
    const k = Math.min(1, max / Math.max(shape.genW, shape.genH));
    const r = (n: number) => Math.max(256, Math.round((n * k) / 16) * 16);
    return { w: r(shape.genW), h: r(shape.genH) };
  }

  private async hfRouter(provider: 'nscale' | 'together', prompt: string, shape: Shape, seed: number): Promise<Buffer> {
    const res = await axios.post(
      `https://router.huggingface.co/${provider}/v1/images/generations`,
      { model: 'black-forest-labs/FLUX.1-schnell', prompt, response_format: 'b64_json', width: this.capped(shape).w, height: this.capped(shape).h, size: `${this.capped(shape).w}x${this.capped(shape).h}`, seed, steps: 4, n: 1 },
      { headers: { Authorization: `Bearer ${config.huggingfaceApiKey}` }, timeout: 120000 }
    );
    const item = res.data?.data?.[0];
    if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
    if (item?.url) return this.fetchBytes(item.url);
    throw new Error('no image in response');
  }

  /** Google Gemini image model (free tier). Also accepts a reference photo to keep a real face consistent. */
  private async gemini(prompt: string, shape: Shape, refUrl?: string): Promise<Buffer> {
    const parts: any[] = [];
    if (refUrl) {
      if (this.anchor && refUrl === this.anchor.url) {
        // our own just-generated image: read from disk instead of calling ourselves over HTTP
        parts.push({ inline_data: { mime_type: 'image/png', data: fs.readFileSync(this.anchor.path).toString('base64') } });
      } else {
        const ref = await axios.get(refUrl, { responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'SaintPostBot/1.0' } });
        const mime = String(ref.headers['content-type'] || 'image/jpeg').split(';')[0];
        parts.push({ inline_data: { mime_type: mime, data: Buffer.from(ref.data).toString('base64') } });
      }
    }
    parts.push({ text: prompt });
    const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: shape.aspect } } },
      { headers: { 'x-goog-api-key': config.geminiApiKey }, timeout: 120000 }
    );
    const out: any[] = res.data?.candidates?.[0]?.content?.parts || [];
    const img = out.find(p => (p.inlineData || p.inline_data)?.data);
    const b64 = (img?.inlineData || img?.inline_data)?.data;
    if (!b64) throw new Error(`no image returned (${res.data?.candidates?.[0]?.finishReason || res.data?.promptFeedback?.blockReason || 'unknown reason'})`);
    return Buffer.from(b64, 'base64');
  }

  /** Cloudflare Workers AI FLUX.1 schnell (daily free allowance). */
  private async cloudflare(prompt: string, shape: Shape, seed: number): Promise<Buffer> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`;
    const headers = { Authorization: `Bearer ${config.cloudflareApiToken}` };
    const { w, h } = this.capped(shape, 1024);
    let res;
    try {
      res = await axios.post(url, { prompt: prompt.slice(0, 2000), steps: 6, seed, width: w, height: h }, { headers, timeout: 90000 });
    } catch (e: any) {
      // If this model build rejects width/height it can only do square images.
      if (e.response?.status === 400 && shape.aspect === '1:1') {
        res = await axios.post(url, { prompt: prompt.slice(0, 2000), steps: 6, seed }, { headers, timeout: 90000 });
      } else {
        throw e;
      }
    }
    const b64 = res.data?.result?.image;
    if (!b64) throw new Error(`no image in response: ${JSON.stringify(res.data?.errors || res.data).slice(0, 120)}`);
    return Buffer.from(b64, 'base64');
  }

  /** Together AI's free FLUX.1 schnell endpoint. */
  private async together(prompt: string, shape: Shape, seed: number): Promise<Buffer> {
    const { w, h } = this.capped(shape, 1344);
    const res = await axios.post(
      'https://api.together.xyz/v1/images/generations',
      { model: process.env.TOGETHER_IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell-Free', prompt, width: w, height: h, steps: 4, seed, n: 1, response_format: 'b64_json' },
      { headers: { Authorization: `Bearer ${config.togetherApiKey}` }, timeout: 120000 }
    );
    const item = res.data?.data?.[0];
    if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
    if (item?.url) return this.fetchBytes(item.url);
    throw new Error('no image in response');
  }

  private async falKontext(prompt: string, shape: Shape, refUrl: string): Promise<Buffer> {
    const res = await axios.post(
      'https://fal.run/fal-ai/flux-pro/kontext',
      { prompt, image_url: refUrl, aspect_ratio: shape.aspect, num_images: 1, output_format: 'png' },
      { headers: { Authorization: `Key ${config.falApiKey}` }, timeout: 120000 }
    );
    const url = res.data?.images?.[0]?.url;
    if (!url) throw new Error('no image url in fal kontext response');
    return this.fetchBytes(url);
  }

  private async replicateKontext(prompt: string, shape: Shape, refUrl: string): Promise<Buffer> {
    const headers = { Authorization: `Bearer ${config.replicateApiToken}`, 'Content-Type': 'application/json', Prefer: 'wait=60' };
    let pred = (
      await axios.post(
        'https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions',
        { input: { prompt, input_image: refUrl, aspect_ratio: shape.aspect, output_format: 'png' } },
        { headers, timeout: 90000 }
      )
    ).data;
    for (let i = 0; i < 30 && !['succeeded', 'failed', 'canceled'].includes(pred.status); i++) {
      await new Promise(r => setTimeout(r, 2000));
      pred = (await axios.get(pred.urls.get, { headers, timeout: 30000 })).data;
    }
    if (pred.status !== 'succeeded') throw new Error(`prediction ${pred.status}: ${pred.error || ''}`);
    return this.fetchBytes(Array.isArray(pred.output) ? pred.output[0] : pred.output);
  }

  private async replicate(prompt: string, shape: Shape, seed: number): Promise<Buffer> {
    const headers = { Authorization: `Bearer ${config.replicateApiToken}`, 'Content-Type': 'application/json' };
    let pred = (
      await axios.post(
        'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions',
        { input: { prompt, aspect_ratio: shape.aspect, seed, output_format: 'png', num_outputs: 1 } },
        { headers: { ...headers, Prefer: 'wait=60' }, timeout: 90000 }
      )
    ).data;
    for (let i = 0; i < 30 && !['succeeded', 'failed', 'canceled'].includes(pred.status); i++) {
      await new Promise(r => setTimeout(r, 2000));
      pred = (await axios.get(pred.urls.get, { headers, timeout: 30000 })).data;
    }
    if (pred.status !== 'succeeded') throw new Error(`prediction ${pred.status}: ${pred.error || ''}`);
    const out = Array.isArray(pred.output) ? pred.output[0] : pred.output;
    return this.fetchBytes(out);
  }

  private async pollinations(prompt: string, shape: Shape, seed: number, model: string, refUrl?: string): Promise<Buffer> {
    const p = encodeURIComponent(prompt.replace(/\s+/g, ' ').trim().slice(0, 900));
    const url = `https://image.pollinations.ai/prompt/${p}?width=${this.capped(shape).w}&height=${this.capped(shape).h}&seed=${seed}&model=${model}&nologo=true&enhance=false&safe=true${refUrl ? `&image=${encodeURIComponent(refUrl)}` : ''}`;
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000, headers: { 'User-Agent': 'SaintPost/1.0', ...(config.pollinationsApiKey ? { Authorization: `Bearer ${config.pollinationsApiKey}` } : {}) } });
    return Buffer.from(res.data);
  }
}
