import axios from 'axios';
import { Context, Markup } from 'telegraf';
import { editService, Draft } from '../services/editService.js';
import { chunkBlocks, describeChange, diffScript, scriptBlocks, startsWithBlock } from './scriptFormat.js';

const MAX_SCRIPT_FILE_BYTES = 512 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30000;

const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fileName = (d: Draft) => `script_${d.manifest.saint.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${d.manifest.lang}_v${d.manifest.version}.txt`;

const FILE_HELP = [
  'Edit any Title / Narration / Picture prompt / Caption below and send this file back to the bot.',
  'Only text you actually change is redone; unchanged scenes are reused for free.',
  'Title "-" removes the on-screen title. Do not change the [Scene N/M] lines.',
  '',
].join('\n');

/** The whole script (every title, narration and picture prompt, never shortened), split only at Telegram's size limit. */
export async function sendFullScript(ctx: Context, d: Draft) {
  const m = d.manifest;
  const chunks = chunkBlocks(scriptBlocks(m));
  for (const [k, chunk] of chunks.entries()) {
    const head = k === 0 ? `📜 Full script: ${m.saint.name} [${m.lang.toUpperCase()}] · version ${m.version} · ${m.scenes.length} scenes\n\n` : '';
    await ctx.reply(head + chunk);
  }
}

/** The same script as copyable blocks plus a .txt file, ready to be edited and sent back. */
export async function sendBulkTemplate(ctx: Context, d: Draft) {
  await ctx.reply(
    '📋 EDIT MANY SCENES AT ONCE\n\n' +
    '1. Tap a block below to copy it (or download the .txt file).\n' +
    '2. Change any Title, Narration or Picture prompt, in as many scenes as you like. Keep the [Scene N/M] lines.\n' +
    '3. Send it back as a message (one block at a time is fine) or send the edited .txt file.\n\n' +
    'Only what you actually changed is redone: a new narration re-records just that scene, a new picture prompt redraws just that picture, a new title costs nothing. Scenes you leave out or do not change stay exactly as they are.'
  );
  for (const chunk of chunkBlocks(scriptBlocks(d.manifest))) {
    await ctx.reply(`<pre>${escapeHtml(chunk)}</pre>`, { parse_mode: 'HTML' });
  }
  const file = Buffer.from(FILE_HELP + scriptBlocks(d.manifest).join('\n\n') + '\n', 'utf8');
  await ctx.replyWithDocument({ source: file, filename: fileName(d) }, {
    caption: 'Same script as a file. Send it back after editing.',
    ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Back to the editor', 'ed:back')]]),
  });
}

/** Diffs the edited text against the draft and applies only the real changes. */
export async function applyBulkText(ctx: Context, d: Draft, text: string, fromFile = false) {
  const kb = Markup.inlineKeyboard([[Markup.button.callback('✅ Apply changes', 'ed:apply'), Markup.button.callback('✏️ Back to the editor', 'ed:back')]]);
  if (!fromFile && !startsWithBlock(text)) {
    await ctx.reply('⚠️ Nothing was changed: the message must start with a [Scene N/M] or [Caption] line. If Telegram split a long paste into several messages, send the scenes in smaller parts or send the .txt file instead.', kb);
    return;
  }
  const { changes, errors } = diffScript(d.manifest, text);
  if (errors.length) {
    await ctx.reply(`⚠️ Nothing was changed. Please fix this and send it again:\n• ${errors.join('\n• ')}`, kb);
    return;
  }
  if (!changes.length) {
    await ctx.reply('ℹ️ No differences found; that text matches the current script. Change some text and send it again.', kb);
    return;
  }
  try {
    await editService.applyScriptChanges(d, changes);
  } catch (e: any) {
    await ctx.reply(`❌ Could not apply the changes: ${e.message}`, kb);
    return;
  }
  const scenes = new Set(changes.flatMap(c => (c.kind === 'scene' ? [c.idx] : []))).size;
  await ctx.reply(
    `✅ ${changes.length} change${changes.length > 1 ? 's' : ''} staged (${scenes} scene${scenes === 1 ? '' : 's'}):\n• ${changes.map(describeChange).join('\n• ')}\n\n` +
    'Everything else stays as it is. Send more edited scenes, or tap Apply to rebuild the video.',
    kb
  );
}

/** An edited script sent back as a .txt file. */
export async function applyBulkFile(ctx: Context, d: Draft, doc: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }) {
  const isText = /^text\//.test(doc.mime_type || '') || /\.txt$/i.test(doc.file_name || '');
  if (!isText) { await ctx.reply('⚠️ Please send the script as a .txt file (or paste it as a message).'); return; }
  if ((doc.file_size || 0) > MAX_SCRIPT_FILE_BYTES) { await ctx.reply('⚠️ That file is too large for a script.'); return; }
  let text: string;
  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const res = await axios.get(link.href, { responseType: 'arraybuffer', timeout: DOWNLOAD_TIMEOUT_MS, maxContentLength: MAX_SCRIPT_FILE_BYTES });
    text = Buffer.from(res.data).toString('utf8');
  } catch (e: any) {
    console.error('❌ Could not download edited script file:', e.message);
    await ctx.reply('❌ Could not read that file from Telegram. Please send it again.');
    return;
  }
  await applyBulkText(ctx, d, text, true);
}
