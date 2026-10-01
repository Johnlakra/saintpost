import { config } from '../config/env.js';

type Sender = (chatId: string, text: string) => Promise<unknown>;
let send: Sender | null = null;

/** Registered once at startup with the Telegram sender. */
export function setNotifier(fn: Sender) {
  send = fn;
}

/** Message every admin (used by unattended jobs such as the daily cron). Never throws. */
export async function notifyAdmins(text: string): Promise<void> {
  if (!send) return console.warn('ℹ️ (no notifier) ' + text);
  for (const id of config.adminIds) {
    try { await send(id, text.slice(0, 3900)); } catch (e: any) { console.warn(`⚠️ Could not notify admin ${id}:`, e.message); }
  }
}
