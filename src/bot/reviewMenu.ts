import { Telegraf, Context, Markup } from 'telegraf';
import { reviewService, Review } from '../services/reviewService.js';
import { editService } from '../services/editService.js';
import { SaintRecord } from '../data/sanctusFetcher.js';
import { LengthId } from '../config/lengths.js';
import { Lang, LANG_LABEL, presentResult } from './present.js';
import { setPending, clearPending, Pending } from './state.js';
import { sendFullScript, sendScriptFile, sendBulkTemplate, applyBulkText, applyBulkFile, BulkOptions } from './editBulk.js';
import { chunkBlocks, picturePrompt } from './scriptFormat.js';

/**
 * "Check first" screens: script → (approve) → pictures → (approve) → video. Every step shows exactly what the video
 * will be made of; text edits use the same [Scene N/M] format as the video editor.
 */
const uid = (ctx: Context) => String(ctx.from?.id ?? '');
const reviews = new Map<string, Review>();
const ALBUM_SIZE = 10; // Telegram media group limit
const PHOTO_CAPTION_LIMIT = 1024;
const back = [Markup.button.callback('⬅️ Menu', 'm:main')];

function gateKeyboard(r: Review) {
  if (r.phase === 'script') {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🎨 Script is good: paint the pictures', 'rv:paint')],
      [Markup.button.callback('📋 Copyable blocks', 'rv:blocks'), Markup.button.callback('📜 Show script again', 'rv:full')],
      [Markup.button.callback('❌ Cancel', 'rv:cancel')],
    ]);
  }
  const nums = r.draft.manifest.scenes.map((_, i) => Markup.button.callback(`${i + 1}${r.draft.dirtyImg.has(i) ? '✎' : ''}`, `rv:sc:${i + 1}`));
  const rows = Array.from({ length: Math.ceil(nums.length / 5) }, (_, k) => nums.slice(k * 5, k * 5 + 5));
  const dirty = r.draft.dirtyImg.size;
  return Markup.inlineKeyboard([
    ...rows,
    [dirty
      ? Markup.button.callback(`🖼 Redraw ${dirty} changed picture${dirty > 1 ? 's' : ''} and show`, 'rv:redraw')
      : Markup.button.callback('🎬 All good: build the video', 'rv:build')],
    [Markup.button.callback('📋 Edit script / prompts', 'rv:blocks'), Markup.button.callback('📜 Full script', 'rv:full')],
    [Markup.button.callback('🖼 Show pictures again', 'rv:pics'), Markup.button.callback('❌ Cancel', 'rv:cancel')],
  ]);
}

function gateText(r: Review): string {
  const m = r.draft.manifest;
  const pending = r.draft.summary.length ? `\n\nChanges so far:\n• ${r.draft.summary.join('\n• ')}` : '';
  if (r.phase === 'script') {
    return `🔍 CHECK THE SCRIPT: ${m.saint.name} [${m.lang.toUpperCase()}] · ${m.scenes.length} scenes\n\n` +
      'Nothing has been painted or recorded yet. Read the script above (titles, narration, picture prompts and caption).\n\n' +
      'To change anything: copy a script message or the .txt file, edit it and send it back (one or more [Scene N/M] blocks, or the file). Changes here are free.\n\n' +
      'When it reads right, tap 🎨 to paint the pictures. You will see every picture before the video is made.' + pending;
  }
  const rep = r.pictures?.report;
  const notes = [
    ...(rep?.reused.length ? [`Scenes ${rep.reused.join(', ')} reuse another picture (image credits ran out). Redraw them.`] : []),
    ...(rep?.qa.flagged.length ? [`The image checker still saw a flaw in: ${rep.qa.flagged.join(', ')}.`] : []),
  ];
  return `🔍 CHECK THE PICTURES: ${m.saint.name} [${m.lang.toUpperCase()}]\n\n` +
    `These ${m.scenes.length} pictures and the cover are exactly what the video will be made of.\n` +
    'Tap a scene number to redraw it, change it or give it a new prompt. Narration, titles and caption can still be changed by sending edited script text.' +
    (notes.length ? `\n\n⚠️ ${notes.join('\n⚠️ ')}` : '') + pending + '\n\n' +
    (r.draft.dirtyImg.size
      ? 'Changed pictures (✎) are redrawn and shown to you before the video can be built.'
      : 'When everything looks right, tap 🎬. The narration is recorded and the video is put together from exactly these.');
}

