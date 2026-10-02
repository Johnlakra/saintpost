/**
 * Video length presets. Narration drives the real duration; scenes x words-per-scene sets the target.
 * Reels and Shorts both allow up to 3 minutes, so "long" stays under that.
 */
export type LengthId = 'short' | 'standard' | 'long';

export interface LengthPreset {
  id: LengthId;
  label: string;
  approx: string; // shown in the menu
  scenes: number;
  words: [number, number]; // spoken words per scene (min, max)
  arc: string; // storytelling beats the script must cover, in order
}

export const LENGTHS: Record<LengthId, LengthPreset> = {
  short: {
    id: 'short', label: 'Short', approx: '~45 sec', scenes: 6, words: [14, 20],
    arc: '1 hook, 2 who they were (when and where), 3 the turning point or key deed, 4 why they are a saint (and the feast day), 5 one lesson for us today and what it shows us about God, 6 closing prayer',
  },
  standard: {
    id: 'standard', label: 'Standard', approx: '~90 sec', scenes: 10, words: [18, 26],
    arc: '1 hook, 2 who they were (when, where, family or background), 3 early life, 4 the turning point or call, 5 the key deeds and struggles (two beats), 6 later life and death, 7 why they are a saint and their patronage (today is their feast day), 8 three lessons for today (practical, something to do this week), 9 a "did you know" fact and what this shows us about God, 10 closing prayer',
  },
  long: {
    id: 'long', label: 'Long', approx: '~2.5 min', scenes: 15, words: [20, 28],
    arc: '1 hook, 2 who they were (when, where), 3 family and early life, 4 growing up or education, 5 the turning point or call, 6 first steps of their mission or vocation, 7 the key deeds (two beats), 8 struggles and sufferings, 9 how they died, 10 what happened after (canonization or recognition, only if documented), 11 their patronage and what the Church celebrates on their feast day, 12 three lessons for today (one per scene across 12-14, each with a real-life example from their life), 14 a "did you know" fact and what this shows us about God, 15 closing prayer',
  },
};

export const DEFAULT_LENGTH: LengthId = (['short', 'standard', 'long'].includes(process.env.DEFAULT_VIDEO_LENGTH || '')
  ? process.env.DEFAULT_VIDEO_LENGTH
  : 'standard') as LengthId;
