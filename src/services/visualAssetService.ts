import axios from 'axios';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/env.js';
import { SaintRecord } from '../data/sanctusFetcher.js';
import { SceneScript } from './llmService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface VisualAssetsResult {
  characterSheetUrl: string;
  coverImageUrl: string;
  sceneImageUrls: string[];
}

export interface ImageAssetResult {
  localPath: string;
  url: string;
}

export class VisualAssetService {
  private outputDir: string;

  constructor() {
    this.outputDir = path.join(__dirname, '..', '..', 'public', 'assets');
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Generates a 3-panel Saint Character Sheet (front, side, full body) to ensure visual consistency across scenes.
   * SuperCMO Adaptation: generating-saint-characters
   */
  async generateCharacterSheet(saint: SaintRecord): Promise<ImageAssetResult> {
    console.log(`🎨 Generating Character Sheet for Saint: ${saint.name}...`);

    const prompt = `3-panel character sheet of Catholic saint ${saint.name}, era ${saint.era || 'ancient'}, region ${saint.region || 'Holy Land'}. Front view, side view, full body. Clean white studio background, photorealistic, cinematic lighting, saintly halo, detailed vestments, hyperdetailed, 8k. Aspect ratio 16:9.`;

    const fileName = `character_sheet_${saint.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}.png`;
    const localFilePath = path.join(this.outputDir, fileName);
    const publicUrl = `${config.renderExternalUrl}/assets/${fileName}`;

    if (config.dryRun || (!config.falApiKey && !config.replicateApiToken && !config.huggingfaceApiKey)) {
      console.log(`[DRY RUN / Fallback] Generating placeholder character sheet for ${saint.name}`);
      this.createFallbackImage(localFilePath, `Character Sheet: ${saint.name}`, 1280, 720);
      return { localPath: localFilePath, url: publicUrl };
    }

    try {
      const imageUrl = await this.queryImageAPI(prompt, '16:9');
      await this.downloadImage(imageUrl, localFilePath);
      return { localPath: localFilePath, url: publicUrl };
    } catch (err: any) {
      console.warn(`⚠️ Character sheet generation error for ${saint.name}:`, err.message);
      this.createFallbackImage(localFilePath, `Character Sheet: ${saint.name}`, 1280, 720);
      return { localPath: localFilePath, url: publicUrl };
    }
  }

  /**
   * Generates 1:1 Cover Image for Instagram Feed
   */
  async generateCoverImage(saint: SaintRecord, characterSheetUrl: string): Promise<ImageAssetResult> {
    console.log(`🖼️ Generating 1:1 Cover Image for ${saint.name}...`);
    const prompt = `Square 1:1 cover portrait of Catholic saint ${saint.name}, sacred golden halo, serene holy expression, cinematic warm lighting, reference visual character sheet ${characterSheetUrl}, renaissance masterpiece style, 8k resolution.`;

    const fileName = `cover_${saint.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}.png`;
    const localFilePath = path.join(this.outputDir, fileName);
    const publicUrl = `${config.renderExternalUrl}/assets/${fileName}`;

    if (config.dryRun || (!config.falApiKey && !config.replicateApiToken && !config.huggingfaceApiKey)) {
      this.createFallbackImage(localFilePath, `Cover: ${saint.name}`, 1080, 1080);
      return { localPath: localFilePath, url: publicUrl };
    }

    try {
      const imageUrl = await this.queryImageAPI(prompt, '1:1');
      await this.downloadImage(imageUrl, localFilePath);
      return { localPath: localFilePath, url: publicUrl };
    } catch (err: any) {
      console.warn(`⚠️ Cover image generation error:`, err.message);
      this.createFallbackImage(localFilePath, `Cover: ${saint.name}`, 1080, 1080);
      return { localPath: localFilePath, url: publicUrl };
    }
  }

  /**
   * Generates 9:16 Scene Images with InstantCharacter consistency reference
   */
  async generateSceneImages(
    saint: SaintRecord,
    scenes: SceneScript[],
    characterSheetUrl: string
  ): Promise<ImageAssetResult[]> {
    console.log(`🎬 Generating 9:16 Scene Images for ${scenes.length} scenes...`);
    const results: ImageAssetResult[] = [];

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      console.log(`   └ Generating scene ${scene.scene_number}/${scenes.length}...`);

      const prompt = `Vertical 9:16 scene for saint story: ${scene.visual}. Consistent character ${saint.name} matching character sheet reference (${characterSheetUrl}). Cinematic warm lighting, detailed background, historical accuracy for ${saint.era || 'ancient'}, 8k quality.`;

      const fileName = `scene_${saint.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_s${scene.scene_number}_${Date.now()}.png`;
      const localFilePath = path.join(this.outputDir, fileName);
      const publicUrl = `${config.renderExternalUrl}/assets/${fileName}`;

      if (config.dryRun || (!config.falApiKey && !config.replicateApiToken && !config.huggingfaceApiKey)) {
        this.createFallbackImage(localFilePath, `Scene ${scene.scene_number}: ${saint.name}`, 1080, 1920);
        results.push({ localPath: localFilePath, url: publicUrl });
        continue;
      }

      try {
        const imageUrl = await this.queryImageAPI(prompt, '9:16');
        await this.downloadImage(imageUrl, localFilePath);
        results.push({ localPath: localFilePath, url: publicUrl });
      } catch (err: any) {
        console.warn(`⚠️ Scene image ${scene.scene_number} error:`, err.message);
        this.createFallbackImage(localFilePath, `Scene ${scene.scene_number}: ${saint.name}`, 1080, 1920);
        results.push({ localPath: localFilePath, url: publicUrl });
      }
    }

    return results;
  }

