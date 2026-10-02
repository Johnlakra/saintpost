import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/env.js';
import { SaintRecord } from '../data/sanctusFetcher.js';
import { SceneScript, ScenePrompt } from './llmService.js';
import { inspectImage, qaEnabled, qaRetries } from './imageQA.js';
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
  'classical oil painting style illustration, warm natural light, sharp focus, intricate fine detail, high resolution, painterly, ' +
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
  /** quality inspector: images inspected, regenerated, and any still flawed after all attempts */
  qa: { checked: number; retried: number; flagged: string[]; engine?: string };
}
const emptyReport = (): VisualReport => ({ reused: [], byProvider: {}, qa: { checked: 0, retried: 0, flagged: [] } });

/** What the image should show; used by the inspector and to build retry prompts. */
interface QASpec {
  label: string; // "cover" | "scene 3"
  subject: string; // short description for the inspector
  mustInclude: string[];
  inspect: boolean; // false = low-risk scene: skip the inspector (saves a vision call)
  useRef: boolean; // apply the face reference (only when the saint themself is in the picture)
  safePrompt?: string; // simpler composition for the retry
}

/** Run fn over items with at most `n` in flight; results keep the input order. */
async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<Array<{ ok: R } | { err: any }>> {
  const out: Array<{ ok: R } | { err: any }> = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { ok: await fn(items[i], i) }; } catch (err) { out[i] = { err }; }
    }
  }));
  return out;
}

export class VisualAssetService {
  private outputDir: string;
  /** In-run face anchor: when no documented photo exists, the first cover image is the reference for every scene. */
  private anchor: { url: string; path: string } | null = null;
  report: VisualReport = emptyReport();

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
    // A feast that is not about one person (angels, a mystery...) has no "main figure": the scene prompts name the cast.
    if (!saint.appearance) return '';
    return `${saint.appearance}${config.saintHalo ? ', a subtle thin golden halo' : ', no halo'}`;
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

  async generateCoverImage(saint: SaintRecord, _characterSheetUrl?: string, brief?: ScenePrompt): Promise<ImageAssetResult> {
    this.anchor = null;
    this.report = emptyReport();
    console.log(`🖼️ Generating 1:1 Cover Image for ${saint.name}...`);
    const desc = this.characterDescriptor(saint);
    const wrap = (body: string) => `${desc ? `${desc}. ` : ''}${body}. ${this.styleFor(saint)}`;
    const prompt = brief?.prompt
      ? wrap(brief.prompt)
      : desc
        ? `Square portrait, head and shoulders, calm expression, centered with space around. ${desc}. ${this.styleFor(saint)}`
        : `A clear scene about ${saint.name}, square composition. ${this.styleFor(saint)}`;
    const qa: QASpec = {
      label: 'cover', subject: `a calm portrait of ${saint.name}`,
      mustInclude: brief?.mustInclude || [], inspect: true, useRef: true, safePrompt: brief?.safe ? wrap(brief.safe) : undefined,
    };
    try {
      return await this.makeImage('cover', saint, prompt, SHAPES.square, this.seedFor(saint), qa);
    } catch (e: any) {
      if (e instanceof ImageProvidersExhausted) {
        throw new Error(`No good image provider is available right now (credits/quota used up), so I did not build a low-quality video. Details: ${e.failures.slice(0, 4).join(' | ')}`);
      }
      throw e;
    }
  }

