import { db } from '../db/index.js';
import type { SaintRecord } from './sanctusFetcher.js';
import { OfficialCelebration, coreTokens, sameCelebration, likelySameCelebration, shortName } from './romanCalendar.js';

/** SQL ORDER BY that puts canonized saints before blesseds (a "Bl." is not a saint yet). */
export const CANONIZED_FIRST = `(name ~* '^(bl\\.|blessed|beato|beata)\\M') ASC`;

/** A martyrology entry that is a canonized saint ("San …", "Santa …", "Santos …"), not a "Beato". */
export const isCanonizedSpanish = (name: string) => /^(san|santa|santo|santos|santas)\b/i.test(name.trim());

/** True when a stored row was checked against a Catholic source (seeded/enriched or from the official calendar). */
export const isVerifiedRow = (row: { feast_month?: number; enriched?: boolean }) => (row.feast_month ?? 0) > 0 || row.enriched === true;

const ensureCacheColumns = async () => {
  for (const col of ['dossier JSONB', 'facts TEXT', 'appearance TEXT']) await db.query(`ALTER TABLE saints ADD COLUMN IF NOT EXISTS ${col}`);
};

const EVENT_WORDS = /\b(conversion|chair|dedication|presentation|nativity|passion|annunciation|visitation|transfiguration|exaltation|assumption|commemoration|queenship)\b/gi;
const peopleCount = (name: string) => shortName(name).split(/,|\band\b/i).filter(t => t.trim()).length;
const eventsIn = (name: string) => new Set((name.match(EVENT_WORDS) || []).map(w => w.toLowerCase()));

/**
 * Should a stored name give way to the official one? Only when the official celebration names more people
 * ("St. Paul" -> "Sts. Peter and Paul") or an event the stored name lacks ("St. Paul the Apostle" -> "The Conversion
 * of St. Paul"). A clearer stored name of the same saint is kept ("St. Anthony the Abbot", not just "St. Anthony").
 */
export function officialAddsSomething(official: string, stored: string): boolean {
  const have = eventsIn(stored);
  return peopleCount(official) > peopleCount(stored) || [...eventsIn(official)].some(w => !have.has(w));
}

interface RowLike { name: string; feast_month: number; feast_day: number }

/**
 * Which stored row is this official celebration? Only the same name, or a row on the same date (undated rows for
 * movable feasts): "St. Joseph Cafasso" (23 June) must never become "St. Joseph". rename = use the official name.
 */
export function matchOfficialRow<R extends RowLike>(o: OfficialCelebration, rows: R[]): { row: R; rename: boolean } | null {
  const sameSlot = (r: R) => (o.fixedDate ? r.feast_month === o.fixedDate.month && r.feast_day === o.fixedDate.day : r.feast_month === 0);
  const exact = rows.find(r => r.name === o.name);
  if (exact) return { row: exact, rename: false };
  const contains = rows.find(r => sameSlot(r) && sameCelebration(o.name, r.name));
  if (contains) return { row: contains, rename: officialAddsSomething(o.name, contains.name) };
  const similar = rows.find(r => sameSlot(r) && likelySameCelebration(o.name, r.name));
  return similar ? { row: similar, rename: officialAddsSomething(o.name, similar.name) } : null;
}

const asRecord = (o: OfficialCelebration): SaintRecord => ({
  name: o.name,
  feast_month: o.fixedDate?.month ?? 0,
  feast_day: o.fixedDate?.day ?? 0,
  rank: o.rank,
  liturgical_color: o.color,
  patronage: '',
  short_description: `${o.fullName}: ${o.rank} in the General Roman Calendar of the Catholic Church.`,
});

/**
 * The saints-table row for an official celebration: an existing row of the same celebration (kept, so its face photo
 * stays) given the official name, rank and colour, or a new row. When the name changes, the cached research is cleared
 * so the next video is researched for the right subject ("St. Paul" -> "The Conversion of St. Paul").
 * Movable celebrations are stored without a date (0/0) so they never come back as some later year's date match.
 */
export async function resolveOfficialRow(o: OfficialCelebration): Promise<SaintRecord> {
  try {
    const tokens = coreTokens(o.name);
    const res = await db.query(
      `SELECT * FROM saints WHERE (feast_month = $1 AND feast_day = $2) OR name ILIKE ANY($3) ORDER BY enriched DESC NULLS LAST, id LIMIT 60`,
      [o.fixedDate?.month ?? -1, o.fixedDate?.day ?? -1, tokens.map(t => `%${t}%`)]
    );
    const match = matchOfficialRow(o, res.rows);
    if (match && !match.rename) {
      await db.query(`UPDATE saints SET rank = $2, liturgical_color = $3 WHERE id = $1`, [match.row.id, o.rank, o.color]);
      return { ...match.row, rank: o.rank, liturgical_color: o.color };
    }
    if (match) {
      await ensureCacheColumns();
      const upd = await db.query(
        `UPDATE saints SET name = $2, rank = $3, liturgical_color = $4, dossier = NULL, facts = NULL, appearance = NULL WHERE id = $1 RETURNING *`,
        [match.row.id, o.name, o.rank, o.color]
      );
      console.log(`✏️ Saints table: "${match.row.name}" is now "${o.name}" (${o.rank}), as in the General Roman Calendar.`);
      return upd.rows[0];
    }
    const r = asRecord(o);
    const ins = await db.query(
      `INSERT INTO saints (name, feast_month, feast_day, rank, liturgical_color, patronage, short_description, enriched)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE) RETURNING *`,
      [r.name, r.feast_month, r.feast_day, r.rank, r.liturgical_color, r.patronage, r.short_description]
    );
    console.log(`💾 Added "${r.name}" (${r.rank}) from the General Roman Calendar to the saints table.`);
    return ins.rows[0];
  } catch (e: any) {
    console.warn('⚠️ Could not store the official celebration (using it without the database):', e.message);
    return asRecord(o);
  }
}
