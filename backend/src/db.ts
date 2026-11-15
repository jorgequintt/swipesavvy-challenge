import pg from 'pg';

export function createPool(connectionString: string): pg.Pool{
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 2000
  });

  pool.on('error', (err) => console.error('pg pool error:', err.message));

  return pool;
}

export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'"); // wait 5s before throwing error 55P03
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}