import axios from 'axios';
import { config } from '../../config/env.js';
import { fetchBytes } from '../http.js';
import type { VideoProvider } from '../types.js';

/**
 * fal.ai image-to-video (LTX / Kling / Wan...). Model is configurable with FAL_VIDEO_MODEL.
 * Typical fal accounts get a small signup credit; each short clip costs a few cents, so it is only used for a few scenes.
 */
export const falVideo: VideoProvider = {
  id: 'fal-video', label: 'fal.ai image-to-video',
  enabled: () => process.env.ENABLE_AI_VIDEO === 'true' && !!config.falApiKey,
  async generate({ imageUrl, prompt }) {
    const model = process.env.FAL_VIDEO_MODEL || 'fal-ai/ltx-video/image-to-video';
    const res = await axios.post(
      `https://fal.run/${model}`,
      { prompt: `${prompt}. Gentle natural motion, slow cinematic camera move, stable face and clothing, no morphing, no text.`.slice(0, 900), image_url: imageUrl },
      { headers: { Authorization: `Key ${config.falApiKey}` }, timeout: 300000 }
    );
    const url = res.data?.video?.url || res.data?.videos?.[0]?.url;
    if (!url) throw new Error('no video url in fal response');
    return fetchBytes(url, 120000);
  },
};
