import axios from 'axios';
import { jsonrepair } from 'jsonrepair';
import { cooldown, coolingFor } from '../providers/cooldown.js';
import { config } from '../config/env.js';
import { SaintRecord } from '../data/sanctusFetcher.js';
import { romanizeFallback } from '../utils/romanize.js';
import { LENGTHS, LengthPreset, DEFAULT_LENGTH } from '../config/lengths.js';

/** Cached, language-neutral fact sheet + casting sheet for a saint (see LLMService.getDossier). */
export interface Dossier {
  hook: string; who: string;
  timeline: Array<{ when: string; what: string }>;
  key_deeds: string[]; struggles: string[]; why_saint: string; feast_and_patronage: string;
  what_we_learn: string[]; did_you_know: string;
  terms: Array<{ term: string; plain: string }>;
  appearance: string;
  /** person = one saint; angels/group/mystery/object = the feast is about something else (e.g. the Holy Guardian Angels) */
  subject_type: 'person' | 'angels' | 'group' | 'mystery' | 'object';
  /** every person/being that appears in the story, each with a distinct look */
  cast: Array<{ role: string; look: string }>;
  /** generally accepted Catholic iconography for non-person subjects (empty for ordinary saints) */
  iconography: string;
}
export function isDossier(d: any): d is Dossier {
  return !!d && Array.isArray(d.what_we_learn) && d.what_we_learn.length >= 3 && typeof d.did_you_know === 'string' && !!d.who && typeof d.appearance === 'string' && Array.isArray(d.cast) && typeof d.subject_type === 'string';
}

/** One image prompt plus what the image inspector should verify. */
export interface ScenePrompt {
  prompt: string;
  /** simpler, lower-risk composition used when retries keep failing */
  safe: string;
  /** things that must be visible for the image to match the narration */
  mustInclude: string[];
  people?: number;
  risk: 'low' | 'medium' | 'high';
  problems: string[];
  /** the saint / main character is visible in this picture (so the face reference should be applied) */
  usesMain: boolean;
}
export interface VisualBrief { cover: ScenePrompt; scenes: ScenePrompt[] }

/** The physical-logic / anatomy rulebook shared by the prompt director and the prompt checker. */
export const VISUAL_RULES = `VISUAL LOGIC RULES (apply to every prompt):
1. ONE clear subject. At most 3 figures per picture; state the exact number ("exactly one person", "exactly two figures"). Avoid crowds.
2. Never let bodies overlap or intersect: every figure has clear empty space around it. Nobody stands inside, behind-through or fused with another figure. Write explicit positions ("the child on the left, the angel one step behind and above, with a visible gap between them").
3. ANGELS: exactly two wings, attached to the angel's own shoulder blades, spread outward BEHIND that angel only. The wings never cross, touch or pass through any human or other object. A guardian angel stands or hovers behind and slightly above the person it protects, with clear air between the wings and the person.
4. HANDS: hide them or keep them simple. Prefer hands clasped in prayer in front of the chest, tucked into sleeves, resting at the sides out of frame, or holding one simple object with both hands. Never close-ups of hands, never interlaced fingers, never hands overlapping faces or other hands. When hands are visible write "two hands, five fingers each, natural proportions".
5. Each figure: exactly one head, two arms, two legs (when visible), natural proportions, a calm clear face turned toward the camera or in three-quarter view, large enough in the frame (at least one third of the picture height) to be drawn well.
6. Objects must be physically supported (on a table, the ground, in a hand). Nothing floats except light, clouds and celestial beings, and those are described explicitly.
7. Show the narration LITERALLY and only that: the subject named in the narration must be visible and recognisable; do not add unrelated people, symbols or events.
8. Period accuracy for architecture, clothing, tools and technology; no halos, crosses, rosaries or religious garments unless documented.
9. Consistent light: one light direction, shadows that match it. Consistent scale and perspective.
10. No text, letters, captions, signs with writing, logos or watermarks.
11. NEVER default to a Christ-like figure (long hair, beard, white or red robe, serene gaze). Show ONLY the cast of this story, each exactly as described in the CAST list (age, gender, hair, clothing), and make different people look clearly different. Jesus appears only when the narration is about Jesus.
12. Use positive wording only (say what IS there). Do not write negations such as "no extra fingers": the generator ignores them.`;

export interface SceneScript {
  safe_prompt?: string; // simpler fallback prompt (see ScenePrompt.safe)
  must_include?: string[]; // checklist the image inspector verifies
  risk?: 'low' | 'medium' | 'high'; // chance of anatomy/logic errors (decides whether the inspector looks at it)
  uses_main?: boolean; // the saint themself is in this picture (face reference applies)
  subtitle?: string; // Roman-script (Hinglish/Pinglish) version of the voiceover for on-screen subtitles
  image_prompt?: string; // detailed, fact-grounded prompt for the image model
  scene_number: number;
  duration: number; // in seconds (5-10)
  visual: string;
  voiceover: string;
  text_overlay: string;
}

export interface GeneratedContent {
  full_story: string;
  what_we_learn: string[];
  did_you_know: string;
  video_script: SceneScript[];
  caption: string;
  hashtags: string;
}

export class LLMService {
  private openrouterApiKey: string;
  private primaryModel: string;
  private badModels = new Set<string>(); // models that hard-failed (404/400/403): don't retry them this run

