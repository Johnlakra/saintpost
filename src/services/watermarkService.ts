import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { config } from '../config/env.js';
import { db } from '../db/index.js';
import { ffmpeg, probeSize, FONTS_DIR } from '../utils/media.js';
import { VIDEO_W, VIDEO_H } from './videoService.js';

/** Position is the element's anchor as % of the frame (0-100); size/opacity are percentages. */
export interface WmElement { x: number; y: number; size: number; opacity: number }

export interface WatermarkConfig {
  enabled: boolean;
  logoUrl: string;
  logo: WmElement; // size = logo width as % of video width
  text: string;
  textColor: string; // #RRGGBB
  textEl: WmElement; // size = font height as % of video height
}

export const DEFAULT_WATERMARK: WatermarkConfig = {
  enabled: true,
  logoUrl: '',
  logo: { x: 88, y: 7, size: 16, opacity: 75 },
  text: '',
  textColor: '#FFFFFF',
  textEl: { x: 50, y: 95, size: 2.6, opacity: 75 },
};

const KEY = 'watermark';
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** ASS style for the watermark text (font fallback to the bundled Noto fonts handles any script). */
export const WM_STYLE_LINE =
  'Style: WM,Noto Sans,50,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,5,10,10,10,1';

export class WatermarkService {
  async get(): Promise<WatermarkConfig> {
    try {
      const r = await db.query(`SELECT value FROM settings WHERE key = $1`, [KEY]);
      if (r.rows[0]) {
        const v = JSON.parse(r.rows[0].value);
        return {
          ...DEFAULT_WATERMARK, ...v,
          logo: { ...DEFAULT_WATERMARK.logo, ...(v.logo || {}) },
          textEl: { ...DEFAULT_WATERMARK.textEl, ...(v.textEl || {}) },
        };
      }
    } catch { /* table missing or bad JSON -> defaults */ }
    return structuredClone(DEFAULT_WATERMARK);
  }

