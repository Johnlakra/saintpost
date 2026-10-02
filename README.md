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


## Picture quality: director, checker, inspector

1. **Director** writes a detailed prompt per scene from the documented facts (shot, exact number of people, spatial layout, action, period-accurate place, light).
2. **Checker** audits each prompt against a physical-logic rulebook (`VISUAL_RULES` in `llmService.ts`: wings only on the angel and never through a person, hands hidden or simple, no overlapping bodies, exact counts, no text) and rewrites risky ones. It also writes a simpler *safe* composition and a must-include checklist.
3. **Inspector** (`imageQA.ts`) looks at every generated picture with a vision model. On a clear defect it redraws: attempt 2 adds the inspector's fix, attempt 3 uses the safe composition. Anything still flawed is flagged and the video is not auto-published.

Settings: `IMAGE_QA`, `IMAGE_QA_RETRIES`, `IMAGE_QA_MODE`, `IMAGE_CONCURRENCY`, `GEMINI_VISION_MODEL`, `IMAGE_QA_MODEL`. Each redraw spends one more image from the provider budget. Vision models are imperfect at counting fingers, so this reduces flaws but cannot guarantee none; the prompt rules do most of the work.


## AI usage (what each video costs)

LLM calls per video (DeepSeek via OpenRouter): **first time for a saint 4, repeats 3** (was 7):

1. `getDossier` (once per saint, cached in the `saints` row): language-neutral fact sheet + casting sheet from the long source text.
2. Script + caption + hashtags + Hinglish/Pinglish subtitles in **one** call, built from the compact fact sheet.
3. Image director, 4. prompt checker: both read the compact fact sheet, not the full biography.

Images: one per scene plus the cover. The inspector looks only at the cover and scenes rated medium/high risk, pictures are painted two at a time, narration is recorded while pictures are painted, the face reference is applied only to scenes where the saint is actually shown, and Gemini/OpenRouter model names are discovered from the API instead of hard-coded.


## LLM reliability (OpenRouter)

Every LLM call sets an explicit `max_tokens` (sized to the video length) and uses JSON mode when the model supports it. If OpenRouter says the balance can only afford N tokens, the call is retried with that smaller limit; a 402 rests the model for 10 minutes instead of banning it. Replies are parsed leniently (`jsonrepair`: trailing commas, comments, code fences) and retried once with a stricter instruction if still invalid. Keep a few dollars on the OpenRouter key: with `deepseek/deepseek-chat` a video uses roughly 10-20k tokens (check openrouter.ai for the current price).


## Who appears in the pictures (cast, not "a saint figure")

The cached fact sheet now includes `subject_type` (person / angels / group / mystery / object), a `cast` list (every person or being in the story with a distinct age, gender, hair and clothing for their real time and place) and, for non-person feasts, the generally accepted Catholic `iconography`. The script, the director and the checker all work from that cast, scenes about other people are drawn as those people, a feast that is not about one person gets no "main figure" and no face reference, and the inspector fails any picture that shows a Christ-like long-haired bearded robed figure when the story is not about Jesus. Fact sheets cached before this change are rebuilt once, automatically.


## Editing a finished video (reuse, don't regenerate)

Every video is saved as an editable **project** in Neon: the script, the cover, one JPEG per scene, the narration (MP3 per scene) and any AI motion clips (about 1-4 MB per project; only the newest `PROJECTS_KEEP`=10 are kept).

Open it from the video's **✏️ Edit this video** button or **/menu -> 📂 My videos**. You can change, per scene: the picture (redraw as-is, or "redraw with my change" such as "make the angel younger"), the narration, the on-screen title, or delete the scene; plus the caption, or make **another language with the same pictures**. Changes are queued; **Apply** redoes only what changed (new pictures cost image credits, edited narration costs one TTS call, a changed picture request or narration costs one tiny LLM call), reuses everything else, re-assembles with the current watermark and saves a new version. "Re-render" with no edits simply re-applies the current watermark/subtitle settings.

Already-published posts cannot be swapped by the Instagram/YouTube APIs: publish the edited version as a new post and remove the old one on the platform.
