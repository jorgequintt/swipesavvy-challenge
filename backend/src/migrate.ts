import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const MIGRATION_LOCK_ID = 727_001;

export async function migrate(connectionString: string, dir: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations',
    );
    const applied = new Set(rows.map((r) => r.name));

    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const newlyApplied: string[] = [];

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await fs.readFile(path.join(dir, file), 'utf8');

      await client.query('BEGIN');

      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(error as Error).message}`);
      }
      newlyApplied.push(file);
    }
    return newlyApplied;
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID])
      .catch(() => {});
    await client.end();
  }
}
