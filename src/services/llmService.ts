import axios from 'axios';
import { config } from '../config/env.js';
import { SaintRecord } from '../data/sanctusFetcher.js';
import { romanizeFallback } from '../utils/romanize.js';
import { LENGTHS, LengthPreset, DEFAULT_LENGTH } from '../config/lengths.js';

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
11. Use positive wording only (say what IS there). Do not write negations such as "no extra fingers": the generator ignores them.`;

export interface SceneScript {
  safe_prompt?: string; // simpler fallback prompt (see ScenePrompt.safe)
  must_include?: string[]; // checklist the image inspector verifies
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
    return [...new Set([...configured, ...dependable, ...free])].filter(m => !this.badModels.has(m)).slice(0, 8);
  }


  /**
   * One-time "casting sheet" for a saint: apparent age, gender, hair, period-correct clothing.
   * Without this, text-to-image models default to an old bearded man for any saint.
   */
  async getAppearance(saint: SaintRecord): Promise<string> {
    if (saint.appearance) return saint.appearance;
    if (config.dryRun || !this.openrouterApiKey) return '';
    try {
      const out = await this.completeJson(`You are a meticulous Catholic historian briefing an illustrator. Describe how "${saint.name}" actually looked, so the illustration is faithful to documented history.

SOURCE (only trust this and widely documented photographs/portraits of this exact person):
${(saint.facts || saint.short_description || '').slice(0, 6000)}

