import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ffmpeg, probeDuration } from '../utils/media.js';
import { generateVideo } from '../providers/video/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Render's free tier (0.1 CPU / 512 MB) renders 1080p very slowly: default to 720x1280 there.
// Override with VIDEO_HEIGHT=1920 (width is derived, 9:16).
const envH = parseInt(process.env.VIDEO_HEIGHT || '', 10);
export const VIDEO_H = envH > 0 ? envH : process.env.RENDER ? 1280 : 1920;
export const VIDEO_W = Math.round((VIDEO_H * 9) / 16 / 2) * 2;
export const FPS = 25;

export class VideoService {
  private outputDir: string;

  constructor() {
    this.outputDir = path.join(__dirname, '..', '..', 'public', 'video_clips');
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  /**
   * Turns a scene image into a smooth, cinematic clip of exactly `durationSec` using a Ken Burns
   * move (alternating zoom-in / zoom-out / pan so consecutive scenes don't feel identical).
   * Free, deterministic and light enough for a 512 MB instance.
   */
  /**
   * One scene clip. When `animate` is set and an AI image-to-video provider is available, the image is brought to
   * life (real motion); otherwise, or on any failure, we use the guaranteed Ken Burns move.
   */
  async generateSceneClip(
    imagePath: string,
    durationSec: number,
    sceneNum: number,
    opts: { animate?: boolean; imageUrl?: string; prompt?: string } = {}
  ): Promise<{ path: string; animated: boolean }> {
    if (opts.animate && opts.imageUrl) {
      try {
        const out = await generateVideo({ imageUrl: opts.imageUrl, imagePath, prompt: opts.prompt || '', durationSec });
        if (out) {
          const raw = path.join(this.outputDir, `ai_${sceneNum}_${Date.now()}.mp4`);
          fs.writeFileSync(raw, out.buffer);
          try {
            const fitted = await this.fitClip(raw, durationSec, sceneNum);
            console.log(`   🎞️ Scene ${sceneNum}: animated by ${out.provider.label}`);
            return { path: fitted, animated: true };
          } finally {
            fs.rmSync(raw, { force: true });
          }
        }
      } catch (e: any) {
        console.warn(`   ⚠️ Scene ${sceneNum}: AI motion failed (${e.message}); using Ken Burns.`);
      }
    }
    return { path: await this.generateVideoClip(imagePath, durationSec, sceneNum), animated: false };
  }

  /** Fit an AI clip (usually ~5 s) to the scene length: gentle slow-down, then hold the last frame; crop to 9:16; fades. */
  async fitClip(rawPath: string, durationSec: number, sceneNum: number): Promise<string> {
    const outputPath = path.join(this.outputDir, `clip_scene_${sceneNum}_${Date.now()}.mp4`);
    const src = await probeDuration(rawPath);
    const slow = src >= durationSec ? 1 : Math.min(durationSec / src, 1.6);
    const played = Math.min(src * slow, durationSec);
    const hold = Math.max(0, durationSec - played);
    const fade = 0.3;
    const vf =
      `setpts=PTS*${slow.toFixed(3)},` +
      `scale=${VIDEO_W}:${VIDEO_H}:force_original_aspect_ratio=increase,crop=${VIDEO_W}:${VIDEO_H},fps=${FPS},` +
      (hold > 0.05 ? `tpad=stop_mode=clone:stop_duration=${hold.toFixed(2)},` : '') +
      `trim=duration=${durationSec.toFixed(2)},setpts=PTS-STARTPTS,` +
      `fade=t=in:st=0:d=${fade},fade=t=out:st=${Math.max(0, durationSec - fade).toFixed(2)}:d=${fade},format=yuv420p`;
    await ffmpeg(['-i', rawPath, '-an', '-vf', vf, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '17', '-threads', '1', '-r', String(FPS), '-pix_fmt', 'yuv420p', outputPath]);
    return outputPath;
  }

  async generateVideoClip(imagePath: string, durationSec: number, sceneNum: number): Promise<string> {
    const outputPath = path.join(this.outputDir, `clip_scene_${sceneNum}_${Date.now()}.mp4`);
    const frames = Math.max(FPS, Math.round(durationSec * FPS));
    const fade = 0.3;

    const progress = `on/${frames}`;
    const moves = [
      { z: `1+0.12*${progress}`, x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)' }, // centre zoom in
      { z: `1.12-0.12*${progress}`, x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)' }, // centre zoom out
      { z: '1.1', x: `(iw-iw/zoom)*${progress}`, y: 'ih/2-(ih/zoom/2)' }, // pan left -> right
      { z: '1.1', x: `(iw-iw/zoom)*(1-${progress})`, y: 'ih/2-(ih/zoom/2)' }, // pan right -> left
    ];
    const m = moves[(sceneNum - 1) % moves.length];

    // Pre-scale 1.25x so zoompan's sub-pixel steps stay smooth (no shimmer) without huge frames.
    const vf =
      `scale=${Math.round(VIDEO_W * 1.25)}:${Math.round(VIDEO_H * 1.25)}:force_original_aspect_ratio=increase,` +
      `crop=${Math.round(VIDEO_W * 1.25)}:${Math.round(VIDEO_H * 1.25)},` +
      `zoompan=z='${m.z}':x='${m.x}':y='${m.y}':d=${frames}:s=${VIDEO_W}x${VIDEO_H}:fps=${FPS},` +
      `fade=t=in:st=0:d=${fade},fade=t=out:st=${(frames / FPS - fade).toFixed(2)}:d=${fade},format=yuv420p`;

    await ffmpeg([
      '-i', imagePath,
      '-vf', vf,
      '-frames:v', String(frames),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '17', '-threads', '1',
      '-r', String(FPS), '-pix_fmt', 'yuv420p',
      outputPath,
    ]);
    return outputPath;
  }
}
