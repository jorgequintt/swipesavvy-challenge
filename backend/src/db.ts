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