Rules:
- State the apparent age the saint is best known at (for saints who died young, their real age), gender, typical complexion and hair, and everyday clothing correct for their REAL time and place.
- Do NOT add a religious habit, robe, cassock, vestments, halo, cross, rosary or any prop unless the SOURCE explicitly says this saint wore/used it (e.g. members of religious orders wear their order's habit; lay people wear ordinary clothes of their era; a teenager of the 1990s wears ordinary modern clothes).
- Include ONLY attributes stated in the SOURCE or visible in well-known documented photographs of this exact person. Do NOT add accessories (glasses, jewellery, hats, bags), hairstyles or habits you cannot tie to documentation; if unknown, omit it or keep it plain and neutral.
- Do NOT default to an old bearded man.

Respond ONLY with JSON: {"appearance": "one sentence, max 40 words, starting with the apparent age and gender"}`, 0.1);
      const text = String(out?.appearance || '').trim();
      if (text.length > 15) return text;
    } catch (e: any) {
      console.warn('⚠️ Could not generate appearance profile:', e.message);
    }
    return '';
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
    feast: { dateLabel: string; rank?: string; color?: string; martyrology?: string }
  ): Promise<VisualBrief | null> {
    if (config.dryRun || !this.openrouterApiKey) return null;
    try {
      const dossier = `SUBJECT DOSSIER
Name: ${saint.name}
Feast: ${feast.dateLabel}${feast.rank ? `, ${feast.rank}` : ''}${feast.color ? `, liturgical colour ${feast.color}` : ''}
Patronage: ${saint.patronage || 'n/a'}
Era: ${saint.era || 'n/a'}   Region: ${saint.region || 'n/a'}
Fixed appearance of the saint (copy verbatim whenever the saint appears; if the subject is not a single person, e.g. a feast of the Angels, there is no fixed person): ${saint.appearance || 'n/a'}
Roman Martyrology entry for the day: ${(feast.martyrology || '').slice(0, 1200) || 'n/a'}
Documented biography:
${(saint.facts || saint.short_description || '').slice(0, 6000)}`;

      const sceneList = JSON.stringify(scenes.map((sc, i) => ({ n: i + 1, narration: sc.voiceover, rough_visual: sc.visual })));

      // ---- Stage 1: DIRECTOR
      const draft = await this.completeJson(`You are an art director writing prompts for an image generator (FLUX). Each prompt must produce a physically logical, clearly composed picture that illustrates exactly what the narration says.

${dossier}

SCENES (narration + rough visual):
${sceneList}

${VISUAL_RULES}

For each scene write ONE prompt of 90-140 English words in this order: (1) shot type and camera angle, (2) EXACTLY who is in frame and how many people, (3) a spatial layout sentence: foreground / midground / background and left / right positions of every figure and object, (4) the action in one simple pose per figure, (5) the real place and its period-accurate architecture, objects and clothing, (6) time of day, light direction, colour palette and mood.
Also write one "cover" prompt (square 1:1, a calm, dignified head-and-shoulders portrait of the saint, or the central subject of the feast, in a setting that reflects their life) following the same rules.

Respond ONLY with JSON: {"cover": "...", "scenes": ["prompt for scene 1", "..."]} with exactly ${scenes.length} scene prompts.`, 0.3);
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
- "risk": "low" | "medium" | "high" chance of anatomy or logic errors.

NARRATION AND DRAFT PROMPTS (item 0 is the cover):
${JSON.stringify([{ i: 0, narration: 'cover portrait', prompt: draft.cover }, ...draft.scenes.map((p: string, i: number) => ({ i: i + 1, narration: scenes[i].voiceover, prompt: p }))])}

${dossier.slice(0, 2500)}

Respond ONLY with JSON: {"items": [ {"i": 0, "problems": [], "prompt": "...", "safe_prompt": "...", "must_include": ["..."], "people": 1, "risk": "low"}, ... ]} with exactly ${scenes.length + 1} items in order.`, 0.2);
        const items: any[] = audit?.items;
        if (!Array.isArray(items) || items.length !== scenes.length + 1) throw new Error('checker returned an unexpected shape');
        const toPrompt = (it: any, fallback: string): ScenePrompt => ({
          prompt: String(it?.prompt || fallback),
          safe: String(it?.safe_prompt || ''),
          mustInclude: Array.isArray(it?.must_include) ? it.must_include.map(String).slice(0, 5) : [],
          people: Number.isFinite(+it?.people) ? +it.people : undefined,
          risk: ['low', 'medium', 'high'].includes(it?.risk) ? it.risk : 'medium',
          problems: Array.isArray(it?.problems) ? it.problems.map(String) : [],
        });
        const fixed = items.map((it, k) => toPrompt(it, k === 0 ? String(draft.cover) : String(draft.scenes[k - 1])));
        const nFixed = fixed.filter(f => f.problems.length).length;
        console.log(`   🔎 Prompt checker: ${nFixed}/${fixed.length} prompts rewritten, ${fixed.filter(f => f.risk === 'high').length} high-risk`);
        return { cover: fixed[0], scenes: fixed.slice(1) };
      } catch (e: any) {
        console.warn(`⚠️ Prompt checker failed (${e.message}); using the director's prompts as they are.`);
        const plain = (p: string): ScenePrompt => ({ prompt: String(p), safe: '', mustInclude: [], risk: 'medium', problems: [] });
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

Respond ONLY with a JSON array of ${scenes.length} strings in the same order.`, 0.1);
      if (!Array.isArray(out) || out.length !== scenes.length || out.some(x => typeof x !== 'string')) throw new Error('unexpected shape');
      return out.map((x: string) => x.trim());
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
  async completeJson(prompt: string, temperature = 0.7): Promise<any> {
    const text = await this.queryOpenRouter(prompt, undefined, temperature);
    const m = text.replace(/```json|```/g, '').match(/[\[{][\s\S]*[\]}]/);
    if (!m) throw new Error('LLM did not return JSON');
    return JSON.parse(m[0]);
  }

  /**
   * Helper to execute completion against OpenRouter API with model fallback rotation
   */
  private async queryOpenRouter(prompt: string, modelOverride?: string, temperature = 0.7): Promise<string> {
    if (config.dryRun || !this.openrouterApiKey) {
      console.log(`[DRY RUN] OpenRouter prompt (${modelOverride || this.primaryModel}):\n${prompt.substring(0, 150)}...`);
      return '';
    }

    const modelsToTry = await this.resolveModels(modelOverride);
    if (modelsToTry.length === 0) throw new Error('No usable OpenRouter models found (check OPENROUTER_MODEL / key credits).');

    for (const model of modelsToTry) {
      try {
        console.log(`🤖 Querying LLM via OpenRouter model: ${model}...`);
        const response = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: model,
            messages: [{ role: 'user', content: prompt }],
            temperature,
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
      } catch (err: any) {
        const detail = err.response?.data?.error?.message || err.message;
        const status = err.response?.status;
        if (status && status !== 429 && status < 500) this.badModels.add(model);
        console.warn(`⚠️ OpenRouter error on model ${model}: ${detail}`);
      }
    }

    throw new Error('All OpenRouter models failed to respond.');
  }

  /**
   * SuperCMO Adaptation: Generate End-to-End Devotional Content Package for a Saint
   * Default Language: Simple, conversational Hindi (हिंदी)
   */
  async generateSaintContentPackage(
    saint: SaintRecord,
    targetLang: 'en' | 'hi' | 'pa' = config.defaultLanguage || 'hi',
    preset: LengthPreset = LENGTHS[DEFAULT_LENGTH]
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
      // Prompt 1: FACT SHEET. Pull every relevant documented fact out of the source, in the target language,
      // so the script can be complete, accurate and well organised (and lessons are tied to real events).
      const sourceText = (saint.facts || saint.short_description || 'No source available - say only what is certain about this saint.').slice(0, 9000);
      const factPrompt = `
You are a careful Catholic historian and teacher preparing a video about "${saint.name}" for a wide audience, including people who are not Catholic and people who know nothing about saints.

Language: write every text value STRICTLY in ${langLabel}. ${targetLang === 'hi' ? 'Use very simple everyday spoken Hindi, no heavy Sanskrit words.' : ''}${targetLang === 'pa' ? 'Use simple everyday spoken Punjabi.' : ''}
Feast: Month ${saint.feast_month}, Day ${saint.feast_day}${saint.rank ? ` (${saint.rank})` : ''}. Patronage: ${saint.patronage || 'n/a'}. Era: ${saint.era || 'n/a'}. Region: ${saint.region || 'n/a'}.

SOURCE FACTS (documented - the ONLY allowed basis for facts):
${sourceText}

FACT RULES: use only what the SOURCE states. No invented events, quotes, miracles, dates, places, relatives or objects. If something is unknown, leave it out. Keep every date and place exact.

Extract a JSON object:
{
  "hook": "one surprising, true, attention-grabbing opening line or question about this saint (max 18 words)",
  "who": "who they were in 2 simple sentences: when and where they lived, and what they were (e.g. student, bishop, nun)",
  "timeline": [ {"when": "year or age, as stated", "what": "one clear sentence"} ],   // 6 to 12 key moments, in order
  "key_deeds": ["what they actually did that mattered, simple sentences (3 to 6)"],
  "struggles": ["hardships they faced, only if documented (0 to 4)"],
  "why_saint": "why the Church honours them: recognition or canonization only if documented, in simple words",
  "feast_and_patronage": "what the Church celebrates on their feast day and whom they are patron of, only if documented",
  "what_we_learn": ["exactly 3 practical lessons, each starts with a verb, max 15 words, each tied to a real event from their life"],
  "did_you_know": "1 true, surprising, lesser-known fact from the SOURCE (1-2 simple sentences)",
  "terms": [ {"term": "a church word a beginner may not know that you use (e.g. beatified, canonized, Carmelite)", "plain": "very short plain explanation"} ]
}
Respond ONLY with valid JSON.
`;
      const factData = JSON.parse((await this.queryOpenRouter(factPrompt, undefined, 0.3)).replace(/```json|```/g, '').match(/\{[\s\S]*\}/)?.[0] || '');
      if (!Array.isArray(factData.what_we_learn) || factData.what_we_learn.length < 3 || !factData.did_you_know) throw new Error('LLM returned an incomplete fact sheet');
      const storyData = { what_we_learn: factData.what_we_learn as string[], did_you_know: String(factData.did_you_know), full_story: '' };

      // Prompt 2: SCRIPT built from the fact sheet, following the storytelling arc for the chosen length.
      const scriptPrompt = `
Write the script for a vertical video (Instagram Reel / YouTube Short) about "${saint.name}", about ${preset.approx}, exactly ${preset.scenes} scenes.

AUDIENCE: everyone, including people who know nothing about the Church. Be warm, clear and interesting. Short sentences. Explain any Church word the first time you use it, in plain words (see "terms"). No jargon, no preaching tone, no long lists of dates: use only the dates that make the story easier to follow.
STORYTELLING: open with the hook so people keep watching, then tell it as a story with a clear beginning, middle and end. Each scene should reveal ONE new thing and flow into the next. Cover this arc in order: ${preset.arc}.
INFORMATIVE: include the most important documented facts: who, when, where, what they did, why they are a saint, their patronage, and what the Church celebrates on their feast day. Skip trivial details. Every lesson must be tied to a real event from their life.

Language: "voiceover" and "text_overlay" MUST be in ${langLabel}. "visual" MUST be in English (it is used to paint the scene).
text_overlay rules: a short title or key phrase only (max 6 words), or "" when nothing is needed. NEVER put account names, @handles, URLs, hashtags, or follow/subscribe/like/share text anywhere.
Voiceover rules: ${preset.words[0]}-${preset.words[1]} spoken words per scene, in natural sentences exactly as a warm storyteller would SAY them aloud. Write the saint's name and any foreign word in the target script (not Latin letters) so the voice pronounces it correctly. No emojis, symbols or hashtags. The last scene is a short prayer or closing thought about the saint - NEVER a call to follow, subscribe, like or share.
Visual rules: each "visual" is a concrete scene (place, action, light) that shows what the narration says; never include text, letters or logos.
Fidelity: depict only events/places stated in the FACT SHEET; add no invented events, clothing, props or symbols (no halo, robe, cross or rosary unless documented). Use the real era's technology and settings.
SAINT APPEARANCE (identical in every scene, including illness/death scenes): ${saint.appearance || 'use accurate age, clothing and setting for this saint'}
Whenever the saint appears in a "visual", describe them as exactly that person (same apparent age, gender, hair, clothing style). NEVER show the saint old unless the appearance above says so.

FACT SHEET (JSON):
${JSON.stringify(factData).slice(0, 9000)}

Format: a JSON array of exactly ${preset.scenes} objects:
[ { "scene_number": 1, "duration": 7, "visual": "...", "voiceover": "...", "text_overlay": "..." } ]
Respond ONLY with the JSON array.
`;

      const scriptResponseStr = await this.queryOpenRouter(scriptPrompt, undefined, 0.6);
      const arr = scriptResponseStr.replace(/```json|```/g, '').match(/\[[\s\S]*\]/);
      const videoScript: SceneScript[] = JSON.parse(arr ? arr[0] : '');
      const minScenes = Math.max(3, Math.floor(preset.scenes * 0.7));
      if (!Array.isArray(videoScript) || videoScript.length < minScenes || videoScript.some(sc => !sc.visual || !sc.voiceover)) {
        throw new Error(`LLM returned an incomplete video script (${Array.isArray(videoScript) ? videoScript.length : 0}/${preset.scenes} scenes)`);
      }
      videoScript.forEach((sc, i) => { sc.scene_number = i + 1; });
      videoScript.forEach(sc => LLMService.stripPromo(sc));
      storyData.full_story = videoScript.map(sc => sc.voiceover).join(' ');

      // Prompt 3: Caption & Hashtags in target language
      const captionPrompt = `
Write an Instagram caption for "${saint.name}" (Feast Day: Month ${saint.feast_month}/${saint.feast_day}).

Language Instruction: Caption MUST be written in ${langLabel}.

Lessons:
${storyData.what_we_learn.join(', ')}

Requirements:
- 200-300 characters
- Start with emoji (🙏, ✨, 🕊️)
- Include saint name, feast date, key lesson, and CTA in ${langLabel}
- Provide 30 optimized hashtags (include regional Catholic tags in ${langLabel} e.g. #संतकथा #कैथोलिक or #ਮਸੀਹੀ if applicable)

Format output as JSON:
{
  "caption": "...",
  "hashtags": "..."
}
`;

      const captionResponseStr = await this.queryOpenRouter(captionPrompt);
      const cleanedCaptionJson = captionResponseStr.replace(/```json|```/g, '').trim();
      const captionData = JSON.parse(cleanedCaptionJson);

      return {
        full_story: storyData.full_story,
        what_we_learn: storyData.what_we_learn,
        did_you_know: storyData.did_you_know,
        video_script: videoScript,
        caption: captionData.caption,
        hashtags: captionData.hashtags,
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