const showGate = (ctx: Context, r: Review) => ctx.reply(gateText(r), gateKeyboard(r));

const bulkOptions = (r: Review): BulkOptions => ({
  keyboard: () => gateKeyboard(r),
  nextStep: r.phase === 'script'
    ? 'Send more edits, or tap 🎨 to paint the pictures.'
    : 'Changed pictures are redrawn and shown to you before the video is built.',
});

/** Progress shown by editing one status message. */
async function statusLine(ctx: Context, first: string) {
  const msg = await ctx.reply(first);
  let last = first;
  return async (t: string) => {
    if (t === last) return;
    last = t;
    await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, t).catch(() => {});
  };
}

function photoCaption(r: Review, i: number): string {
  const s = r.draft.manifest.scenes[i];
  const head = `Scene ${i + 1}/${r.draft.manifest.scenes.length}: ${s.overlay || '(no title)'}`;
  const full = `${head}\n\n${s.voiceover}`;
  return full.length <= PHOTO_CAPTION_LIMIT ? full : head;
}

/** The pictures as albums (cover first); `only` = just these scenes, e.g. after a redraw. */
async function sendPictures(ctx: Context, r: Review, only?: number[]) {
  const a = r.draft.assets;
  const items = [
    ...(only || !a.cover ? [] : [{ buf: a.cover, caption: 'Cover (also the face reference for every scene)' }]),
    ...(only ?? r.draft.manifest.scenes.map((_, i) => i)).flatMap(i => (a.scenes[i] ? [{ buf: a.scenes[i]!, caption: photoCaption(r, i) }] : [])),
  ];
  for (let k = 0; k < items.length; k += ALBUM_SIZE) {
    const group = items.slice(k, k + ALBUM_SIZE);
    try {
      if (group.length === 1) await ctx.replyWithPhoto({ source: group[0].buf }, { caption: group[0].caption });
      else await ctx.replyWithMediaGroup(group.map(g => ({ type: 'photo' as const, media: { source: g.buf }, caption: g.caption })));
    } catch (e: any) {
      console.error('❌ Could not send review pictures:', e.message);
      await ctx.reply(`❌ Telegram did not accept some pictures (${e.message}). Tap 🖼 Show pictures again.`);
    }
  }
}

async function sendScript(ctx: Context, r: Review) {
  const m = r.draft.manifest;
  await sendFullScript(ctx, r.draft, `📜 SCRIPT TO CHECK: ${m.saint.name} [${m.lang.toUpperCase()}] · ${m.scenes.length} scenes`);
  await sendScriptFile(ctx, r.draft, 'The same script as a .txt file: edit it and send it back if that is easier.');
}

/** Entry point when "check first" is on: writes the script and stops for approval. */
export async function startReviewFlow(ctx: Context, saintInput: SaintRecord | string, lang: Lang, length: LengthId, dateMode: boolean) {
  const upd = await statusLine(ctx, `🔍 Check first (${LANG_LABEL[lang]}): writing the script. You will check it before anything is painted.`);
  try {
    const r = await reviewService.start(saintInput, lang, length, dateMode, t => void upd(t));
    reviews.set(uid(ctx), r);
    await upd(`✅ Script ready: ${r.stage.saint.name}`);
    await sendScript(ctx, r);
    setPending(uid(ctx), { kind: 'rv_bulk' });
    await showGate(ctx, r);
  } catch (e: any) {
    await upd(`❌ ${e.message}`);
    await ctx.reply('Something went wrong. Back to the menu?', Markup.inlineKeyboard([back]));
  }
}

