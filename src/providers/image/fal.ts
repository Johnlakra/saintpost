import axios from 'axios';
import { config } from '../../config/env.js';
import { fetchBytes } from '../http.js';
import type { ImageProvider } from '../types.js';

const headers = () => ({ Authorization: `Key ${config.falApiKey}` });

export const falSchnell: ImageProvider = {
  id: 'fal-flux', label: 'fal.ai FLUX', tier: 'premium', mode: 'text',
  enabled: () => !!config.falApiKey,
  async generate({ prompt, shape, seed }) {
    const model = process.env.FAL_IMAGE_MODEL || 'fal-ai/flux/schnell';
    const res = await axios.post(
      `https://fal.run/${model}`,
      { prompt, image_size: { width: shape.genW, height: shape.genH }, num_inference_steps: process.env.FAL_IMAGE_MODEL ? 28 : 4, seed, enable_safety_checker: true },
      { headers: headers(), timeout: 90000 }
    );
    const url = res.data?.images?.[0]?.url;
    if (!url) throw new Error('no image url in fal response');
    return fetchBytes(url);
  },
};

export const falKontext: ImageProvider = {
  id: 'fal-kontext', label: 'fal.ai FLUX Kontext (reference)', tier: 'premium', mode: 'ref',
  enabled: () => !!config.falApiKey,
  async generate({ prompt, shape, refUrl }) {
    const res = await axios.post(
      'https://fal.run/fal-ai/flux-pro/kontext',
      { prompt, image_url: refUrl, aspect_ratio: shape.aspect, num_images: 1, output_format: 'png' },
      { headers: headers(), timeout: 120000 }
    );
    const url = res.data?.images?.[0]?.url;
    if (!url) throw new Error('no image url in fal kontext response');
    return fetchBytes(url);
  },
};
