import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { config } from './config/env.js';
import { setupTelegramBot } from './bot/bot.js';
import { SaintPostPipeline } from './engine/pipeline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Serve static assets (generated videos, images, character sheets, voiceovers)
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.use('/assets', express.static(path.join(publicDir, 'assets')));
app.use('/renders', express.static(path.join(publicDir, 'renders')));
app.use('/audio', express.static(path.join(publicDir, 'audio')));

// Initialize Telegram Bot
const bot = setupTelegramBot();
const pipeline = new SaintPostPipeline();

// 1. Health Check Endpoint (For cron-job.org keep-alive every 5 minutes)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    app: 'SaintPost Automated Bot',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: config.nodeEnv,
  });
});

// 2. Telegram Webhook Endpoint
app.post('/webhook', (req, res) => {
  if (config.botToken) {
    bot.handleUpdate(req.body, res);
  } else {
    res.status(200).send('Bot Token not set. Running in webhook stub mode.');
  }
});

// 3. Trigger Endpoint for Daily Post (6:00 AM IST Cron Job)
app.post('/api/trigger-daily-post', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${config.cronSecret}` && req.query.secret !== config.cronSecret) {
    return res.status(401).json({ error: 'Unauthorized secret' });
  }

  console.log('⏰ Triggering Daily Feast Automation Flow...');
  try {
    const result = await pipeline.runPipelineForSaint();
    res.status(200).json({
      status: 'success',
      saint: result.saint.name,
      videoUrl: result.finalVideoUrl,
      publishedCount: result.publishResult.successCount,
    });
  } catch (err: any) {
    console.error('❌ Daily automated flow failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// 4. In-App Automated Cron Schedule (Daily at 06:00 AM IST = 00:30 UTC)
cron.schedule('30 0 * * *', async () => {
  console.log('⏰ Executing internal Cron Job: Daily Saint Feast Automation Flow...');
  try {
    await pipeline.runPipelineForSaint();
  } catch (err: any) {
    console.error('❌ Scheduled cron execution error:', err.message);
  }
});

// Start Server & Bot
const PORT = config.port;
app.listen(PORT, async () => {
  console.log(`\n======================================================`);
  console.log(`🌐 SAINTPOST SERVER RUNNING ON PORT ${PORT}`);
  console.log(`🔗 Health Check URL: ${config.renderExternalUrl}/health`);
  console.log(`======================================================\n`);

  // Set up Telegram Webhook or Long Polling
  if (config.botToken && config.telegramWebhookUrl) {
    try {
      await bot.telegram.setWebhook(`${config.telegramWebhookUrl}/webhook`);
      console.log(`✅ Telegram Webhook registered: ${config.telegramWebhookUrl}/webhook`);
    } catch (e: any) {
      console.warn('⚠️ Telegram webhook setup warning:', e.message);
    }
  } else if (config.botToken && config.nodeEnv === 'development') {
    bot.launch();
    console.log('🤖 Telegram Bot launched in Long Polling mode (development).');
  }
});
