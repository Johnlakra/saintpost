import axios from 'axios';
import { config } from '../config/env.js';

/**
 * Google retires Gemini model names often ("no longer available to new users"). Instead of hard-coding one,
 * ask the API which models this key can use and take the newest suitable one. Env overrides still win.
 */
export type GeminiKind = 'vision' | 'image' | 'tts';

const FALLBACK: Record<GeminiKind, string[]> = {
  vision: ['gemini-3.8-flash', 'gemini-2.5-flash'],
  image: ['gemini-2.5-flash-image'],
  tts: ['gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-tts'],
};
const ENV: Record<GeminiKind, string> = { vision: 'GEMINI_VISION_MODEL', image: 'GEMINI_IMAGE_MODEL', tts: 'GEMINI_TTS_MODEL' };

let cache: { at: number; names: Array<{ name: string; methods: string[] }> } | null = null;

async function listModels(): Promise<Array<{ name: string; methods: string[] }>> {
  if (cache && Date.now() - cache.at < 6 * 3600_000) return cache.names;
  const names: Array<{ name: string; methods: string[] }> = [];
  let token = '';
  for (let page = 0; page < 5; page++) {
    const res = await axios.get('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': config.geminiApiKey },
      params: { pageSize: 200, ...(token ? { pageToken: token } : {}) },
      timeout: 20000,
    });
    for (const m of res.data?.models || []) names.push({ name: String(m.name).replace(/^models\//, ''), methods: m.supportedGenerationMethods || [] });
    token = res.data?.nextPageToken || '';
    if (!token) break;
  }
  cache = { at: Date.now(), names };
  return names;
}

const version = (n: string) => (n.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ? parseFloat(n.match(/gemini-(\d+(?:\.\d+)?)/)![1]) : 0);

/** Candidate model names for a purpose, best first. Never throws. */
export async function geminiModelCandidates(kind: GeminiKind): Promise<string[]> {
  const forced = process.env[ENV[kind]];
  if (forced) return [forced];
  try {
    const all = await listModels();
    const ok = (n: { name: string; methods: string[] }) => n.methods.includes('generateContent') && /^gemini-/.test(n.name);
    let pool: string[];
    if (kind === 'image') pool = all.filter(n => ok(n) && /image/.test(n.name) && !/pro|preview-\d|exp/.test(n.name)).map(n => n.name);
    else if (kind === 'tts') pool = all.filter(n => ok(n) && /tts/.test(n.name)).map(n => n.name);
    else pool = all.filter(n => ok(n) && /^gemini-[\d.]+-flash(-lite)?$/.test(n.name)).map(n => n.name); // stable text/vision flash models
    // newest version first; for vision prefer the cheaper "-lite" of the same version
    pool.sort((a, b) => version(b) - version(a) || (kind === 'vision' ? Number(/lite/.test(b)) - Number(/lite/.test(a)) : 0));
    if (pool.length) return pool.slice(0, 3);
  } catch { /* fall through to static names */ }
  return FALLBACK[kind];
}

/** Call after a 404 "no longer available" so the next call re-discovers. */
export const forgetGeminiModels = () => { cache = null; };
