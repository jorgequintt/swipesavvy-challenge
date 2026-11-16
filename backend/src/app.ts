import path from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import type pg from 'pg';
import { ordersRouter } from './routes/orders.js';
import { ApiError } from './errors.js';
import { paymentsRouter } from './routes/payments.js';
import { Gateway } from './gateway.js';
import { PaymentHooks } from './payments.js';
import { refundsRouter } from './routes/refunds.js';

export interface AppConfig {
  pool: pg.Pool;
  color: string;
  version: string;
  gateway: Gateway;
  paymentHooks?: PaymentHooks; // For tests
  staticDir?: string; // built frontend; served at / when set
}

export function createApp({ pool, color, version, gateway, paymentHooks, staticDir }: AppConfig) {
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
  api.use('/orders/:orderId/payments', paymentsRouter(pool, gateway, paymentHooks))
  api.use('/orders/:orderId/refunds', refundsRouter(pool, gateway, paymentHooks))
  api.use((req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `No route for ${req.method} ${req.originalUrl} found`,
      },
    });
  });
  app.use('/api', api);

  // AI MADE
  if (staticDir) {
    // Vite fingerprints asset filenames (index-BmO14tDo.js), so they can be cached
    // forever. index.html must not be cached: it's what points at the current assets,
    // and after a blue/green flip the browser should pick up the new ones.
    app.use(
      express.static(staticDir, {
        index: false,
        setHeaders: (res, filePath) => {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
    // Any other GET is a client-side route like /orders/<id>: serve the app shell
    // and let the frontend read the path. (/api/* never gets here: it 404s above.)
    app.get('/{*path}', (req, res) => {
      res.set('Cache-Control', 'no-cache').sendFile(path.join(staticDir, 'index.html'));
    });
  }

  const onError: ErrorRequestHandler = (err, req, res, next) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }

    if (err.type === 'entity.parse.failed') {
      res.status(400).json({
        error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
      });
      return;
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
      return;
    }

    // lock_timeout triggered. The order stayed locked by another request for too long
    if (err.code === '55P03') {
      res.status(503).json({
        error: { code: 'BUSY', message: 'Order is busy. Retry' },
      });
      return;
    }

    console.error(err);
    res
      .status(500)
      .json({ error: { code: 'INTERNAL', message: 'Internal Server Error' } });
  };

  app.use(onError);

  return app;
}
