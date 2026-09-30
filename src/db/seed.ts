import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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
    console.log(`✅ Seeded ${saints.length} saints into Neon database.`);
  } catch (error) {
    console.error('❌ Seeding failed:', error);
  } finally {
    await pool.end();
  }
}

seedSaints();