  constructor() {
    this.openrouterApiKey = config.openrouterApiKey;
    this.primaryModel = config.openrouterModel;
  }


  /**
   * OpenRouter retires/renames models often hard-coded slugs rot. Ask OpenRouter what exists right now:
   * the configured model first (if still live), then any extra models from OPENROUTER_FALLBACK_MODELS,
   * then currently-free capable models.
   */
  private async resolveModels(modelOverride?: string): Promise<string[]> {
    let live: Array<{ id: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }> = [];
    try {
      const res = await axios.get('https://openrouter.ai/api/v1/models', { timeout: 20000 });
      live = res.data?.data || [];
    } catch (e: any) {
      console.warn('⚠️ Could not list OpenRouter models:', e.message);
    }
    const liveIds = new Set(live.map(m => m.id));
    const wanted = [modelOverride || this.primaryModel, ...(process.env.OPENROUTER_FALLBACK_MODELS || '').split(',').map(x => x.trim())].filter(Boolean);
    // If the list call failed, trust configured names as-is.
    const configured = liveIds.size ? wanted.filter(m => liveIds.has(m)) : wanted;
    wanted.filter(m => liveIds.size && !liveIds.has(m)).forEach(m => console.warn(`⚠️ Model "${m}" no longer exists on OpenRouter - skipping. Update OPENROUTER_MODEL.`));

    const pref = /llama-3\.3-70b|qwen|gpt-oss|gemma-3-27b|deepseek|mistral|gemini|glm|kimi/i;
    const free = live
      .filter(m => m.id.endsWith(':free') && (m.context_length || 0) >= 16000 && !/vision|image|embed|guard|safe/i.test(m.id))
      .sort((a, b) => Number(pref.test(b.id)) - Number(pref.test(a.id)) || (b.context_length || 0) - (a.context_length || 0))
      .map(m => m.id);

    // Proven cheap multilingual default, tried before the (unreliable) free tier.
    const dependable = ['deepseek/deepseek-chat'].filter(m => !liveIds.size || liveIds.has(m));
    return [...new Set([...configured, ...dependable, ...free])].filter(m => !this.badModels.has(m) && !coolingFor(`llm:${m}`)).slice(0, 8);
  }


  private dossiers = new Map<string, Dossier>();

  /**
   * ONE call per saint, cached forever (memory + the saints row): a language-neutral English fact sheet AND the
   * "casting sheet" (apparent age, gender, hair, period clothing). Every later video of this saint (regenerate,
   * other languages, other lengths) reuses it, so the expensive source text is read only once.
   */
  async getDossier(saint: SaintRecord): Promise<Dossier | null> {
    const key = `${saint.name}|${(saint.facts || '').length}`;
    const cached = this.dossiers.get(key) || (isDossier(saint.dossier) ? saint.dossier : null);
    if (cached) { this.dossiers.set(key, cached); return cached; }
    if (config.dryRun || !this.openrouterApiKey) return null;
    const sourceText = (saint.facts || saint.short_description || 'No source available - say only what is certain about this saint.').slice(0, 9000);
    const d = await this.completeJson(`You are a careful Catholic historian and teacher. Prepare a reusable fact sheet about "${saint.name}" for a video aimed at a wide audience, including people who know nothing about saints.

Feast: month ${saint.feast_month}, day ${saint.feast_day}${saint.rank ? ` (${saint.rank})` : ''}. Patronage: ${saint.patronage || 'n/a'}. Era: ${saint.era || 'n/a'}. Region: ${saint.region || 'n/a'}.

SOURCE FACTS (documented - the ONLY allowed basis for facts):
${sourceText}

FACT RULES: use only what the SOURCE states. No invented events, quotes, miracles, dates, places, relatives or objects. Leave out what is unknown. Keep every date and place exact. Write in simple plain English.

Return JSON:
{
  "hook": "one surprising, true, attention-grabbing opening line or question (max 18 words)",
  "who": "who they were in 2 simple sentences: when and where they lived, and what they were",
  "timeline": [ {"when": "year or age, as stated", "what": "one clear sentence"} ],
  "key_deeds": ["what they did that mattered (3 to 6 simple sentences)"],
  "struggles": ["documented hardships (0 to 4)"],
  "why_saint": "why the Church honours them; recognition/canonization only if documented",
  "feast_and_patronage": "what the Church celebrates on their feast day and whom they are patron of, only if documented",
  "what_we_learn": ["exactly 3 practical lessons, each starts with a verb, max 15 words, each tied to a real event"],
  "did_you_know": "1 true, surprising, lesser-known fact from the SOURCE (1-2 simple sentences)",
  "terms": [ {"term": "a Church word a beginner may not know", "plain": "very short plain explanation"} ],
  "subject_type": "person" | "angels" | "group" | "mystery" | "object"   (person = the feast honours one real saint; angels = a feast of angels; group = several saints/martyrs; mystery/object = e.g. the Holy Cross, a title of Mary),
  "cast": [ {"role": "who or what appears in the story", "look": "age, gender, complexion, hair and clothing, correct for their real time and place; every cast member must look CLEARLY DIFFERENT from the others in age/gender/hair/clothing"} ]   (3 to 6 entries: the saint, and everyone else the story needs, e.g. a child, a bishop, a pope of that century, a crowd member; for a feast of angels: the angel and the person they protect),
  "iconography": "ONLY for angels/mystery/object/group: how Catholic art generally shows this subject in 2 plain sentences (e.g. a young adult angel in a plain white robe with two feathered wings standing behind and slightly above a child, no halo needed). \"\" for ordinary saints.",
  "appearance": "ONLY if the subject is one real person: one sentence (max 40 words) starting with apparent age and gender, then complexion, hair and everyday clothing correct for their real time and place. Age = the age they are best known at (the real age at death for saints who died young). Do NOT add a religious habit, robe, cassock, halo, cross, rosary, glasses or any accessory unless the SOURCE explicitly says they wore/used it. Never default to an old bearded man. Use \"\" if the subject is not one person (e.g. a feast of the Angels). NEVER describe any cast member as Christ-like (long hair + beard + white robe) unless the subject is Jesus himself."
}
Respond ONLY with JSON.`, 0.2, 3200);
    if (!isDossier(d)) throw new Error('LLM returned an incomplete fact sheet');
    this.dossiers.set(key, d);
    return d;
  }

