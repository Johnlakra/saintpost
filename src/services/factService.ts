import axios from 'axios';
import { SaintRecord } from '../data/sanctusFetcher.js';
import { db } from '../db/index.js';

export interface SaintFacts {
  title: string;
  url: string;
  extract: string; // documented biography (Wikipedia intro)
  imageUrl?: string; // documented photo/portrait (Wikipedia lead image), if any
}

const UA = { 'User-Agent': 'SaintPostBot/1.0 (Catholic devotional content; contact via repo)' };
const TITLES = /^(st\\.?|saint|san|santa|santo|bl\\.?|blessed|beato|beata|pope|venerable|ven\\.?|servant of god)\\s+/i;

const normalize = (s: string) =>
  s.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(TITLES, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\\s+/g, ' ').trim();

/** Wikipedia page must actually be about this person: every name token must appear in the title. */
export function titleMatches(name: string, title: string): boolean {
  const want = normalize(name).split(' ').filter(t => t.length > 2 && !['of', 'the', 'and'].includes(t));
  const got = normalize(title);
  return want.length > 0 && want.slice(0, 2).every(t => got.includes(t));
}

export class FactService {
  /** Facts + reference image for a saint, cached on the saints row (facts, reference_image_url). */
  async ensureFacts(saint: SaintRecord): Promise<SaintRecord> {
    await db.query(`ALTER TABLE saints ADD COLUMN IF NOT EXISTS facts TEXT`).catch(() => {});
    await db.query(`ALTER TABLE saints ADD COLUMN IF NOT EXISTS reference_image_url TEXT`).catch(() => {});
    if (saint.id) {
      const r = await db.query(`SELECT facts, reference_image_url, appearance FROM saints WHERE id = $1`, [saint.id]).catch(() => null);
      if (r?.rows[0]) {
        const hadFacts = !!r.rows[0].facts;
        saint.facts = r.rows[0].facts || undefined;
        saint.reference_image_url = r.rows[0].reference_image_url || undefined;
        // An appearance saved before facts existed was not grounded in documentation: regenerate it.
        saint.appearance = hadFacts ? r.rows[0].appearance || undefined : undefined;
      }
    }
    if (!saint.facts || !saint.reference_image_url) {
      const found = await this.lookup(saint.name).catch((e: any) => {
        console.warn('⚠️ Fact lookup failed:', e.message);
        return null;
      });
      if (found) {
        console.log(`📚 Facts from ${found.url}${found.imageUrl ? ' (+ reference image)' : ' (no image)'}`);
        saint.facts = saint.facts || found.extract;
        saint.reference_image_url = saint.reference_image_url || found.imageUrl;
        if (saint.id) {
          await db
            .query(`UPDATE saints SET facts = COALESCE(facts, $2), reference_image_url = COALESCE(reference_image_url, $3) WHERE id = $1`, [saint.id, saint.facts, saint.reference_image_url || null])
            .catch(() => {});
        }
      } else {
        console.warn(`⚠️ No documented source found for "${saint.name}" - falling back to database text only.`);
      }
    }
    // Sanctus (Roman Martyrology) text is an acceptable secondary source.
    const src = (saint as any).source_text as string | undefined;
    if (!saint.facts && src) saint.facts = src;
    return saint;
  }

  async lookup(name: string): Promise<SaintFacts | null> {
    const queries = [name, `${name} saint`];
    for (const q of queries) {
      const res = await axios.get('https://en.wikipedia.org/w/api.php', {
        headers: UA,
        timeout: 15000,
        params: {
          action: 'query', format: 'json', generator: 'search', gsrsearch: q, gsrlimit: 3,
          prop: 'extracts|pageimages|info', exintro: 1, explaintext: 1, exchars: 3500,
          piprop: 'thumbnail', pithumbsize: 768, inprop: 'url', redirects: 1,
        },
      });
      const pages: any[] = Object.values(res.data?.query?.pages || {});
      pages.sort((a, b) => (a.index ?? 9) - (b.index ?? 9));
      for (const p of pages) {
        if (!p.extract || !titleMatches(name, p.title)) continue;
        const img: string | undefined = p.thumbnail?.source;
        const okImg = img && /\\.(jpe?g|png|webp)(\\?|$)/i.test(img) ? img : undefined; // skip SVG/maps/coats of arms
        return { title: p.title, url: p.fullurl, extract: String(p.extract).trim(), imageUrl: okImg };
      }
    }
    return null;
  }
}
