import path from 'node:path';
import pg from 'pg';
import { migrate } from '../src/migrate.js';
import { TEST_DATABASE_URL } from './env.js';

export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);

  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();

  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
  } catch (error) {
    if ((error as { code?: string }).code !== '42P04') throw error; // if error 42P04, db already exist
  } finally {
    await admin.end();
  }

  await migrate(
    TEST_DATABASE_URL,
    path.resolve(process.env.MIGRATIONS_DIR ?? '../db/migrations'),
  );
}
