import pg from 'pg';
import request from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../src/app';
import { createPool } from '../src/db';
import { TEST_DATABASE_URL } from './env';
import { FakeGateway, Gateway } from '../src/gateway';
import { PaymentHooks } from '../src/payments';
import { randomUUID } from 'node:crypto';

export function setupTestApp() {
  const pool: pg.Pool = createPool(TEST_DATABASE_URL);
  const gateway = new FakeGateway();
  const hooks: PaymentHooks = {};
  const app = createApp({
    pool,
    color: 'test',
    version: 'test',
    gateway,
    paymentHooks: hooks,
  });
  return { pool, app, gateway, hooks };
}

export async function resetDb(pool: pg.Pool) {
  await pool.query('TRUNCATE refunds, payments, orders');
}

type App = ReturnType<typeof setupTestApp>['app'];

export async function createOrder(app: App, totalCents: number): Promise<string> {
  const res = await request(app).post('/api/orders').send({ total_cents: totalCents });
  expect(res.status).toBe(201);
  return res.body.id;
}

export async function pay(
  app: App,
  orderId: string,
  body: Record<string, unknown>,
  key: string = randomUUID(),
) {
  return request(app)
    .post(`/api/orders/${orderId}/payments`)
    .set('Idempotency-Key', key)
    .send(body);
}

// AI MADE
export async function expectCountersMatchLedger(pool: pg.Pool, orderId: string) {
  const { rows: [r] } = await pool.query(
    `SELECT o.paid_cents::bigint AS counter,
            (SELECT COALESCE(SUM(amount_cents), 0) FROM payments
              WHERE order_id = o.id AND status IN ('pending', 'captured'))
          - (SELECT COALESCE(SUM(amount_cents), 0) FROM refunds
              WHERE order_id = o.id AND status = 'succeeded') AS ledger
       FROM orders o WHERE o.id = $1`,
    [orderId],
  );
  expect(Number(r.counter)).toBe(Number(r.ledger));
}