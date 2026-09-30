import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // Server & Render
  port: parseInt(process.env.PORT || '10000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  renderExternalUrl: process.env.RENDER_EXTERNAL_URL || 'http://localhost:10000',
  cronSecret: process.env.CRON_SECRET || 'saintpost-cron-secret-key',

  // Telegram
  botToken: process.env.BOT_TOKEN || '',
  adminIds: (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean),
  telegramWebhookUrl: process.env.TELEGRAM_WEBHOOK_URL || '',
  webhookSecret: process.env.WEBHOOK_SECRET || 'saintpost-webhook-secret',

  // Neon PostgreSQL Database
  databaseUrl: process.env.DATABASE_URL || 'postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require',

  // AI Content Models (OpenRouter / Free Tier)
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openrouterModel: process.env.OPENROUTER_MODEL || '',
  // Extra free-tier image providers (all optional)
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
  cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN || '',
  togetherApiKey: process.env.TOGETHER_API_KEY || '',
  pollinationsApiKey: process.env.POLLINATIONS_API_KEY || '',
  huggingfaceApiKey: process.env.HUGGINGFACE_API_KEY || '',

  // Visual Asset Generation
  replicateApiToken: process.env.REPLICATE_API_TOKEN || '',
  falApiKey: process.env.FAL_API_KEY || '',

  // Video Generation
  minimaxApiKey: process.env.MINIMAX_API_KEY || '',
  hunyuanApiKey: process.env.HUNYUAN_API_KEY || '',

  // Voiceover / TTS
  elevenlabsApiKey: process.env.ELEVENLABS_API_KEY || '',
  edgeTtsVoice: process.env.EDGE_TTS_VOICE || 'en-US-AriaNeural',

  // Social Media Integrations
  instagramAppId: process.env.INSTAGRAM_APP_ID || '',
  instagramAppSecret: process.env.INSTAGRAM_APP_SECRET || '',
  youtubeClientId: process.env.YOUTUBE_CLIENT_ID || '',
  youtubeClientSecret: process.env.YOUTUBE_CLIENT_SECRET || '',

  // Feature Flags & Language Options
  defaultLanguage: (process.env.DEFAULT_LANGUAGE || 'hi') as 'hi' | 'en' | 'pa',
  enableVideoGeneration: process.env.ENABLE_VIDEO_GENERATION !== 'false',
  enableVoiceover: process.env.ENABLE_VOICEOVER !== 'false',
  enableMusic: process.env.ENABLE_MUSIC !== 'false',
  enableSubtitles: process.env.ENABLE_SUBTITLES !== 'false',
  // Devotional extras are OFF by default so images stay true to the documented saint.
  saintHalo: process.env.SAINT_HALO === 'true',
  freeMode: process.env.FREE_MODE !== 'false',
  dryRun: process.env.DRY_RUN === 'true',
};
