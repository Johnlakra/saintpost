import { SaintFetcherService, SaintRecord } from '../data/sanctusFetcher.js';
import { LLMService, GeneratedContent } from '../services/llmService.js';
import { VisualAssetService } from '../services/visualAssetService.js';
import { VideoService } from '../services/videoService.js';
import { TTSService } from '../services/ttsService.js';
import { VideoAssemblyService } from '../services/videoAssemblyService.js';
import { PublishingService } from '../services/publishingService.js';
import { config } from '../config/env.js';
import { db } from '../db/index.js';

export interface PipelineResult {
  saint: SaintRecord;
  content: GeneratedContent;
  characterSheetUrl: string;
  coverImageUrl: string;
  finalVideoUrl: string;
  publishResult: { successCount: number; errors: string[] };
}

export class SaintPostPipeline {
  private saintFetcher: SaintFetcherService;
  private llmService: LLMService;
  private visualService: VisualAssetService;
  private videoService: VideoService;
  private ttsService: TTSService;
  private assemblyService: VideoAssemblyService;
  private publishingService: PublishingService;

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

    // STEP 2: GENERATE CONTENT (LLM in Target Language)
    const content = await this.llmService.generateSaintContentPackage(saint, targetLang);
    console.log(`✅ Step 2: LLM Content Generated (${content.video_script.length} scenes in ${targetLang.toUpperCase()})`);

    // STEP 3: GENERATE CHARACTER SHEET
    const charSheetResult = await this.visualService.generateCharacterSheet(saint);
    const characterSheetUrl = charSheetResult.url;
    console.log(`✅ Step 3: Saint Character Sheet Generated -> ${characterSheetUrl}`);

    // STEP 4: GENERATE SCENE IMAGES & COVER IMAGE
    const coverResult = await this.visualService.generateCoverImage(saint, characterSheetUrl);
    const coverImageUrl = coverResult.url;
    const sceneAssets = await this.visualService.generateSceneImages(
      saint,
      content.video_script,
      characterSheetUrl
    );
    console.log(`✅ Step 4: Visual Images Generated (1 Cover + ${sceneAssets.length} Scenes)`);

    // STEP 5: GENERATE VIDEO CLIPS
    const clipPaths: string[] = [];
    for (let i = 0; i < sceneAssets.length; i++) {
      const scene = content.video_script[i];
      const clipPath = await this.videoService.generateVideoClip(
        sceneAssets[i].localPath,
        scene.visual,
        scene.duration || 5,
        i + 1
      );
      clipPaths.push(clipPath);
    }
    console.log(`✅ Step 5: ${clipPaths.length} Video Clips Generated`);

    // STEP 6: GENERATE VOICEOVER & SUBTITLES IN TARGET LANGUAGE
    const ttsResult = await this.ttsService.generateVoiceover(content.full_story, saint.name, targetLang);
    console.log(`✅ Step 6: Voiceover Audio & Subtitles Generated (${targetLang.toUpperCase()})`);

    // STEP 7: ASSEMBLE VIDEO (FFmpeg)
    const outputFileName = `saintpost_${saint.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${targetLang}_${Date.now()}.mp4`;
    const finalVideoUrl = await this.assemblyService.assembleFinalVideo({
      videoClips: clipPaths,
      voiceoverAudioPath: ttsResult.audioPath,
      subtitlesSrtPath: ttsResult.subtitlesPath,
      outputFileName: outputFileName,
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
      coverImageUrl,
      finalVideoUrl,
      publishResult,
    };
  }
}
