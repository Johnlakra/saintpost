/** What the bot is waiting for the admin to type/send next (per Telegram user). */
export type Pending =
  | { kind: 'saint' }
  | { kind: 'date' }
  | { kind: 'ref_name' }
  | { kind: 'ref_photo'; name: string }
  | { kind: 'wm_logo' }
  | { kind: 'wm_text' }
  | { kind: 'wm_custom'; el: 'logo' | 'text' };

const pending = new Map<string, Pending>();
export const getPending = (uid: string) => pending.get(uid);
export const setPending = (uid: string, p: Pending) => void pending.set(uid, p);
export const clearPending = (uid: string) => void pending.delete(uid);