  /**
   * Two-stage "director + checker" for image prompts.
   *  1) DIRECTOR writes a detailed, fact-grounded prompt per scene (what to show, exactly where, from which angle).
   *  2) CHECKER audits every prompt against a physical-logic / anatomy rulebook and rewrites the ones that could
   *     produce impossible pictures (wings through bodies, extra hands, merged figures), and adds a "safe" fallback
   *     composition plus a checklist (must_include) that the image inspector later verifies.
   */
  async buildVisualBrief(
    saint: SaintRecord,
    scenes: SceneScript[],
    feast: { dateLabel: string; rank?: string; color?: string; martyrology?: string },
    facts: Dossier | null = null
  ): Promise<VisualBrief | null> {
    if (config.dryRun || !this.openrouterApiKey) return null;
    try {
      const dossier = `SUBJECT DOSSIER
Name: ${saint.name}
Feast: ${feast.dateLabel}${feast.rank ? `, ${feast.rank}` : ''}${feast.color ? `, liturgical colour ${feast.color}` : ''}
Patronage: ${saint.patronage || 'n/a'}
Era: ${saint.era || 'n/a'}   Region: ${saint.region || 'n/a'}
Subject type: ${facts?.subject_type || 'person'}
Fixed appearance of the saint (copy verbatim whenever the saint appears): ${saint.appearance || 'n/a (this feast is not about one person)'}
CAST (the ONLY figures allowed; copy each look exactly; they must look clearly different from each other): ${facts ? JSON.stringify(facts.cast).slice(0, 1500) : 'n/a'}${facts?.iconography ? `\nIconography: ${facts.iconography}` : ''}
Roman Martyrology entry for the day: ${(feast.martyrology || '').slice(0, 600) || 'n/a'}
Documented facts (compact):
${facts ? JSON.stringify({ who: facts.who, timeline: facts.timeline, key_deeds: facts.key_deeds, struggles: facts.struggles, why_saint: facts.why_saint, feast: facts.feast_and_patronage }).slice(0, 3000) : (saint.facts || saint.short_description || '').slice(0, 3000)}`;

      const sceneList = JSON.stringify(scenes.map((sc, i) => ({ n: i + 1, narration: sc.voiceover, rough_visual: sc.visual })));

      // ---- Stage 1: DIRECTOR
      const draft = await this.completeJson(`You are an art director writing prompts for an image generator (FLUX). Each prompt must produce a physically logical, clearly composed picture that illustrates exactly what the narration says.

${dossier}

SCENES (narration + rough visual):
${sceneList}

${VISUAL_RULES}

For each scene write ONE prompt of 90-140 English words in this order: (1) shot type and camera angle, (2) EXACTLY who is in frame and how many people, (3) a spatial layout sentence: foreground / midground / background and left / right positions of every figure and object, (4) the action in one simple pose per figure, (5) the real place and its period-accurate architecture, objects and clothing, (6) time of day, light direction, colour palette and mood.
Also write one "cover" prompt (square 1:1). If the subject type is "person": a calm head-and-shoulders portrait of the saint in a setting that reflects their life. Otherwise (angels, group, mystery, object): the central subject of the feast shown through its cast in one clear scene (NOT a portrait of a lone robed figure).

Respond ONLY with JSON: {"cover": "...", "scenes": ["prompt for scene 1", "..."]} with exactly ${scenes.length} scene prompts.`, 0.3, 600 + (scenes.length + 1) * 260);
      if (!draft?.cover || !Array.isArray(draft.scenes) || draft.scenes.length !== scenes.length) throw new Error('director returned an unexpected shape');

      // ---- Stage 2: CHECKER
      try {
        const audit = await this.completeJson(`You are a strict quality checker for AI image prompts. Image generators often draw impossible things: wings or limbs passing through another body, merged figures, extra hands or fingers, floating objects, wrong counts, unclear scenes. Audit each prompt below and fix it so the picture will be logical and unambiguous.

${VISUAL_RULES}

For EACH item decide:
- "problems": what could go wrong or is not relevant to the narration (empty array if none).
- "prompt": the corrected, final prompt (keep it 90-140 words, same structure: shot, who and how many, spatial layout, action, place, light). Apply every rule. Rewrite poses so hands are hidden or simple.
- "safe_prompt": a SIMPLER composition that conveys the same idea with the lowest risk of errors: a single main figure (or a single subject), three-quarter or back view or medium shot, hands hidden or clasped, no overlapping bodies, plain uncluttered background. 50-90 words.
- "must_include": 2 to 4 short phrases naming things that MUST be visible for the picture to match the narration (e.g. "angel behind the child", "two wings attached to the angel's back").
- "people": the exact number of human or angelic figures in the picture.
- "main_character_visible": true only if the saint themself (the fixed-appearance person) is clearly in the picture; false for scenes of other people, crowds, objects, places or heavenly scenes without the saint.
- "risk": "low" | "medium" | "high" chance of anatomy or logic errors.

NARRATION AND DRAFT PROMPTS (item 0 is the cover):
${JSON.stringify([{ i: 0, narration: 'cover portrait', prompt: draft.cover }, ...draft.scenes.map((p: string, i: number) => ({ i: i + 1, narration: scenes[i].voiceover, prompt: p }))])}

Saint appearance (fixed): ${saint.appearance || 'n/a (the subject is not one person)'}\nSubject: ${saint.name} (${facts?.subject_type || 'person'})\nCAST: ${facts ? JSON.stringify(facts.cast).slice(0, 1200) : 'n/a'}${facts?.iconography ? `\nIconography: ${facts.iconography}` : ''}\n\nRespond ONLY with JSON: {"items": [ {"i": 0, "problems": [], "prompt": "...", "safe_prompt": "...", "must_include": ["..."], "people": 1, "main_character_visible": true, "risk": "low"}, ... ]} with exactly ${scenes.length + 1} items in order.`, 0.2, 700 + (scenes.length + 1) * 500);
        const items: any[] = audit?.items;
        if (!Array.isArray(items) || items.length !== scenes.length + 1) throw new Error('checker returned an unexpected shape');
        const toPrompt = (it: any, fallback: string): ScenePrompt => ({
          prompt: String(it?.prompt || fallback),
          safe: String(it?.safe_prompt || ''),
          mustInclude: Array.isArray(it?.must_include) ? it.must_include.map(String).slice(0, 5) : [],
          people: Number.isFinite(+it?.people) ? +it.people : undefined,
          risk: ['low', 'medium', 'high'].includes(it?.risk) ? it.risk : 'medium',
          problems: Array.isArray(it?.problems) ? it.problems.map(String) : [],
          usesMain: it?.main_character_visible !== false,
        });
        const fixed = items.map((it, k) => toPrompt(it, k === 0 ? String(draft.cover) : String(draft.scenes[k - 1])));
        const nFixed = fixed.filter(f => f.problems.length).length;
        console.log(`   🔎 Prompt checker: ${nFixed}/${fixed.length} prompts rewritten, ${fixed.filter(f => f.risk === 'high').length} high-risk`);
        return { cover: fixed[0], scenes: fixed.slice(1) };
      } catch (e: any) {
        console.warn(`⚠️ Prompt checker failed (${e.message}); using the director's prompts as they are.`);
        const plain = (p: string): ScenePrompt => ({ prompt: String(p), safe: '', mustInclude: [], risk: 'medium', problems: [], usesMain: true });
        return { cover: plain(draft.cover), scenes: draft.scenes.map(plain) };
      }
    } catch (e: any) {
      console.warn('⚠️ Visual brief failed, using basic scene visuals:', e.message);
      return null;
    }
  }

