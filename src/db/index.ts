import { Pool } from 'pg';
import { config } from '../config/env.js';

// PostgreSQL Connection Pool for Neon Serverless DB
export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
  idleTimeoutMillis: 30_000, // drop idle clients before Neon's pooler closes them on us
  keepAlive: true,
});

// Neon closes idle connections server-side. The pool discards the dead client and reconnects on the next
// query; without this listener the 'error' event would surface as an uncaught exception.
pool.on('error', err => console.warn(`⚠️ Idle DB connection dropped (${err.message}); will reconnect on next query.`));

export const db = {
  query: (text: string, params?: any[]) => pool.query(text, params),
  getClient: () => pool.connect(),
};
