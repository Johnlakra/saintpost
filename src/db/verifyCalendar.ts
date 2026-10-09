import Sanctus from 'sanctus';
import { db, pool } from './index.js';
import { fixedCelebration } from '../data/romanCalendar.js';
import { resolveOfficialRow, matchOfficialRow, CANONIZED_FIRST, isCanonizedSpanish } from '../data/saintRows.js';

/**
 * Checks the saints table against the Roman Catholic Church's calendar for all 366 days.
 *   npm run db:verify-calendar            report only (read-only)
 *   npm run db:verify-calendar -- --apply also fix the table, then run `npm run db:enrich` for new martyrology rows
 *
 * - days with a celebration in the General Roman Calendar must have that celebration's row (right rank and colour);
 * - other days fall back to the Roman Martyrology and must offer a canonized saint, not only a Blessed.
 */
const LEAP_YEAR = 2024; // so 29 February is checked too
const BLESSED = /^(bl\.|blessed)\s/i;

interface DayResult { date: string; status: 'ok' | 'missing-official' | 'blessed-only' | 'empty'; detail: string }

async function checkDay(month: number, day: number, apply: boolean, sanctus: Sanctus): Promise<DayResult> {
  const date = `${month}/${day}`;
  const rows = (await db.query(`SELECT id, name, rank, enriched, feast_month, feast_day FROM saints WHERE feast_month = $1 AND feast_day = $2 ORDER BY ${CANONIZED_FIRST}, enriched DESC, id`, [month, day])).rows;
  const official = await fixedCelebration(month, day);
  if (official) {
    const match = matchOfficialRow(official, rows);
    if (match && !match.rename && match.row.rank === official.rank) return { date, status: 'ok', detail: `${match.row.name} [${official.rank}]` };
    const fixed = apply ? await resolveOfficialRow(official) : null; // corrects/renames the matching row, or adds one
    const plan = !match ? `add "${official.name}" (table shows: ${rows.map(r => r.name).join(' | ') || 'nothing'})`
      : match.rename ? `rename "${match.row.name}" -> "${official.name}"`
      : `"${match.row.name}": rank ${match.row.rank} -> ${official.rank}`;
    return { date, status: 'missing-official', detail: `[${official.rank}] ${plan}${fixed ? ' ✓' : ''}` };
  }
  if (rows[0] && !BLESSED.test(rows[0].name)) return { date, status: 'ok', detail: `${rows[0].name} (Roman Martyrology)` };
  const canonized = (sanctus.getSaintsOfDay(new Date(LEAP_YEAR, month - 1, day)) as any[]).find(s => isCanonizedSpanish(String(s.name || '')));
  if (apply && canonized) {
    await db.query(
      `INSERT INTO saints (name, feast_month, feast_day, rank, short_description, source_text, enriched) VALUES ($1, $2, $3, 'Memorial', $4, $5, FALSE)`,
      [canonized.name, month, day, canonized.shortDescription || canonized.description || '', [canonized.description, canonized.birth, canonized.dead].filter(Boolean).join('\n')]
    );
  }
  const fix = canonized ? `canonized saint available: ${canonized.name}` : 'no canonized saint in the martyrology for this day';
  return rows[0]
    ? { date, status: 'blessed-only', detail: `${rows[0].name}; ${fix}` }
    : { date, status: 'empty', detail: fix };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const sanctus = new Sanctus();
  const results: DayResult[] = [];
  for (let i = 0; i < 366; i++) {
    const d = new Date(LEAP_YEAR, 0, 1 + i);
    results.push(await checkDay(d.getMonth() + 1, d.getDate(), apply, sanctus));
  }
  const bad = results.filter(r => r.status !== 'ok');
  for (const r of bad) console.log(`${r.status.padEnd(16)} ${r.date.padEnd(6)} ${r.detail}`);
  const count = (s: DayResult['status']) => results.filter(r => r.status === s).length;
  console.log(`\n${count('ok')}/366 days OK · ${count('missing-official')} missing/wrong official celebration · ${count('blessed-only')} only a Blessed · ${count('empty')} empty`);
  console.log(apply
    ? '✅ Fixed. New Roman Martyrology rows are in Spanish until you run `npm run db:enrich`.'
    : 'Report only, nothing changed. Run with -- --apply to fix the table.');
}

main()
  .catch(e => { console.error('❌ Calendar verification failed:', e); process.exitCode = 1; })
  .finally(() => pool.end());
