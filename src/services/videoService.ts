import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ffmpeg } from '../utils/media.js';

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
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-threads', '1',
      '-r', String(FPS), '-pix_fmt', 'yuv420p',
      outputPath,
    ]);
    return outputPath;
  }
}
