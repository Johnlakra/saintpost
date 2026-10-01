import axios from 'axios';
import { config } from '../../config/env.js';
import { capped, fetchBytes } from '../http.js';
import type { ImageProvider } from '../types.js';

const b64OrUrl = async (data: any): Promise<Buffer> => {
  const item = data?.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item?.url) return fetchBytes(item.url);
  throw new Error('no image in response');
};

/** Together AI's free FLUX.1 schnell endpoint. */
export const together: ImageProvider = {
  id: 'together', label: 'Together FLUX schnell (free)', tier: 'standard', mode: 'text',
  enabled: () => !!config.togetherApiKey,
  async generate({ prompt, shape, seed }) {
    const { w, h } = capped(shape);
    const res = await axios.post(
      'https://api.together.xyz/v1/images/generations',
      { model: process.env.TOGETHER_IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell-Free', prompt, width: w, height: h, steps: 4, seed, n: 1, response_format: 'b64_json' },
      { headers: { Authorization: `Bearer ${config.togetherApiKey}` }, timeout: 120000 }
    );
    return b64OrUrl(res.data);
  },
};

/** HuggingFace Inference Providers (monthly free credits). The old hf-inference FLUX endpoint returns 410 Gone. */
const hf = (provider: 'nscale' | 'together'): ImageProvider => ({
  id: `hf-${provider}`, label: `HuggingFace/${provider} FLUX schnell`, tier: 'standard', mode: 'text',
  enabled: () => !!config.huggingfaceApiKey,
  async generate({ prompt, shape, seed }) {
    const { w, h } = capped(shape);
    const res = await axios.post(
      `https://router.huggingface.co/${provider}/v1/images/generations`,
      { model: 'black-forest-labs/FLUX.1-schnell', prompt, response_format: 'b64_json', width: w, height: h, size: `${w}x${h}`, seed, steps: 4, n: 1 },
      { headers: { Authorization: `Bearer ${config.huggingfaceApiKey}` }, timeout: 120000 }
    );
    return b64OrUrl(res.data);
  },
});
export const hfNscale = hf('nscale');
export const hfTogether = hf('together');

async function replicateRun(model: string, input: any): Promise<Buffer> {
  const headers = { Authorization: `Bearer ${config.replicateApiToken}`, 'Content-Type': 'application/json', Prefer: 'wait=60' };
  let pred = (await axios.post(`https://api.replicate.com/v1/models/${model}/predictions`, { input }, { headers, timeout: 90000 })).data;
  for (let i = 0; i < 30 && !['succeeded', 'failed', 'canceled'].includes(pred.status); i++) {
    await new Promise(r => setTimeout(r, 2000));
    pred = (await axios.get(pred.urls.get, { headers, timeout: 30000 })).data;
  }
  if (pred.status !== 'succeeded') throw new Error(`prediction ${pred.status}: ${pred.error || ''}`);
  return fetchBytes(Array.isArray(pred.output) ? pred.output[0] : pred.output);
}

export const replicateFlux: ImageProvider = {
  id: 'replicate-flux', label: 'Replicate FLUX schnell', tier: 'standard', mode: 'text',
  enabled: () => !!config.replicateApiToken,
  generate: ({ prompt, shape, seed }) => replicateRun('black-forest-labs/flux-schnell', { prompt, aspect_ratio: shape.aspect, seed, output_format: 'png', num_outputs: 1 }),
};

export const replicateKontext: ImageProvider = {
  id: 'replicate-kontext', label: 'Replicate FLUX Kontext (reference)', tier: 'premium', mode: 'ref',
  enabled: () => !!config.replicateApiToken,
  generate: ({ prompt, shape, refUrl }) => replicateRun('black-forest-labs/flux-kontext-pro', { prompt, input_image: refUrl, aspect_ratio: shape.aspect, output_format: 'png' }),
};

/** Pollinations: anonymous tier is rate-limited and low quality => 'basic' (never used for scenes unless explicitly allowed). */
let chain: Promise<unknown> = Promise.resolve();
const polli = (model: string, id: string, mode: 'text' | 'ref'): ImageProvider => ({
  id, label: `Pollinations ${model}`, tier: 'basic', mode, tries: model === 'flux' ? 3 : 1,
  enabled: () => mode === 'text' || !!config.pollinationsApiKey, // kontext needs an account key
  generate({ prompt, shape, seed, refUrl }) {
    const run = chain.then(async () => {
      try {
        const { w, h } = capped(shape);
        const p = encodeURIComponent(prompt.replace(/\s+/g, ' ').trim().slice(0, 900));
        const url = `https://image.pollinations.ai/prompt/${p}?width=${w}&height=${h}&seed=${seed}&model=${model}&nologo=true&enhance=false&safe=true${refUrl && mode === 'ref' ? `&image=${encodeURIComponent(refUrl)}` : ''}`;
        const res = await axios.get(url, {
          responseType: 'arraybuffer', timeout: 120000,
          headers: { 'User-Agent': 'SaintPost/1.0', ...(config.pollinationsApiKey ? { Authorization: `Bearer ${config.pollinationsApiKey}` } : {}) },
        });
        return Buffer.from(res.data);
      } finally {
        await new Promise(r => setTimeout(r, 3000)); // one request at a time, 3s apart
      }
    });
    chain = run.catch(() => undefined);
    return run;
  },
});
export const pollinationsFlux = polli('flux', 'pollinations-flux', 'text');
export const pollinationsKontext = polli('kontext', 'pollinations-kontext', 'ref');
