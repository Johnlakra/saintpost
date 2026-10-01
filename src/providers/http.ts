import axios from 'axios';
import type { Shape } from './types.js';

export async function fetchBytes(url: string, timeout = 60000): Promise<Buffer> {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout, headers: { 'User-Agent': 'SaintPostBot/1.0' } });
  return Buffer.from(res.data);
}

/** Some providers choke on >~1.3k px sides: shrink (keeping aspect, multiples of 16) for them. */
export function capped(shape: Shape, max = 1344): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(shape.genW, shape.genH));
  const r = (n: number) => Math.max(256, Math.round((n * k) / 16) * 16);
  return { w: r(shape.genW), h: r(shape.genH) };
}

export function describeError(e: any): string {
  if (!e?.response) return e?.message || String(e);
  let body = '';
  try {
    const d = e.response.data;
    body = Buffer.isBuffer(d) || d instanceof ArrayBuffer ? Buffer.from(d as any).toString('utf8') : typeof d === 'string' ? d : JSON.stringify(d);
  } catch { /* ignore */ }
  return `HTTP ${e.response.status}${body ? ` ${body.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
}

export function isImage(buf: Buffer): boolean {
  if (buf.length < 4000) return false;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const jpg = buf[0] === 0xff && buf[1] === 0xd8;
  const webp = buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  return png || jpg || webp;
}
