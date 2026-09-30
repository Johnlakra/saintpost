import * as SanscriptNs from '@indic-transliteration/sanscript';
const Sanscript: any = (SanscriptNs as any).default ?? SanscriptNs;

/**
 * Rule-based Devanagari/Gurmukhi -> Roman (Hinglish/Pinglish-style). Only a FALLBACK for when the LLM
 * is unavailable: it is readable but less natural than LLM-written Hinglish/Pinglish.
 */
export function romanizeFallback(text: string, lang: 'hi' | 'pa'): string {
  const itrans = Sanscript.t(text, lang === 'hi' ? 'devanagari' : 'gurmukhi', 'itrans');
  return itrans
    .replace(/\.n|M|\.m|~N|N\^/g, 'n')
    .replace(/A/g, 'aa').replace(/ii|I/g, 'ee').replace(/uu|U/g, 'oo')
    .replace(/RRi|R\^i/g, 'ri').replace(/Sh|sh/g, 'sh').replace(/Ch/g, 'chh').replace(/ch/g, 'ch')
    .replace(/T/g, 't').replace(/D/g, 'd').replace(/N/g, 'n')
    .replace(/(?<=[bcdfghjklmnpqrstvwxyz])a(?=[\s.,!?;:]|$)/g, '') // drop word-final schwa: "sevaa" stays, "jeevana" -> "jeevan"
    .replace(/\|\|?/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}
