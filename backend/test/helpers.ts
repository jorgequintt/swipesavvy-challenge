import pg from 'pg';
import { createApp } from '../src/app';
import { createPool } from '../src/db';
import { TEST_DATABASE_URL } from './env';

export function setupTestApp() {
  const pool: pg.Pool = createPool(TEST_DATABASE_URL);
  const app = createApp({ pool, color: 'test', version: 'test' });
  return { pool, app };
}

export async function resetDb(pool: pg.Pool) {
  await pool.query('TRUNCATE refunds, payments, orders');
}