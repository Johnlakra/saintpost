import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { config } from '../config/env.js';
import { ffmpeg, FONTS_DIR } from '../utils/media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AssemblyScene {
  clipPath: string;
  audioPath: string;
  durationSec: number; // clip length (== narration + padding)
  narration: string;
  overlay: string;
}

export interface VideoAssemblyOptions {
  scenes: AssemblyScene[];
  logoUrl?: string;
  brandColor?: string;
  outputFileName: string;
}

const assTime = (s: number) => {
  const cs = Math.round(s * 100);
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const assEscape = (t: string) => t.replace(/[{}\\]/g, '').replace(/\n/g, '\\N');
/** #RRGGBB -> ASS &HBBGGRR& */
const assColor = (hex?: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  return m ? `&H${m[1].slice(4, 6)}${m[1].slice(2, 4)}${m[1].slice(0, 2)}&` : '&H0000D7FF&'; // default gold
};

export class VideoAssemblyService {
  private outputDir: string;

  constructor() {
    this.outputDir = path.join(__dirname, '..', '..', 'public', 'renders');
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  /**
   * Stitches scene clips, lays per-scene narration on an exactly-aligned audio track,
   * and burns in a title + subtitles (Devanagari/Gurmukhi capable, fonts bundled).
   */
  async assembleFinalVideo(opts: VideoAssemblyOptions): Promise<string> {
    console.log(`🎬 Assembling final 9:16 video: ${opts.outputFileName} (${opts.scenes.length} scenes)...`);
    const stamp = Date.now();
    const tmp = (name: string) => path.join(this.outputDir, `tmp_${stamp}_${name}`);
    const finalPath = path.join(this.outputDir, opts.outputFileName);
    const temps: string[] = [];

    try {
      // 1. Audio track: each scene's narration padded to its clip length, concatenated.
      const audioPath = tmp('audio.m4a');
      temps.push(audioPath);
      const n = opts.scenes.length;
      const aInputs = opts.scenes.flatMap(s => ['-i', s.audioPath]);
      const aFilter =
        opts.scenes.map((s, i) => `[${i}:a]aformat=sample_rates=44100:channel_layouts=mono,apad=whole_dur=${s.durationSec.toFixed(3)}[a${i}]`).join(';') +
        ';' + opts.scenes.map((_, i) => `[a${i}]`).join('') + `concat=n=${n}:v=0:a=1,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;
      await ffmpeg([...aInputs, '-filter_complex', aFilter, '-map', '[aout]', '-c:a', 'aac', '-b:a', '160k', audioPath]);

      // 2. Video: concat identically-encoded clips.
      const listPath = tmp('list.txt');
      temps.push(listPath);
      fs.writeFileSync(listPath, opts.scenes.map(s => `file '${s.clipPath.replace(/'/g, "'\\''")}'`).join('\n'));

      // 3. Subtitles/title (ASS) + optional logo.
      const assPath = tmp('subs.ass');
      temps.push(assPath);
      fs.writeFileSync(assPath, this.buildAss(opts.scenes, opts.brandColor));

      let logoPath: string | null = null;
      if (opts.logoUrl) {
        logoPath = await this.downloadLogo(opts.logoUrl, tmp('logo.png'));
        if (logoPath) temps.push(logoPath);
      }

      const esc = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
      const render = async (withSubs: boolean) => {
        const args = ['-f', 'concat', '-safe', '0', '-i', listPath, '-i', audioPath];
        if (logoPath) args.push('-i', logoPath);
        let chain = '[0:v]';
        let fc = '';
        if (withSubs) {
          fc += `${chain}ass='${esc(assPath)}':fontsdir='${esc(FONTS_DIR)}'[vs];`;
          chain = '[vs]';
        }
        if (logoPath) {
          fc += `[2:v]scale=150:-1,format=rgba,colorchannelmixer=aa=0.35[lg];${chain}[lg]overlay=W-w-40:40[vl];`;
          chain = '[vl]';
        }
        if (!fc) { fc = `${chain}null[vl];`; chain = '[vl]'; }
        await ffmpeg([
          ...args,
          '-filter_complex', fc.replace(/;$/, ''),
          '-map', chain, '-map', '1:a',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-threads', '2', '-pix_fmt', 'yuv420p',
          '-c:a', 'copy', '-shortest', '-movflags', '+faststart',
          finalPath,
        ]);
      };

      try {
        await render(config.enableSubtitles);
      } catch (e: any) {
        if (!config.enableSubtitles) throw e;
        console.warn('⚠️ Render with subtitles failed, retrying without them:', e.message);
        await render(false);
      }

      console.log(`✅ Final 9:16 MP4 rendered: ${finalPath}`);
      return `${config.renderExternalUrl}/renders/${opts.outputFileName}`;
    } finally {
      temps.forEach(f => fs.rmSync(f, { force: true }));
      opts.scenes.forEach(s => {
        fs.rmSync(s.clipPath, { force: true });
        fs.rmSync(s.audioPath, { force: true });
      });
    }
  }

  private buildAss(scenes: AssemblyScene[], brandColor?: string): string {
    const head = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Noto Sans Devanagari,58,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,2,70,70,300,1
Style: Title,Noto Sans Devanagari,68,${assColor(brandColor)},&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,6,2,8,70,70,220,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
    let t = 0;
    const lines: string[] = [];
    for (const s of scenes) {
      const start = t, end = t + s.durationSec;
      if (s.overlay?.trim()) {
        lines.push(`Dialogue: 1,${assTime(start + 0.2)},${assTime(end - 0.1)},Title,,0,0,0,,{\\fad(300,300)}${assEscape(this.wrap(s.overlay.trim(), 18))}`);
      }
      const words = (s.narration || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      if (words.length) {
        const chunks: string[] = [];
        for (let i = 0; i < words.length; i += 5) chunks.push(words.slice(i, i + 5).join(' '));
        const total = chunks.reduce((a, c) => a + c.length, 0);
        const speechDur = Math.max(1, s.durationSec - 0.5);
        let cur = start + 0.1;
        for (const c of chunks) {
          const d = (c.length / total) * speechDur;
          lines.push(`Dialogue: 0,${assTime(cur)},${assTime(cur + d)},Sub,,0,0,0,,${assEscape(c)}`);
          cur += d;
        }
      }
      t = end;
    }
    return head + lines.join('\n') + '\n';
  }

  private wrap(text: string, max: number): string {
    const out: string[] = [];
    let line = '';
    for (const w of text.split(/\s+/)) {
      if ((line + ' ' + w).trim().length > max && line) { out.push(line); line = w; }
      else line = (line + ' ' + w).trim();
    }
    if (line) out.push(line);
    return out.join('\n');
  }

  private async downloadLogo(url: string, dest: string): Promise<string | null> {
    try {
      const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
      fs.writeFileSync(dest, Buffer.from(res.data));
      return dest;
    } catch (e: any) {
      console.warn('⚠️ Logo download failed, rendering without logo:', e.message);
      return null;
    }
  }
}
