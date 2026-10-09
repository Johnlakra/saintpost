import fs from 'fs';
import os from 'os';
import path from 'path';
import { SaintPostPipeline, ScriptStage, PictureStage, PipelineResult, toManifest, withManifest } from '../engine/pipeline.js';
import { LengthId } from '../config/lengths.js';
import { SaintRecord } from '../data/sanctusFetcher.js';
import { editService, Draft } from './editService.js';
import { ProjectService } from './projectService.js';

/**
 * "Check first" run of a new video: the admin approves the script (text only, free to change), then the pictures
 * (redraw any of them), and only then is the narration recorded and the video built. Nothing is put together
 * from anything the admin has not seen. The script lives in a Draft, so every editor tool and the text format apply.
 */
export interface Review {
  phase: 'script' | 'pictures';
  draft: Draft;
  stage: ScriptStage;
  pictures?: PictureStage;
  dateMode: boolean;
  length: LengthId;
  /** a slow step (painting / redrawing / building) is running for this review */
  working: boolean;
}

const emptyDraft = (stage: ScriptStage): Draft => ({
  projectId: 0, videoUrl: '', coverUrl: '', manifest: toManifest(stage),
  assets: { scenes: [], audios: [], aiClips: {} },
  dirtyImg: new Set(), dirtyAud: new Set(), instructions: new Map(), editInPlace: new Set(), freshPrompt: new Set(), needsRender: false, summary: [],
});

const clearMarks = (d: Draft) => {
  d.dirtyImg.clear(); d.dirtyAud.clear(); d.instructions.clear(); d.editInPlace.clear(); d.freshPrompt.clear();
  d.needsRender = false; d.summary = [];
};

export class ReviewService {
  private pipeline = new SaintPostPipeline();

  async start(saintInput: SaintRecord | string, lang: 'hi' | 'pa' | 'en', length: LengthId, dateMode: boolean, onProgress: (m: string) => void): Promise<Review> {
    const stage = await this.pipeline.prepareScript(saintInput, lang, { publish: false, length, onProgress });
    return { phase: 'script', draft: emptyDraft(stage), stage, dateMode, length, working: false };
  }

  /** Paints the cover and every scene from the approved script (with all text edits). */
  async paint(r: Review, onProgress: (m: string) => void) {
    const pictures = await this.pipeline.paintPictures(withManifest(r.stage, r.draft.manifest), { publish: false, length: r.length, onProgress });
    r.pictures = pictures;
    r.draft.assets = {
      cover: await ProjectService.toJpeg(pictures.cover.localPath),
      scenes: await Promise.all(pictures.scenes.map(s => ProjectService.toJpeg(s.localPath))),
      audios: [], aiClips: {},
    };
    clearMarks(r.draft); // edits made before painting are already in the pictures
    r.phase = 'pictures';
  }

  /** Redraws only the pictures the admin changed; returns the scene indexes that were redrawn. */
  async redraw(r: Review, onProgress: (m: string) => void): Promise<number[]> {
    const pictures = r.pictures;
    if (!pictures) throw new Error('The pictures have not been painted yet.');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'review_'));
    try {
      const coverFile = path.join(work, 'cover.jpg');
      fs.writeFileSync(coverFile, r.draft.assets.cover!);
      const done = await editService.redrawPictures(r.draft, pictures.saint, work, coverFile, onProgress);
      const redrawn = [...done.keys()];
      const scenes = pictures.scenes.map((s, i) => done.get(i) ?? s);
      // a redrawn scene is no longer a reused or flagged one
      const report = {
        ...pictures.report,
        reused: pictures.report.reused.filter(n => !done.has(n - 1)),
        qa: { ...pictures.report.qa, flagged: pictures.report.qa.flagged.filter(l => !redrawn.some(i => l === `scene ${i + 1}`)) },
      };
      r.pictures = { ...pictures, scenes, report };
      r.draft.dirtyImg.clear(); r.draft.instructions.clear(); r.draft.editInPlace.clear(); r.draft.freshPrompt.clear();
      return redrawn;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  /** Records the narration and builds the video from exactly the approved script and pictures. */
  async build(r: Review, onProgress: (m: string) => void): Promise<PipelineResult> {
    if (!r.pictures) throw new Error('The pictures have not been painted yet.');
    if (r.draft.dirtyImg.size) throw new Error('Some pictures were changed but not redrawn yet. Redraw them first so you can check them.');
    return this.pipeline.buildVideo(withManifest(r.pictures, r.draft.manifest), { publish: false, length: r.length, onProgress });
  }
}

export const reviewService = new ReviewService();
