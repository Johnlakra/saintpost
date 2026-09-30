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
  'classical Catholic devotional oil painting, reverent, warm golden candlelight, soft glowing halo, rich detail, painterly, dignified, ' +
  'beautiful composition, no text, no letters, no watermark, no logo, no modern objects, anatomically correct hands and face';

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
    const symbols = Array.isArray(saint.symbols) && saint.symbols.length ? `, with symbols: ${saint.symbols.slice(0, 3).join(', ')}` : '';
    return `${saint.name}, Catholic saint from ${saint.region || 'the Holy Land'}, ${saint.era || 'ancient'} era, wearing period-accurate humble clothing and a thin golden halo${symbols}`;
  }

  async generateCharacterSheet(saint: SaintRecord): Promise<ImageAssetResult> {
    console.log(`🎨 Generating Character Sheet for Saint: ${saint.name}...`);
    const prompt = `Character reference sheet, three panels side by side: front view, side profile, full body. ${this.characterDescriptor(saint)}. Plain light neutral background, ${STYLE}`;
    return this.makeImage('character_sheet', saint, prompt, SHAPES.sheet, this.seedFor(saint));
  }

  async generateCoverImage(saint: SaintRecord, _characterSheetUrl?: string): Promise<ImageAssetResult> {
    console.log(`🖼️ Generating 1:1 Cover Image for ${saint.name}...`);
    const prompt = `Square devotional portrait, head and shoulders, serene holy expression, centered with space around. ${this.characterDescriptor(saint)}. ${STYLE}`;
    return this.makeImage('cover', saint, prompt, SHAPES.square, this.seedFor(saint));
  }

  async generateSceneImages(saint: SaintRecord, scenes: SceneScript[], _characterSheetUrl?: string): Promise<ImageAssetResult[]> {
    console.log(`🎬 Generating 9:16 Scene Images for ${scenes.length} scenes...`);
    const results: ImageAssetResult[] = [];
    const seed = this.seedFor(saint);

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      console.log(`   └ Generating scene ${i + 1}/${scenes.length}...`);
      const prompt = `${scene.visual}. Main figure: ${this.characterDescriptor(saint)}. Vertical cinematic composition, subject in the middle third. ${STYLE}`;
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
    const raw = await this.queryImageAPI(prompt, shape, seed);

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
  private async queryImageAPI(prompt: string, shape: Shape, seed: number): Promise<Buffer> {
    const providers: Array<[string, () => Promise<Buffer>]> = [];
    if (config.falApiKey) providers.push(['fal.ai FLUX schnell', () => this.fal(prompt, shape, seed)]);
    if (config.huggingfaceApiKey) providers.push(['HuggingFace FLUX schnell', () => this.huggingFace(prompt, shape, seed)]);
    if (config.replicateApiToken) providers.push(['Replicate FLUX schnell', () => this.replicate(prompt, shape, seed)]);
    providers.push(['Pollinations flux', () => this.pollinations(prompt, shape, seed, 'flux')]);
    providers.push(['Pollinations turbo', () => this.pollinations(prompt, shape, seed, 'turbo')]);

    const errors: string[] = [];
    for (const [name, fn] of providers) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const buf = await fn();
          if (!isImage(buf)) throw new Error('response was not a valid image');
          console.log(`     ✓ ${name} (${Math.round(buf.length / 1024)} KB)`);
          return buf;
        } catch (e: any) {
          const msg = e.response?.status ? `HTTP ${e.response.status}` : e.message;
          console.warn(`     ✗ ${name} attempt ${attempt}: ${msg}`);
          if (attempt === 2) errors.push(`${name}: ${msg}`);
          else await new Promise(r => setTimeout(r, 2500));
        }
      }
    }
    throw new Error(`All image providers failed -> ${errors.join(' | ')}`);
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

  private async huggingFace(prompt: string, shape: Shape, seed: number): Promise<Buffer> {
    const res = await axios.post(
      'https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell',
      { inputs: prompt, parameters: { width: shape.genW, height: shape.genH, seed, num_inference_steps: 4 } },
      { headers: { Authorization: `Bearer ${config.huggingfaceApiKey}`, Accept: 'image/png' }, responseType: 'arraybuffer', timeout: 120000 }
    );
    return Buffer.from(res.data);
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

  private async pollinations(prompt: string, shape: Shape, seed: number, model: string): Promise<Buffer> {
    const p = encodeURIComponent(prompt.replace(/\s+/g, ' ').trim().slice(0, 900));
    const url = `https://image.pollinations.ai/prompt/${p}?width=${shape.genW}&height=${shape.genH}&seed=${seed}&model=${model}&nologo=true&enhance=false&safe=true`;
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000, headers: { 'User-Agent': 'SaintPost/1.0' } });
    return Buffer.from(res.data);
  }
}