/** Runs a slow step once at a time per review; the review stays open on failure so the step can be retried. */
async function runStep(ctx: Context, r: Review, first: string, step: (upd: (t: string) => void) => Promise<void>) {
  if (r.working) { await ctx.reply('⏳ Still working on the previous step. Please wait.'); return; }
  r.working = true;
  const upd = await statusLine(ctx, first);
  try {
    await step(t => void upd(t));
  } catch (e: any) {
    await upd(`❌ ${e.message}`);
    await showGate(ctx, r);
  } finally {
    r.working = false;
  }
}

async function showReviewScene(ctx: Context, r: Review, n: number) {
  const s = r.draft.manifest.scenes[n - 1];
  const pic = r.draft.assets.scenes[n - 1];
  if (pic) await ctx.replyWithPhoto({ source: pic }, { caption: `Scene ${n}/${r.draft.manifest.scenes.length}${r.draft.dirtyImg.has(n - 1) ? ' (will be redrawn)' : ''}` }).catch(() => {});
  const text = `Scene ${n}\n\n🔤 Title: ${s.overlay || '(none)'}\n\n🎙 Narration:\n${s.voiceover}\n\n🖼 Picture prompt:\n${picturePrompt(s)}`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Change this picture (keeps the rest)', `rv:imgi:${n}`)],
    [Markup.button.callback('🖼 Redraw from scratch', `rv:img:${n}`), Markup.button.callback('📝 New picture prompt', `rv:prm:${n}`)],
    [Markup.button.callback('⬅️ Back', 'rv:back')],
  ]);
  const parts = chunkBlocks([text]);
  for (const [k, part] of parts.entries()) await ctx.reply(part, k === parts.length - 1 ? kb : {});
}

export function registerReviewMenu(bot: Telegraf<Context>, auth: (ctx: Context, next: () => Promise<void>) => any) {
  const need = async (ctx: Context, phase?: Review['phase']): Promise<Review | null> => {
    const r = reviews.get(uid(ctx));
    if (!r) { await ctx.answerCbQuery('This check was closed (or the bot restarted). Start the video again.', { show_alert: true }); return null; }
    if (phase && r.phase !== phase) { await ctx.answerCbQuery(phase === 'pictures' ? 'Paint the pictures first.' : 'The pictures are already painted.', { show_alert: true }); return null; }
    await ctx.answerCbQuery();
    return r;
  };

  bot.action('rv:paint', auth, async ctx => {
    const r = await need(ctx, 'script'); if (!r) return;
    await runStep(ctx, r, '🎨 Painting the cover and every scene (the slow part)…', async upd => {
      await reviewService.paint(r, upd);
      upd('✅ Pictures ready. Check them below.');
      await sendPictures(ctx, r);
      await showGate(ctx, r);
    });
  });

  bot.action('rv:redraw', auth, async ctx => {
    const r = await need(ctx, 'pictures'); if (!r) return;
    await runStep(ctx, r, '🖼 Redrawing the changed pictures…', async upd => {
      const redrawn = await reviewService.redraw(r, upd);
      upd(`✅ Redrew ${redrawn.length} picture${redrawn.length === 1 ? '' : 's'}. Check ${redrawn.length === 1 ? 'it' : 'them'} below.`);
      await sendPictures(ctx, r, redrawn);
      await showGate(ctx, r);
    });
  });

  bot.action('rv:build', auth, async ctx => {
    const r = await need(ctx, 'pictures'); if (!r) return;
    await runStep(ctx, r, '🎬 Recording the narration and putting the video together…', async upd => {
      const result = await reviewService.build(r, upd);
      upd(`✅ Done: ${result.saint.name}`);
      reviews.delete(uid(ctx));
      clearPending(uid(ctx));
      await presentResult(ctx, result, r.stage.lang, r.dateMode);
    });
  });

  bot.action('rv:cancel', auth, async ctx => {
    await ctx.answerCbQuery('Cancelled');
    reviews.delete(uid(ctx));
    clearPending(uid(ctx));
    await ctx.reply('❌ Cancelled. Nothing was built.', Markup.inlineKeyboard([back]));
  });

  bot.action('rv:full', auth, async ctx => { const r = await need(ctx); if (!r) return; await sendFullScript(ctx, r.draft); await showGate(ctx, r); });
  bot.action('rv:pics', auth, async ctx => { const r = await need(ctx, 'pictures'); if (!r) return; await sendPictures(ctx, r); await showGate(ctx, r); });
  bot.action('rv:back', auth, async ctx => { const r = await need(ctx); if (!r) return; setPending(uid(ctx), { kind: 'rv_bulk' }); await showGate(ctx, r); });
  bot.action('rv:blocks', auth, async ctx => {
    const r = await need(ctx); if (!r) return;
    setPending(uid(ctx), { kind: 'rv_bulk' });
    const intro = r.phase === 'script'
      ? 'Nothing is painted or recorded yet, so every change here is free.'
      : 'A new picture prompt redraws just that picture (you see it before the video is built); narration, title and caption changes are free.';
    await sendBulkTemplate(ctx, r.draft, intro, gateKeyboard(r));
  });

  bot.action(/^rv:sc:(\d+)$/, auth, async ctx => { const r = await need(ctx, 'pictures'); if (!r) return; await showReviewScene(ctx, r, +ctx.match[1]); });
  bot.action(/^rv:img:(\d+)$/, auth, async ctx => {
    const r = await need(ctx, 'pictures'); if (!r) return;
    editService.redrawScene(r.draft, +ctx.match[1] - 1);
    await showGate(ctx, r);
  });
  const ask = (action: string, field: 'instruction' | 'prompt', prompt: string) =>
    bot.action(new RegExp(`^rv:${action}:(\\d+)$`), auth, async ctx => {
      const r = await need(ctx, 'pictures'); if (!r) return;
      setPending(uid(ctx), { kind: 'rv_text', field, idx: +ctx.match[1] - 1 });
      await ctx.reply(prompt, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'rv:back')]]));
    });
  ask('imgi', 'instruction', '✏️ What should change in this picture? Only that is changed; the composition, background and faces stay. For example: "make the angel look younger", "remove the people in the background".');
  ask('prm', 'prompt', '📝 Send the full new picture prompt for this scene. It is used exactly as written and the picture is drawn fresh from it.');
}

