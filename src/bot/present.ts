import { Context, Markup } from 'telegraf';
import type { PostPayloadData } from '../engine/pipeline.js';
import type { SaintRecord } from '../data/sanctusFetcher.js';

export type Lang = 'hi' | 'pa' | 'en';
export const LANG_LABEL: Record<Lang, string> = { hi: '🇮🇳 हिंदी', pa: '🇮🇳 ਪੰਜਾਬੀ', en: '🇬🇧 English' };
const backRow = [Markup.button.callback('⬅️ Menu', 'm:main')];

/** Previews awaiting Publish / Edit / Regenerate (in memory; the editable project itself lives in Neon). */
export interface Preview { saint: SaintRecord; lang: Lang; payload: PostPayloadData; dateMode: boolean; projectId?: number }
const previews = new Map<string, Preview>();
let seq = 0;
export function rememberPreview(p: Preview): string {
  const id = String(++seq);
  previews.set(id, p);
  if (previews.size > 30) previews.delete(previews.keys().next().value as string);
  return id;
}
export const getPreview = (id: string) => previews.get(id);

/** Sends the finished video with the action buttons (publish, edit, other languages, regenerate). */
export async function sendPreview(ctx: Context, p: Preview, videoUrl: string, caption: string): Promise<string> {
  const id = rememberPreview(p);
  const others = (['hi', 'pa', 'en'] as Lang[]).filter(l => l !== p.lang);
  const rows = [
    [Markup.button.callback('📤 Publish to all accounts', `pub:${id}`)],
    ...(p.projectId ? [[Markup.button.callback('✏️ Edit this video (cheap)', `ed:open:${p.projectId}:${id}`)]] : []),
    [Markup.button.callback('🔁 Make a new one from scratch', `regen:${id}`)],
    others.map(l => Markup.button.callback(`🌐 ${LANG_LABEL[l]}${p.projectId ? ' (same pictures)' : ''}`, p.projectId ? `ed:tr:${p.projectId}:${l}:${id}` : `lang2:${id}:${l}`)),
    backRow,
  ];
  const kb = Markup.inlineKeyboard(rows);
  const text = caption.slice(0, 1000);
  try {
    await ctx.replyWithVideo({ url: videoUrl }, { caption: text, ...kb, supports_streaming: true });
  } catch (e: any) {
    console.warn('⚠️ Could not attach video to Telegram (sending link instead):', e.message);
    await ctx.reply(`${text}\n\n▶️ ${videoUrl}`, kb);
  }
  return id;
}
