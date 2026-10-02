import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../config/env.js';
import { LLMService, SceneScript } from './llmService.js';
import { VisualAssetService } from './visualAssetService.js';
import { VideoService } from './videoService.js';
import { TTSService } from './ttsService.js';
import { VideoAssemblyService, AssemblyScene } from './videoAssemblyService.js';
import { fileURLToPath } from 'url';
import { projectService, ProjectService, Manifest, ProjectAssets } from './projectService.js';
import { probeDuration } from '../utils/media.js';
import { SaintRecord } from '../data/sanctusFetcher.js';

/**
 * An editing session on a saved project. Edits only change the in-memory draft and mark what became stale;
 * apply() then redoes JUST those parts (pictures, narration), reuses everything else, re-assembles and saves.
 */
export interface Draft {
  projectId: number;
  manifest: Manifest;
  assets: ProjectAssets;
  videoUrl: string;
  coverUrl: string;
  dirtyImg: Set<number>;
  dirtyAud: Set<number>;
  /** per-scene change requests for the picture ("make the angel younger") */
  instructions: Map<number, string>;
  /** a translation or caption/title edit changed what is on screen: a re-render is needed */
  needsRender: boolean;
  summary: string[];
}

export class EditService {
  private llm = new LLMService();
  private visual = new VisualAssetService();
  private video = new VideoService();
  private tts = new TTSService();
  private assembler = new VideoAssemblyService();

  async open(projectId: number): Promise<Draft | null> {
    const p = await projectService.load(projectId);
    if (!p) return null;
    return { projectId, manifest: p.manifest, assets: p.assets, videoUrl: p.videoUrl, coverUrl: p.coverUrl, dirtyImg: new Set(), dirtyAud: new Set(), instructions: new Map(), needsRender: false, summary: [] };
  }

  // ---- edits (cheap: they only mark what must be redone) ----
  redrawScene(d: Draft, i: number, instruction?: string) {
    d.dirtyImg.add(i);
    if (instruction) d.instructions.set(i, instruction);
    d.summary.push(`Scene ${i + 1}: new picture${instruction ? ` ("${instruction.slice(0, 40)}")` : ''}`);
  }

  async setNarration(d: Draft, i: number, text: string) {
    const sc = d.manifest.scenes[i];
    sc.voiceover = text.trim();
    if (d.manifest.romanSubs && d.manifest.lang !== 'en') {
      sc.subtitle = (await this.llm.romanizeScenes([{ voiceover: sc.voiceover } as SceneScript], d.manifest.lang as 'hi' | 'pa'))[0];
    } else {
      sc.subtitle = undefined;
    }
    d.dirtyAud.add(i);
    d.summary.push(`Scene ${i + 1}: new narration`);
  }

  setTitle(d: Draft, i: number, text: string) {
    d.manifest.scenes[i].overlay = text.trim() === '-' ? '' : text.trim();
    d.needsRender = true;
    d.summary.push(`Scene ${i + 1}: new title`);
  }

  setCaption(d: Draft, caption: string) {
    d.manifest.caption = caption.trim();
    d.summary.push('New caption');
  }

  deleteScene(d: Draft, i: number) {
    if (d.manifest.scenes.length <= 3) throw new Error('A video needs at least 3 scenes.');
    d.manifest.scenes.splice(i, 1);
    d.assets.scenes.splice(i, 1);
    d.assets.audios.splice(i, 1);
    // shift every index above the deleted one
    const shift = (s: Set<number>) => new Set([...s].filter(x => x !== i).map(x => (x > i ? x - 1 : x)));
    d.dirtyImg = shift(d.dirtyImg);
    d.dirtyAud = shift(d.dirtyAud);
    const ins = new Map<number, string>();
    d.instructions.forEach((v, k) => { if (k !== i) ins.set(k > i ? k - 1 : k, v); });
    d.instructions = ins;
    const clips: Record<number, Buffer> = {};
    Object.entries(d.assets.aiClips).forEach(([k, v]) => { const n = +k; if (n !== i) clips[n > i ? n - 1 : n] = v; });
    d.assets.aiClips = clips;
    d.needsRender = true;
    d.summary.push(`Scene ${i + 1}: removed`);
  }

  /** Same video in another language: pictures reused, only text/narration redone. */
  async translate(d: Draft, to: 'hi' | 'pa' | 'en', roman: boolean) {
    const m = d.manifest;
    const out = await this.llm.translateScenes(m.scenes.map(s => ({ voiceover: s.voiceover, overlay: s.overlay })), m.caption, m.hashtags, to, roman);
    out.scenes.forEach((t, i) => {
      m.scenes[i].voiceover = t.voiceover;
      m.scenes[i].overlay = t.overlay;
      m.scenes[i].subtitle = t.subtitle;
    });
    m.caption = out.caption;
    m.hashtags = out.hashtags;
    m.lang = to;
    m.romanSubs = roman && to !== 'en';
    m.scenes.forEach((_, i) => d.dirtyAud.add(i));
    d.needsRender = true;
    d.summary.push(`Translated to ${to.toUpperCase()} (pictures reused)`);
  }