const reviewClosed = async (ctx: Context) => {
  clearPending(uid(ctx));
  await ctx.reply('This check was closed (or the bot restarted). Start the video again.', Markup.inlineKeyboard([back]));
};

/** Script text / single-picture answers during a check. Returns true when handled. */
export async function handleReviewText(ctx: Context, st: Pending, text: string): Promise<boolean> {
  if (st.kind !== 'rv_bulk' && st.kind !== 'rv_text') return false;
  const r = reviews.get(uid(ctx));
  if (!r) { await reviewClosed(ctx); return true; }
  if (r.working) { await ctx.reply('⏳ Please wait for the current step to finish, then send your changes again.'); return true; }
  if (st.kind === 'rv_bulk') { await applyBulkText(ctx, r.draft, text, false, bulkOptions(r)); return true; }
  setPending(uid(ctx), { kind: 'rv_bulk' });
  if (st.field === 'prompt') editService.setPicturePrompt(r.draft, st.idx, text);
  else editService.redrawScene(r.draft, st.idx, text, true);
  await showGate(ctx, r);
  return true;
}

/** An edited script .txt sent back during a check. Returns true when handled. */
export async function handleReviewDocument(ctx: Context, st: Pending | undefined, doc: Parameters<typeof applyBulkFile>[2]): Promise<boolean> {
  if (st?.kind !== 'rv_bulk') return false;
  const r = reviews.get(uid(ctx));
  if (!r) { await reviewClosed(ctx); return true; }
  if (r.working) { await ctx.reply('⏳ Please wait for the current step to finish, then send the file again.'); return true; }
  await applyBulkFile(ctx, r.draft, doc, bulkOptions(r));
  return true;
}
