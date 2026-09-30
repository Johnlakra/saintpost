import { SaintFetcherService, SaintRecord } from '../data/sanctusFetcher.js';
import { LLMService, GeneratedContent } from '../services/llmService.js';
import { VisualAssetService } from '../services/visualAssetService.js';
import { VideoService } from '../services/videoService.js';
import { TTSService } from '../services/ttsService.js';
import { VideoAssemblyService, AssemblyScene } from '../services/videoAssemblyService.js';
import { FactService } from '../services/factService.js';
import { PublishingService } from '../services/publishingService.js';
import { config } from '../config/env.js';
import { db } from '../db/index.js';

export interface PipelineResult {
  saint: SaintRecord;
  content: GeneratedContent;
  characterSheetUrl: string;
  referenceImageUrl?: string;
  coverImageUrl: string;
  finalVideoUrl: string;
  publishResult: { successCount: number; errors: string[] };
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
  async runPipelineForSaint(
    saintInput?: SaintRecord | string,
    targetLang: 'en' | 'hi' | 'pa' = config.defaultLanguage || 'hi'
  ): Promise<PipelineResult> {
    // One render at a time: parallel runs exhaust RAM on the free tier and trip image-API rate limits.
    if (pipelineBusy) throw new Error('Another video is still being generated. Please wait for it to finish.');
    pipelineBusy = true;
    try {
      return await this.runPipeline(saintInput, targetLang);
    } finally {
      pipelineBusy = false;
    }
  }

  private async runPipeline(
    saintInput: SaintRecord | string | undefined,
    targetLang: 'en' | 'hi' | 'pa'
  ): Promise<PipelineResult> {
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

    // STEP 1a: documented facts + documented photo (cached on the saint row)
    await this.factService.ensureFacts(saint);

    // STEP 1b: casting sheet (age/gender/clothing) so every scene shows the right person
    await db.query(`ALTER TABLE saints ADD COLUMN IF NOT EXISTS appearance TEXT`).catch(() => {});
    saint.appearance = await this.llmService.getAppearance(saint);
    if (saint.appearance) {
      console.log(`🧑 Appearance: ${saint.appearance}`);
      console.log(`🖼️ Face reference: ${saint.reference_image_url || 'none (text-only, appearance from documented facts)'}`);
      if (saint.id) db.query(`UPDATE saints SET appearance = $2 WHERE id = $1`, [saint.id, saint.appearance]).catch(() => {});
    }

    // STEP 2: GENERATE CONTENT (LLM in Target Language)
    const content = await this.llmService.generateSaintContentPackage(saint, targetLang);
    console.log(`✅ Step 2: LLM Content Generated (${content.video_script.length} scenes in ${targetLang.toUpperCase()})`);

    // STEP 2b: fact-grounded detailed image prompts (saint dossier + the day's feast)
    const brief = await this.llmService.buildVisualBrief(saint, content.video_script, {
      dateLabel: `${saint.feast_month}/${saint.feast_day}`,
      rank: saint.rank,
      color: saint.liturgical_color,
      martyrology: (saint as any).source_text || saint.short_description,
    });
    if (brief) content.video_script.forEach((sc, i) => { sc.image_prompt = brief.scenes[i]; });
    console.log(`✅ Step 2b: Visual brief ${brief ? 'built for ' + brief.scenes.length + ' scenes' : 'skipped (using basic visuals)'}`);

    // STEP 3: GENERATE CHARACTER SHEET
    const charSheetResult = await this.visualService.generateCharacterSheet(saint);
    const characterSheetUrl = charSheetResult.url;
    console.log(`✅ Step 3: Saint Character Sheet Generated -> ${characterSheetUrl}`);

    // STEP 4: GENERATE SCENE IMAGES & COVER IMAGE
    const coverResult = await this.visualService.generateCoverImage(saint, characterSheetUrl, brief?.cover);
    const coverImageUrl = coverResult.url;
    const sceneAssets = await this.visualService.generateSceneImages(
      saint,
      content.video_script,
      characterSheetUrl
    );
    console.log(`✅ Step 4: Visual Images Generated (1 Cover + ${sceneAssets.length} Scenes)`);

    // STEP 5: GENERATE PER-SCENE VOICEOVER (neural TTS). Video timing is driven by the audio.
    const scenes = content.video_script;
    const audios = await this.ttsService.generateSceneVoiceovers(
      scenes.map(sc => sc.voiceover),
      saint.name,
      targetLang
    );
    console.log(`✅ Step 5: ${audios.length} scene voiceovers generated (${targetLang.toUpperCase()})`);

    // STEP 6: GENERATE VIDEO CLIPS, each exactly as long as its narration (+0.5s breathing room)
    const assemblyScenes: AssemblyScene[] = [];
    for (let i = 0; i < sceneAssets.length; i++) {
      const durationSec = Math.max(3, audios[i].durationSec + 0.5);
      const clipPath = await this.videoService.generateVideoClip(sceneAssets[i].localPath, durationSec, i + 1);
      assemblyScenes.push({
        clipPath,
        audioPath: audios[i].audioPath,
        durationSec,
        narration: scenes[i].voiceover || '',
        overlay: scenes[i].text_overlay || '',
      });
    }
    console.log(`✅ Step 6: ${assemblyScenes.length} video clips generated`);

    // STEP 7: ASSEMBLE VIDEO (FFmpeg)
    const outputFileName = `saintpost_${saint.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${targetLang}_${Date.now()}.mp4`;
    const finalVideoUrl = await this.assemblyService.assembleFinalVideo({
      scenes: assemblyScenes,
      outputFileName,
    });
    console.log(`✅ Step 7: Final 9:16 MP4 Video Rendered -> ${finalVideoUrl}`);

    // STEP 8: CAPTION & HASHTAG PREPARATION
    console.log(`✅ Step 8: Caption Prepared (${content.caption.length} chars, 30 hashtags in ${targetLang.toUpperCase()})`);

    // STEP 9: PUBLISH TO CONNECTED ACCOUNTS
    const publishResult = await this.publishingService.publishToAllActiveAccounts({
      saintName: saint.name,
      videoUrl: finalVideoUrl,
      coverImageUrl: coverImageUrl,
      caption: content.caption,
      hashtags: content.hashtags,
    });
    console.log(`✅ Step 9: Published to ${publishResult.successCount} accounts`);

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
    };
  }
}
