import axios from 'axios';
import Sanctus from 'sanctus';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SaintRecord {
  id?: number;
  name: string;
  feast_month: number;
  feast_day: number;
  rank: string;
  liturgical_color: string;
  patronage: string;
  short_description: string;
  full_story?: string;
  what_we_learn?: string[];
  did_you_know?: string;
  character_sheet_url?: string;
  era?: string;
  region?: string;
  symbols?: string[];
  appearance?: string; // how to draw the saint consistently (age, gender, hair, period clothing)
}

export class SaintFetcherService {
  private sanctus: Sanctus;

  constructor() {
    this.sanctus = new Sanctus();
  }

  /**
   * Fetch saint for a specific date using 3-tier priority logic:
   * 1. Sanctus npm package
   * 2. Liturgical Calendar API
   * 3. Neon DB / Curated JSON fallback
   */
  async getSaintForDate(date: Date = new Date()): Promise<SaintRecord> {
    const month = date.getMonth() + 1; // 1-12
    const day = date.getDate();       // 1-31

    console.log(`🔍 Fetching Saint of the Day for Month: ${month}, Day: ${day}...`);

    // Tier 0: Neon DB (seeded for all 366 days, enriched to structured English)
    try {
      const res = await db.query(
        `SELECT * FROM saints WHERE feast_month = $1 AND feast_day = $2 ORDER BY enriched DESC, id LIMIT 1`,
        [month, day]
      );
      if (res.rows.length > 0) {
        console.log(`✅ Tier 0 (Neon DB) matched: ${res.rows[0].name}`);
        return res.rows[0];
      }
    } catch (dbErr: any) {
      console.warn('⚠️ Neon DB lookup skipped/error:', dbErr.message);
    }

    // Tier 1: Sanctus NPM Package (note: its month argument is 0-based, so use getSaint(date))
    try {
      const sanctusSaint: any = this.sanctus.getSaint(date);
      if (sanctusSaint && sanctusSaint.name) {
        console.log(`✅ Tier 1 (Sanctus package) matched: ${sanctusSaint.name}`);
        return {
          name: sanctusSaint.name,
          feast_month: month,
          feast_day: day,
          rank: sanctusSaint.category || 'Memorial',
          liturgical_color: 'White',
          patronage: 'Universal Church',
          short_description: sanctusSaint.shortDescription || sanctusSaint.description || `Feast of ${sanctusSaint.name}`,
          full_story: sanctusSaint.description || sanctusSaint.shortDescription || '',
          era: 'Christian Era',
          region: 'Universal',
          symbols: ['cross', 'book'],
        };
      }
    } catch (err: any) {
      console.warn('⚠️ Tier 1 Sanctus package fetch warning:', err.message);
    }

    // Tier 2: Liturgical Calendar API (calapi.inadiutorium.cz)
    try {
      const year = date.getFullYear();
      const response = await axios.get(
        `http://calapi.inadiutorium.cz/api/v1/calendars/general-en/${year}/${month}/${day}`,
        { timeout: 5000 }
      );
      if (response.data && response.data.celebrations && response.data.celebrations.length > 0) {
        const celeb = response.data.celebrations[0];
        console.log(`✅ Tier 2 (Liturgical Calendar API) matched: ${celeb.title}`);
        return {
          name: celeb.title,
          feast_month: month,
          feast_day: day,
          rank: celeb.rank || 'Memorial',
          liturgical_color: celeb.colour || 'White',
          patronage: 'Universal Church',
          short_description: `Today the Church celebrates ${celeb.title}.`,
          era: 'Christian Era',
          region: 'Universal',
          symbols: ['cross'],
        };
      }
    } catch (err: any) {
      console.warn('⚠️ Tier 2 Liturgical Calendar API error:', err.message);
    }

    // Tier 3: Neon DB / Local JSON Fallback
    try {
      const res = await db.query(
        `SELECT * FROM saints WHERE feast_month = $1 AND feast_day = $2 LIMIT 1`,
        [month, day]
      );
      if (res.rows.length > 0) {
        console.log(`✅ Tier 3 (Neon DB) matched: ${res.rows[0].name}`);
        return res.rows[0];
      }
    } catch (dbErr: any) {
      console.warn('⚠️ Neon DB lookup skipped/error:', dbErr.message);
    }

    // Local saints.json file lookup fallback
    try {
      const jsonPath = path.join(__dirname, 'saints.json');
      if (fs.existsSync(jsonPath)) {
        const raw = fs.readFileSync(jsonPath, 'utf8');
        const list: SaintRecord[] = JSON.parse(raw);
        const match = list.find(s => s.feast_month === month && s.feast_day === day);
        if (match) {
          console.log(`✅ Tier 3 (Local JSON fallback) matched: ${match.name}`);
          return match;
        }
      }
    } catch (jsonErr: any) {
      console.warn('⚠️ Local JSON lookup error:', jsonErr.message);
    }

    // Default fallback if no date match
    console.log('ℹ️ No specific feast found for today. Returning default Marian fallback.');
    return {
      name: 'Mary, Mother of God',
      feast_month: month,
      feast_day: day,
      rank: 'Memorial',
      liturgical_color: 'White',
      patronage: 'Mothers, Universal Church',
      short_description: 'Our Lady, Holy Mother of God',
      full_story: 'Mary is the beloved mother of Jesus Christ and patron of the Church.',
      what_we_learn: ['Pray with faith.', 'Trust God\'s promise.', 'Love your neighbor.'],
      did_you_know: 'Mary\'s fiat opened salvation history.',
      era: 'Apostolic Era',
      region: 'Nazareth',
      symbols: ['rosary', "crown of stars"],
    };
  }

  /**
   * Search saint by name (for on-demand /saint command)
   */
  async getSaintByName(name: string): Promise<SaintRecord> {
    console.log(`🔍 Searching for saint by name: "${name}"...`);

    // Check DB
    try {
      const res = await db.query(
        `SELECT * FROM saints WHERE name ILIKE $1 LIMIT 1`,
        [`%${name}%`]
      );
      if (res.rows.length > 0) {
        return res.rows[0];
      }
    } catch (e) {}

    // Check local json
    try {
      const jsonPath = path.join(__dirname, 'saints.json');
      if (fs.existsSync(jsonPath)) {
        const raw = fs.readFileSync(jsonPath, 'utf8');
        const list: SaintRecord[] = JSON.parse(raw);
        const match = list.find(s => s.name.toLowerCase().includes(name.toLowerCase()));
        if (match) return match;
      }
    } catch (e) {}

    // Return dynamically constructed record for unknown saints
    return {
      name: name,
      feast_month: new Date().getMonth() + 1,
      feast_day: new Date().getDate(),
      rank: 'Memorial',
      liturgical_color: 'White',
      patronage: 'Faithful Christian Community',
      short_description: `Holy Servant of God, ${name}`,
      full_story: `${name} lived a faithful life dedicated to God and neighbor.`,
      era: '',
      region: '',
      symbols: ['cross', 'halo'],
    };
  }
}
