import axios from 'axios';
import { Telegraf, Context, Markup } from 'telegraf';
import { db } from '../db/index.js';
import { config } from '../config/env.js';
import { watermarkService, WatermarkConfig } from '../services/watermarkService.js';
import { setPending, clearPending, Pending } from './state.js';

const uid = (ctx: Context) => String(ctx.from?.id ?? '');
const back = [Markup.button.callback('⬅️ Menu', 'm:main')];

const GRID: Array<[string, number, number]> = [
  ['↖️', 12, 7], ['⬆️', 50, 7], ['↗️', 88, 7],
  ['⬅️', 12, 50], ['⏺', 50, 50], ['➡️', 88, 50],
  ['↙️', 12, 94], ['⬇️', 50, 94], ['↘️', 88, 94],
];

function summary(c: WatermarkConfig): string {
  const pos = (e: { x: number; y: number }) => `x ${e.x}%, y ${e.y}%`;
  return (
    `💧 WATERMARK — applies to every new video\n\n` +
    `Status: ${c.enabled ? '🟢 ON' : '⚪️ OFF'}\n\n` +
    `🖼 Logo: ${c.logoUrl ? 'uploaded' : 'none'}\n   position ${pos(c.logo)} · size ${c.logo.size}% of width · opacity ${c.logo.opacity}%\n\n` +
    `🔤 Text: ${c.text ? `"${c.text}"` : 'none'}\n   position ${pos(c.textEl)} · size ${c.textEl.size}% of height · opacity ${c.textEl.opacity}%\n\n` +
    `Changes save instantly. Edit any time; already-rendered videos are not changed.`
  );
}

function panelKeyboard(c: WatermarkConfig) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(c.enabled ? '✅ Watermark ON (tap to turn off)' : '⚪️ Watermark OFF (tap to turn on)', 'wm:toggle')],
    [Markup.button.callback('🖼 Upload / replace logo', 'wm:logo'), Markup.button.callback('🗑 Remove logo', 'wm:rmlogo')],
    [Markup.button.callback('📍 Logo position', 'wm:pos:logo'), Markup.button.callback('Logo size ➖', 'wm:sz:logo:-'), Markup.button.callback('➕', 'wm:sz:logo:+')],
    [Markup.button.callback('Logo opacity ➖', 'wm:op:logo:-'), Markup.button.callback('➕', 'wm:op:logo:+')],
    [Markup.button.callback('✏️ Set text', 'wm:text'), Markup.button.callback('🗑 Remove text', 'wm:rmtext')],
    [Markup.button.callback('📍 Text position', 'wm:pos:text'), Markup.button.callback('Text size ➖', 'wm:sz:text:-'), Markup.button.callback('➕', 'wm:sz:text:+')],
    [Markup.button.callback('Text opacity ➖', 'wm:op:text:-'), Markup.button.callback('➕', 'wm:op:text:+')],
    [Markup.button.callback('👁 Preview', 'wm:preview'), ...back],
  ]);
}

export async function showWatermarkPanel(ctx: Context, edit = true) {
  const c = await watermarkService.get();
  const kb = panelKeyboard(c);
  try {
    if (edit && 'callbackQuery' in ctx && ctx.callbackQuery) {
      await ctx.editMessageText(summary(c), kb);
      return;
    }
  } catch { /* unchanged text or old message */ }
  await ctx.reply(summary(c), kb);
}

