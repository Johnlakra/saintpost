import { Romcal } from 'romcal';
import { GeneralRoman_En } from '@romcal/calendar.general-roman';

/**
 * The General Roman Calendar of the Roman Catholic Church (romcal, computed offline), so "Today's Feast" is the
 * Church's own celebration of the day, not just any name from a martyrology list.
 */
export type OfficialRank = 'Solemnity' | 'Feast' | 'Memorial' | 'Optional Memorial';

export interface OfficialCelebration {
  id: string;
  /** e.g. "St. Robert Bellarmine" (titles such as ", Bishop and Doctor of the Church" dropped) */
  name: string;
  fullName: string;
  rank: OfficialRank;
  color: string;
  /** the fixed calendar date, or null for movable celebrations (Easter, Pentecost, Sacred Heart…) */
  fixedDate: { month: number; day: number } | null;
}

/** romcal-like shape this module needs (kept small so the selection rules can be unit tested). */
export interface CalendarEntry {
  id: string;
  name: string;
  rank: string;
  colors?: string[];
  dateDef?: { month?: number; date?: number; dateFn?: string };
}

const RANKS: Record<string, OfficialRank> = { SOLEMNITY: 'Solemnity', FEAST: 'Feast', MEMORIAL: 'Memorial', OPTIONAL_MEMORIAL: 'Optional Memorial' };
const RANK_ORDER: OfficialRank[] = ['Solemnity', 'Feast', 'Memorial', 'Optional Memorial'];

/** Celebrations romcal computes by function although their date never changes. */
const FIXED_FN_DATES: Record<string, [number, number]> = {
  maryMotherOfGod: [1, 1], epiphany: [1, 6], presentationOfTheLord: [2, 2], annunciation: [3, 25],
  nativityOfJohnTheBaptist: [6, 24], peterAndPaulApostles: [6, 29], transfiguration: [8, 6], assumption: [8, 15],
  exaltationOfTheHolyCross: [9, 14], allSaints: [11, 1], immaculateConceptionOfMary: [12, 8], christmas: [12, 25],
};

/** Words that make up a title segment such as ", Bishop and Doctor of the Church" or ", the First Martyr". */
const TITLE_VOCAB = new Set(('pope popes bishop bishops priest priests deacon virgin virgins martyr martyrs abbot abbess doctor doctors ' +
  'religious hermit monk missionary missionaries apostle apostles evangelist archangels spouse parents founder layman laywoman ' +
  'married couple disciples queen widow mystic and of the church first blessed mary lord').split(' '));
const isTitleSegment = (seg: string) => seg.toLowerCase().split(/\s+/).every(w => TITLE_VOCAB.has(w.replace(/[^a-z]/g, '')));

/**
 * "Saint Robert Bellarmine, Bishop and Doctor of the Church" -> "St. Robert Bellarmine";
 * "Saints Pontian, Pope, and Hippolytus, Priest, Martyrs" -> "Sts. Pontian and Hippolytus" (only title segments go).
 */
export function shortName(full: string): string {
  const main = full.includes(': ') ? full.slice(full.lastIndexOf(': ') + 2) : full; // "The Octave Day…: Solemnity of Mary…"
  const segs = main.split(',').map(t => t.trim()).filter(Boolean);
  const kept = segs.filter((seg, i) => i === 0 || !isTitleSegment(seg));
  const joined = kept.reduce((acc, seg, i) => (i === 0 ? seg : /^and\s/i.test(seg) ? `${acc} ${seg}` : `${acc}, ${seg}`), '');
  return joined.replace(/^Saints\b/, 'Sts.').replace(/^Saint\b/, 'St.').replace(/\bSaint\b/g, 'St.').trim();
}

export function fixedDateOf(e: CalendarEntry): { month: number; day: number } | null {
  if (e.dateDef?.month && e.dateDef?.date) return { month: e.dateDef.month, day: e.dateDef.date };
  const f = e.dateDef?.dateFn ? FIXED_FN_DATES[e.dateDef.dateFn] : undefined;
  return f ? { month: f[0], day: f[1] } : null;
}

