-- 1. Accounts table (multi-account support)
CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    platform VARCHAR(20) NOT NULL, -- 'instagram', 'youtube'
    account_name VARCHAR(100) NOT NULL,
    account_id VARCHAR(200) NOT NULL, -- IG user ID or YouTube channel ID
    access_token TEXT NOT NULL,       -- encrypted
    refresh_token TEXT,
    token_expires_at TIMESTAMP,
    logo_url TEXT,                    -- per-account logo overlay
    brand_color VARCHAR(7) DEFAULT '#8A2BE2', -- hex color for overlays
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 2. Saints table (curated + auto-fetched)
CREATE TABLE IF NOT EXISTS saints (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    feast_month INT NOT NULL,         -- 1-12
    feast_day INT NOT NULL,           -- 1-31
    rank VARCHAR(50),                 -- 'Solemnity', 'Feast', 'Memorial', 'Optional'
    liturgical_color VARCHAR(20),     -- 'White', 'Red', 'Green', 'Purple', 'Rose'
    patronage TEXT,                   -- comma-separated
    short_description TEXT,
    full_story TEXT,
    what_we_learn TEXT[],             -- array of 3 bullet points
    did_you_know TEXT,                -- interesting fact
    character_sheet_url TEXT,         -- generated character sheet
    era VARCHAR(50),                  -- 'Early Church', 'Medieval', 'Modern'
    region VARCHAR(100),              -- 'Italy', 'France', 'Ireland', etc.
    symbols TEXT[],                   -- e.g., ['lily', 'book', 'dragon']
    created_at TIMESTAMP DEFAULT NOW()
);

-- 3. Posts table (track what was posted)
CREATE TABLE IF NOT EXISTS posts (
    id SERIAL PRIMARY KEY,
    saint_id INT REFERENCES saints(id),
    account_id INT REFERENCES accounts(id),
    platform VARCHAR(20) NOT NULL,
    post_type VARCHAR(20) NOT NULL,   -- 'daily_feast', 'on_demand'
    video_url TEXT,                   -- rendered MP4 URL
    cover_image_url TEXT,
    caption TEXT,
    hashtags TEXT,
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'processing', 'posted', 'failed'
    scheduled_for TIMESTAMP,
    posted_at TIMESTAMP,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 4. Assets table (store generated assets)
CREATE TABLE IF NOT EXISTS assets (
    id SERIAL PRIMARY KEY,
    saint_id INT REFERENCES saints(id),
    asset_type VARCHAR(50) NOT NULL,  -- 'character_sheet', 'scene_image', 'video_clip', 'voiceover', 'music'
    file_url TEXT NOT NULL,
    file_size BIGINT,
    metadata JSONB,                   -- model used, prompt, cost, etc.
    created_at TIMESTAMP DEFAULT NOW()
);

-- 5. Settings table (bot configuration)
CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW()
);
