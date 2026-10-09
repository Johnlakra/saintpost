import Sanctus from 'sanctus';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../db/index.js';
import { officialCelebration, findOfficialByName } from './romanCalendar.js';
import { resolveOfficialRow, CANONIZED_FIRST, isCanonizedSpanish, isVerifiedRow } from './saintRows.js';
import { verifyCatholicSaint, refusalMessage } from '../services/saintVerifier.js';

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
  facts?: string; // documented biography used to ground all generated content
  reference_image_url?: string; // documented photo/portrait used as the face reference
  dossier?: any; // cached fact sheet + casting sheet (see LLMService.getDossier)
  appearance?: string; // how to draw the saint consistently (age, gender, hair, period clothing)
}

export class SaintFetcherService {
  private sanctus: Sanctus;

  constructor() {
    this.sanctus = new Sanctus();
  }

  /**
   * The saint (or feast) of a date, Roman Catholic sources only:
   * 0. the General Roman Calendar: the day's solemnity / feast / memorial (or the saint fixed on this date when a
   *    Sunday or season outranks it this year)
   * 1. on days without one: the Roman Martyrology saint of the day from Neon DB, canonized saints before blesseds
   * 2. the Roman Martyrology itself (sanctus package), canonized saints first
   * 3. curated JSON, then Mary, Mother of God
   */
  async getSaintForDate(date: Date = new Date()): Promise<SaintRecord> {
    const month = date.getMonth() + 1; // 1-12
    const day = date.getDate();       // 1-31

    console.log(`🔍 Fetching Saint of the Day for Month: ${month}, Day: ${day}...`);

    // Tier 0: the Church's own calendar
    try {
      const official = await officialCelebration(date);
      if (official) {
        console.log(`✅ Tier 0 (General Roman Calendar): ${official.fullName} [${official.rank}]`);
        return await resolveOfficialRow(official);
      }
      console.log('ℹ️ No celebration in the General Roman Calendar on this date: using the Roman Martyrology (canonized saints first).');
    } catch (err: any) {
      console.warn('⚠️ General Roman Calendar lookup failed:', err.message);
    }

    // Tier 1: Neon DB (Roman Martyrology, enriched to structured English), canonized saints before blesseds
    let blessed: SaintRecord | null = null;
    try {
      const res = await db.query(
        `SELECT * FROM saints WHERE feast_month = $1 AND feast_day = $2 ORDER BY ${CANONIZED_FIRST}, enriched DESC, id LIMIT 1`,
        [month, day]
      );
      const row = res.rows[0];
      if (row && !/^(bl\.|blessed)\b/i.test(row.name)) {
        console.log(`✅ Tier 1 (Neon DB, Roman Martyrology) matched: ${row.name}`);
        return row;
      }
      blessed = row || null;
    } catch (dbErr: any) {
      console.warn('⚠️ Neon DB lookup skipped/error:', dbErr.message);
    }

    // Tier 2: Roman Martyrology (sanctus package; its month argument is 0-based, so use getSaintsOfDay(date))
    try {
      const list: any[] = this.sanctus.getSaintsOfDay(date) || [];
      const sanctusSaint = list.find(s => isCanonizedSpanish(String(s.name || ''))) || (blessed ? null : list[0]);
      if (sanctusSaint && sanctusSaint.name) {
        console.log(`✅ Tier 2 (Roman Martyrology, sanctus) matched: ${sanctusSaint.name}`);
        return {
          name: sanctusSaint.name,
          feast_month: month,
          feast_day: day,
          rank: 'Memorial',
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
      console.warn('⚠️ Tier 2 Sanctus package fetch warning:', err.message);
    }
    if (blessed) {
      console.warn(`⚠️ Only a Blessed is listed for ${month}/${day}: ${blessed.name}. Run \`npm run db:verify-calendar\`.`);
      return blessed;
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

    // Check DB: exact-ish match first (only rows that came from a Catholic source; a face-photo row alone is not proof)
    let unverified: SaintRecord | null = null;
    try {
      const res = await db.query(`SELECT * FROM saints WHERE name ILIKE $1 ORDER BY enriched DESC NULLS LAST, id LIMIT 5`, [`%${name}%`]);
      const verified = res.rows.find(isVerifiedRow);
      if (verified) return verified;
      unverified = res.rows[0] || null;
    } catch (e) {}

    // The General Roman Calendar by name ("Hildegard" -> St. Hildegard of Bingen)
    try {
      const official = await findOfficialByName(name);
      if (official) {
        console.log(`🔎 "${name}" is "${official.fullName}" in the General Roman Calendar.`);
        return await resolveOfficialRow(official);
      }
    } catch (e: any) {
      console.warn('⚠️ General Roman Calendar name lookup failed:', e.message);
    }

    // Word-by-word match so "the three archangels" finds "Sts. Michael, Gabriel and Raphael, Archangels"
    // (names are rarely typed exactly as stored)
    try {
      const stop = new Set(['the', 'saint', 'saints', 'feast', 'memorial', 'day', 'and', 'of', 'our', 'holy', 'blessed', 'one', 'two', 'three', 'four', 'five', 'seven', 'twelve', 'great']);
      const words = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z]+/).filter(w => w.length >= 4 && !stop.has(w));
      const stems = [...new Set(words.map(w => w.replace(/(es|s)$/, '')))].filter(w => w.length >= 4);
      if (stems.length) {
        const cand = await db.query(`SELECT * FROM saints WHERE name ILIKE ANY($1) ORDER BY id LIMIT 40`, [stems.map(w => `%${w}%`)]);
        const score = (row: any) => stems.filter(w => String(row.name).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(w)).length;
        const ranked = cand.rows.filter(isVerifiedRow).sort((a, b) => score(b) - score(a) || (b.enriched ? 1 : 0) - (a.enriched ? 1 : 0));
        const best = ranked[0];
        // accept when most typed words matched AND no other saint matches equally well (a common word like "john" must not pick a random one)
        const ambiguous = ranked.length > 1 && score(ranked[1]) === score(best) && ranked[1].name !== best.name;
        if (best && !ambiguous && score(best) >= Math.max(1, Math.ceil(stems.length * 0.6))) {
          console.log(`🔎 "${name}" matched "${best.name}" in the database.`);
          return best;
        }
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

    // Not in any Catholic list we hold: only go ahead for a canonized saint of the Roman Catholic Church
    const check = await verifyCatholicSaint(name);
    if (!check.accepted) throw new Error(refusalMessage(name, check));
    console.log(`✅ "${name}" checked: ${check.officialName} is a canonized Catholic saint (${check.reason || 'no reason given'}).`);
    if (unverified) return unverified; // keeps a face photo saved under this name

    return {
      name: check.officialName,
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
