import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import * as googleTTS from 'google-tts-api';
import { config } from '../config/env.js';
import { ffmpeg, probeDuration } from '../utils/media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Lang = 'en' | 'hi' | 'pa';

export interface SceneAudio {
  audioPath: string;
  durationSec: number;
}

/** Ordered by preference; the first voice that exists in Edge's live voice list is used. */
const EDGE_VOICES: Record<Lang, string[]> = {
  hi: ['hi-IN-SwaraNeural', 'hi-IN-MadhurNeural'],
  pa: ['pa-IN-VaaniNeural', 'pa-IN-OjasNeural', 'pa-IN-GurpreetNeural'],
  en: [config.edgeTtsVoice || 'en-US-AriaNeural', 'en-IN-NeerjaNeural'],
};

// Slightly slower than default with a touch of warmth reads as calm devotional narration.
const PROSODY: Record<Lang, { rate: string; pitch: string }> = {
  hi: { rate: '-8%', pitch: '-2Hz' },
  pa: { rate: '-8%', pitch: '-2Hz' },
  en: { rate: '-5%', pitch: '+0Hz' },
};

class NoVoiceError extends Error {}

export class TTSService {
  private outputDir: string;
  private voiceCache = new Map<Lang, string>();

  constructor() {
    this.outputDir = path.join(__dirname, '..', '..', 'public', 'audio');
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  /** Strip emoji/markdown that TTS engines either read aloud or stumble on. */
  static cleanForSpeech(text: string): string {
    return text
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[*#_`~@\[\]{}<>|\\]/g, ' ')
      .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ')
      .replace(/\s*[\n\r]+\s*/g, '. ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * One audio file PER SCENE. The video is then timed to the audio (not the other way round),
   * so narration always covers every scene.
   */
  async generateSceneVoiceovers(texts: string[], saintName: string, lang: Lang): Promise<SceneAudio[]> {
    console.log(`🎙️ Synthesizing ${texts.length} scene voiceovers for ${saintName} [${lang.toUpperCase()}]...`);
    const base = `vo_${saintName.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${lang}_${Date.now()}`;
    const out: SceneAudio[] = [];
    for (let i = 0; i < texts.length; i++) {
      const file = path.join(this.outputDir, `${base}_s${i + 1}.mp3`);
      const text = TTSService.cleanForSpeech(texts[i] || '');
      let ok = false;
      if (text) ok = await this.synthesize(text, lang, file);
      if (!ok) {
        console.warn(`   ⚠️ Scene ${i + 1}: no TTS engine succeeded, using silence.`);
        await this.silence(file, 4);
      }
      out.push({ audioPath: file, durationSec: await probeDuration(file) });
    }
    return out;
  }

  private async synthesize(text: string, lang: Lang, file: string): Promise<boolean> {
    // Paid path only when FREE_MODE=false and a key exists.
    if (!config.freeMode && config.elevenlabsApiKey) {
      try { await this.elevenLabs(text, file); return true; }
      catch (e: any) { console.warn('   ⚠️ ElevenLabs failed:', e.response?.status || e.message); }
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { await this.edge(text, lang, file); return true; }
      catch (e: any) {
        console.warn(`   ⚠️ Edge neural TTS attempt ${attempt}/3 failed:`, e.message);
        if (e instanceof NoVoiceError) break;
        this.voiceCache.delete(lang);
        await new Promise(r => setTimeout(r, 700 * attempt));
      }
    }
    try { await this.google(text, lang, file); return true; }
    catch (e: any) { console.warn('   ⚠️ Google TTS fallback failed:', e.message); }
    return false;
  }

  private async pickEdgeVoice(tts: MsEdgeTTS, lang: Lang): Promise<string> {
    const cached = this.voiceCache.get(lang);
    if (cached) return cached;
    let names: Set<string> | null = null;
    try {
      names = new Set((await tts.getVoices()).map(v => v.ShortName));
    } catch { /* offline listing: fall through and try the first candidate */ }
    let chosen = EDGE_VOICES[lang][0];
    if (names) {
      const found = EDGE_VOICES[lang].find(v => names!.has(v));
      if (!found) {
        const locale = lang === 'en' ? 'en-' : `${lang}-IN`;
        const have = [...names].filter(n => n.startsWith(locale));
        console.warn(`   ⚠️ None of ${EDGE_VOICES[lang].join(', ')} exist in Edge's voice list. Available ${locale}* voices: ${have.join(', ') || 'none'}`);
        if (have.length === 0) throw new NoVoiceError(`No Edge neural voice for ${lang}`);
        chosen = have[0];
      } else {
        chosen = found;
      }
    }
    console.log(`   🎤 Edge voice for ${lang}: ${chosen}`);
    this.voiceCache.set(lang, chosen);
    return chosen;
  }

  /**
   * Collect the audio stream in memory. (msedge-tts' toFile() has a bug: if the connection drops early it calls
   * fs.unlinkSync on a file that was never created, which throws an UNCAUGHT exception and kills the whole server.)
   */
  private async edge(text: string, lang: Lang, file: string): Promise<void> {
    const tts = new MsEdgeTTS();
    try {
      const voice = await this.pickEdgeVoice(tts, lang);
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(text, PROSODY[lang]);
      const buf: Buffer = await new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const timer = setTimeout(() => { audioStream.destroy(); reject(new Error('Edge TTS timed out')); }, 60000);
        audioStream.on('data', (c: Buffer) => chunks.push(c));
        audioStream.once('error', (e: Error) => { clearTimeout(timer); reject(e); });
        audioStream.once('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      });
      if (buf.length < 2000) throw new Error('Edge TTS returned empty audio');
      fs.writeFileSync(file, buf);
    } finally {
      try { tts.close(); } catch { /* ignore */ }
    }
  }

  private async elevenLabs(text: string, file: string): Promise<void> {
    const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      { text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.8 } },
      { headers: { 'xi-api-key': config.elevenlabsApiKey, Accept: 'audio/mpeg' }, responseType: 'arraybuffer', timeout: 60000 }
    );
    fs.writeFileSync(file, Buffer.from(res.data));
  }

  /** Last resort only: robotic, but better than a silent video. */
  private async google(text: string, lang: Lang, file: string): Promise<void> {
    const parts = await googleTTS.getAllAudioBase64(text, { lang, slow: false, timeout: 15000, splitPunct: ',.!?।' });
    fs.writeFileSync(file, Buffer.concat(parts.map(p => Buffer.from(p.base64, 'base64'))));
  }

  private async silence(file: string, sec: number): Promise<void> {
    await ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(sec), '-c:a', 'libmp3lame', file]);
  }
}
