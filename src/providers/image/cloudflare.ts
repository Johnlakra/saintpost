import axios from 'axios';
import { config } from '../../config/env.js';
import { capped } from '../http.js';
import type { ImageProvider } from '../types.js';

const base = () => `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/ai/run`;
const auth = () => ({ Authorization: `Bearer ${config.cloudflareApiToken}` });
const on = () => !!(config.cloudflareApiToken && config.cloudflareAccountId);

/** Workers AI FLUX.1 schnell (free daily allowance, no card). */
export const cloudflareFlux: ImageProvider = {
  id: 'cf-flux', label: 'Cloudflare FLUX schnell', tier: 'standard', mode: 'text',
  enabled: on,
  async generate({ prompt, shape, seed }) {
    const { w, h } = capped(shape, 1344);
    const res = await axios.post(
      `${base()}/@cf/black-forest-labs/flux-1-schnell`,
      { prompt: prompt.slice(0, 2000), steps: 6, seed, width: w, height: h },
      { headers: auth(), timeout: 90000 }
    );
    const b64 = res.data?.result?.image;
    if (!b64) throw new Error(`no image in response: ${JSON.stringify(res.data?.errors || res.data).slice(0, 120)}`);
    return Buffer.from(b64, 'base64');
  },
};

/** Workers AI SDXL-Lightning: lower detail than FLUX but a second free quota (returns raw PNG bytes). */
export const cloudflareSdxl: ImageProvider = {
  id: 'cf-sdxl', label: 'Cloudflare SDXL-Lightning', tier: 'standard', mode: 'text',
  enabled: on,
  async generate({ prompt, shape, seed }) {
    const { w, h } = capped(shape, 1024);
    const res = await axios.post(
      `${base()}/@cf/bytedance/stable-diffusion-xl-lightning`,
      { prompt: prompt.slice(0, 1500), width: w, height: h, num_steps: 8, guidance: 3, seed },
      { headers: auth(), responseType: 'arraybuffer', timeout: 90000 }
    );
    return Buffer.from(res.data);
  },
};
