import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as googleTTS from 'google-tts-api';
import { config } from '../config/env.js';

const execAsync = util.promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface TTSResult {
  audioPath: string;
  audioUrl: string;
  subtitlesPath?: string;
}

export class TTSService {
  private outputDir: string;

  constructor() {
    this.outputDir = path.join(__dirname, '..', '..', 'public', 'audio');
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Generates audible voiceover narration in Hindi, Punjabi, or English using Google TTS & Edge TTS fallback
   */
  async generateVoiceover(
    text: string,
    saintName: string,
    targetLang: 'en' | 'hi' | 'pa' = config.defaultLanguage || 'hi'
  ): Promise<TTSResult> {
    console.log(`🎙️ Generating audible voiceover narration for ${saintName} [Lang: ${targetLang.toUpperCase()}]...`);

    const sanitizedName = saintName.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const fileName = `narration_${sanitizedName}_${targetLang}_${Date.now()}.mp3`;
    const audioPath = path.join(this.outputDir, fileName);
    const audioUrl = `${config.renderExternalUrl}/audio/${fileName}`;

    // 1. Primary Synthesizer: google-tts-api (Pure Node.js, 100% audible, no python required)
    try {
      const cleanText = text.replace(/[*#]/g, '').trim();
      const langCode = targetLang === 'pa' ? 'pa' : targetLang === 'hi' ? 'hi' : 'en';

      console.log(`   └ Synthesizing audio via Google TTS (${langCode})...`);
      const results = await googleTTS.getAllAudioBase64(cleanText, {
        lang: langCode,
        slow: false,
        host: 'https://translate.google.com',
        timeout: 15000,
      });

      const buffers = results.map(r => Buffer.from(r.base64, 'base64'));
      const combinedAudio = Buffer.concat(buffers);
      fs.writeFileSync(audioPath, combinedAudio);

      console.log(`✅ Audible Voiceover Audio generated: ${audioPath} (${combinedAudio.byteLength} bytes)`);

      // Subtitle generation
      const srtPath = await this.generateSubtitlesSRT(text, audioPath);
      return { audioPath, audioUrl, subtitlesPath: srtPath };
    } catch (gErr: any) {
      console.warn('⚠️ Google TTS synthesis warning:', gErr.message);
    }

    // 2. Secondary Synthesizer: Microsoft Edge TTS CLI
    const voiceMap: Record<string, string> = {
      en: config.edgeTtsVoice || 'en-US-AriaNeural',
      hi: 'hi-IN-SwaraNeural',
      pa: 'pa-IN-OjasNeural',
    };
    const voice = voiceMap[targetLang] || voiceMap.hi;

    try {
      const cleanText = text.replace(/"/g, '\\"').replace(/\n/g, ' ');
      const cmd = `edge-tts --voice "${voice}" --text "${cleanText}" --write-media "${audioPath}"`;
      await execAsync(cmd);

      console.log(`✅ Voiceover generated via Edge-TTS [Voice: ${voice}]: ${audioPath}`);
      const srtPath = await this.generateSubtitlesSRT(text, audioPath);
      return { audioPath, audioUrl, subtitlesPath: srtPath };
    } catch (err: any) {
      console.warn(`⚠️ Edge-TTS CLI error for voice ${voice}:`, err.message);
      await this.generateSilentAudio(audioPath, 20);
      return { audioPath, audioUrl };
    }
  }

  /**
   * Generates SRT subtitle file from narration script with estimated word timing
   */
  private async generateSubtitlesSRT(text: string, audioPath: string): Promise<string> {
    const srtPath = audioPath.replace(/\.mp3$/, '.srt');
    const sentences = text.match(/[^.!?\n]+[.!?\n]+/g) || [text];
    
    let srtContent = '';
    let currentTime = 0;
    const secondsPerChar = 0.06;

    sentences.forEach((sentence, idx) => {
      const duration = Math.max(2, sentence.length * secondsPerChar);
      const startTimeStr = this.formatSRTTime(currentTime);
      const endTimeStr = this.formatSRTTime(currentTime + duration);

      srtContent += `${idx + 1}\n${startTimeStr} --> ${endTimeStr}\n${sentence.trim()}\n\n`;
      currentTime += duration + 0.3;
    });

    fs.writeFileSync(srtPath, srtContent);
    console.log(`📝 Generated subtitles SRT file: ${srtPath}`);
    return srtPath;
  }

  private formatSRTTime(seconds: number): string {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const millis = Math.floor((seconds % 1) * 1000);

    const pad = (n: number, z = 2) => ('00' + n).slice(-z);
    const pad3 = (n: number) => ('000' + n).slice(-3);

    return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad3(millis)}`;
  }

  /**
   * Creates a silent MP3 audio track fallback using FFmpeg
   */
  private async generateSilentAudio(outputPath: string, durationSec: number): Promise<void> {
    try {
      const cmd = `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${durationSec} -q:a 9 -acodec libmp3lame "${outputPath}"`;
      await execAsync(cmd);
    } catch (e: any) {
      fs.writeFileSync(outputPath, Buffer.alloc(1024));
    }
  }
}
