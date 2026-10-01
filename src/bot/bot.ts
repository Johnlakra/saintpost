import { Telegraf, Context } from 'telegraf';
import { config } from '../config/env.js';
import { registerBotCommands } from './commands.js';

export function setupTelegramBot(): Telegraf<Context> {
  const botToken = config.botToken || 'MOCK_TELEGRAM_BOT_TOKEN';
  console.log('🤖 Initializing Telegraf Telegram Bot...');

  const bot = new Telegraf(botToken, { handlerTimeout: 30 * 60 * 1000 }); // video generation takes minutes; default is 90s

  // A button press can reach us after Telegram's ~15s answer window (cold start on Render, or a handler that was
  // busy). Answering it then fails with "query is too old" - that must not abort the action the user asked for.
  bot.use((ctx, next) => {
    if (ctx.callbackQuery) {
      const answer = ctx.answerCbQuery.bind(ctx);
      ctx.answerCbQuery = (async (...args: Parameters<typeof answer>) => {
        try {
          return await answer(...args);
        } catch (e: any) {
          if (!/query is too old|query ID is invalid/i.test(e?.description || e?.message || '')) throw e;
          console.warn('⚠️ Callback query expired before it was answered; continuing anyway.');
          return true;
        }
      }) as typeof ctx.answerCbQuery;
    }
    return next();
  });

  // Register command routes
  registerBotCommands(bot);

  // Global Error Handler
  bot.catch((err: any, ctx: Context) => {
    console.error(`❌ Telegram Bot Error for ${ctx.updateType}:`, err);
  });

  return bot;
}
