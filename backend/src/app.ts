import express, { type ErrorRequestHandler } from 'express';
import type pg from 'pg';
import { ordersRouter } from './routes/orders.js';
import { ApiError } from './errors.js';

export interface AppConfig {
  pool: pg.Pool;
  color: string;
  version: string;
}

export function createApp({ pool, color, version }: AppConfig) {
  const app = express();
  app.use(express.json());

  app.get('/healthz', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({
        ok: true,
        color,
      });
    } catch (error) {
      res.status(503).json({ ok: false, color });
    }
  });

  const api = express.Router();
  api.get('/version', (req, res) => {
    res.json({ color, version });
  });
  api.use('/orders', ordersRouter(pool));
  api.use((req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `No route for ${req.method} ${req.originalUrl} found`,
      },
    });
  });
  app.use('/api', api);

  const onError: ErrorRequestHandler = (err, req, res, next) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }

    if (err.type === 'entity.parse.failed') {
      res.status(400).json({
        error: { code: 'INVALID_JSON', message: 'Reques body is not a valid JSON' },
      });
    }

    // Handle CHECK constraint violation from db
    if (err.code === '23514') {
      res
        .status(422)
        .json({
          error: {
            code: 'CONSTRAINT_VIOLATION',
            message: 'Request violates a ledger rule',
            details: { constraint: err.constraint },
          },
        });
    }

    console.error(err);
    res
      .status(500)
      .json({ error: { code: 'INTERNAL', message: 'Internal Server Error' } });
  };

  app.use(onError);

  return app;
}
