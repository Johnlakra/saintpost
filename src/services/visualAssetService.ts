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
  story: { w: 1080, h: 1920, genW: 768, genH: 1344, aspect: '9:16' },
  sheet: { w: 1280, h: 720, genW: 1280, genH: 720, aspect: '16:9' },
};

const STYLE =
  'classical devotional oil painting, reverent, warm natural light, rich detail, painterly, dignified, ' +
  'beautiful composition, no text, no letters, no watermark, no logo, anatomically correct hands and face';

const STYLE_MODERN =
  'warm realistic digital illustration, soft golden light, gentle uplifting mood, natural youthful features, rich detail, ' +
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

  async generateCoverImage(saint: SaintRecord, _characterSheetUrl?: string): Promise<ImageAssetResult> {
    console.log(`🖼️ Generating 1:1 Cover Image for ${saint.name}...`);
    const prompt = `Square devotional portrait, head and shoulders, serene holy expression, centered with space around. ${this.characterDescriptor(saint)}. ${this.styleFor(saint)}`;
    return this.makeImage('cover', saint, prompt, SHAPES.square, this.seedFor(saint));
  }

  async generateSceneImages(saint: SaintRecord, scenes: SceneScript[], _characterSheetUrl?: string): Promise<ImageAssetResult[]> {
    console.log(`🎬 Generating 9:16 Scene Images for ${scenes.length} scenes...`);
    const results: ImageAssetResult[] = [];
    const seed = this.seedFor(saint);

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      console.log(`   └ Generating scene ${i + 1}/${scenes.length}...`);
      const prompt = `Main figure: ${this.characterDescriptor(saint)}. Scene: ${scene.visual}. The main figure must match that description exactly in every scene. Vertical cinematic composition, subject in the middle third. ${this.styleFor(saint)}`;
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
    const ref = saint.reference_image_url;
    const finalPrompt = ref
      ? `Keep the EXACT same real person as in the reference photo: identical face, age, skin tone, hair and clothing. Do not add robes, halos, crosses or props that are not in the photo. ${prompt}`
      : prompt;
    const raw = await this.queryImageAPI(finalPrompt, shape, seed, ref);

    const tmp = `${localPath}.raw`;
    fs.writeFileSync(tmp, raw);
    try {
      await ffmpeg(['-i', tmp, '-vf', `scale=${shape.w}:${shape.h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${shape.w}:${shape.h}`, '-frames:v', '1', localPath]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return { localPath, url: `${config.renderExternalUrl}/assets/${fileName}` };
  }

  /** Tries each configured provider in order, validating that real image bytes came back. */
  private async queryImageAPI(prompt: string, shape: Shape, seed: number, refUrl?: string): Promise<Buffer> {
    const providers: Array<[string, () => Promise<Buffer>, number]> = [];
    // Documented photo available: use reference-conditioned (Kontext) models first so the face stays true and consistent.
    if (refUrl) {
      providers.push(['Pollinations kontext (reference photo)', () => this.pollinationsQueued(prompt, shape, seed, 'kontext', refUrl), 3]);
      if (config.falApiKey) providers.push(['fal.ai FLUX Kontext (reference photo)', () => this.falKontext(prompt, shape, refUrl), 1]);
      if (config.replicateApiToken) providers.push(['Replicate FLUX Kontext (reference photo)', () => this.replicateKontext(prompt, shape, refUrl), 1]);
    }
    if (config.falApiKey) providers.push(['fal.ai FLUX schnell', () => this.fal(prompt, shape, seed), 1]);
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
      for (let attempt = 1; attempt <= tries; attempt++) {
        try {
          const buf = await fn();
          if (!isImage(buf)) throw new Error('response was not a valid image');
          console.log(`     ✓ ${name} (${Math.round(buf.length / 1024)} KB)`);
          return buf;
        } catch (e: any) {
          const msg = this.describeError(e);
          console.warn(`     ✗ ${name} attempt ${attempt}/${tries}: ${msg}`);
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
      'https://fal.run/fal-ai/flux/schnell',
      { prompt, image_size: { width: shape.genW, height: shape.genH }, num_inference_steps: 4, seed, enable_safety_checker: true },
      { headers: { Authorization: `Key ${config.falApiKey}` }, timeout: 90000 }
    );
    const url = res.data?.images?.[0]?.url;
    if (!url) throw new Error('no image url in fal response');
    return this.fetchBytes(url);
  }

  /** HuggingFace Inference Providers (OpenAI-style images API). The old hf-inference FLUX endpoint returns 410 Gone. */
  private async hfRouter(provider: 'nscale' | 'together', prompt: string, shape: Shape, seed: number): Promise<Buffer> {
    const res = await axios.post(
      `https://router.huggingface.co/${provider}/v1/images/generations`,
      { model: 'black-forest-labs/FLUX.1-schnell', prompt, response_format: 'b64_json', width: shape.genW, height: shape.genH, size: `${shape.genW}x${shape.genH}`, seed, steps: 4, n: 1 },
      { headers: { Authorization: `Bearer ${config.huggingfaceApiKey}` }, timeout: 120000 }
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
    const url = `https://image.pollinations.ai/prompt/${p}?width=${shape.genW}&height=${shape.genH}&seed=${seed}&model=${model}&nologo=true&enhance=false&safe=true${refUrl ? `&image=${encodeURIComponent(refUrl)}` : ''}`;
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000, headers: { 'User-Agent': 'SaintPost/1.0', ...(config.pollinationsApiKey ? { Authorization: `Bearer ${config.pollinationsApiKey}` } : {}) } });
    return Buffer.from(res.data);
  }
}
