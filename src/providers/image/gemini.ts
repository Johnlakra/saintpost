import axios from 'axios';
import fs from 'fs';
import { config } from '../../config/env.js';
import type { ImageProvider } from '../types.js';
import { geminiModelCandidates, forgetGeminiModels } from '../geminiModels.js';

/** Gemini image model: text-to-image, or reference-conditioned when a face reference is supplied. */
export const geminiImage: ImageProvider = {
  id: 'gemini', label: 'Gemini image', tier: 'premium', mode: 'both',
  enabled: () => !!config.geminiApiKey,
  async generate({ prompt, shape, refUrl, refPath }) {
    const parts: any[] = [];
    if (refPath && fs.existsSync(refPath)) {
      parts.push({ inline_data: { mime_type: 'image/png', data: fs.readFileSync(refPath).toString('base64') } });
    } else if (refUrl) {
      const ref = await axios.get(refUrl, { responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'SaintPostBot/1.0' } });
      const mime = String(ref.headers['content-type'] || 'image/jpeg').split(';')[0];
      parts.push({ inline_data: { mime_type: mime, data: Buffer.from(ref.data).toString('base64') } });
    }
    parts.push({ text: prompt });
    let res: any;
    let last: any;
    for (const model of await geminiModelCandidates('image')) {
      try {
        res = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          { contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: shape.aspect } } },
          { headers: { 'x-goog-api-key': config.geminiApiKey }, timeout: 120000 }
        );
        break;
      } catch (e: any) {
        last = e;
        if (e.response?.status !== 404) throw e;
        forgetGeminiModels();
      }
    }
    if (!res) throw last;
    const out: any[] = res.data?.candidates?.[0]?.content?.parts || [];
    const img = out.find(p => (p.inlineData || p.inline_data)?.data);
    const b64 = (img?.inlineData || img?.inline_data)?.data;
    if (!b64) throw new Error(`no image returned (${res.data?.candidates?.[0]?.finishReason || res.data?.promptFeedback?.blockReason || 'unknown reason'})`);
    return Buffer.from(b64, 'base64');
  },
};
