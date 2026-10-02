import axios from 'axios';
import { Telegraf, Context, Markup } from 'telegraf';
import { config } from '../config/env.js';
import { db } from '../db/index.js';
import { SaintPostPipeline, PipelineResult, PostPayloadData } from '../engine/pipeline.js';
import { SaintFetcherService, SaintRecord } from '../data/sanctusFetcher.js';
import { LENGTHS, LengthId, DEFAULT_LENGTH } from '../config/lengths.js';
import { imageProviderStatus, cloudflareBudget, cloudflareVideosLeft, testImageProviders } from '../providers/image/index.js';
import { getPending, setPending, clearPending } from './state.js';
import { registerWatermarkMenu, handleLogoUpload, handleWatermarkText } from './watermarkMenu.js';

type Lang = 'hi' | 'pa' | 'en';
const LANG_LABEL: Record<Lang, string> = { hi: '🇮🇳 हिंदी', pa: '🇮🇳 ਪੰਜਾਬੀ', en: '🇬🇧 English' };

const pipeline = new SaintPostPipeline();
const fetcher = new SaintFetcherService();

const pending = { get: getPending, set: setPending, delete: clearPending };
export { clearPending };

/** Last previews awaiting Publish/Regenerate (in memory; lost on restart). */
interface Preview { saint: SaintRecord; lang: Lang; payload: PostPayloadData; dateMode: boolean }
const previews = new Map<string, Preview>();
let previewSeq = 0;
function rememberPreview(p: Preview): string {
  const id = String(++previewSeq);
  previews.set(id, p);
  if (previews.size > 20) previews.delete(previews.keys().next().value as string);
  return id;
}

const uid = (ctx: Context) => String(ctx.from?.id ?? '');

// ---------- settings helpers ----------
export async function getLang(userId: string): Promise<Lang> {
  try {
    const r = await db.query(`SELECT value FROM settings WHERE key = $1`, [`lang:${userId}`]);
    const v = r.rows[0]?.value;
    if (v === 'hi' || v === 'pa' || v === 'en') return v;
  } catch { /* table missing -> default */ }
  return config.defaultLanguage || 'hi';
}
export async function getLength(userId: string): Promise<LengthId> {
  try {
    const r = await db.query(`SELECT value FROM settings WHERE key = $1`, [`length:${userId}`]);
    const v = r.rows[0]?.value;
    if (v === 'short' || v === 'standard' || v === 'long') return v;
  } catch { /* default */ }
  return DEFAULT_LENGTH;
}
async function setLength(userId: string, l: LengthId) {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [`length:${userId}`, l]
  ).catch(() => {});
}

async function setLang(userId: string, lang: Lang) {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [`lang:${userId}`, lang]
  ).catch(() => {});
}

