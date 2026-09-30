import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bundled static binaries work on Render's native Node runtime (no apt-get). Env overrides win.
export const FFMPEG: string = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string) || 'ffmpeg';
export const FFPROBE: string = process.env.FFPROBE_PATH || ffprobeStatic?.path || 'ffprobe';
export const FONTS_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

export function run(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr || '').split('\n').slice(-6).join('\n');
        return reject(new Error(`${path.basename(bin)} failed: ${err.message.split('\n')[0]}\n${tail}`));
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export const ffmpeg = (args: string[]) => run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args]);

export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const d = parseFloat(stdout.trim());
  if (!isFinite(d) || d <= 0) throw new Error(`Could not read duration of ${file}`);
  return d;
}