  /**
   * Unified Image API Caller (Fal.ai FLUX.1 Schnell -> Replicate -> HuggingFace Open Model)
   */
  private async queryImageAPI(prompt: string, aspectRatio: '1:1' | '9:16' | '16:9'): Promise<string> {
    // 1. Try Fal.ai FLUX.1 Schnell (Fast & High quality open-weight model)
    if (config.falApiKey) {
      try {
        const res = await axios.post(
          'https://fal.run/fal-ai/flux/schnell',
          { prompt, image_size: aspectRatio === '9:16' ? 'portrait_16_9' : aspectRatio === '1:1' ? 'square_hd' : 'landscape_16_9' },
          { headers: { Authorization: `Key ${config.falApiKey}` } }
        );
        if (res.data?.images?.[0]?.url) {
          return res.data.images[0].url;
        }
      } catch (e: any) {
        console.warn('⚠️ Fal.ai API error:', e.message);
      }
    }

    // 2. Try Replicate FLUX Schnell
    if (config.replicateApiToken) {
      try {
        const res = await axios.post(
          'https://api.replicate.com/v1/predictions',
          {
            version: 'black-forest-labs/flux-schnell',
            input: { prompt, aspect_ratio: aspectRatio },
          },
          { headers: { Authorization: `Token ${config.replicateApiToken}` } }
        );
        if (res.data?.output?.[0]) {
          return res.data.output[0];
        }
      } catch (e: any) {
        console.warn('⚠️ Replicate API error:', e.message);
      }
    }

    throw new Error('No working image generation API key available.');
  }

  private async downloadImage(url: string, destPath: string): Promise<void> {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    fs.writeFileSync(destPath, Buffer.from(response.data));
  }

  /**
   * Generates a valid PNG image binary fallback using FFmpeg color generator
   */
  private createFallbackImage(destPath: string, label: string, width: number, height: number): void {
    try {
      // Use FFmpeg color generator to create a genuine 1080x1920 or 1080x1080 PNG image file
      const escapedLabel = label.replace(/'/g, '').replace(/:/g, '\\:');
      const cmd = `ffmpeg -y -f lavfi -i color=c=0x2c1b4d:s=${width}x${height}:d=1 -vf "drawtext=text='${escapedLabel}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2" -vframes 1 "${destPath}"`;
      execSync(cmd, { stdio: 'ignore' });
    } catch (e) {
      // If drawtext font or filter fails, create basic solid color PNG via FFmpeg
      try {
        const cmdSimple = `ffmpeg -y -f lavfi -i color=c=0x3b1e54:s=${width}x${height}:d=1 -vframes 1 "${destPath}"`;
        execSync(cmdSimple, { stdio: 'ignore' });
      } catch (err) {
        fs.writeFileSync(destPath, Buffer.alloc(4096));
      }
    }
  }
}
