# SaintPost ✝️🤖
### Automated Catholic Feast Day & Saint Content Bot for Instagram Reels & YouTube Shorts

SaintPost is a production-grade automated content generation and publishing engine built with Node.js, TypeScript, Telegraf, FFmpeg, Render, and Neon PostgreSQL.

It automatically generates 30–60 second 9:16 video Reels/Shorts, 1:1 feed cover images, devotional captions with 30 hashtags, character sheets, voiceovers, and subtitles for Catholic feast days and on-demand saints.

---

## 🌟 Key Features

1. **Daily Automated Feast Posts**: Triggered automatically every day at 06:00 AM IST.
2. **Interactive On-Demand Posts**: Telegram bot command `/saint "St. Francis of Assisi"` generates custom saint videos in ~2 minutes.
3. **Character Consistency**: Generates 3-panel character sheets (front, side, full body) to maintain saint visual identity across video scenes.
4. **Multi-Account & Per-Account Logo Overlay**: Supports publishing to multiple Instagram accounts and YouTube channels with custom logo overlays burned into the bottom-right corner.
5. **Zero-Cost Free Infrastructure**: Operates on Render (Free tier Web Service) + Neon PostgreSQL (Free serverless DB) with `cron-job.org` keep-alive pinging every 5 minutes.
6. **Robust Multi-Tier Fallbacks**:
   - Saint Data: `sanctus` npm package ➔ Liturgical Calendar API ➔ Curated Neon DB / Local JSON.
   - LLM: OpenRouter Free Models (Claude 3.5 Haiku, DeepSeek V3, Gemini 2.0 Flash rotation).
   - Visuals: FLUX.1 Schnell ➔ SDXL ➔ FFmpeg High-Res Generator.
   - Videos: MiniMax H3 ➔ HunyuanVideo 1.5 ➔ FFmpeg Ken Burns `zoompan` motion animation.
   - Voiceover: Microsoft Edge-TTS (Free) ➔ gTTS.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TELEGRAM BOT (SaintPost)                          │
│  /start | /help | /today | /saint | /post | /schedule | /accounts | /logo   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         10-STEP PIPELINE ENGINE                             │
│  1. Saint Data Fetcher (sanctus npm + Liturgical API + fallback DB)         │
│  2. Devotional Script & Prompt Generator (OpenRouter free tier)              │
│  3. Character Sheet Generator (3-panel visual consistency reference)       │
│  4. 1:1 Cover & 9:16 Scene Image Generator (FLUX.1 Schnell)                  │
│  5. 9:16 Video Clip Generator (MiniMax H3 / FFmpeg Ken Burns)               │
│  6. Voiceover & Subtitles Generator (Edge-TTS + SRT Whisper format)          │
│  7. Video Assembly & Audio Ducking (FFmpeg + per-account logo overlay)       │
│  8. Devotional Caption & 30 Hashtag Generator                                │
│  9. Multi-Account Publisher (Instagram Graph API + YouTube Shorts API)       │
│  10. Database Logging & Telegram Admin Notification                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 🛠️ Reference Repositories Integrated

- **SuperCMO Skills (`SupercmoHQ/superCMO-skills`)**:
  - `generating-ai-actors` ➔ `generating-saint-characters`
  - `generating-image-ads` ➔ `generating-saint-covers`
  - `writing-ad-copy` ➔ `writing-devotional-captions`
  - `generating-cartoon-videos` ➔ `generating-saint-story-videos`
  - `film-and-video-editors` ➔ `saint-video-editor`
- **Opportunity Radar (`Johnlakra/opportunity-radar`)**:
  - Express + Webhook structure, Neon Postgres integration, Render deployment pattern.

---

## 🚀 Telegram Bot Commands

| Command | Usage | Description |
|---------|-------|-------------|
| `/start` | `/start` | Setup wizard & welcome |
| `/today` | `/today` | Preview & generate post for today's saint |
| `/saint` | `/saint St. Patrick` | Generate on-demand post for any saint |
| `/accounts` | `/accounts` | List connected social accounts |
| `/addaccount` | `/addaccount instagram "Catholic Daily"` | Add new channel |
| `/logo` | `/logo "Catholic Daily" https://url/logo.png` | Set custom logo overlay |
| `/status` | `/status` | Check system & pipeline health |
| `/help` | `/help` | Detailed command reference |

---

## ⚙️ Environment Variables (`.env`)

```bash
# Telegram
BOT_TOKEN=your_telegram_bot_token
ADMIN_IDS=123456789,987654321
TELEGRAM_WEBHOOK_URL=https://your-app.onrender.com/webhook

# Neon Database
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require

# AI Model APIs
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=anthropic/claude-3.5-haiku
FAL_API_KEY=your_fal_api_key
MINIMAX_API_KEY=your_minimax_api_key

# Options
FREE_MODE=true
DRY_RUN=false
```

---

## 📦 Local Development & Deployment

### 1. Install & Build
```bash
npm install
npm run build
```

### 2. Database Migration & Seed
```bash
npm run db:migrate
npm run db:seed
```

### 3. Run Pipeline Dry Run Test
```bash
DRY_RUN=true node -e "import('./dist/engine/pipeline.js').then(m => new m.SaintPostPipeline().runPipelineForSaint('St. Francis of Assisi'))"
```

### 4. Deploy to Render
1. Connect GitHub repository to [Render.com](https://render.com).
2. Use **Web Service** with build command `npm install && npm run build` and start command `npm start`.
3. Set environment variables from `.env.example`.
4. Set up keep-alive ping on [cron-job.org](https://cron-job.org) targeting `https://your-app.onrender.com/health` every 5 minutes.


## Free daily image quota (Cloudflare Workers AI)

Cloudflare gives every free account **10,000 neurons per day, renewing at 00:00 UTC, no credit card**. SaintPost uses it first:

| Model | Neurons per 9:16 frame | Notes |
|---|---|---|
| FLUX.2 klein 4B | ~190 (with a reference photo) | width/height, reference images for consistent faces |
| FLUX.1 schnell | ~70 | cheaper fallback, text only |

That is roughly 8 Short, 5 Standard or 3 Long videos per day. The bot's **Status** and **Length** screens show an estimate of what is left.

Setup: sign up at dash.cloudflare.com, open **AI > Workers AI > Use REST API**, copy the **Account ID**, click **Create a Workers AI API token**, then set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in Render. Verify with `npm run check:providers` or the bot's **Status > Test image providers** button.