  async save(cfg: WatermarkConfig): Promise<void> {
    cfg.logo.x = clamp(cfg.logo.x, 0, 100); cfg.logo.y = clamp(cfg.logo.y, 0, 100);
    cfg.logo.size = clamp(cfg.logo.size, 4, 50); cfg.logo.opacity = clamp(cfg.logo.opacity, 10, 100);
    cfg.textEl.x = clamp(cfg.textEl.x, 0, 100); cfg.textEl.y = clamp(cfg.textEl.y, 0, 100);
    cfg.textEl.size = clamp(cfg.textEl.size, 1, 8); cfg.textEl.opacity = clamp(cfg.textEl.opacity, 10, 100);
    await db.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [KEY, JSON.stringify(cfg)]
    );
  }

  async update(mutator: (cfg: WatermarkConfig) => void): Promise<WatermarkConfig> {
    const cfg = await this.get();
    mutator(cfg);
    await this.save(cfg);
    return cfg;
  }

  /** Logo bytes -> file. Uploaded logos live in Neon (/ref/:id); anything else is fetched over HTTP. */
  async fetchLogo(url: string, dest: string): Promise<string | null> {
    try {
      const own = url.match(/\/ref\/(\d+)$/);
      if (own) {
        const r = await db.query(`SELECT data FROM reference_images WHERE id = $1`, [parseInt(own[1], 10)]);
        if (!r.rows[0]) return null;
        fs.writeFileSync(dest, r.rows[0].data);
      } else {
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
        fs.writeFileSync(dest, Buffer.from(res.data));
      }
      return dest;
    } catch (e: any) {
      console.warn('⚠️ Watermark logo unavailable, rendering without it:', e.message);
      return null;
    }
  }

  /** Numeric overlay box for the logo so it never leaves the frame. */
  async logoBox(cfg: WatermarkConfig, logoPath: string): Promise<{ w: number; x: number; y: number }> {
    const w = Math.max(16, Math.round((VIDEO_W * cfg.logo.size) / 100 / 2) * 2);
    const { w: iw, h: ih } = await probeSize(logoPath);
    const h = Math.round((w * ih) / iw);
    const x = clamp(Math.round((VIDEO_W * cfg.logo.x) / 100 - w / 2), 0, Math.max(0, VIDEO_W - w));
    const y = clamp(Math.round((VIDEO_H * cfg.logo.y) / 100 - h / 2), 0, Math.max(0, VIDEO_H - h));
    return { w, x, y };
  }

  /** ASS event for the text watermark (PlayRes 1080x1920). Anchored by nearest edge so text never overflows. */
  assEvent(cfg: WatermarkConfig, endSec: number, fmtTime: (s: number) => string): string | null {
    const text = cfg.text.replace(/[{}\\]/g, '').trim();
    if (!cfg.enabled || !text) return null;
    const { x, y, size, opacity } = cfg.textEl;
    const px = clamp(Math.round((1080 * x) / 100), 40, 1040);
    const py = clamp(Math.round((1920 * y) / 100), 40, 1880);
    const col = x < 33 ? 0 : x > 66 ? 2 : 1; // left / centre / right
    const row = y < 33 ? 2 : y > 66 ? 0 : 1; // top / middle / bottom
    const an = [[1, 2, 3], [4, 5, 6], [7, 8, 9]][row][col];
    const alpha = Math.round(255 - (opacity / 100) * 255).toString(16).toUpperCase().padStart(2, '0');
    const m = /^#?([0-9a-f]{6})$/i.exec(cfg.textColor);
    const bgr = m ? m[1].slice(4, 6) + m[1].slice(2, 4) + m[1].slice(0, 2) : 'FFFFFF';
    const fs_ = Math.round((1920 * size) / 100);
    return `Dialogue: 3,${fmtTime(0)},${fmtTime(endSec)},WM,,0,0,0,,{\\an${an}\\pos(${px},${py})\\fs${fs_}\\1c&H${bgr}&\\alpha&H${alpha}&}${text}`;
  }

  /** A sample frame (PNG) with the current watermark so the admin can tune position/size. */
  async renderPreview(): Promise<Buffer> {
    const cfg = await this.get();
    const tmp = (n: string) => path.join(FONTS_DIR, '..', `tmp_wm_${Date.now()}_${n}`);
    const out = tmp('preview.png'), ass = tmp('p.ass'), logoFile = tmp('logo');
    const fmt = (s: number) => `0:00:${String(Math.floor(s)).padStart(2, '0')}.00`;
    const ev = this.assEvent(cfg, 5, fmt);
    fs.writeFileSync(
      ass,
      `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${WM_STYLE_LINE}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${ev || ''}\n`
    );
    const esc = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    let logoPath: string | null = null;
    try {
      if (cfg.enabled && cfg.logoUrl) logoPath = await this.fetchLogo(cfg.logoUrl, logoFile);
      // sky-blue to dusk gradient stand-in for a video frame
      const base = ['-f', 'lavfi', '-i', `gradients=s=${VIDEO_W}x${VIDEO_H}:c0=0x3b5b84:c1=0xd9a066:x0=0:y0=0:x1=0:y1=${VIDEO_H}:d=1`];
      const args = [...base];
      let fc = `[0:v]ass='${esc(ass)}':fontsdir='${esc(FONTS_DIR)}'[v1]`;
      let last = '[v1]';
      if (logoPath) {
        const box = await this.logoBox(cfg, logoPath);
        args.push('-i', logoPath);
        fc += `;[1:v]scale=${box.w}:-1,format=rgba,colorchannelmixer=aa=${cfg.logo.opacity / 100}[lg];${last}[lg]overlay=${box.x}:${box.y}[v2]`;
        last = '[v2]';
      }
      await ffmpeg([...args, '-filter_complex', fc, '-map', last, '-frames:v', '1', out]);
      return fs.readFileSync(out);
    } finally {
      [out, ass, logoFile].forEach(f => fs.rmSync(f, { force: true }));
    }
  }
}

export const watermarkService = new WatermarkService();
void config;