  async generateSceneImages(saint: SaintRecord, scenes: SceneScript[], _characterSheetUrl?: string): Promise<ImageAssetResult[]> {
    const conc = Math.max(1, parseInt(process.env.IMAGE_CONCURRENCY || '2', 10));
    const inspectAll = process.env.IMAGE_QA_MODE === 'all';
    console.log(`🎬 Generating 9:16 Scene Images for ${scenes.length} scenes (${conc} at a time)...`);
    const seed = this.seedFor(saint);

    const settled = await pool(scenes, conc, async (scene, i) => {
      console.log(`   └ Generating scene ${i + 1}/${scenes.length}...`);
      const desc = this.characterDescriptor(saint);
      const wrap = (body: string) => `${desc ? `Main figure: ${desc}. ` : ''}Scene: ${body}. ${desc ? 'The main figure must match that description exactly in every scene. ' : ''}Vertical cinematic composition, subject in the middle third. ${this.styleFor(saint)}`;
      const prompt = wrap(scene.image_prompt || scene.visual);
      const qa: QASpec = {
        label: `scene ${i + 1}`,
        subject: (scene.must_include?.length ? scene.must_include.join(', ') : scene.voiceover).slice(0, 300),
        mustInclude: scene.must_include || [],
        // low-risk scenes skip the inspector: it only looks where flaws are likely
        inspect: inspectAll || scene.risk !== 'low',
        useRef: scene.uses_main !== false,
        safePrompt: scene.safe_prompt ? wrap(scene.safe_prompt) : undefined,
      };
      return this.makeImage(`scene_${i + 1}`, saint, prompt, SHAPES.story, seed + i, qa);
    });

    // Scenes that could not get a good image reuse the nearest good one (and are flagged); anything else is a real error.
    const results: ImageAssetResult[] = new Array(scenes.length);
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if ('ok' in r) results[i] = r.ok;
      else if (!(r.err instanceof ImageProvidersExhausted)) throw r.err;
    }
    const firstGood = results.find(Boolean);
    if (!firstGood) throw (settled.find(r => 'err' in r) as { err: any }).err;
    for (let i = 0; i < results.length; i++) {
      if (results[i]) continue;
      let src: ImageAssetResult | undefined;
      for (let k = i - 1; k >= 0 && !src; k--) src = results[k];
      results[i] = src || firstGood;
      console.warn(`   ⚠️ Scene ${i + 1}: no good provider available; reusing a neighbouring scene image (video will be flagged).`);
      this.report.reused.push(i + 1);
    }
    return results;
  }

  /**
   * Generate one image, then INSPECT it. If the inspector finds a clear defect (extra hands, wings through a body,
   * merged figures, melted face, stray text, wrong subject) it regenerates: attempt 2 = same scene, new seed, with the
   * inspector's fix instruction; attempt 3 = the simpler "safe" composition. The best attempt wins; anything still
   * flawed is flagged so the video is not auto-published. The inspector is fail-open (no inspector = accept).
   */
  private async makeImage(kind: string, saint: SaintRecord, prompt: string, shape: Shape, seed: number, qa?: QASpec): Promise<ImageAssetResult> {
    if (!qa || !qaEnabled() || !qa.inspect) return this.renderOnce(kind, saint, prompt, shape, seed, qa?.useRef !== false);

    const attempts = 1 + qaRetries();
    let fixHint = '';
    let best: { res: ImageAssetResult; issues: string[] } | null = null;
    for (let a = 0; a < attempts; a++) {
      const last = a === attempts - 1 && attempts > 1;
      const text = last && qa.safePrompt ? `${qa.safePrompt}${fixHint ? ` Important corrections: ${fixHint}` : ''}` : fixHint ? `${prompt} Important corrections: ${fixHint}` : prompt;
      let res: ImageAssetResult;
      try {
        res = await this.renderOnce(kind, saint, text, shape, seed + a * 1000, qa.useRef);
      } catch (e: any) {
        if (best) { console.warn(`     ⚠️ ${qa.label}: could not regenerate (${e.message.slice(0, 80)}); keeping the best earlier attempt.`); break; }
        throw e;
      }
      const verdict = await inspectImage(res.localPath, qa.subject, qa.mustInclude);
      if (verdict.checked) {
        this.report.qa.checked++;
        this.report.qa.engine = verdict.engine;
      }
      if (!verdict.checked || verdict.pass) {
        if (verdict.checked) console.log(`     🔎 ${qa.label}: inspector OK${a ? ` (attempt ${a + 1})` : ''}`);
        return res;
      }
      console.warn(`     🔎 ${qa.label}: inspector found problems: ${verdict.issues.join('; ') || 'unspecified'}${a < attempts - 1 ? ' -> regenerating' : ''}`);
      if (!best || verdict.issues.length < best.issues.length) best = { res, issues: verdict.issues };
      this.report.qa.retried++;
      fixHint = verdict.fix || verdict.issues.join('; ');
    }
    this.report.qa.flagged.push(qa.label);
    return best!.res;
  }

  private async renderOnce(kind: string, saint: SaintRecord, prompt: string, shape: Shape, seed: number, useRef = true): Promise<ImageAssetResult> {
    const fileName = `${kind}_${slug(saint.name)}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`;
    const localPath = path.join(this.outputDir, fileName);
    // The face reference only applies when the saint themself is in the picture (not for a pope, a crowd, an altar...)
    const documented = useRef ? saint.reference_image_url : undefined;
    const refUrl = documented || (useRef && kind !== 'cover' ? this.anchor?.url : undefined);
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
    // the first cover (when we have no documented photo) becomes the face anchor, but never for a non-person feast
    if (kind === 'cover' && !saint.reference_image_url && saint.appearance) this.anchor = { url: result.url, path: localPath };
    return result;
  }
}
