import path from 'node:path';
import {migrate} from './migrate.js';

const url = process.env.DATABASE_URL;
if(!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const dir = path.resolve(process.env.MIGRATIONS_DIR ?? '../db/migrations');

try {
  const applied = await migrate(url, dir);
  console.log(applied.length ? `applied: ${applied.join(', ')}`: 'schema up to date');
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}