  // ---- apply ----
  async apply(d: Draft, onProgress: (m: string) => void = () => {}): Promise<{ videoUrl: string; coverUrl?: string; redrawn: number; reRecorded: number }> {
    const m = d.manifest;
    const saint = { name: m.saint.name, feast_month: m.saint.feast_month, feast_day: m.saint.feast_day, appearance: m.saint.appearance, reference_image_url: m.saint.reference_image_url } as SaintRecord;
    // older/partial projects: anything missing is simply rebuilt
    m.scenes.forEach((_, i) => { if (!d.assets.audios[i]) d.dirtyAud.add(i); });
    if (m.scenes.some((_, i) => !d.assets.scenes[i] && !d.dirtyImg.has(i))) throw new Error('This project is missing some pictures; please regenerate the video instead.');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'edit_'));
    try {
      // 1. redraw only the scenes that changed (the only step that spends image credits)
      const coverFile = path.join(work, 'cover.jpg');
      if (d.assets.cover) fs.writeFileSync(coverFile, d.assets.cover);
      let redrawn = 0;
      for (const i of [...d.dirtyImg].sort((a, b) => a - b)) {
        onProgress(`🖼 Redrawing scene ${i + 1}…`);
        const sc = m.scenes[i];
        const instr = d.instructions.get(i);
        if (instr) {
          const r = await this.llm.rewriteImagePrompt(sc.image_prompt || sc.visual, instr, sc.voiceover, { appearance: m.saint.appearance, mustInclude: sc.must_include });
          sc.image_prompt = r.prompt;
          sc.safe_prompt = r.safe || sc.safe_prompt;
          sc.must_include = r.mustInclude;
        }
        const scene: SceneScript = { scene_number: i + 1, duration: 0, visual: sc.visual, voiceover: sc.voiceover, text_overlay: sc.overlay, image_prompt: sc.image_prompt, safe_prompt: sc.safe_prompt, must_include: sc.must_include, risk: sc.risk, uses_main: sc.uses_main };
        const img = await this.visual.regenerateScene(saint, scene, i, d.assets.cover ? coverFile : undefined, 1 + Math.floor(Math.random() * 50));
        d.assets.scenes[i] = await ProjectService.toJpeg(img.localPath);
        d.assets.aiClips && delete d.assets.aiClips[i]; // the old motion clip no longer matches the new picture
        redrawn++;
      }

      // 2. re-record only the scenes whose narration changed (free engines first, as in the original run)
      const aud = [...d.dirtyAud].sort((a, b) => a - b);
      if (aud.length) {
        onProgress(`🎙 Recording ${aud.length} narration${aud.length > 1 ? 's' : ''}…`);
        const res = await this.tts.generateSceneVoiceovers(aud.map(i => m.scenes[i].voiceover), m.saint.name, m.lang);
        aud.forEach((i, k) => { d.assets.audios[i] = fs.readFileSync(res[k].audioPath); fs.rmSync(res[k].audioPath, { force: true }); });
      }

      // 3. rebuild clips (local ffmpeg, free) and assemble with the CURRENT watermark/subtitle settings
      onProgress('🎬 Putting the video back together…');
      const scenes: AssemblyScene[] = [];
      for (let i = 0; i < m.scenes.length; i++) {
        const imgFile = path.join(work, `s${i}.jpg`);
        const audFile = path.join(work, `a${i}.mp3`);
        fs.writeFileSync(imgFile, d.assets.scenes[i]!);
        fs.writeFileSync(audFile, d.assets.audios[i]!);
        const durationSec = Math.max(3, (await probeDuration(audFile)) + 0.5);
        let clip: string;
        if (d.assets.aiClips[i]) {
          const raw = path.join(work, `ai${i}.mp4`);
          fs.writeFileSync(raw, d.assets.aiClips[i]);
          clip = await this.video.fitClip(raw, durationSec, i + 1); // stored AI motion is reused, no new credits
        } else {
          clip = await this.video.generateVideoClip(imgFile, durationSec, i + 1);
        }
        const sub = m.romanSubs ? m.scenes[i].subtitle : undefined;
        scenes.push({ clipPath: clip, audioPath: audFile, durationSec, narration: sub || m.scenes[i].voiceover, overlay: m.scenes[i].overlay });
      }
      m.version += 1;
      const outName = `saintpost_${m.saint.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${m.lang}_v${m.version}_${Date.now()}.mp4`;
      const videoUrl = await this.assembler.assembleFinalVideo({ scenes, outputFileName: outName });

      // 4. save the new state (so the next edit starts from here)
      await projectService.save(d.projectId, m, d.assets, videoUrl);
      d.videoUrl = videoUrl;
      const reRecorded = aud.length;
      d.dirtyImg.clear(); d.dirtyAud.clear(); d.instructions.clear(); d.needsRender = false; d.summary = [];
      // the cover must be reachable at a public URL for publishing (old files may be gone after a redeploy)
      let coverUrl: string | undefined;
      if (d.assets.cover) {
        const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'assets');
        fs.mkdirSync(dir, { recursive: true });
        const name = `cover_p${d.projectId}_v${m.version}.jpg`;
        fs.writeFileSync(path.join(dir, name), d.assets.cover);
        coverUrl = `${config.renderExternalUrl}/assets/${name}`;
      }
      return { videoUrl, redrawn, reRecorded, coverUrl };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
}

export const editService = new EditService();
