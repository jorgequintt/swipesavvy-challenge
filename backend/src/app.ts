import express, { type ErrorRequestHandler } from 'express';
import type pg from 'pg';

export interface AppConfig {
  pool: pg.Pool;
  color: string;
  version: string;
}

export function createApp({ pool, color, version }: AppConfig) {
  const app = express();
  app.use(express.json());

  app.get('/healthz', async(req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({
        ok: true,
        color
      })
    } catch (error) {
      res.status(503).json({ ok: false, color })
    }
  });

  const api = express.Router();
  api.get('/version', (req, res) => {
    res.json({ color, version })
  });
  app.use('/api', api)

  const onError: ErrorRequestHandler = (err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal Server Error' } });
  }

  app.use(onError);

  return app;
}