import { SaintFetcherService, SaintRecord } from '../data/sanctusFetcher.js';
import { LLMService, GeneratedContent } from '../services/llmService.js';
import { VisualAssetService } from '../services/visualAssetService.js';
import { VideoService } from '../services/videoService.js';
import { aiVideoAvailable } from '../providers/video/index.js';
import { LENGTHS, LengthId, DEFAULT_LENGTH } from '../config/lengths.js';
import { TTSService } from '../services/ttsService.js';
import { VideoAssemblyService, AssemblyScene } from '../services/videoAssemblyService.js';
import { FactService } from '../services/factService.js';
import { PublishingService } from '../services/publishingService.js';
import { config } from '../config/env.js';
import { db } from '../db/index.js';

export interface PipelineOptions {
  /** false = build the video and stop for admin review (menu/preview flows). Default true (daily cron). */
  publish?: boolean;
  onProgress?: (message: string) => void;
  /** short (~45s) | standard (~90s) | long (~2.5 min) */
  length?: LengthId;
}

export interface PostPayloadData {
  saintName: string;
  videoUrl: string;
  coverImageUrl: string;
  caption: string;
  hashtags: string;
}

export interface PipelineResult {
  saint: SaintRecord;
  content: GeneratedContent;
  characterSheetUrl: string;
  referenceImageUrl?: string;
  coverImageUrl: string;
  finalVideoUrl: string;
  publishResult: { successCount: number; errors: string[] };
  published: boolean;
  payload: PostPayloadData;
  /** true when quality was compromised (e.g. reused images); such videos are never auto-published */
  degraded: boolean;
  notes: string[];
  sceneCount: number;
  animatedScenes: number;
  /** image inspector summary: images checked / regenerated / still flawed */
  qa: { checked: number; retried: number; flagged: string[] };
}

let pipelineBusy = false;

export class SaintPostPipeline {
  private saintFetcher: SaintFetcherService;
  private llmService: LLMService;
  private visualService: VisualAssetService;
  private videoService: VideoService;
  private ttsService: TTSService;
  private assemblyService: VideoAssemblyService;
  private publishingService: PublishingService;
  private factService = new FactService();

  constructor() {
    this.saintFetcher = new SaintFetcherService();
    this.llmService = new LLMService();
    this.visualService = new VisualAssetService();
    this.videoService = new VideoService();
    this.ttsService = new TTSService();
    this.assemblyService = new VideoAssemblyService();
    this.publishingService = new PublishingService();
  }

  /**
   * Executes the complete 10-Step Automated Flow for a saint in Simple Hindi (Default), English, or Punjabi
   */
  /** 'roman' (Hinglish/Pinglish) or 'native' subtitles for Hindi/Punjabi; admin-switchable from the bot menu. */
  async subtitleMode(): Promise<'roman' | 'native'> {
    try {
      const r = await db.query(`SELECT value FROM settings WHERE key = 'subtitle_script'`);
      if (r.rows[0]?.value === 'native' || r.rows[0]?.value === 'roman') return r.rows[0].value;
    } catch { /* no table yet */ }
    return config.subtitleScript;
  }

  /** Publish an already-rendered post (used by the Telegram Publish button). */
  async publishPayload(payload: PostPayloadData) {
    const result = await this.publishingService.publishToAllActiveAccounts(payload);
    if (result.successCount > 0) {
      await db.query(`UPDATE posts SET status = 'posted', posted_at = NOW() WHERE video_url = $1`, [payload.videoUrl]).catch(() => {});
    }
    return result;
  }

  async runPipelineForSaint(
    saintInput?: SaintRecord | string,
    targetLang: 'en' | 'hi' | 'pa' = config.defaultLanguage || 'hi',
    opts: PipelineOptions = {}
  ): Promise<PipelineResult> {
    // One render at a time: parallel runs exhaust RAM on the free tier and trip image-API rate limits.
    if (pipelineBusy) throw new Error('Another video is still being generated. Please wait for it to finish.');
    pipelineBusy = true;
    try {
      return await this.runPipeline(saintInput, targetLang, opts);
    } finally {
      pipelineBusy = false;
    }
  }

