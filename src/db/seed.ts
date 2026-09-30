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
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT DO NOTHING`,
        [
          saint.name,
          saint.month,
          saint.day,
          saint.rank,
          saint.color,
          saint.patronage,
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