const toOfficial = (e: CalendarEntry): OfficialCelebration => ({
  id: e.id,
  name: shortName(e.name),
  fullName: e.name,
  rank: RANKS[e.rank],
  color: e.colors?.[0] ? e.colors[0][0] + e.colors[0].slice(1).toLowerCase() : 'White',
  fixedDate: fixedDateOf(e),
});

/** The highest-ranked solemnity / feast / memorial in the list (Sundays and weekdays are not saints' days). */
export function pickCelebration(entries: CalendarEntry[]): OfficialCelebration | null {
  const ranked = entries.filter(e => RANKS[e.rank]);
  if (!ranked.length) return null;
  const best = [...ranked].sort((a, b) => RANK_ORDER.indexOf(RANKS[a.rank]) - RANK_ORDER.indexOf(RANKS[b.rank]))[0];
  return toOfficial(best);
}

// ---- romcal (cached: one calendar per year, definitions once) ----
const romcal = new Romcal({ localizedCalendar: GeneralRoman_En });
const years = new Map<number, Promise<Record<string, CalendarEntry[]>>>();
let definitions: Promise<CalendarEntry[]> | null = null;

const calendarFor = (year: number) => {
  if (!years.has(year)) years.set(year, romcal.generateCalendar(year) as unknown as Promise<Record<string, CalendarEntry[]>>);
  return years.get(year)!;
};
const allDefinitions = () => (definitions ??= romcal.getAllDefinitions().then(d => Object.values(d) as unknown as CalendarEntry[]));
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The fixed-date celebration of a calendar day, whatever weekday it falls on this year. */
export async function fixedCelebration(month: number, day: number): Promise<OfficialCelebration | null> {
  const defs = await allDefinitions();
  return pickCelebration(defs.filter(e => { const f = fixedDateOf(e); return f?.month === month && f.day === day; }));
}

/**
 * The Church's celebration for this date: the day's solemnity / feast / memorial, or, when a Sunday or a season
 * outranks it this year, the saint fixed on this date (so St. Francis is still the saint of 4 October on a Sunday).
 * null = no celebration in the General Roman Calendar (an ordinary weekday).
 */
export async function officialCelebration(date: Date): Promise<OfficialCelebration | null> {
  const day = (await calendarFor(date.getFullYear()))[ymd(date)] || [];
  return pickCelebration(day) ?? fixedCelebration(date.getMonth() + 1, date.getDate());
}

/** Words that identify a celebration (titles and filler removed). */
export function coreTokens(name: string): string[] {
  const stop = new Set(['saint', 'saints', 'st', 'sts', 'pope', 'blessed', 'bl', 'the', 'of', 'and', 'our', 'lady', 'holy', 'virgin', 'mary']);
  return [...new Set(shortName(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z]+/).filter(w => w.length >= 3 && !stop.has(w)))];
}

/**
 * For two names on the SAME date: clearly the same celebration under another name ("St. Thérèse of Lisieux" ~
 * "St. Thérèse of the Child Jesus", "St. Pio of Pietrelcina (Padre Pio)" ~ "St. Pius of Pietrelcina").
 */
export function likelySameCelebration(official: string, other: string): boolean {
  const a = coreTokens(official);
  const b = new Set(coreTokens(other));
  const shared = a.filter(w => b.has(w));
  return shared.some(w => w.length >= 4) && shared.length * 2 >= Math.min(a.length, b.size);
}

/** Every identifying word of the official name appears in the other name ("Francis of Assisi" ~ "St. Francis of Assisi"). */
export function sameCelebration(official: string, other: string): boolean {
  const want = coreTokens(official);
  const have = new Set(coreTokens(other));
  return want.length > 0 && want.every(w => have.has(w));
}

/** A celebration of the General Roman Calendar whose name matches what the admin typed. */
export async function findOfficialByName(typed: string): Promise<OfficialCelebration | null> {
  if (!coreTokens(typed).length) return null;
  const defs = await allDefinitions();
  const hits = defs.filter(e => RANKS[e.rank] && sameCelebration(typed, e.name));
  return hits.length === 1 ? toOfficial(hits[0]) : null; // ambiguous ("John") is not a match
}
