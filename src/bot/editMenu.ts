import { Telegraf, Context, Markup } from 'telegraf';
import { editService, Draft } from '../services/editService.js';
import { projectService } from '../services/projectService.js';
import { SaintRecord } from '../data/sanctusFetcher.js';
import { Lang, LANG_LABEL, getPreview, sendPreview } from './present.js';
import { setPending, clearPending, Pending } from './state.js';
import { db } from '../db/index.js';

const uid = (ctx: Context) => String(ctx.from?.id ?? '');
const drafts = new Map<string, Draft>();
let busy = false;
const back = [Markup.button.callback('⬅️ Menu', 'm:main')];

async function romanPref(): Promise<boolean> {
  try {
    const r = await db.query(`SELECT value FROM settings WHERE key = 'subtitle_script'`);
    return r.rows[0]?.value !== 'native';
  } catch { return true; }
}

const short = (t: string, n = 70) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

function panelText(d: Draft): string {
  const m = d.manifest;
  const lines = m.scenes.map((s, i) => `${i + 1}. ${short(s.voiceover)}${d.dirtyImg.has(i) ? ' 🖼✎' : ''}${d.dirtyAud.has(i) ? ' 🎙✎' : ''}`);
  return (
    `✏️ Editing: ${m.saint.name} [${m.lang.toUpperCase()}] · version ${m.version}\n\n` +
    lines.join('\n') +
    `\n\n📝 Caption: ${short(m.caption, 120)}\n\n` +
    (d.summary.length ? `Pending changes:\n• ${d.summary.join('\n• ')}\n\n` : 'No changes yet. ') +
    'Tap a scene number to change its picture, narration or title. Only what you change is redone; everything else is reused, so no image credits or AI tokens are spent on the rest.'
  );
}

function panelKeyboard(d: Draft) {
  const n = d.manifest.scenes.length;
  const nums = Array.from({ length: n }, (_, i) => Markup.button.callback(String(i + 1), `ed:sc:${i + 1}`));
  const rows: any[] = [];
  for (let i = 0; i < nums.length; i += 5) rows.push(nums.slice(i, i + 5));
  const others = (['hi', 'pa', 'en'] as Lang[]).filter(l => l !== d.manifest.lang);
  rows.push([Markup.button.callback('📝 Edit caption', 'ed:cap'), ...others.map(l => Markup.button.callback(`🌐 ${LANG_LABEL[l]}`, `ed:tr2:${l}`))]);
  const pending = d.dirtyImg.size + d.dirtyAud.size > 0 || d.needsRender;
  rows.push([Markup.button.callback(pending ? '✅ Apply changes' : '🎬 Re-render (new watermark/settings)', 'ed:apply'), Markup.button.callback('❌ Close', 'ed:cancel')]);
  return Markup.inlineKeyboard(rows);
}

async function showPanel(ctx: Context, d: Draft, edit = true) {
  const kb = panelKeyboard(d);
  try {
    if (edit && 'callbackQuery' in ctx && ctx.callbackQuery) { await ctx.editMessageText(panelText(d), kb); return; }
  } catch { /* unchanged / old message */ }
  await ctx.reply(panelText(d), kb);
}

