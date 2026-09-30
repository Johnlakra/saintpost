import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Sanctus from 'sanctus';
import { db, pool } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function seedSaints() {
  console.log('🌱 Seeding Saints database...');
  try {
    const jsonPath = path.join(__dirname, '..', 'data', 'saints.json');
    const rawData = fs.readFileSync(jsonPath, 'utf8');
    const saints = JSON.parse(rawData);

    for (const saint of saints) {
      await db.query(
        `INSERT INTO saints (
          name, feast_month, feast_day, rank, liturgical_color, patronage,
          short_description, full_story, what_we_learn, did_you_know, era, region, symbols
        )
        SELECT $1::varchar, $2::int, $3::int, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12, $13::text[]
        WHERE NOT EXISTS (SELECT 1 FROM saints WHERE name = $1::varchar AND feast_month = $2::int AND feast_day = $3::int)`,
        [
          saint.name,
          saint.month,
          saint.day,
          saint.rank,
          saint.color,
          Array.isArray(saint.patronage) ? saint.patronage.join(', ') : saint.patronage,
          saint.shortDescription,
          saint.fullStory,
          saint.whatWeLearn,
          saint.didYouKnow,
          saint.era,
          saint.region,
          saint.symbols,
        ]
      );
    }
    console.log(`✅ Seeded ${saints.length} curated saints into Neon database.`);

    // One primary saint for EVERY day of the year (366) from the sanctus dataset.
    // Curated entries above win for their dates. Text is Spanish; run `npm run db:enrich` to translate/structure it.
    await db.query(`ALTER TABLE saints ADD COLUMN IF NOT EXISTS source_text TEXT`);
    await db.query(`ALTER TABLE saints ADD COLUMN IF NOT EXISTS enriched BOOLEAN DEFAULT FALSE`);
    await db.query(`UPDATE saints SET enriched = TRUE WHERE full_story IS NOT NULL AND source_text IS NULL`);
    const sanctus = new Sanctus();
    const ranks = ['Solemnity', 'Memorial', 'Optional Memorial'];
    let added = 0;
    for (let i = 0; i < 366; i++) {
      const dt = new Date(2024, 0, 1 + i); // leap year so Feb 29 is included
      const month = dt.getMonth() + 1, day = dt.getDate();
      const exists = await db.query(`SELECT 1 FROM saints WHERE feast_month = $1 AND feast_day = $2 LIMIT 1`, [month, day]);
      if (exists.rows.length) continue;
      const list = sanctus.getSaintsOfDay(dt);
      if (!list.length) continue;
      const primary = [...list].sort((a: any, b: any) => (a.category ?? 9) - (b.category ?? 9))[0] as any;
      await db.query(
        `INSERT INTO saints (name, feast_month, feast_day, rank, short_description, source_text, enriched)
         VALUES ($1, $2, $3, $4, $5, $6, FALSE)`,
        [primary.name, month, day, ranks[primary.category] || 'Memorial', primary.shortDescription || primary.description || '', [primary.description, primary.birth, primary.dead].filter(Boolean).join('\n')]
      );
      added++;
    }
    const total = await db.query(`SELECT count(*)::int AS n, count(DISTINCT (feast_month, feast_day))::int AS days FROM saints`);
    console.log(`✅ Added ${added} saints from sanctus. Table now has ${total.rows[0].n} saints covering ${total.rows[0].days}/366 days.`);
  } catch (error) {
    console.error('❌ Seeding failed:', error);
  } finally {
    await pool.end();
  }
}

seedSaints();