  private async runPipeline(
    saintInput: SaintRecord | string | undefined,
    targetLang: 'en' | 'hi' | 'pa',
    opts: PipelineOptions
  ): Promise<PipelineResult> {
    const progress = (m: string) => { try { opts.onProgress?.(m); } catch { /* never break the pipeline on UI errors */ } };
    const shouldPublish = opts.publish !== false;
    console.log(`\n======================================================`);
    console.log(`🚀 STARTING SAINTPOST AUTOMATION PIPELINE [LANG: ${targetLang.toUpperCase()}]`);
    console.log(`======================================================\n`);

    // STEP 1: FETCH SAINT DATA
    let saint: SaintRecord;
    if (typeof saintInput === 'string') {
      saint = await this.saintFetcher.getSaintByName(saintInput);
    } else if (saintInput) {
      saint = saintInput;
    } else {
      saint = await this.saintFetcher.getSaintForDate(new Date());
    }
    console.log(`✅ Step 1: Loaded Saint Data -> ${saint.name}`);
    progress(`📖 Found: ${saint.name}. Researching documented facts...`);

    // STEP 1a: documented facts + documented photo (cached on the saint row)
    await this.factService.ensureFacts(saint);

    // STEP 1b: cached fact sheet + casting sheet (one LLM call per saint, ever). Regenerating or making another
    // language/length of the same saint reuses it, so the long source text is not re-read.
    await db.query(`ALTER TABLE saints ADD COLUMN IF NOT EXISTS appearance TEXT`).catch(() => {});
    await db.query(`ALTER TABLE saints ADD COLUMN IF NOT EXISTS dossier JSONB`).catch(() => {});
    const dossier = await this.llmService.getDossier(saint);
    if (dossier) {
      saint.dossier = dossier;
      saint.appearance = dossier.appearance || '';
      if (saint.id) db.query(`UPDATE saints SET dossier = $2, appearance = $3 WHERE id = $1`, [saint.id, JSON.stringify(dossier), saint.appearance]).catch(() => {});
    }
    if (saint.appearance) console.log(`🧑 Appearance: ${saint.appearance}`);
    console.log(`🖼️ Face reference: ${saint.reference_image_url || 'none (text-only, appearance from documented facts)'}`);

    // STEP 2: GENERATE CONTENT (LLM in Target Language): script + caption + hashtags (+ Hinglish/Pinglish subtitles) in ONE call
    const preset = LENGTHS[opts.length || DEFAULT_LENGTH];
    const wantRoman = targetLang !== 'en' && (await this.subtitleMode()) === 'roman';
    progress(`✍️ Writing a ${preset.label.toLowerCase()} script (${preset.approx}, ${preset.scenes} scenes)...`);
    const content = await this.llmService.generateSaintContentPackage(saint, targetLang, preset, dossier, { roman: wantRoman });
    console.log(`✅ Step 2: LLM Content Generated (${content.video_script.length} scenes in ${targetLang.toUpperCase()})`);
    progress('✍️ Script written. Designing detailed scenes...');

    // STEP 2a: subtitles normally arrive inside the script call; only if some are missing do we spend another call
    if (wantRoman) {
      if (content.video_script.some(sc => !sc.subtitle)) {
        const roman = await this.llmService.romanizeScenes(content.video_script, targetLang as 'hi' | 'pa');
        content.video_script.forEach((sc, i) => { if (!sc.subtitle) sc.subtitle = roman[i]; });
      }
      console.log(`✅ Step 2a: ${targetLang === 'hi' ? 'Hinglish' : 'Pinglish'} subtitles ready`);
    }

    // Narration can be recorded while the pictures are being painted (it only needs the script)
    const audiosPromise = this.ttsService.generateSceneVoiceovers(content.video_script.map(sc => sc.voiceover), saint.name, targetLang);
    audiosPromise.catch(() => undefined); // awaited later; avoid an unhandled rejection if images fail first

    // STEP 2b: fact-grounded detailed image prompts (saint dossier + the day's feast)
    const brief = await this.llmService.buildVisualBrief(saint, content.video_script, {
      dateLabel: `${saint.feast_month}/${saint.feast_day}`,
      rank: saint.rank,
      color: saint.liturgical_color,
      martyrology: (saint as any).source_text || saint.short_description,
    }, dossier);
    if (brief) {
      content.video_script.forEach((sc, i) => {
        const b = brief.scenes[i];
        sc.image_prompt = b.prompt;
        sc.safe_prompt = b.safe || undefined;
        sc.must_include = b.mustInclude;
        sc.risk = b.risk;
        sc.uses_main = b.usesMain;
      });
    }
    console.log(`✅ Step 2b: Visual brief ${brief ? 'built for ' + brief.scenes.length + ' scenes' : 'skipped (using basic visuals)'}`);

    // STEP 3/4: cover first (it becomes the face anchor for every scene when no documented photo exists)
    progress('🎨 Painting cover and scene images (this is the slow part)...');
    const coverResult = await this.visualService.generateCoverImage(saint, undefined, brief?.cover);
    const coverImageUrl = coverResult.url;
    let characterSheetUrl = '';
    if (config.generateCharacterSheet) {
      characterSheetUrl = (await this.visualService.generateCharacterSheet(saint)).url;
    }
    console.log(`✅ Step 3: Cover generated${characterSheetUrl ? ' + character sheet' : ' (character sheet skipped to save image calls)'}`);
    const sceneAssets = await this.visualService.generateSceneImages(
      saint,
      content.video_script,
      characterSheetUrl
    );
    if (this.visualService.report.reused.length > Math.floor(sceneAssets.length * 0.4)) {
      throw new Error(`Too many scenes (${this.visualService.report.reused.length}/${sceneAssets.length}) could not get a good image (image credits/quota used up). I stopped instead of making a poor video. Check the Providers screen in the menu.`);
    }
    console.log(`✅ Step 4: Visual Images Generated (1 Cover + ${sceneAssets.length} Scenes)`);
    progress('🎙️ Recording the narration...');

    // STEP 5: GENERATE PER-SCENE VOICEOVER (neural TTS). Video timing is driven by the audio.
    const scenes = content.video_script;
    const audios = await audiosPromise;
    console.log(`✅ Step 5: ${audios.length} scene voiceovers generated (${targetLang.toUpperCase()})`);
    progress('🎞️ Animating scenes...');

    // STEP 6: GENERATE VIDEO CLIPS, each exactly as long as its narration (+0.5s breathing room).
    // The first few scenes get real AI motion when a provider is available; the rest use the Ken Burns move.
    const notes: string[] = [];
    const reusedScenes = this.visualService.report.reused;
    const maxAi = parseInt(process.env.VIDEO_AI_SCENES || '3', 10);
    let animatedScenes = 0;
    const assemblyScenes: AssemblyScene[] = [];
    for (let i = 0; i < sceneAssets.length; i++) {
      const durationSec = Math.max(3, audios[i].durationSec + 0.5);
      const animate = animatedScenes < maxAi && !reusedScenes.includes(i + 1) && aiVideoAvailable();
      const clip = await this.videoService.generateSceneClip(sceneAssets[i].localPath, durationSec, i + 1, {
        animate,
        imageUrl: sceneAssets[i].url,
        prompt: scenes[i].image_prompt || scenes[i].visual,
      });
      if (clip.animated) animatedScenes++;
      assemblyScenes.push({
        clipPath: clip.path,
        audioPath: audios[i].audioPath,
        durationSec,
        narration: scenes[i].subtitle || scenes[i].voiceover || '',
        overlay: scenes[i].text_overlay || '',
      });
    }
    const flagged = this.visualService.report.qa.flagged;
    if (flagged.length) notes.push(`The image inspector still saw a visible flaw in: ${flagged.join(', ')} (after ${this.visualService.report.qa.retried} regeneration(s))`);
    if (reusedScenes.length) notes.push(`${reusedScenes.length} scene(s) reused an earlier image (${reusedScenes.join(', ')}) because the image services ran out of credit/quota`);
    console.log(`✅ Step 6: ${assemblyScenes.length} video clips generated`);
    progress('🎬 Assembling the final video...');

    // STEP 7: ASSEMBLE VIDEO (FFmpeg)
    const outputFileName = `saintpost_${saint.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${targetLang}_${Date.now()}.mp4`;
    const finalVideoUrl = await this.assemblyService.assembleFinalVideo({
      scenes: assemblyScenes,
      outputFileName,
    });
    console.log(`✅ Step 7: Final 9:16 MP4 Video Rendered -> ${finalVideoUrl}`);

    // STEP 8: CAPTION & HASHTAG PREPARATION
    console.log(`✅ Step 8: Caption Prepared (${content.caption.length} chars, 30 hashtags in ${targetLang.toUpperCase()})`);

    // STEP 9: PUBLISH TO CONNECTED ACCOUNTS (skipped in preview mode; admin publishes from the menu)
    const payload: PostPayloadData = {
      saintName: saint.name,
      videoUrl: finalVideoUrl,
      coverImageUrl: coverImageUrl,
      caption: content.caption,
      hashtags: content.hashtags,
    };
    const publishResult = shouldPublish
      ? await this.publishingService.publishToAllActiveAccounts(payload)
      : { successCount: 0, errors: [] as string[] };
    console.log(shouldPublish ? `✅ Step 9: Published to ${publishResult.successCount} accounts` : '✅ Step 9: Preview mode - not published');

    // STEP 10: SAVE RECORD TO NEON DB
    try {
      await db.query(
        `INSERT INTO posts (platform, post_type, language, video_url, cover_image_url, caption, hashtags, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          'multi-platform',
          saintInput ? 'on_demand' : 'daily_feast',
          targetLang,
          finalVideoUrl,
          coverImageUrl,
          content.caption,
          content.hashtags,
          publishResult.successCount > 0 ? 'posted' : 'pending',
        ]
      );
    } catch (e: any) {
      console.warn('⚠️ Neon DB post logging warning:', e.message);
    }

    console.log(`\n🎉 SAINTPOST PIPELINE COMPLETED SUCCESSFULLY FOR ${saint.name} [LANG: ${targetLang.toUpperCase()}]!\n`);

    return {
      saint,
      content,
      characterSheetUrl,
      referenceImageUrl: saint.reference_image_url,
      coverImageUrl,
      finalVideoUrl,
      publishResult,
      published: shouldPublish,
      payload,
      degraded: notes.length > 0,
      notes,
      sceneCount: assemblyScenes.length,
      animatedScenes,
      qa: this.visualService.report.qa,
    };
  }
}
