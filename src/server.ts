import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { config } from './config/env.js';
import { setupTelegramBot } from './bot/bot.js';
import { SaintPostPipeline } from './engine/pipeline.js';
import { db } from './db/index.js';

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

// Face-reference photos uploaded through Telegram (stored in Neon so they survive redeploys)
app.get('/ref/:id', async (req, res) => {
  try {
    const r = await db.query(`SELECT mime, data FROM reference_images WHERE id = $1`, [parseInt(req.params.id, 10)]);
    if (!r.rows[0]) return res.status(404).send('Not found');
    res.set('Content-Type', r.rows[0].mime).set('Cache-Control', 'public, max-age=86400').send(r.rows[0].data);
  } catch {
    res.status(404).send('Not found');
  }
});

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

// 2. Telegram Webhook Endpoint (Instantly Acknowledge 200 OK to prevent Telegram retry loops)
app.post('/webhook', (req, res) => {
  res.status(200).send('OK');
  if (config.botToken) {
    bot.handleUpdate(req.body).catch(err => {
      console.error('❌ Background webhook update error:', err);
    });
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

// The "/" command list + the blue Menu button next to the message box
async function registerTelegramMenu() {
  try {
    await bot.telegram.setMyCommands([
      { command: 'menu', description: '🙏 Open the button menu' },
      { command: 'today', description: "✝️ Today's feast video" },
      { command: 'saint', description: '🔎 Video for any saint: /saint <name>' },
      { command: 'watermark', description: '💧 Logo & text watermark' },
      { command: 'refimage', description: '🖼 Set a saint\'s face photo' },
      { command: 'accounts', description: '📱 Connected accounts' },
      { command: 'status', description: '📊 System status' },
      { command: 'help', description: '❓ Help' },
      { command: 'cancel', description: '🛑 Cancel current question' },
    ]);
    await bot.telegram.setChatMenuButton({ menuButton: { type: 'commands' } });
    console.log('✅ Telegram command menu registered');
  } catch (e: any) {
    console.warn('⚠️ Could not register Telegram command menu:', e.message);
  }
}

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
      await registerTelegramMenu();
    } catch (e: any) {
      console.warn('⚠️ Telegram webhook setup warning:', e.message);
    }
  } else if (config.botToken && config.nodeEnv === 'development') {
    registerTelegramMenu();
    bot.launch();
    console.log('🤖 Telegram Bot launched in Long Polling mode (development).');
  }
});