// ---------- reference photo storage (survives Render redeploys: bytes live in Neon) ----------
export async function saveReferenceBytes(name: string, mime: string, data: Buffer): Promise<string> {
  await db.query(`CREATE TABLE IF NOT EXISTS reference_images (id SERIAL PRIMARY KEY, saint_name TEXT NOT NULL, mime TEXT NOT NULL, data BYTEA NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
  const ins = await db.query(`INSERT INTO reference_images (saint_name, mime, data) VALUES ($1, $2, $3) RETURNING id`, [name, mime, data]);
  return saveReferenceUrl(name, `${config.renderExternalUrl}/ref/${ins.rows[0].id}`);
}

export async function saveReferenceUrl(name: string, url: string): Promise<string> {
  await db.query(`ALTER TABLE saints ADD COLUMN IF NOT EXISTS reference_image_url TEXT`);
  const upd = await db.query(`UPDATE saints SET reference_image_url = $2 WHERE name ILIKE $1 RETURNING name`, [`%${name}%`, url]);
  if (upd.rows.length === 0) {
    // feast 0/0 never matches a calendar date, so this row is only found by name
    await db.query(`INSERT INTO saints (name, feast_month, feast_day, reference_image_url) VALUES ($1, 0, 0, $2)`, [name, url]);
  }
  return url;
}

// ---------- keyboards ----------
async function mainKeyboard(userId: string) {
  const lang = await getLang(userId);
  const length = await getLength(userId);
  return Markup.inlineKeyboard([
    [Markup.button.callback("✝️ Today's Feast", 'm:today'), Markup.button.callback('🔎 Pick a Saint', 'm:pick')],
    [Markup.button.callback('📅 Feast by Date', 'm:date'), Markup.button.callback('🖼 Face Photo', 'm:ref')],
    [Markup.button.callback(`🌐 Language: ${LANG_LABEL[lang]}`, 'm:lang'), Markup.button.callback('📱 Accounts', 'm:acc')],
    [Markup.button.callback(`🎞 Length: ${LENGTHS[length].label} (${LENGTHS[length].approx})`, 'm:len'), Markup.button.callback('💧 Watermark', 'm:wm')],
    [Markup.button.callback('📊 Status', 'm:status'), Markup.button.callback('❓ Help', 'm:help')],
  ]);
}
const backRow = [Markup.button.callback('⬅️ Menu', 'm:main')];

const MENU_TEXT =
  '🙏 *SaintPost* — choose what to do:\n\n' +
  "✝️ *Today's Feast* — make a video for today's saint\n" +
  '🔎 *Pick a Saint* — any saint, by name\n' +
  '📅 *Feast by Date* — the saint for any day (e.g. 13/06)\n' +
  '🖼 *Face Photo* — set a documented photo so the face is accurate\n' +
  '💧 *Watermark* — your logo/text on every video, movable any time\n' +
  'Videos are *previews first*; you publish with one tap.';

export async function showMainMenu(ctx: Context, edit = false) {
  const kb = await mainKeyboard(uid(ctx));
  try {
    if (edit && 'callbackQuery' in ctx && ctx.callbackQuery) {
      await ctx.editMessageText(MENU_TEXT, { parse_mode: 'Markdown', ...kb });
      return;
    }
  } catch { /* message unchanged / too old: send a new one */ }
  await ctx.reply(MENU_TEXT, { parse_mode: 'Markdown', ...kb });
}

// ---------- generation + presentation ----------
export async function runAndPresent(ctx: Context, saintInput: SaintRecord | string, lang: Lang, dateMode = false) {
  const status = await ctx.reply(`🚀 Starting (${LANG_LABEL[lang]})... this takes several minutes. I'll update this message.`);
  let last = '';
  const update = async (text: string) => {
    if (text === last) return;
    last = text;
    await ctx.telegram.editMessageText(status.chat.id, status.message_id, undefined, text).catch(() => {});
  };

  try {
    const length = await getLength(uid(ctx));
    const result: PipelineResult = await pipeline.runPipelineForSaint(saintInput, lang, { publish: false, onProgress: update, length });
    await update(`✅ Done: ${result.saint.name}`);

    const id = rememberPreview({ saint: result.saint, lang, payload: result.payload, dateMode });
    const caption =
      `🎬 ${result.saint.name} [${lang.toUpperCase()}]\n\n${result.content.caption}\n\n${result.content.hashtags}`.slice(0, 1000);
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('📤 Publish to all accounts', `pub:${id}`)],
      [Markup.button.callback('🔁 Regenerate', `regen:${id}`)],
      [
        ...(['hi', 'pa', 'en'] as Lang[]).filter(l => l !== lang).map(l => Markup.button.callback(`🌐 ${LANG_LABEL[l]}`, `lang2:${id}:${l}`)),
      ],
      backRow,
    ]);

    let sentVideo = false;
    try {
      await ctx.replyWithVideo({ url: result.finalVideoUrl }, { caption, ...kb, supports_streaming: true });
      sentVideo = true;
    } catch (e: any) {
      console.warn('⚠️ Could not attach video to Telegram (sending link instead):', e.message);
    }
    if (!sentVideo) {
      await ctx.reply(`${caption}\n\n▶️ ${result.finalVideoUrl}`, kb);
    }
    await ctx.reply(
      `🖼 Cover: ${result.coverImageUrl}\n` +
      `🧑 Face reference: ${result.referenceImageUrl || 'none (tap 🖼 Face Photo in the menu to add one)'}\n` +
      `🎞 ${result.sceneCount} scenes${result.animatedScenes ? `, ${result.animatedScenes} with real motion` : ''}` +
      (result.notes.length ? `\n\n⚠️ Quality notes:\n• ${result.notes.join('\n• ')}\nConsider regenerating before you publish.` : '')
    );
  } catch (err: any) {
    await update(`❌ ${err.message}`);
    await ctx.reply('Something went wrong. Back to the menu?', Markup.inlineKeyboard([backRow]));
  }
}

