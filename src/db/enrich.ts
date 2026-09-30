import { db, pool } from './index.js';
import { LLMService } from '../services/llmService.js';

const BATCH = 6;

/**
 * Turns the raw Spanish sanctus rows into structured English records (name, rank, colour, patronage,
 * short description, era, region, symbols). Resumable: only rows with enriched = FALSE are processed.
 * Long-form story / lessons / "did you know" are NOT stored here; they are written fresh at post time.
 */
async function enrich() {
  const llm = new LLMService();
  const { rows } = await db.query(
    `SELECT id, name, feast_month, feast_day, rank, source_text FROM saints WHERE enriched = FALSE ORDER BY feast_month, feast_day`
  );
  console.log(`🧠 ${rows.length} saints to enrich (batches of ${BATCH})...`);
  let done = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const prompt = `You are a careful Catholic church historian. For each saint below (Spanish source data from the Roman Martyrology), return structured ENGLISH data.

Rules:
- Base everything on the provided source text. Do not invent facts. If unsure about a field, use an empty string / empty array.
- "name": the standard English name with title, e.g. "St. Thérèse of Lisieux", "Bl. Frederick Albert", "Pope St. Anicetus".
- "rank": one of Solemnity, Feast, Memorial, Optional Memorial (keep the given rank unless clearly wrong).
- "color": liturgical colour: Red for martyrs/apostles/Holy Spirit, White otherwise, Purple/Green/Rose only if clearly applicable.
- "patronage": comma-separated well-established patronages only, else "".
- "short_description": 1-2 plain English sentences summarising who they were (from the source text).
- "era": one of "Apostolic Era", "Early Church", "Medieval", "Renaissance/Reformation", "Modern".
- "region": country/region of life (e.g. "France"); "" if unknown.
- "symbols": 2-3 traditional iconographic attributes (e.g. "lily", "book"); [] if unsure.

Input (JSON):
${JSON.stringify(batch.map(r => ({ id: r.id, name_es: r.name, rank: r.rank, source: String(r.source_text || '').slice(0, 900) })))}

Respond ONLY with a JSON array, one object per input, with fields: id, name, rank, color, patronage, short_description, era, region, symbols.`;

    try {
      const out: any[] = await llm.completeJson(prompt);
      for (const o of out) {
        if (!o?.id || !o.name) continue;
        await db.query(
          `UPDATE saints SET name=$2, rank=COALESCE(NULLIF($3,''), rank), liturgical_color=$4, patronage=$5,
             short_description=$6, era=$7, region=$8, symbols=$9::text[], enriched=TRUE WHERE id=$1`,
          [o.id, o.name, o.rank, o.color || 'White', o.patronage || '', o.short_description || '', o.era || 'Christian Era', o.region || '', Array.isArray(o.symbols) ? o.symbols : []]
        );
        done++;
      }
      console.log(`   ✓ ${Math.min(i + BATCH, rows.length)}/${rows.length} (enriched so far: ${done})`);
    } catch (e: any) {
      console.warn(`   ✗ batch starting at ${i} failed: ${e.message} - will retry on next run`);
    }
  }
  console.log(`✅ Enriched ${done} saints. Re-run \`npm run db:enrich\` to retry any that failed.`);
}

enrich()
  .catch(e => console.error('❌ Enrichment failed:', e))
  .finally(() => pool.end());