  /**
   * Hinglish / Pinglish subtitles: the SAME words as the Hindi / Punjabi narration, typed in English letters
   * the way people write them on phones. Falls back to rule-based transliteration if the LLM is unavailable.
   */
  async romanizeScenes(scenes: SceneScript[], lang: 'hi' | 'pa'): Promise<string[]> {
    const name = lang === 'hi' ? 'Hinglish (Hindi written in English letters)' : 'Pinglish (Punjabi written in English letters)';
    try {
      if (config.dryRun || !this.openrouterApiKey) throw new Error('LLM disabled');
      const out = await this.completeJson(`Transliterate each line into natural ${name}, exactly as a young Indian would type it on WhatsApp.

Rules:
- Keep EVERY word and the exact meaning. Do NOT translate into English and do not add or drop words.
- Use simple, common Roman spellings (e.g. "hai", "ka", "ki", "nahi", "prarthna", "jeevan", "seva", "ਕੀਤਾ" -> "kita", "ਹੈ" -> "hai", "ਦਾ" -> "da"). No diacritics, no accents.
- Saint names and English words: use their normal English spelling (e.g. "Saint Francis", "Carlo Acutis").
- Keep the punctuation. Sentence case.

Input lines (JSON array):
${JSON.stringify(scenes.map(s => s.voiceover))}

Respond ONLY with a JSON object: {"lines": [${scenes.length} strings in the same order]}.`, 0.1, 400 + scenes.length * 120);
      const lines = Array.isArray(out) ? out : out?.lines;
      if (!Array.isArray(lines) || lines.length !== scenes.length || lines.some((x: any) => typeof x !== 'string')) throw new Error('unexpected shape');
      return lines.map((x: string) => x.trim());
    } catch (e: any) {
      console.warn(`⚠️ LLM romanization failed (${e.message}); using rule-based transliteration.`);
      return scenes.map(s => romanizeFallback(s.voiceover, lang));
    }
  }

