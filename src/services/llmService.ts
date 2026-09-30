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
   */
  async generateSaintContentPackage(saint: SaintRecord): Promise<GeneratedContent> {
    console.log(`📝 Generating LLM content package for ${saint.name}...`);

    if (config.dryRun || !this.openrouterApiKey) {
      return this.getDryRunFallbackContent(saint);
    }

    try {
      // Prompt 1: Story + Lessons + Did You Know
      const storyPrompt = `
You are a Catholic content writer creating devotional social media posts.

Write content for Saint: "${saint.name}"
Feast Date: Month ${saint.feast_month}, Day ${saint.feast_day}
Era: ${saint.era || 'Historical'}
Region: ${saint.region || 'Universal'}
Patronage: ${saint.patronage || 'Church'}
Short Description: ${saint.short_description || ''}

Please generate a JSON object with the following fields:
1. "full_story": A 150-200 word engaging story about ${saint.name}. Warm, devotional tone.
2. "what_we_learn": Array of exactly 3 practical lessons for modern Catholics (max 15 words each, starting with action verbs).
3. "did_you_know": 1 fascinating, surprising, lesser-known historical fact (1-2 sentences).

Respond ONLY with valid JSON.
`;

      const storyResponseStr = await this.queryOpenRouter(storyPrompt);
      const cleanedStoryJson = storyResponseStr.replace(/```json|```/g, '').trim();
      const storyData = JSON.parse(cleanedStoryJson);

      // Prompt 2: Video Script Breakdown (SuperCMO adapted script logic)
      const scriptPrompt = `
Create a 30-60 second Instagram Reel / YouTube Shorts script for "${saint.name}".

Story Context:
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
    "visual": "Cinematic visual description of scene 1...",
    "voiceover": "Opening narration hook...",
    "text_overlay": "On-screen title text..."
  }
]

Respond ONLY with valid JSON array.
`;

      const scriptResponseStr = await this.queryOpenRouter(scriptPrompt);
      const cleanedScriptJson = scriptResponseStr.replace(/```json|```/g, '').trim();
      const videoScript: SceneScript[] = JSON.parse(cleanedScriptJson);

      // Prompt 3: Caption & 30 Hashtags
      const captionPrompt = `
Write an Instagram caption for "${saint.name}" (Feast Day: Month ${saint.feast_month}/${saint.feast_day}).

Lessons:
${storyData.what_we_learn.join(', ')}

Requirements:
- 200-300 characters
- Start with emoji (🙏, ✨, 🕊️)
- Include saint name, feast date, key lesson, and CTA: "Follow for daily saint content!"
- Provide 30 optimized hashtags (5 Catholic, 5 devotional, 5 saint-specific, 5 engagement, 10 niche)

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
      console.warn('⚠️ LLM Generation failed, using robust fallback template:', err.message);
      return this.getDryRunFallbackContent(saint);
    }
  }

  private getDryRunFallbackContent(saint: SaintRecord): GeneratedContent {
    const name = saint.name;
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
