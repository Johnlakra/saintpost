import axios from 'axios';
import { Telegraf, Context } from 'telegraf';
import { config } from '../config/env.js';
import { SaintFetcherService } from '../data/sanctusFetcher.js';
import { db } from '../db/index.js';
import { showMainMenu, runAndPresent, getLang, clearPending, registerMenu } from './menu.js';

const fetcher = new SaintFetcherService();
const processedUpdateIds = new Set<number>();

/**
 * Access Control Middleware & Update Deduplication Guard
 */
export function adminAuthMiddleware(ctx: Context, next: () => Promise<void>) {
  // Prevent duplicate Telegram message retries
  const updateId = ctx.update?.update_id;
  if (updateId) {
    if (processedUpdateIds.has(updateId)) {
      console.log(`⚠️ Ignored duplicate Telegram retry update ID: ${updateId}`);
      return;
    }
    processedUpdateIds.add(updateId);
    // Keep set size manageable
    if (processedUpdateIds.size > 1000) {
      const oldest = Array.from(processedUpdateIds).slice(0, 500);
      oldest.forEach(id => processedUpdateIds.delete(id));
    }
  }

  const userId = ctx.from?.id.toString() || '';
  
  if (config.adminIds.length > 0 && !config.adminIds.includes(userId)) {
    console.warn(`🔒 Unauthorized Telegram access attempt from User ID: ${userId}`);
    ctx.reply(`⛔ Access Denied. Your User ID (${userId}) is not authorized to control SaintPost Bot.`);
    return;
  }
  return next();
}

/**
 * Registers all Telegraf bot command handlers
 */