function parseDate(text: string): Date | null {
  const m = text.trim().match(/^(\d{1,2})[\/\-.](\d{1,2})$/);
  if (!m) return null;
  const day = +m[1], month = +m[2];
  const d = new Date(2024, month - 1, day); // leap year so 29/02 is valid
  return d.getMonth() === month - 1 && d.getDate() === day ? d : null;
}

// ---------- registration ----------
export function registerMenu(bot: Telegraf<Context>, auth: (ctx: Context, next: () => Promise<void>) => any) {
  bot.command('menu', auth, ctx => showMainMenu(ctx));
  registerWatermarkMenu(bot, auth);

  bot.action('m:main', auth, async ctx => { await ctx.answerCbQuery(); pending.delete(uid(ctx)); await showMainMenu(ctx, true); });

  bot.action('m:today', auth, async ctx => {
    await ctx.answerCbQuery('Starting…');
    const lang = await getLang(uid(ctx));
    const saint = await fetcher.getSaintForDate(new Date());
    await runAndPresent(ctx, saint, lang);
  });

  bot.action('m:pick', auth, async ctx => {
    await ctx.answerCbQuery();
    pending.set(uid(ctx), { kind: 'saint' });
    await ctx.reply('🔎 Send the saint\'s name (use the standard name, e.g. "Carlo Acutis" or "Francis of Assisi").', Markup.inlineKeyboard([backRow]));
  });

  bot.action('m:date', auth, async ctx => {
    await ctx.answerCbQuery();
    pending.set(uid(ctx), { kind: 'date' });
    await ctx.reply('📅 Send the date as DD/MM, for example 13/06.', Markup.inlineKeyboard([backRow]));
  });

  bot.action('m:ref', auth, async ctx => {
    await ctx.answerCbQuery();
    pending.set(uid(ctx), { kind: 'ref_name' });
    await ctx.reply(
      '🖼 Which saint is the photo for? Send the name.\n\nTip: use a real, documented photo or portrait you have the rights to use. Every image for that saint will keep this face.',
      Markup.inlineKeyboard([backRow])
    );
  });

  bot.action('m:lang', auth, async ctx => {
    await ctx.answerCbQuery();
    const mode = await pipeline.subtitleMode();
    await ctx.editMessageText('🌐 Choose the language for narration, subtitles and captions.\n\nFor Hindi/Punjabi you can show subtitles in English letters (Hinglish/Pinglish) or in the native script.', Markup.inlineKeyboard([
      (['hi', 'pa', 'en'] as Lang[]).map(l => Markup.button.callback(LANG_LABEL[l], `setlang:${l}`)),
      [Markup.button.callback(mode === 'roman' ? '🔤 Subtitles: Hinglish / Pinglish ✅' : '🔤 Subtitles: Hindi / Punjabi script ✅', 'subs:toggle')],
      backRow,
    ]));
  });
  bot.action('subs:toggle', auth, async ctx => {
    const next = (await pipeline.subtitleMode()) === 'roman' ? 'native' : 'roman';
    await db.query(`INSERT INTO settings (key, value) VALUES ('subtitle_script', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`, [next]).catch(() => {});
    await ctx.answerCbQuery(next === 'roman' ? 'Subtitles: Hinglish / Pinglish' : 'Subtitles: native script');
    await ctx.editMessageText('🌐 Language & subtitles:', Markup.inlineKeyboard([
      (['hi', 'pa', 'en'] as Lang[]).map(l => Markup.button.callback(LANG_LABEL[l], `setlang:${l}`)),
      [Markup.button.callback(next === 'roman' ? '🔤 Subtitles: Hinglish / Pinglish ✅' : '🔤 Subtitles: Hindi / Punjabi script ✅', 'subs:toggle')],
      backRow,
    ])).catch(() => {});
  });
  bot.action(/^setlang:(hi|pa|en)$/, auth, async ctx => {
    const lang = ctx.match[1] as Lang;
    await setLang(uid(ctx), lang);
    await ctx.answerCbQuery(`Language set: ${LANG_LABEL[lang]}`);
    await showMainMenu(ctx, true);
  });

  bot.action('m:len', auth, async ctx => {
    await ctx.answerCbQuery();
    const cur = await getLength(uid(ctx));
    await ctx.editMessageText(
      '🎞 Video length\n\n' + (Object.values(LENGTHS) as typeof LENGTHS[LengthId][]).map(l => `${l.id === cur ? '✅ ' : ''}${l.label} (${l.approx}, ${l.scenes} scenes)`).join('\n') +
      '\n\nLonger videos tell the whole story with more detail but take longer to make and use more image credits. Reels and Shorts both allow up to 3 minutes.' +
      (cloudflareVideosLeft(LENGTHS[cur].scenes) !== null ? `\n\n☁️ Free Cloudflare images left today: about ${cloudflareVideosLeft(LENGTHS[cur].scenes)} video(s) of this length.` : ''),
      Markup.inlineKeyboard([
        (Object.values(LENGTHS) as typeof LENGTHS[LengthId][]).map(l => Markup.button.callback(`${l.id === cur ? '✅ ' : ''}${l.label} ${l.approx}`, `setlen:${l.id}`)),
        backRow,
      ])
    );
  });
  bot.action(/^setlen:(short|standard|long)$/, auth, async ctx => {
    await setLength(uid(ctx), ctx.match[1] as LengthId);
    await ctx.answerCbQuery(`Length: ${LENGTHS[ctx.match[1] as LengthId].label}`);
    await showMainMenu(ctx, true);
  });

  bot.action('m:acc', auth, async ctx => {
    await ctx.answerCbQuery();
    try {
      const res = await db.query(`SELECT id, platform, account_name, is_active FROM accounts ORDER BY id`);
      if (res.rows.length === 0) {
        await ctx.editMessageText('📱 No accounts connected yet.\nAdd one with:\n/addaccount instagram "Name"\n/addaccount youtube "Name"', Markup.inlineKeyboard([backRow]));
        return;
      }
      const rows = res.rows.map((a: any) => [
        Markup.button.callback(`${a.is_active ? '🟢' : '⚪️'} ${a.platform === 'instagram' ? '📸' : '▶️'} ${a.account_name}`, `acc:t:${a.id}`),
      ]);
      await ctx.editMessageText('📱 Accounts — tap to switch publishing on/off:', Markup.inlineKeyboard([...rows, backRow]));
    } catch (e: any) {
      await ctx.editMessageText(`⚠️ Could not read accounts: ${e.message}`, Markup.inlineKeyboard([backRow]));
    }
  });
  bot.action(/^acc:t:(\d+)$/, auth, async ctx => {
    await db.query(`UPDATE accounts SET is_active = NOT is_active WHERE id = $1`, [ctx.match[1]]);
    await ctx.answerCbQuery('Updated');
    // re-render
    const res = await db.query(`SELECT id, platform, account_name, is_active FROM accounts ORDER BY id`);
    const rows = res.rows.map((a: any) => [
      Markup.button.callback(`${a.is_active ? '🟢' : '⚪️'} ${a.platform === 'instagram' ? '📸' : '▶️'} ${a.account_name}`, `acc:t:${a.id}`),
    ]);
    await ctx.editMessageText('📱 Accounts — tap to switch publishing on/off:', Markup.inlineKeyboard([...rows, backRow])).catch(() => {});
  });

  bot.action('m:status', auth, async ctx => {
    await ctx.answerCbQuery();
    let dbLine = '🔴 Database: not reachable';
    try {
      const r = await db.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE enriched)::int AS e FROM saints`);
      const a = await db.query(`SELECT count(*) FILTER (WHERE is_active)::int AS on_, count(*)::int AS n FROM accounts`);
      dbLine = `🟢 Database: ${r.rows[0].n} saints (${r.rows[0].e} enriched), ${a.rows[0].on_}/${a.rows[0].n} accounts active`;
    } catch { /* keep default */ }
    await ctx.editMessageText(
      `📊 STATUS\n\n${dbLine}\n🤖 LLM: ${config.openrouterModel || 'auto (deepseek → free models)'}\n` +
      `🧰 Image providers:\n${(config.cloudflareApiToken ? `☁️ Cloudflare free budget today: ~${cloudflareBudget().left.toLocaleString()} of ${cloudflareBudget().total.toLocaleString()} neurons left (renews 00:00 UTC; estimate since last restart)\n` : '')}${imageProviderStatus().filter(p => p.state !== 'off').map(p => `${p.state === 'ready' ? '🟢' : '⏸'} ${p.label} (${p.tier}) ${p.note}`).join('\n') || 'none configured'}\n🎙️ Voice: ${[config.sarvamApiKey && 'Sarvam', 'Edge neural (Hindi/English)', config.geminiApiKey && 'Gemini TTS', 'Google fallback'].filter(Boolean).join(' → ')}\n🖼️ Images: ${config.falApiKey ? 'fal.ai → ' : ''}HuggingFace → Pollinations\n` +
      `⚡ Free mode: ${config.freeMode ? 'on' : 'off'}`,
      Markup.inlineKeyboard([[Markup.button.callback('🧪 Test image providers', 'm:test')], backRow])
    );
  });

  bot.action('m:test', auth, async ctx => {
    await ctx.answerCbQuery('Testing…');
    const msg = await ctx.reply('🧪 Sending one tiny test image to each configured provider…');
    const results = await testImageProviders();
    const text = results.length
      ? results.map(r => `${r.ok ? '✅' : '❌'} ${r.label}: ${r.detail}`).join('\n')
      : 'No good image provider is configured. Add CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (free) in Render.';
    await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, `🧪 Provider test\n\n${text}`, Markup.inlineKeyboard([backRow])).catch(() => ctx.reply(text));
  });

  bot.action('m:help', auth, async ctx => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      'ℹ️ HOW IT WORKS\n\n1. Pick a saint (or today\'s feast).\n2. I research documented facts, write the script, paint the scenes, record narration and build the video — about 5–15 minutes.\n3. You get a preview with Publish / Regenerate / other-language buttons.\n\nTips:\n• Use 🖼 Face Photo for accurate faces.\n• Only one video is built at a time.\n• /menu opens this menu anytime; /cancel stops a pending question.',
      Markup.inlineKeyboard([backRow])
    );
  });

  // Preview actions
  bot.action(/^pub:(\d+)$/, auth, async ctx => {
    const p = previews.get(ctx.match[1]);
    if (!p) { await ctx.answerCbQuery('Preview expired — regenerate it.', { show_alert: true }); return; }
    await ctx.answerCbQuery('Publishing…');
    const r = await pipeline.publishPayload(p.payload);
    await ctx.reply(
      r.successCount > 0
        ? `✅ Published ${p.saint.name} to ${r.successCount} account(s).${r.errors.length ? `\n⚠️ ${r.errors.join('\n')}` : ''}`
        : `⚠️ Nothing published. ${r.errors.join('\n') || 'No active accounts (see 📱 Accounts).'}`,
      Markup.inlineKeyboard([backRow])
    );
  });
  bot.action(/^regen:(\d+)$/, auth, async ctx => {
    const p = previews.get(ctx.match[1]);
    if (!p) { await ctx.answerCbQuery('Preview expired.', { show_alert: true }); return; }
    await ctx.answerCbQuery('Regenerating…');
    await runAndPresent(ctx, p.saint, p.lang, p.dateMode);
  });
  bot.action(/^lang2:(\d+):(hi|pa|en)$/, auth, async ctx => {
    const p = previews.get(ctx.match[1]);
    if (!p) { await ctx.answerCbQuery('Preview expired.', { show_alert: true }); return; }
    await ctx.answerCbQuery('Making that version…');
    await runAndPresent(ctx, p.saint, ctx.match[2] as Lang, p.dateMode);
  });

  // Photo sent directly: caption = saint name, or the name given in the "Face Photo" flow
  bot.on('photo', auth, async ctx => {
    const st = pending.get(uid(ctx));
    if (st?.kind === 'wm_logo') {
      const sizes = ctx.message.photo;
      await handleLogoUpload(ctx, sizes[sizes.length - 1].file_id, 'image/jpeg');
      return;
    }
    const caption = ('caption' in ctx.message && ctx.message.caption ? ctx.message.caption : '').trim();
    const name = st?.kind === 'ref_photo' ? st.name : caption;
    if (!name) {
      await ctx.reply('🖼 To set a face photo, send the photo with the saint\'s name as the caption (or use the menu → Face Photo).');
      return;
    }
    try {
      const sizes = ctx.message.photo;
      const fileId = sizes[sizes.length - 1].file_id;
      const link = await ctx.telegram.getFileLink(fileId);
      const bytes = Buffer.from((await axios.get(link.href, { responseType: 'arraybuffer', timeout: 30000 })).data);
      await saveReferenceBytes(name, 'image/jpeg', bytes);
      pending.delete(uid(ctx));
      await ctx.reply(`✅ Face photo saved for "${name}". All images for this saint will now keep this face.`, Markup.inlineKeyboard([backRow]));
    } catch (e: any) {
      await ctx.reply(`❌ Could not save the photo: ${e.message}`);
    }
  });

  // Logo sent as a file keeps PNG transparency
  bot.on('document', auth, async (ctx, next) => {
    const st = pending.get(uid(ctx));
    if (st?.kind !== 'wm_logo') return next();
    await handleLogoUpload(ctx, ctx.message.document.file_id, ctx.message.document.mime_type || '');
  });

  // Free-text answers to the questions above (must be registered after all commands)
  bot.on('text', auth, async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return next();
    const st = pending.get(uid(ctx));
    if (!st) return next();
    if (await handleWatermarkText(ctx, st, text)) return;

    if (st.kind === 'saint') {
      pending.delete(uid(ctx));
      await runAndPresent(ctx, text, await getLang(uid(ctx)));
    } else if (st.kind === 'date') {
      const d = parseDate(text);
      if (!d) { await ctx.reply('⚠️ Please send the date as DD/MM, e.g. 13/06.'); return; }
      pending.delete(uid(ctx));
      const saint = await fetcher.getSaintForDate(d);
      await runAndPresent(ctx, saint, await getLang(uid(ctx)), true);
    } else if (st.kind === 'ref_name') {
      pending.set(uid(ctx), { kind: 'ref_photo', name: text });
      await ctx.reply(`📷 Now send the photo of ${text} (as a Telegram photo), or paste a direct link to a jpg/png.`, Markup.inlineKeyboard([backRow]));
    } else if (st.kind === 'ref_photo') {
      if (!/^https?:\/\//i.test(text)) { await ctx.reply('⚠️ Send a photo, or a link starting with http(s)://'); return; }
      try {
        const head = await axios.get(text, { responseType: 'arraybuffer', timeout: 20000, headers: { 'User-Agent': 'SaintPostBot/1.0' } });
        if (!/^image\/(jpeg|png|webp)/i.test(String(head.headers['content-type'] || ''))) throw new Error('that link is not a jpg/png/webp image');
        await saveReferenceUrl(st.name, text);
        pending.delete(uid(ctx));
        await ctx.reply(`✅ Face photo saved for "${st.name}".`, Markup.inlineKeyboard([backRow]));
      } catch (e: any) {
        await ctx.reply(`❌ ${e.message}`);
      }
    }
  });
}
