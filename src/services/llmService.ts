import axios from 'axios';
import { config } from '../config/env.js';
import { SaintRecord } from '../data/sanctusFetcher.js';

export interface SceneScript {
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

  constructor() {
    this.openrouterApiKey = config.openrouterApiKey;
    this.primaryModel = config.openrouterModel || 'anthropic/claude-3.5-haiku';
  }

  /**
   * Helper to execute completion against OpenRouter API with model fallback rotation
   */
  private async queryOpenRouter(prompt: string, modelOverride?: string): Promise<string> {
    if (config.dryRun || !this.openrouterApiKey) {
      console.log(`[DRY RUN] OpenRouter prompt (${modelOverride || this.primaryModel}):\n${prompt.substring(0, 150)}...`);
      return '';
    }

    const modelsToTry = [
      modelOverride || this.primaryModel,
      'google/gemini-2.0-flash-exp:free',
      'deepseek/deepseek-chat:free',
      'meta-llama/llama-3.3-70b-instruct:free',
    ];

    for (const model of modelsToTry) {
      try {
        console.log(`🤖 Querying LLM via OpenRouter model: ${model}...`);
        const response = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
          },
          {
            headers: {
              'Authorization': `Bearer ${this.openrouterApiKey}`,
              'HTTP-Referer': config.renderExternalUrl,
              'X-Title': 'SaintPost Automation Bot',
              'Content-Type': 'application/json',
            },
            timeout: 30000,
          }
        );

        if (response.data?.choices?.[0]?.message?.content) {
          return response.data.choices[0].message.content.trim();
        }
      } catch (err: any) {
        console.warn(`⚠️ OpenRouter error on model ${model}:`, err.response?.data || err.message);
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
    targetLang: 'en' | 'hi' | 'pa' = config.defaultLanguage || 'hi'
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
      // Prompt 1: Story + Lessons + Did You Know in target language
      const storyPrompt = `
You are a Catholic content writer creating devotional social media posts.

Language Instruction: Write all output text STRICTLY in ${langLabel}.
IMPORTANT FOR HINDI: Use extremely simple, clear, everyday conversational Hindi that is easy for anyone (young and old) to understand. Avoid complex, archaic Sanskritized or overly academic vocabulary.

Saint: "${saint.name}"
Feast Date: Month ${saint.feast_month}, Day ${saint.feast_day}
Era: ${saint.era || 'Historical'}
Region: ${saint.region || 'Holy Land'}
Patronage: ${saint.patronage || 'Church'}
Short Description: ${saint.short_description || ''}

Please generate a JSON object with the following fields:
1. "full_story": A 150-200 word engaging story about ${saint.name} written in ${langLabel}. Warm, simple, devotional tone.
2. "what_we_learn": Array of exactly 3 practical lessons for modern Catholics written in ${langLabel} (max 15 words each, starting with simple action verbs).
3. "did_you_know": 1 fascinating, surprising, lesser-known historical fact written in ${langLabel} (1-2 simple sentences).

Respond ONLY with valid JSON.
`;

      const storyResponseStr = await this.queryOpenRouter(storyPrompt);
      const cleanedStoryJson = storyResponseStr.replace(/```json|```/g, '').trim();
      const storyData = JSON.parse(cleanedStoryJson);

      // Prompt 2: Video Script Breakdown (in target language)
      const scriptPrompt = `
Create a 30-60 second Instagram Reel / YouTube Shorts script for "${saint.name}".

Language Instruction: The "voiceover" and "text_overlay" fields MUST be written in ${langLabel}. Visual descriptions MUST be in English for image generation models.

Story Context (${langLabel}):
${storyData.full_story}

What We Learn:
${storyData.what_we_learn.join('\n')}

Did You Know:
${storyData.did_you_know}

Format as a JSON array of 5 to 7 scene objects:
[
  {
    "scene_number": 1,
    "duration": 5,
    "visual": "English visual prompt description of scene 1 for FLUX/SDXL image generator...",
    "voiceover": "Narration text in ${langLabel}...",
    "text_overlay": "On-screen title text in ${langLabel}..."
  }
]

Respond ONLY with valid JSON array.
`;

      const scriptResponseStr = await this.queryOpenRouter(scriptPrompt);
      const cleanedScriptJson = scriptResponseStr.replace(/```json|```/g, '').trim();
      const videoScript: SceneScript[] = JSON.parse(cleanedScriptJson);

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
      console.warn(`⚠️ LLM Generation failed for ${langLabel}, using fallback template:`, err.message);
      return this.getDryRunFallbackContent(saint, targetLang);
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
            voiceover: `हे ${name}, हमारे लिए प्रार्थना कीजिए। रोज संत कथाओं के लिए सब्सक्राइब करें।`,
            text_overlay: `फॉलो करें @SaintPost`,
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
            voiceover: `ਹੇ ${name}, ਸਾਡੇ ਲਈ ਪ੍ਰਾਰਥਨਾ ਕਰੋ। ਰੋਜ਼ਾਨਾ ਸੰਤ ਕਥਾਵਾਂ ਲਈ ਸਬਸਕ੍ਰਾਈਬ ਕਰੋ।`,
            text_overlay: `ਫਾਲੋ ਕਰੋ @SaintPost`,
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
          voiceover: `Pray for us, ${name}. Follow SaintPost for daily holy saint stories.`,
          text_overlay: `Follow @SaintPost`,
        },
      ],
      caption: `🙏 Feast of ${name} (Month ${saint.feast_month}/${saint.feast_day})! Learn from their virtue: ${learn[0]} ✨ Follow for daily saint stories!`,
      hashtags: `#SaintOfTheDay #${name.replace(/\s+/g, '')} #Catholic #FeastDay #DailySaint #CatholicFaith #PrayForUs #ChristianDevotion #CatholicReels #Shorts #CatholicInstagram #Saints #CatholicLife #FaithInAction #CatholicCommunity #Holiness #Vatican #JesusChrist #Blessed #Spirituality #CatholicChurch #Inspiration #Gospel #Grace #CatholicYouth #Prayer #SacredArt #DivineMercy #Peace #SaintPost`,
    };
  }
}
