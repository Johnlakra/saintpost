import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../config/env.js';
import { ffmpeg } from '../utils/media.js';
import { classify, cooldown, coolingFor } from '../providers/cooldown.js';
import { describeError } from '../providers/http.js';
import { geminiModelCandidates, forgetGeminiModels } from '../providers/geminiModels.js';

export interface QAResult {
  /** false = no inspector was available (fail-open: the image is accepted unchecked) */
  checked: boolean;
  pass: boolean;
  issues: string[];
  /** short instruction to avoid the problems on the next attempt */
  fix: string;
  engine?: string;
}

export const qaEnabled = () => process.env.IMAGE_QA !== 'false';
export const qaRetries = () => Math.max(0, parseInt(process.env.IMAGE_QA_RETRIES || '1', 10));

const INSPECT = (subject: string, mustInclude: string[]) => `You inspect AI-generated artwork for a devotional video. Judge ONLY the defects listed below; do not judge style, camera shot, pose, clothing details, hand positions or small missing props.

Subject: ${subject}
${mustInclude.length ? `Main things that should be visible: ${mustInclude.join('; ')}` : ''}

MAJOR defects (fail only for these):
- extra or missing arms, legs or heads; two bodies fused into one;
- a hand clearly malformed at normal viewing size (extra hand, 6+ fingers, fused or missing fingers);
- wings, limbs or objects passing THROUGH another person's body, or figures overlapping so they cannot be told apart;
- a badly distorted or melted face;
- readable text, letters or a watermark;
- the main subject is clearly absent or wrong (e.g. a different kind of figure than the subject);
- a figure that looks like the traditional depiction of Jesus Christ (long hair and beard, robe, serene gaze) when the subject is not Jesus.

JSON only: {"pass": true|false, "severity": "none"|"minor"|"major", "issues": ["each major defect, briefly"], "fix": "one short instruction to avoid them next time, e.g. 'hide the hands; keep the angel clearly behind the girl with a gap'"}. pass=false only if severity is "major".`;

/** Downscale to a small JPEG for the inspector (cheap and fast). */
async function smallJpeg(imagePath: string): Promise<string> {
  const out = path.join(os.tmpdir(), `qa_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
  try {
    await ffmpeg(['-i', imagePath, '-vf', 'scale=768:768:force_original_aspect_ratio=decrease', '-frames:v', '1', '-q:v', '4', out]);
    return fs.readFileSync(out).toString('base64');
  } finally {
    fs.rmSync(out, { force: true });
  }
}

const parse = (text: string): { pass: boolean; severity: string; issues: string[]; fix: string } => {
  const m = text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('inspector did not return JSON');
  const j = JSON.parse(m[0]);
  const major = j.severity === 'major' || j.pass === false;
  return { pass: !major, severity: String(j.severity || ''), issues: Array.isArray(j.issues) ? j.issues.map(String) : [], fix: String(j.fix || '') };
};

/** Gemini vision (text/vision models have a real free tier, unlike the image-generation models). */
async function geminiInspect(b64: string, prompt: string): Promise<string> {
  let last: any;
  for (const model of await geminiModelCandidates('vision')) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: b64 } }, { text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        },
        { headers: { 'x-goog-api-key': config.geminiApiKey }, timeout: 60000 }
      );
      const text = res.data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join('');
      if (!text) throw new Error('empty inspector response');
      return text;
    } catch (e: any) {
      last = e;
      if (e.response?.status !== 404) throw e;
      forgetGeminiModels(); // retired name: try the next candidate / re-discover
    }
  }
  throw last;
}

/** OpenRouter vision models: IMAGE_QA_MODEL if set, else any currently-live free model that accepts images. */
let visionModels: { at: number; ids: string[] } | null = null;
async function openRouterVisionModels(): Promise<string[]> {
  if (process.env.IMAGE_QA_MODEL) return [process.env.IMAGE_QA_MODEL];
  if (visionModels && Date.now() - visionModels.at < 3600_000) return visionModels.ids;
  const res = await axios.get('https://openrouter.ai/api/v1/models', { timeout: 20000 });
  const pref = /gemini|gemma-3|qwen.*vl|pixtral|llama.*vision|mistral-small/i;
  const ids: string[] = (res.data?.data || [])
    .filter((m: any) => m.architecture?.input_modalities?.includes('image') && m.id.endsWith(':free'))
    .sort((a: any, b: any) => Number(pref.test(b.id)) - Number(pref.test(a.id)))
    .map((m: any) => m.id)
    .slice(0, 4);
  visionModels = { at: Date.now(), ids };
  return ids;
}
async function openRouterInspect(b64: string, prompt: string): Promise<{ text: string; model: string }> {
  let last: any;
  for (const model of await openRouterVisionModels()) {
    if (coolingFor(`qa:${model}`)) continue;
    try {
      const res = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        { model, temperature: 0, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }] }] },
        { headers: { Authorization: `Bearer ${config.openrouterApiKey}`, 'HTTP-Referer': config.renderExternalUrl, 'X-Title': 'SaintPost' }, timeout: 90000 }
      );
      const text = res.data?.choices?.[0]?.message?.content;
      if (text) return { text: String(text), model };
    } catch (e: any) {
      last = e;
      cooldown(`qa:${model}`, 10 * 60_000, 'vision model unavailable');
    }
  }
  throw last || new Error('no vision model available');
}

/**
 * Look at a generated image and decide whether it is logical and clean. FAIL-OPEN: if no inspector can be reached,
 * the image is accepted (checked:false) so a QA outage never blocks a video.
 */
export async function inspectImage(imagePath: string, subject: string, mustInclude: string[] = []): Promise<QAResult> {
  const open: QAResult = { checked: false, pass: true, issues: [], fix: '' };
  if (!qaEnabled()) return open;
  const prompt = INSPECT(subject, mustInclude);
  let b64: string;
  try { b64 = await smallJpeg(imagePath); } catch (e: any) { console.warn('     ⚠️ QA could not read the image:', e.message); return open; }

  if (config.geminiApiKey && !coolingFor('qa:gemini')) {
    try {
      const r = parse(await geminiInspect(b64, prompt));
      return { checked: true, ...r, engine: 'Gemini vision' };
    } catch (e: any) {
      const msg = describeError(e);
      console.warn(`     ⚠️ Gemini vision QA failed: ${msg}`);
      const c = classify(e, msg);
      cooldown('qa:gemini', c.kind === 'transient' ? 2 * 60_000 : c.ms, 'QA unavailable');
    }
  }
  if (config.openrouterApiKey) {
    try {
      const out = await openRouterInspect(b64, prompt);
      return { checked: true, ...parse(out.text), engine: `OpenRouter ${out.model}` };
    } catch (e: any) {
      console.warn(`     ⚠️ OpenRouter vision QA failed: ${describeError(e)}`);
    }
  }
  return open;
}
