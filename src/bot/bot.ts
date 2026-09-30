import { Telegraf, Context } from 'telegraf';
import { config } from '../config/env.js';
import { registerBotCommands } from './commands.js';

export function setupTelegramBot(): Telegraf<Context> {
  const botToken = config.botToken || 'MOCK_TELEGRAM_BOT_TOKEN';
  console.log('🤖 Initializing Telegraf Telegram Bot...');

  const bot = new Telegraf(botToken, { handlerTimeout: 30 * 60 * 1000 }); // video generation takes minutes; default is 90s

  // Register command routes
  registerBotCommands(bot);

  // Global Error Handler
  bot.catch((err: any, ctx: Context) => {
    console.error(`❌ Telegram Bot Error for ${ctx.updateType}:`, err);
  });

  return bot;
}
