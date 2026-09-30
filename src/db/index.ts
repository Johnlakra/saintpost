import { Pool } from 'pg';
import { config } from '../config/env.js';

// PostgreSQL Connection Pool for Neon Serverless DB
export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
});

export const db = {
  query: (text: string, params?: any[]) => pool.query(text, params),
  getClient: () => pool.connect(),
};
