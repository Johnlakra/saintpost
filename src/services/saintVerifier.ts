import { config } from '../config/env.js';
import { LLMService } from './llmService.js';

/**
 * Last check for a typed name that is in neither the General Roman Calendar nor the saints table: is this a
 * canonized saint of the Roman Catholic Church? Saints venerated only by other churches are refused.
 */
export type SaintStatus = 'saint' | 'blessed' | 'venerable' | 'servant_of_god' | 'not_recognized';

export interface SaintCheck {
  accepted: boolean;
  status: SaintStatus;
  officialName: string;
  reason: string;
}

const STATUSES: SaintStatus[] = ['saint', 'blessed', 'venerable', 'servant_of_god', 'not_recognized'];
const llm = new LLMService();

/** Turns the model's JSON into a decision; anything unexpected counts as not recognized. */
export function toSaintCheck(typed: string, raw: any): SaintCheck {
  const status: SaintStatus = STATUSES.includes(raw?.status) ? raw.status : 'not_recognized';
  return {
    accepted: status === 'saint',
    status,
    officialName: String(raw?.official_name || '').trim() || typed,
    reason: String(raw?.reason || '').trim(),
  };
}

export async function verifyCatholicSaint(typed: string): Promise<SaintCheck> {
  if (config.dryRun) return { accepted: true, status: 'saint', officialName: typed, reason: 'not checked (dry run)' };
  let raw: any;
  try {
    raw = await llm.completeJson(`You are a careful Catholic church historian. Someone typed this name: "${typed}".

Is this person (or these people) a CANONIZED SAINT of the Roman Catholic Church? Count saints of the Latin Church and of the Eastern Catholic Churches in communion with Rome, including saints from before 1054 that the Catholic Church venerates. Do NOT count saints venerated only by the Orthodox, Oriental Orthodox, Anglican, Lutheran or other churches, people the Catholic Church has only beatified or declared Venerable / Servant of God, or anyone not recognized by the Catholic Church.

Respond ONLY with JSON: {"status": "saint" | "blessed" | "venerable" | "servant_of_god" | "not_recognized", "official_name": "the usual English Catholic name, e.g. St. Carlo Acutis", "reason": "one short sentence"}`, 0, 300);
  } catch (e: any) {
    console.error(`❌ Could not verify "${typed}" as a Catholic saint:`, e.message);
    throw new Error(`I could not check right now whether "${typed}" is a saint of the Roman Catholic Church. Please try again in a moment.`);
  }
  return toSaintCheck(typed, raw);
}

/** The message shown when a name is refused. */
export function refusalMessage(typed: string, c: SaintCheck): string {
  const what: Record<SaintStatus, string> = {
    saint: '',
    blessed: 'is a Blessed (beatified), not yet a canonized saint',
    venerable: 'is Venerable, not yet a canonized saint',
    servant_of_god: 'is a Servant of God, not yet a canonized saint',
    not_recognized: 'is not a canonized saint of the Roman Catholic Church',
  };
  return `"${typed}" ${what[c.status]}${c.reason ? ` (${c.reason})` : ''}. I only make videos about saints of the Roman Catholic Church. Check the spelling, or use ✝️ Today's Feast.`;
}