  /** Belt and braces: never let follow/subscribe/@handle text reach the video, whatever the LLM wrote. */
  static stripPromo(sc: SceneScript): void {
    const promo = /@\w|https?:\/\/|www\.|\b(follow|subscribe|like and share|share this)\b|फॉलो|सब्सक्राइब|फ़ॉलो|ਫਾਲੋ|ਸਬਸਕ੍ਰਾਈਬ|ਫ਼ਾਲੋ/i;
    if (promo.test(sc.text_overlay || '')) sc.text_overlay = '';
    sc.voiceover = (sc.voiceover || '')
      .split(/(?<=[.!?।])\s+/)
      .filter(sentence => !promo.test(sentence))
      .join(' ')
      .trim();
  }

  /** Generic JSON completion used by maintenance scripts (db:enrich). */
  async completeJson(prompt: string, temperature = 0.7, maxTokens = 3000): Promise<any> {
    let lastErr: any;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const text = await this.queryOpenRouter(
        attempt === 1 ? prompt : `${prompt}\n\nIMPORTANT: your previous answer was not valid JSON. Answer again with strictly valid JSON only: double quotes, no comments, no trailing commas, no text outside the JSON.`,
        undefined, attempt === 1 ? temperature : Math.min(temperature, 0.2), { maxTokens, json: true }
      );
      try {
        return LLMService.parseJsonLoose(text);
      } catch (e: any) {
        lastErr = e;
        console.warn(`⚠️ LLM returned unparseable JSON (attempt ${attempt}/2): ${e.message}`);
      }
    }
    throw lastErr;
  }

  /** Tolerant JSON: strips code fences/prose, then repairs trailing commas, comments, unescaped newlines, etc. */
  static parseJsonLoose(text: string): any {
    const cleaned = text.replace(/```json|```/g, '');
    const m = cleaned.match(/[\[{][\s\S]*[\]}]/);
    if (!m) throw new Error('LLM did not return JSON');
    try { return JSON.parse(m[0]); } catch { /* try to repair */ }
    return JSON.parse(jsonrepair(m[0]));
  }

  /**
   * Helper to execute completion against OpenRouter API with model fallback rotation
   */
  private async queryOpenRouter(
    prompt: string,
    modelOverride?: string,
    temperature = 0.7,
    opts: { maxTokens?: number; json?: boolean } = {}
  ): Promise<string> {
    if (config.dryRun || !this.openrouterApiKey) {
      console.log(`[DRY RUN] OpenRouter prompt (${modelOverride || this.primaryModel}):\n${prompt.substring(0, 150)}...`);
      return '';
    }

    const modelsToTry = await this.resolveModels(modelOverride);
    if (modelsToTry.length === 0) throw new Error('No usable OpenRouter models found (check OPENROUTER_MODEL / key credits).');

    for (const model of modelsToTry) {
      // An explicit max_tokens keeps the request affordable on a small balance (OpenRouter otherwise reserves the
      // model's maximum) and caps runaway output.
      let maxTokens = opts.maxTokens ?? config.openrouterMaxTokens;
      let json = !!opts.json;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log(`🤖 Querying LLM via OpenRouter model: ${model}...`);
          const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              model,
              messages: [{ role: 'user', content: prompt }],
              temperature,
              max_tokens: maxTokens,
              ...(json ? { response_format: { type: 'json_object' } } : {}),
            },
            {
              headers: {
                'Authorization': `Bearer ${this.openrouterApiKey}`,
                'HTTP-Referer': config.renderExternalUrl,
                'X-Title': 'SaintPost Automation Bot',
                'Content-Type': 'application/json',
              },
              timeout: 240000, // long scripts (15 scenes) can take a couple of minutes
            }
          );
          const text = response.data?.choices?.[0]?.message?.content;
          if (text) return String(text).trim();
          break;
        } catch (err: any) {
          const detail: string = err.response?.data?.error?.message || err.message;
          const status = err.response?.status;
          const afford = /can only afford (\d+)/i.exec(detail);
          if (afford && attempt < 3) {
            // low balance: shrink the request to what the account can pay for and try again
            const room = parseInt(afford[1], 10) - 100;
            if (room >= 600 && room < maxTokens) {
              console.warn(`⚠️ OpenRouter balance is low: retrying with max_tokens=${room}. Top up credits at openrouter.ai.`);
              maxTokens = room;
              continue;
            }
          }
          if (json && status === 400 && /response_format|json/i.test(detail)) { json = false; continue; } // model has no JSON mode
          console.warn(`⚠️ OpenRouter error on model ${model}: ${detail}`);
          if (status === 402 || afford) cooldown(`llm:${model}`, 10 * 60_000, 'low OpenRouter credit');
          else if (status && status !== 429 && status < 500) this.badModels.add(model);
          break;
        }
      }
    }

    throw new Error('All OpenRouter models failed to respond. If your OpenRouter balance is low, add credit at openrouter.ai/credits.');
  }

  /**
   * SuperCMO Adaptation: Generate End-to-End Devotional Content Package for a Saint
   * Default Language: Simple, conversational Hindi (हिंदी)
   */
  async generateSaintContentPackage(
    saint: SaintRecord,
    targetLang: 'en' | 'hi' | 'pa' = config.defaultLanguage || 'hi',
    preset: LengthPreset = LENGTHS[DEFAULT_LENGTH],
    dossier: Dossier | null = null,
    opts: { roman?: boolean } = {}
  ): Promise<GeneratedContent> {
    const langNames: Record<string, string> = {
      hi: 'Simple, Everyday Conversational Hindi (आसान और सरल हिंदी, Devanagari script)',
      en: 'English',
      pa: 'Punjabi (Gurmukhi script, ਪੰਜਾਬੀ)',
    };
    const langLabel = langNames[targetLang] || langNames.hi;

    console.log(`📝 Generating LLM content package for ${saint.name} in ${langLabel}...`);

    if (config.dryRun || !this.openrouterApiKey) {
      return this.getDryRunFallbackContent(saint, targetLang);
    }

    try {
      const factData = dossier;
      if (!factData) throw new Error('missing fact sheet');
      const storyData = { what_we_learn: factData.what_we_learn, did_you_know: String(factData.did_you_know), full_story: '' };
      const roman = targetLang !== 'en' && !!opts.roman;
      const romanName = targetLang === 'hi' ? 'Hinglish (Hindi in English letters, as people type it on WhatsApp)' : 'Pinglish (Punjabi in English letters, as people type it on WhatsApp)';
      const { appearance: _a, cast: _c, iconography: _i, ...facts } = factData; // shown separately below

      // ONE call: script + caption + hashtags (+ romanized subtitles). The fact sheet is cached, so no extraction call here.
      const scriptPrompt = `
Write the script for a vertical video (Instagram Reel / YouTube Short) about "${saint.name}", about ${preset.approx}, exactly ${preset.scenes} scenes.

AUDIENCE: everyone, including people who know nothing about the Church. Warm, clear, interesting. Short sentences. Explain any Church word the first time you use it, in plain words (see "terms"). No jargon, no preaching tone, no long lists of dates: use only the dates that make the story easier to follow.
STORYTELLING: open with the hook so people keep watching, then tell it as a story with a clear beginning, middle and end. Each scene reveals ONE new thing and flows into the next. Cover this arc in order: ${preset.arc}.
INFORMATIVE: include the most important documented facts: who, when, where, what they did, why they are a saint, their patronage, and what the Church celebrates on their feast day. Skip trivial details. Every lesson is tied to a real event from their life.

Language: "voiceover", "text_overlay", "caption" and "hashtags" MUST be in ${langLabel}. "visual" MUST be in English.
text_overlay: a short title or key phrase (max 6 words) or "". NEVER account names, @handles, URLs, hashtags, or follow/subscribe/like/share text anywhere.
voiceover: ${preset.words[0]}-${preset.words[1]} spoken words per scene, natural sentences exactly as a warm storyteller would SAY them. Write the saint's name and any foreign word in the target script (not Latin letters) so the voice pronounces it correctly. No emojis, symbols or hashtags. The last scene is a short prayer or closing thought - NEVER a call to follow, subscribe, like or share.
visual: a concrete scene (place, action, light) that shows what the narration says; no text, letters or logos.
${roman ? `subtitle: the SAME voiceover written in ${romanName}: every word and the exact meaning, no translation into English, simple common spellings, no accents. Saint names and English words in normal English spelling.` : ''}
Fidelity: depict only events/places in the FACT SHEET; add no invented events, clothing, props or symbols (no halo, robe, cross or rosary unless documented). Use the real era's technology and settings.
SAINT APPEARANCE (identical in every scene, including illness/death scenes): ${saint.appearance || (factData.appearance || 'none: this feast is not about one person')}
SUBJECT TYPE: ${factData.subject_type}. CAST (use these looks for every person or being in a "visual"): ${JSON.stringify(factData.cast).slice(0, 1500)}${factData.iconography ? `\nICONOGRAPHY: ${factData.iconography}` : ''}
Whenever a cast member appears in a "visual", describe them exactly as listed (same apparent age, gender, hair, clothing). NEVER show anyone as a Christ-like long-haired bearded man in a robe unless the story is about Jesus. NEVER show the saint old unless the appearance says so.
caption: 200-300 characters in ${langLabel}, start with an emoji (🙏 ✨ 🕊️), include the saint's name, the feast date, one key lesson and a warm closing line (no follow/subscribe call). hashtags: 30 relevant hashtags (include regional Catholic tags in ${langLabel}).

FACT SHEET (JSON, language-neutral English):
${JSON.stringify(facts).slice(0, 7000)}

Return ONE JSON object:
{ "scenes": [ { "scene_number": 1, "duration": 7, "visual": "...", "voiceover": "...", "text_overlay": "..."${roman ? ', "subtitle": "..."' : ''} } ], "caption": "...", "hashtags": "..." }
with exactly ${preset.scenes} scenes. Respond ONLY with the JSON object.
`;

      const obj = await this.completeJson(scriptPrompt, 0.6, 700 + preset.scenes * (targetLang === 'en' ? 230 : 330));
      const videoScript: SceneScript[] = obj.scenes;
      const minScenes = Math.max(3, Math.floor(preset.scenes * 0.7));
      if (!Array.isArray(videoScript) || videoScript.length < minScenes || videoScript.some(sc => !sc.visual || !sc.voiceover)) {
        throw new Error(`LLM returned an incomplete video script (${Array.isArray(videoScript) ? videoScript.length : 0}/${preset.scenes} scenes)`);
      }
      videoScript.forEach((sc, i) => { sc.scene_number = i + 1; });
      videoScript.forEach(sc => LLMService.stripPromo(sc));
      // subtitles come back in the same call; promo words must not sneak in through them either
      videoScript.forEach(sc => { if (sc.subtitle) sc.subtitle = String(sc.subtitle).trim(); });
      storyData.full_story = videoScript.map(sc => sc.voiceover).join(' ');

      return {
        full_story: storyData.full_story,
        what_we_learn: storyData.what_we_learn,
        did_you_know: storyData.did_you_know,
        video_script: videoScript,
        caption: String(obj.caption || ''),
        hashtags: String(obj.hashtags || ''),
      };

    } catch (err: any) {
      // Don't auto-post a generic template as if it were real content.
      throw new Error(`LLM content generation failed: ${err.message}`);
    }
  }

  private getDryRunFallbackContent(saint: SaintRecord, targetLang: 'en' | 'hi' | 'pa' = 'en'): GeneratedContent {
    const name = saint.name;

    if (targetLang === 'hi') {
      // Hindi Fallback Template (Devanagari)
      const storyHi = `${name} का जीवन ईश्वर के प्रति अटूट भक्ति और सेवा की प्रेरणादायी मिसाल है। उन्होंने अपने जीवन से प्रेम, करुणा और प्रार्थना का संदेश दिया।`;
      const learnHi = [
        'ईश्वर की पवित्र इच्छा पर पूर्ण विश्वास रखें।',
        'दूसरों की निःस्वार्थ सेवा और सहायता करें।',
        'कठिन समय में भी निरंतर प्रार्थना में लीन रहें।'
      ];
      const factHi = `${name} का पर्व संपूर्ण कैथोलिक कलीसिया में अपार श्रद्धा के साथ मनाया जाता है।`;

      return {
        full_story: storyHi,
        what_we_learn: learnHi,
        did_you_know: factHi,
        video_script: [
          {
            scene_number: 1,
            duration: 5,
            visual: `Cinematic portrait of ${name} with halo, historical ${saint.era || 'ancient'} setting`,
            voiceover: `आइए जानें ${name} का पवित्र जीवन चरित्र।`,
            text_overlay: `${name} का पर्व`,
          },
          {
            scene_number: 2,
            duration: 7,
            visual: `${name} performing acts of charity and prayer`,
            voiceover: storyHi,
            text_overlay: `भक्ति और सेवा का जीवन`,
          },
          {
            scene_number: 3,
            duration: 6,
            visual: `Golden spiritual light shining over ${name}`,
            voiceover: `सीख: ${learnHi[0]}`,
            text_overlay: `सीख: ${learnHi[0]}`,
          },
          {
            scene_number: 4,
            duration: 5,
            visual: `Historical symbols of ${name}`,
            voiceover: `क्या आप जानते हैं? ${factHi}`,
            text_overlay: `विशेष तथ्य`,
          },
          {
            scene_number: 5,
            duration: 5,
            visual: `Sacred heart lighting up with call to action`,
            voiceover: `हे ${name}, हमारे लिए प्रार्थना कीजिए।`,
            text_overlay: ``,
          },
        ],
        caption: `🙏 संत ${name} का पर्व! उनकी शिक्षा: ${learnHi[0]} ✨ दैनिक संत कथाओं के लिए फॉलो करें!`,
        hashtags: `#SaintOfTheDay #${name.replace(/\s+/g, '')} #संतकथा #कैथोलिक #ईसामसीह #प्रार्थना #CatholicHindi #DailySaint #PrayForUs #CatholicReels #Shorts #SaintPost`,
      };
    } else if (targetLang === 'pa') {
      // Punjabi Fallback Template (Gurmukhi)
      const storyPa = `${name} ਦਾ ਜੀਵਨ ਪਰਮੇਸ਼ੁਰ ਦੀ ਭਗਤੀ ਅਤੇ ਮਾਨਵਤਾ ਦੀ ਸੇਵਾ ਦੀ ਮਹਾਨ ਮਿਸਾਲ ਹੈ। ਉਨ੍ਹਾਂ ਨੇ ਪ੍ਰੇਮ, ਸ਼ਾਂਤੀ ਅਤੇ ਪ੍ਰਾਰਥਨਾ ਦਾ ਸੰਦੇਸ਼ ਦਿੱਤਾ।`;
      const learnPa = [
        'ਪਰਮੇਸ਼ੁਰ ਦੀ ਇੱਛਾ ਤੇ ਪੂਰਾ ਭਰੋਸਾ ਰੱਖੋ।',
        'ਲੋੜਵੰਦਾਂ ਦੀ ਨਿਸ਼ਕਾਮ ਸੇਵਾ ਕਰੋ।',
        'ਹਰ ਹਾਲਤ ਵਿੱਚ ਪ੍ਰਾਰਥਨਾ ਵਿੱਚ ਲੀਨ ਰਹੋ।'
      ];
      const factPa = `${name} ਦਾ ਤਿਉਹਾਰ ਦੁਨੀਆ ਭਰ ਦੀ ਕੈਥੋਲਿਕ ਕਲੀਸੀਆ ਵਿੱਚ ਬੜੀ ਸ਼ਰਧਾ ਨਾਲ ਮਨਾਇਆ ਜਾਂਦਾ ਹੈ।`;

      return {
        full_story: storyPa,
        what_we_learn: learnPa,
        did_you_know: factPa,
        video_script: [
          {
            scene_number: 1,
            duration: 5,
            visual: `Cinematic portrait of ${name} with halo, historical ${saint.era || 'ancient'} setting`,
            voiceover: `ਆਓ ਜਾਣੀਏ ${name} ਦਾ ਪਵਿੱਤਰ ਜੀਵਨ ਬਿਰਤਾਂਤ।`,
            text_overlay: `${name} ਦਾ ਪਰਵ`,
          },
          {
            scene_number: 2,
            duration: 7,
            visual: `${name} performing acts of charity and prayer`,
            voiceover: storyPa,
            text_overlay: `ਭਗਤੀ ਅਤੇ ਸੇਵਾ`,
          },
          {
            scene_number: 3,
            duration: 6,
            visual: `Golden spiritual light shining over ${name}`,
            voiceover: `ਸਿੱਖਿਆ: ${learnPa[0]}`,
            text_overlay: `ਸਿੱਖਿਆ: ${learnPa[0]}`,
          },
          {
            scene_number: 4,
            duration: 5,
            visual: `Historical symbols of ${name}`,
            voiceover: `ਕੀ ਤੁਸੀਂ ਜਾਣਦੇ ਹੋ? ${factPa}`,
            text_overlay: `ਖਾਸ ਤੱਥ`,
          },
          {
            scene_number: 5,
            duration: 5,
            visual: `Sacred heart lighting up with call to action`,
            voiceover: `ਹੇ ${name}, ਸਾਡੇ ਲਈ ਪ੍ਰਾਰਥਨਾ ਕਰੋ।`,
            text_overlay: ``,
          },
        ],
        caption: `🙏 ਸੰਤ ${name} ਦਾ ਪਰਵ! ਸਿੱਖਿਆ: ${learnPa[0]} ✨ ਰੋਜ਼ਾਨਾ ਸੰਤ ਕਥਾਵਾਂ ਲਈ ਫਾਲੋ ਕਰੋ!`,
        hashtags: `#SaintOfTheDay #${name.replace(/\s+/g, '')} #ਸੰਤਕਥਾ #ਕੈਥੋਲਿਕ #ਮਸੀਹੀ #ਪ੍ਰਾਰਥਨਾ #CatholicPunjabi #DailySaint #PrayForUs #Shorts #SaintPost`,
      };
    }

    // English Fallback Template
    const story = saint.full_story || `${name} was a faithful follower of Christ whose life inspired generations. Through courage, charity, and prayer, ${name} demonstrated God's miraculous grace in daily life.`;
    const learn = saint.what_we_learn || [
      'Trust in God\'s divine providence.',
      'Serve others with humility and love.',
      'Persevere in prayer during trials.'
    ];
    const fact = saint.did_you_know || `${name} lived during the ${saint.era || 'Early Church'} and remains an inspiring patron for millions around the world.`;

    return {
      full_story: story,
      what_we_learn: learn,
      did_you_know: fact,
      video_script: [
        {
          scene_number: 1,
          duration: 5,
          visual: `Cinematic portrait of ${name} with halo, historical ${saint.era || 'ancient'} setting`,
          voiceover: `Discover the inspiring story of ${name}.`,
          text_overlay: `Feast of ${name}`,
        },
        {
          scene_number: 2,
          duration: 7,
          visual: `${name} performing acts of charity and prayer`,
          voiceover: story,
          text_overlay: `A Life of Faith`,
        },
        {
          scene_number: 3,
          duration: 6,
          visual: `Golden spiritual light shining over ${name}`,
          voiceover: `What we can learn: ${learn[0]}`,
          text_overlay: `Lesson: ${learn[0]}`,
        },
        {
          scene_number: 4,
          duration: 5,
          visual: `Historical symbols of ${name}`,
          voiceover: `Did you know? ${fact}`,
          text_overlay: `Did You Know?`,
        },
        {
          scene_number: 5,
          duration: 5,
          visual: `Sacred heart lighting up with call to action`,
          voiceover: `Pray for us, ${name}.`,
          text_overlay: ``,
        },
      ],
      caption: `🙏 Feast of ${name} (Month ${saint.feast_month}/${saint.feast_day})! Learn from their virtue: ${learn[0]} ✨ Follow for daily saint stories!`,
      hashtags: `#SaintOfTheDay #${name.replace(/\s+/g, '')} #Catholic #FeastDay #DailySaint #CatholicFaith #PrayForUs #ChristianDevotion #CatholicReels #Shorts #CatholicInstagram #Saints #CatholicLife #FaithInAction #CatholicCommunity #Holiness #Vatican #JesusChrist #Blessed #Spirituality #CatholicChurch #Inspiration #Gospel #Grace #CatholicYouth #Prayer #SacredArt #DivineMercy #Peace #SaintPost`,
    };
  }
}
