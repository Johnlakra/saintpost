import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/env.js';
import { SaintRecord } from '../data/sanctusFetcher.js';
import { SceneScript } from './llmService.js';
import { ffmpeg } from '../utils/media.js';
import { generateImage, ImageProvidersExhausted } from '../providers/image/index.js';
import type { Shape } from '../providers/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ImageAssetResult {
  localPath: string;
  url: string;
}

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

export interface VisualReport {
  /** scenes that had to reuse an earlier image because no good provider was available */
  reused: number[];
  /** images by provider label */
  byProvider: Record<string, number>;
}

export class VisualAssetService {
  private outputDir: string;
  /** In-run face anchor: when no documented photo exists, the first cover image is the reference for every scene. */
  private anchor: { url: string; path: string } | null = null;
  report: VisualReport = { reused: [], byProvider: {} };

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
    this.report = { reused: [], byProvider: {} };
    console.log(`🖼️ Generating 1:1 Cover Image for ${saint.name}...`);
    const prompt = detailedPrompt
      ? `${this.characterDescriptor(saint)}. ${detailedPrompt}. ${this.styleFor(saint)}`
      : `Square devotional portrait, head and shoulders, calm dignified expression, centered with space around. ${this.characterDescriptor(saint)}. ${this.styleFor(saint)}`;
    try {
      return await this.makeImage('cover', saint, prompt, SHAPES.square, this.seedFor(saint));
    } catch (e: any) {
      if (e instanceof ImageProvidersExhausted) {
        throw new Error(`No good image provider is available right now (credits/quota used up), so I did not build a low-quality video. Details: ${e.failures.slice(0, 4).join(' | ')}`);
      }
      throw e;
    }
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
        if (!(err instanceof ImageProvidersExhausted)) throw err;
        // Never ship a low-quality image: reuse an earlier GOOD one (the video gets a different move/crop) and flag it.
        const prev = results[results.length - 1];
        if (!prev) throw err;
        console.warn(`   ⚠️ Scene ${i + 1}: no good provider available; reusing the previous scene image (video will be flagged).`);
        this.report.reused.push(i + 1);
        results.push(prev);
      }
    }
    return results;
  }

  private async makeImage(kind: string, saint: SaintRecord, prompt: string, shape: Shape, seed: number): Promise<ImageAssetResult> {
    const fileName = `${kind}_${slug(saint.name)}_${Date.now()}.png`;
    const localPath = path.join(this.outputDir, fileName);
    const documented = saint.reference_image_url;
    const refUrl = documented || (kind !== 'cover' ? this.anchor?.url : undefined);
    const refPath = !documented && refUrl && this.anchor && refUrl === this.anchor.url ? this.anchor.path : undefined;
    const finalPrompt = documented
      ? `Keep the EXACT same real person as in the reference photo: identical face, age, skin tone, hair and clothing. Do not add robes, halos, crosses or props that are not in the photo. ${prompt}`
      : refUrl
        ? `Keep the exact same character as in the reference image: identical face, age, skin tone, hair and clothing style. ${prompt}`
        : prompt;

    const { buffer, provider } = await generateImage({ prompt: finalPrompt, shape, seed, refUrl, refPath });
    this.report.byProvider[provider.label] = (this.report.byProvider[provider.label] || 0) + 1;

    const tmp = `${localPath}.raw`;
    fs.writeFileSync(tmp, buffer);
    try {
      await ffmpeg(['-i', tmp, '-vf', `scale=${shape.w}:${shape.h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${shape.w}:${shape.h}`, '-frames:v', '1', localPath]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    const result = { localPath, url: `${config.renderExternalUrl}/assets/${fileName}` };
    if (kind === 'cover' && !documented) this.anchor = { url: result.url, path: localPath };
    return result;
  }
}