async function showScene(ctx: Context, d: Draft, n: number) {
  const s = d.manifest.scenes[n - 1];
  await ctx.editMessageText(
    `Scene ${n}/${d.manifest.scenes.length}\n\n🎙 ${s.voiceover}\n\n🔤 Title: ${s.overlay || '(none)'}\n\n🖼 Picture idea: ${short(s.visual, 200)}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('✏️ Change this picture (keeps the rest)', `ed:imgi:${n}`)],
      [Markup.button.callback('🖼 Redraw from scratch', `ed:img:${n}`)],
      [Markup.button.callback('🎙 Edit narration', `ed:nar:${n}`), Markup.button.callback('🔤 Edit title', `ed:tit:${n}`)],
      [Markup.button.callback('🗑 Delete scene', `ed:del:${n}`)],
      [Markup.button.callback('⬅️ Back to scenes', 'ed:back')],
    ])
  ).catch(() => {});
}

async function applyAndPresent(ctx: Context, d: Draft) {
  if (busy) { await ctx.reply('⏳ Another edit is being rebuilt. Please wait for it to finish.'); return; }
  busy = true;
  const status = await ctx.reply('🔧 Applying your changes…');
  let last = '';
  const upd = async (t: string) => { if (t !== last) { last = t; await ctx.telegram.editMessageText(status.chat.id, status.message_id, undefined, t).catch(() => {}); } };
  try {
    const res = await editService.apply(d, upd);
    const m = d.manifest;
    await upd(`✅ Done (version ${m.version}): ${res.redrawn} picture(s) redrawn, ${res.reRecorded} narration(s) re-recorded; everything else reused.`);
    const caption = `🎬 ${m.saint.name} [${m.lang.toUpperCase()}] v${m.version}\n\n${m.caption}\n\n${m.hashtags}`;
    const saint = { name: m.saint.name, feast_month: m.saint.feast_month, feast_day: m.saint.feast_day } as SaintRecord;
    await sendPreview(ctx, {
      saint, lang: m.lang, dateMode: false, projectId: d.projectId,
      payload: { saintName: m.saint.name, videoUrl: res.videoUrl, coverImageUrl: res.coverUrl || d.coverUrl, caption: m.caption, hashtags: m.hashtags },
    }, res.videoUrl, caption);
  } catch (e: any) {
    await upd(`❌ ${e.message}`);
    await ctx.reply('Your changes are still in the editor. Try Apply again, or close it.', Markup.inlineKeyboard([[Markup.button.callback('✏️ Back to the editor', 'ed:back')]]));
  } finally {
    busy = false;
  }
}

export function registerEditMenu(bot: Telegraf<Context>, auth: (ctx: Context, next: () => Promise<void>) => any) {
  const need = async (ctx: Context): Promise<Draft | null> => {
    const d = drafts.get(uid(ctx));
    if (!d) { await ctx.answerCbQuery('The editor was closed (or the bot restarted). Open it again from the video.', { show_alert: true }); return null; }
    return d;
  };

  // "My videos": reopen any recent video later (not only right after it was made)
  bot.action('m:vids', auth, async ctx => {
    await ctx.answerCbQuery();
    let list: Awaited<ReturnType<typeof projectService.list>> = [];
    try { list = await projectService.list(8); } catch { /* no table yet */ }
    if (!list.length) {
      await ctx.editMessageText('📂 No saved videos yet. Make one first; the newest ones stay editable here.', Markup.inlineKeyboard([back])).catch(() => {});
      return;
    }
    await ctx.editMessageText(
      '📂 My videos: tap one to edit it (change a picture, narration, title or caption, or make another language with the same pictures).',
      Markup.inlineKeyboard([
        ...list.map(p => [Markup.button.callback(`${p.saint_name} · ${p.lang.toUpperCase()} · v${p.version}`, `ed:open:${p.id}:0`)]),
        back,
      ])
    ).catch(() => {});
  });

  bot.action(/^ed:open:(\d+):(\d+)$/, auth, async ctx => {
    await ctx.answerCbQuery('Opening editor…');
    const d = await editService.open(+ctx.match[1]);
    if (!d) { await ctx.reply('That project is no longer stored (only the newest ones are kept). Make the video again.'); return; }
    drafts.set(uid(ctx), d);
    await showPanel(ctx, d, false);
  });

  // another language, pictures reused: translate + rebuild in one tap
  bot.action(/^ed:tr:(\d+):(hi|pa|en):(\d+)$/, auth, async ctx => {
    await ctx.answerCbQuery('Translating…');
    const d = await editService.open(+ctx.match[1]);
    if (!d) { await ctx.reply('That project is no longer stored. Make the video again.'); return; }
    try {
      await editService.translate(d, ctx.match[2] as Lang, await romanPref());
    } catch (e: any) { await ctx.reply(`❌ Could not translate: ${e.message}`); return; }
    drafts.set(uid(ctx), d);
    await applyAndPresent(ctx, d);
  });
  bot.action(/^ed:tr2:(hi|pa|en)$/, auth, async ctx => {
    const d = await need(ctx); if (!d) return;
    await ctx.answerCbQuery('Translating…');
    try { await editService.translate(d, ctx.match[1] as Lang, await romanPref()); } catch (e: any) { await ctx.reply(`❌ Could not translate: ${e.message}`); return; }
    await showPanel(ctx, d);
  });

  bot.action('ed:back', auth, async ctx => { const d = await need(ctx); if (!d) return; await ctx.answerCbQuery(); clearPending(uid(ctx)); await showPanel(ctx, d); });
  bot.action('ed:cancel', auth, async ctx => { await ctx.answerCbQuery('Closed'); drafts.delete(uid(ctx)); clearPending(uid(ctx)); await ctx.editMessageText('✏️ Editor closed.', Markup.inlineKeyboard([back])).catch(() => {}); });
  bot.action('ed:apply', auth, async ctx => { const d = await need(ctx); if (!d) return; await ctx.answerCbQuery(); await applyAndPresent(ctx, d); });

  bot.action(/^ed:sc:(\d+)$/, auth, async ctx => { const d = await need(ctx); if (!d) return; await ctx.answerCbQuery(); await showScene(ctx, d, +ctx.match[1]); });
  bot.action(/^ed:img:(\d+)$/, auth, async ctx => { const d = await need(ctx); if (!d) return; editService.redrawScene(d, +ctx.match[1] - 1); await ctx.answerCbQuery('Picture queued'); await showPanel(ctx, d); });
  bot.action(/^ed:del:(\d+)$/, auth, async ctx => {
    const d = await need(ctx); if (!d) return;
    try { editService.deleteScene(d, +ctx.match[1] - 1); await ctx.answerCbQuery('Scene removed'); } catch (e: any) { await ctx.answerCbQuery(e.message, { show_alert: true }); return; }
    await showPanel(ctx, d);
  });

  const ask = (field: 'narration' | 'title' | 'instruction', prompt: string) =>
    bot.action(new RegExp(`^ed:${{ narration: 'nar', title: 'tit', instruction: 'imgi' }[field]}:(\\d+)$`), auth, async ctx => {
      const d = await need(ctx); if (!d) return;
      await ctx.answerCbQuery();
      setPending(uid(ctx), { kind: 'ed_text', field, idx: +ctx.match[1] - 1 });
      await ctx.reply(prompt, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to scenes', 'ed:back')]]));
    });
  ask('narration', `🎙 Send the new narration for this scene (in the video's language). Keep it about the same length so it still fits the picture.`);
  ask('title', '🔤 Send the new on-screen title (max 6 words), or "-" to remove it.');
  ask('instruction', '✏️ What should change in this picture? Only that is changed; the composition, background and faces stay. For example: "make the angel look younger", "remove the people in the background", "make it evening".');
  bot.action('ed:cap', auth, async ctx => {
    const d = await need(ctx); if (!d) return;
    await ctx.answerCbQuery();
    setPending(uid(ctx), { kind: 'ed_text', field: 'caption', idx: 0 });
    await ctx.reply('📝 Send the new caption text (hashtags are kept).', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to scenes', 'ed:back')]]));
  });
}

/** Free-text answers for the editor. Returns true when handled. */
export async function handleEditText(ctx: Context, st: Pending, text: string): Promise<boolean> {
  if (st.kind !== 'ed_text') return false;
  const d = drafts.get(uid(ctx));
  if (!d) { clearPending(uid(ctx)); await ctx.reply('The editor was closed. Open it again from the video.'); return true; }
  clearPending(uid(ctx));
  try {
    if (st.field === 'narration') await editService.setNarration(d, st.idx, text);
    else if (st.field === 'title') editService.setTitle(d, st.idx, text);
    else if (st.field === 'instruction') editService.redrawScene(d, st.idx, text, true);
    else editService.setCaption(d, text);
  } catch (e: any) {
    await ctx.reply(`❌ ${e.message}`);
  }
  await showPanel(ctx, d, false);
  return true;
}