/** Save a logo image (Telegram photo/document bytes) into Neon and point the watermark at it. */
async function storeLogo(ctx: Context, fileId: string, mime: string) {
  const link = await ctx.telegram.getFileLink(fileId);
  const bytes = Buffer.from((await axios.get(link.href, { responseType: 'arraybuffer', timeout: 30000 })).data);
  await db.query(`CREATE TABLE IF NOT EXISTS reference_images (id SERIAL PRIMARY KEY, saint_name TEXT NOT NULL, mime TEXT NOT NULL, data BYTEA NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
  const ins = await db.query(`INSERT INTO reference_images (saint_name, mime, data) VALUES ('__watermark_logo__', $1, $2) RETURNING id`, [mime, bytes]);
  const url = `${config.renderExternalUrl}/ref/${ins.rows[0].id}`;
  await watermarkService.update(c => { c.logoUrl = url; c.enabled = true; });
  clearPending(uid(ctx));
  await ctx.reply('✅ Logo saved. Tip: send it as a *file* (not a photo) to keep a transparent background.', { parse_mode: 'Markdown' });
  await showWatermarkPanel(ctx, false);
}

/** Called by the photo/document handler in menu.ts when a logo is expected. */
export async function handleLogoUpload(ctx: Context, fileId: string, mime: string): Promise<void> {
  try {
    if (!/^image\/(png|jpeg|webp)/i.test(mime)) throw new Error('please send a PNG, JPG or WebP image');
    await storeLogo(ctx, fileId, mime);
  } catch (e: any) {
    await ctx.reply(`❌ Could not save the logo: ${e.message}`);
  }
}

/** Free-text answers for watermark questions. Returns true if handled. */
export async function handleWatermarkText(ctx: Context, st: Pending, text: string): Promise<boolean> {
  if (st.kind === 'wm_text') {
    const t = text.replace(/\s+/g, ' ').trim().slice(0, 60);
    await watermarkService.update(c => { c.text = t; c.enabled = true; });
    clearPending(uid(ctx));
    await showWatermarkPanel(ctx, false);
    return true;
  }
  if (st.kind === 'wm_custom') {
    const m = text.match(/^\s*(\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(\d{1,3}(?:\.\d+)?)\s*$/);
    if (!m || +m[1] > 100 || +m[2] > 100) {
      await ctx.reply('⚠️ Send two numbers between 0 and 100 as "x,y" — x = from the left, y = from the top. Example: 85,8');
      return true;
    }
    await watermarkService.update(c => { const e = st.el === 'logo' ? c.logo : c.textEl; e.x = +m[1]; e.y = +m[2]; });
    clearPending(uid(ctx));
    await showWatermarkPanel(ctx, false);
    return true;
  }
  return false;
}

export function registerWatermarkMenu(bot: Telegraf<Context>, auth: (ctx: Context, next: () => Promise<void>) => any) {
  bot.command('watermark', auth, ctx => showWatermarkPanel(ctx, false));
  bot.action('m:wm', auth, async ctx => { await ctx.answerCbQuery(); await showWatermarkPanel(ctx); });

  bot.action('wm:toggle', auth, async ctx => {
    const c = await watermarkService.update(c => { c.enabled = !c.enabled; });
    await ctx.answerCbQuery(c.enabled ? 'Watermark ON' : 'Watermark OFF');
    await showWatermarkPanel(ctx);
  });

  bot.action('wm:logo', auth, async ctx => {
    await ctx.answerCbQuery();
    setPending(uid(ctx), { kind: 'wm_logo' });
    await ctx.reply('🖼 Send your logo now — as a *file* (📎 → File) for a transparent PNG, or as a normal photo.', { parse_mode: 'Markdown', ...Markup.inlineKeyboard([back]) });
  });
  bot.action('wm:rmlogo', auth, async ctx => {
    await watermarkService.update(c => { c.logoUrl = ''; });
    await ctx.answerCbQuery('Logo removed');
    await showWatermarkPanel(ctx);
  });

  bot.action('wm:text', auth, async ctx => {
    await ctx.answerCbQuery();
    setPending(uid(ctx), { kind: 'wm_text' });
    await ctx.reply('✏️ Send the watermark text (max 60 characters), e.g. your channel name.', Markup.inlineKeyboard([back]));
  });
  bot.action('wm:rmtext', auth, async ctx => {
    await watermarkService.update(c => { c.text = ''; });
    await ctx.answerCbQuery('Text removed');
    await showWatermarkPanel(ctx);
  });

  // Position pad
  bot.action(/^wm:pos:(logo|text)$/, auth, async ctx => {
    await ctx.answerCbQuery();
    const el = ctx.match[1];
    const rows = [0, 1, 2].map(r => GRID.slice(r * 3, r * 3 + 3).map(([label], i) => Markup.button.callback(label, `wm:at:${el}:${r * 3 + i}`)));
    await ctx.editMessageText(
      `📍 Where should the ${el === 'logo' ? 'logo' : 'text'} go? Pick a spot, or set exact coordinates.`,
      Markup.inlineKeyboard([...rows, [Markup.button.callback('🎯 Exact position (x,y)', `wm:cust:${el}`)], [Markup.button.callback('⬅️ Back', 'm:wm')]])
    );
  });
  bot.action(/^wm:at:(logo|text):(\d)$/, auth, async ctx => {
    const [, x, y] = GRID[+ctx.match[2]];
    await watermarkService.update(c => { const e = ctx.match[1] === 'logo' ? c.logo : c.textEl; e.x = x; e.y = y; });
    await ctx.answerCbQuery('Moved');
    await showWatermarkPanel(ctx);
  });
  bot.action(/^wm:cust:(logo|text)$/, auth, async ctx => {
    await ctx.answerCbQuery();
    setPending(uid(ctx), { kind: 'wm_custom', el: ctx.match[1] as 'logo' | 'text' });
    await ctx.reply('🎯 Send "x,y" as percentages: x from the left (0–100), y from the top (0–100).\nExample: 85,8 = top-right corner area.', Markup.inlineKeyboard([back]));
  });

  // Size / opacity steps
  bot.action(/^wm:sz:(logo|text):([+-])$/, auth, async ctx => {
    const up = ctx.match[2] === '+';
    await watermarkService.update(c => {
      if (ctx.match[1] === 'logo') c.logo.size += up ? 2 : -2;
      else c.textEl.size += up ? 0.4 : -0.4;
      c.textEl.size = Math.round(c.textEl.size * 10) / 10;
    });
    await ctx.answerCbQuery(up ? 'Bigger' : 'Smaller');
    await showWatermarkPanel(ctx);
  });
  bot.action(/^wm:op:(logo|text):([+-])$/, auth, async ctx => {
    const d = ctx.match[2] === '+' ? 10 : -10;
    await watermarkService.update(c => { (ctx.match[1] === 'logo' ? c.logo : c.textEl).opacity += d; });
    await ctx.answerCbQuery(d > 0 ? 'More visible' : 'More transparent');
    await showWatermarkPanel(ctx);
  });

  bot.action('wm:preview', auth, async ctx => {
    await ctx.answerCbQuery('Rendering preview…');
    try {
      const png = await watermarkService.renderPreview();
      await ctx.replyWithPhoto({ source: png }, { caption: '👁 Preview on a sample frame (real videos use the same position and size).' });
    } catch (e: any) {
      await ctx.reply(`⚠️ Preview failed: ${e.message}`);
    }
  });
}