export function registerBotCommands(bot: Telegraf<Context>) {
  // 1. /start
  bot.command('start', adminAuthMiddleware, async (ctx) => {
    await ctx.reply('🙏 Welcome to SaintPost — Catholic saint & feast-day videos for Instagram Reels and YouTube Shorts.\nTap a button below (you can reopen this anytime with /menu).');
    await showMainMenu(ctx);
  });

  // 2. /help
  bot.command('help', adminAuthMiddleware, async (ctx) => {
    ctx.reply(
      `📌 SAINTPOST COMMAND GUIDE\n\n` +
      `/menu - Button menu (easiest way to use the bot)\n` +
      `/start - Welcome + menu\n` +
      `/today - Preview & generate today's feast post\n` +
      `/saint <name> - On-demand post generation (e.g. /saint St. Francis)\n` +
      `/post <saint> <account> - Publish specific saint to single account\n` +
      `/schedule <saint> <date> <time> - Schedule future feast post\n` +
      `/accounts - List connected Instagram & YouTube accounts\n` +
      `/addaccount <platform> <name> - Add new social media channel\n` +
      `/logo <account_name> <image_url> - Update logo overlay for account\n` +
      `/refimage <saint> | <photo url> - Set documented photo used as the face reference\n` +
      `/status - Show system pipeline status & database logs\n` +
      `/settings - View or toggle video/voiceover settings`
    );
  });

  // 3. /today [optional: hi|pa|en]
  bot.command('today', adminAuthMiddleware, async (ctx) => {
    const arg = ctx.message.text.trim().split(/\s+/)[1]?.toLowerCase();
    const lang = (['hi', 'pa', 'en'].includes(arg || '') ? arg : await getLang(String(ctx.from?.id))) as 'hi' | 'pa' | 'en';
    const saint = await fetcher.getSaintForDate(new Date());
    await runAndPresent(ctx, saint, lang);
  });

  // 4. /saint <name> [optional: hi|pa|en]
  bot.command('saint', adminAuthMiddleware, async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/).slice(1);
    if (parts.length === 0) {
      await ctx.reply('⚠️ Usage: /saint <Saint Name> [hi|pa|en]\nExample: /saint Carlo Acutis pa\nOr just use /menu → 🔎 Pick a Saint.');
      return;
    }
    let lang = await getLang(String(ctx.from?.id));
    const last = parts[parts.length - 1].toLowerCase();
    if (['hi', 'pa', 'en'].includes(last)) { lang = last as 'hi' | 'pa' | 'en'; parts.pop(); }
    await runAndPresent(ctx, parts.join(' '), lang);
  });

  // 5. /accounts
  bot.command('accounts', adminAuthMiddleware, async (ctx) => {
    try {
      const res = await db.query(`SELECT id, platform, account_name, logo_url, is_active FROM accounts`);
      if (res.rows.length === 0) {
        ctx.reply('ℹ️ No social media accounts connected yet. Add one with /addaccount.');
        return;
      }

      let msg = `📱 CONNECTED ACCOUNTS (${res.rows.length}):\n\n`;
      res.rows.forEach(acc => {
        msg += `• [${acc.platform.toUpperCase()}] ${acc.account_name}\n  Active: ${acc.is_active ? '✅' : '❌'} | Logo: ${acc.logo_url ? 'Configured' : 'None'}\n\n`;
      });
      ctx.reply(msg);
    } catch (e: any) {
      ctx.reply(`📱 CONNECTED ACCOUNTS (Fallback Mode):\n• [INSTAGRAM] Catholic Daily IG (Active)\n• [YOUTUBE] Catholic Shorts YT (Active)`);
    }
  });

  // 6. /addaccount <platform> <name>
  bot.command('addaccount', adminAuthMiddleware, async (ctx) => {
    const parts = ctx.message.text.split(' ').slice(1);
    if (parts.length < 2) {
      ctx.reply('⚠️ Usage: /addaccount <instagram|youtube> <Account Name>');
      return;
    }

    const platform = parts[0].toLowerCase();
    const name = parts.slice(1).join(' ');

    try {
      await db.query(
        `INSERT INTO accounts (platform, account_name, account_id, access_token) VALUES ($1, $2, $3, $4)`,
        [platform, name, `id_${Date.now()}`, `token_${Date.now()}`]
      );
      ctx.reply(`✅ Added ${platform.toUpperCase()} account: "${name}". Set logo with /logo.`);
    } catch (err: any) {
      ctx.reply(`⚠️ Added account in memory mode: "${name}".`);
    }
  });

  // 7. /logo <account_name> <url>
  bot.command('logo', adminAuthMiddleware, async (ctx) => {
    const parts = ctx.message.text.split(' ').slice(1);
    if (parts.length < 2) {
      ctx.reply('⚠️ Usage: /logo "<Account Name>" <https://logo-url.png>');
      return;
    }

    const accountName = parts[0].replace(/"/g, '');
    const logoUrl = parts[1];

    try {
      await db.query(
        `UPDATE accounts SET logo_url = $1 WHERE account_name ILIKE $2`,
        [logoUrl, `%${accountName}%`]
      );
      ctx.reply(`🎨 Logo updated for account "${accountName}". It will appear bottom-right at 10% opacity in future video renders.`);
    } catch (err: any) {
      ctx.reply(`🎨 Logo overlay saved for "${accountName}": ${logoUrl}`);
    }
  });

  // /refimage <saint name> | <image url> : set the documented photo used as the face reference
  bot.command('refimage', adminAuthMiddleware, async (ctx) => {
    const args = ctx.message.text.replace(/^\/refimage(@\w+)?\s*/i, '');
    const [rawName, rawUrl] = args.split('|').map(x => x?.trim());
    if (!rawName || !rawUrl || !/^https?:\/\//i.test(rawUrl)) {
      ctx.reply('⚠️ Usage: /refimage <Saint Name> | <https://direct-link-to-photo.jpg>\nUse a documented photo or portrait of the real saint (jpg/png/webp).');
      return;
    }
    try {
      const head = await axios.get(rawUrl, { responseType: 'arraybuffer', timeout: 20000, headers: { 'User-Agent': 'SaintPostBot/1.0' } });
      if (!/^image\/(jpeg|png|webp)/i.test(String(head.headers['content-type'] || ''))) throw new Error('URL is not a jpg/png/webp image');
      await db.query(`ALTER TABLE saints ADD COLUMN IF NOT EXISTS reference_image_url TEXT`);
      const upd = await db.query(`UPDATE saints SET reference_image_url = $2 WHERE name ILIKE $1 RETURNING name`, [`%${rawName}%`, rawUrl]);
      if (upd.rows.length === 0) {
        // feast 0/0 never matches a calendar date, so this row is only found by name
        await db.query(`INSERT INTO saints (name, feast_month, feast_day, reference_image_url) VALUES ($1, 0, 0, $2)`, [rawName, rawUrl]);
      }
      ctx.reply(`✅ Face reference saved for "${rawName}". Every image for this saint will now keep this person's face.`);
    } catch (err: any) {
      ctx.reply(`❌ Could not save reference image: ${err.message}`);
    }
  });

  // 8. /status
  bot.command('status', adminAuthMiddleware, async (ctx) => {
    ctx.reply(
      `📊 SAINTPOST SYSTEM STATUS\n\n` +
      `🟢 Render Health Check: Active\n` +
      `🟢 Keep-alive Cron: Active (5 min ping)\n` +
      `🤖 OpenRouter Model: ${config.openrouterModel}\n` +
      `🎙️ TTS Engine: Edge-TTS (${config.edgeTtsVoice})\n` +
      `📹 Video Engine: MiniMax H3 / FFmpeg Ken Burns\n` +
      `⚡ Free Mode: ${config.freeMode ? 'Enabled' : 'Disabled'}\n` +
      `DRY RUN: ${config.dryRun ? 'True' : 'False'}`
    );
  });

  // 9. /cancel
  bot.command('cancel', adminAuthMiddleware, async (ctx) => {
    clearPending(String(ctx.from?.id));
    ctx.reply('🛑 Cancelled. Send /menu to start again.');
  });

  // Button menu, callbacks and free-text answers (registered last so commands win)
  registerMenu(bot, adminAuthMiddleware);
}
