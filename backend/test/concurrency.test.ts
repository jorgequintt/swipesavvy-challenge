// AI MADE
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrder, expectCountersMatchLedger, pay, refund, resetDb, setupTestApp } from './helpers.js';

const { pool, app, gateway, hooks } = setupTestApp();
const N = 10;

beforeEach(async () => {
  await resetDb(pool);
  // A slow gateway widens the race window: payments overlap while others are pending.
  gateway.latencyMs = 30;
  // Pause between "check outstanding" and "reserve" so every request is inside that
  // window at once. Without the order lock, they would all pass the check.
  hooks.afterBalanceCheck = () => new Promise((r) => setTimeout(r, 25));
});
afterAll(() => pool.end());

// How many responses had each status code, e.g. { 201: 1, 422: 9 }.
const countStatuses = (responses: { status: number }[]) =>
  responses.reduce<Record<number, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});

describe('concurrent payments on one order', () => {
  it(`${N} parallel payments that would each fit alone: exactly one wins`, async () => {
    const orderId = await createOrder(app, 10000);

    const responses = await Promise.all(
      Array.from({ length: N }, () => pay(app, orderId, { tender: 'card', amount_cents: 6000 })),
    );

    expect(countStatuses(responses)).toEqual({ 201: 1, 422: N - 1 });
    // Rejected by the app's own check under the lock, not by the CHECK constraint
    // backstop (that would be CONSTRAINT_VIOLATION, and would mean the lock failed).
    for (const r of responses.filter((r) => r.status === 422)) expect(r.body.error.code).toBe('OVERPAY');
    const order = await request(app).get(`/api/orders/${orderId}`);
    expect(order.body).toMatchObject({ paid_cents: 6000, outstanding_cents: 4000 });
    expect(order.body.payments).toHaveLength(1);
    await expectCountersMatchLedger(pool, orderId);
  });

  it(`${N} parallel payments of 20%: exactly five fit, total lands exactly on 100%`, async () => {
    const orderId = await createOrder(app, 10000);

    const responses = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        pay(app, orderId, { tender: i % 2 ? 'cash' : 'card', amount_cents: 2000 }),
      ),
    );

    expect(countStatuses(responses)).toEqual({ 201: 5, 422: 5 });
    for (const r of responses.filter((r) => r.status === 422)) expect(r.body.error.code).toBe('OVERPAY');
    const order = await request(app).get(`/api/orders/${orderId}`);
    expect(order.body).toMatchObject({ paid_cents: 10000, outstanding_cents: 0, status: 'paid' });
    await expectCountersMatchLedger(pool, orderId);
  });

  it(`${N} parallel retries with the SAME key: one payment, one charge`, async () => {
    const orderId = await createOrder(app, 10000);
    const key = randomUUID();
    const before = gateway.chargeCount;

    const responses = await Promise.all(
      Array.from({ length: N }, () => pay(app, orderId, { tender: 'card', amount_cents: 3000 }, key)),
    );

    expect(countStatuses(responses)).toEqual({ 201: 1, 200: N - 1 });
    const ids = new Set(responses.map((r) => r.body.payment.id));
    expect(ids.size).toBe(1);
    expect(gateway.chargeCount).toBe(before + 1);
    await expectCountersMatchLedger(pool, orderId);
  });
});

// REFUNDS

describe('concurrent refunds on one payment', () => {
  // A 5000 card payment, fully captured.
  async function capturedPayment() {
    const orderId = await createOrder(app, 5000);
    const res = await pay(app, orderId, { tender: 'card', amount_cents: 5000 });
    expect(res.status).toBe(201);
    return { orderId, paymentId: res.body.payment.id as string };
  }

  it(`${N} parallel refunds that would each fit alone: exactly one wins`, async () => {
    const { orderId, paymentId } = await capturedPayment();

    const responses = await Promise.all(
      Array.from({ length: N }, () => refund(app, orderId, { payment_id: paymentId, amount_cents: 3000 })),
    );

    expect(countStatuses(responses)).toEqual({ 201: 1, 422: N - 1 });
    for (const r of responses.filter((r) => r.status === 422)) expect(r.body.error.code).toBe('OVER_REFUND');
    const order = await request(app).get(`/api/orders/${orderId}`);
    expect(order.body.payments[0]).toMatchObject({ refunded_cents: 3000, refundable_cents: 2000 });
    await expectCountersMatchLedger(pool, orderId);
  });

  it(`${N} parallel refunds of 20%: exactly five fit, refunded lands exactly on the captured amount`, async () => {
    const { orderId, paymentId } = await capturedPayment();

    const responses = await Promise.all(
      Array.from({ length: N }, () => refund(app, orderId, { payment_id: paymentId, amount_cents: 1000 })),
    );

    expect(countStatuses(responses)).toEqual({ 201: 5, 422: 5 });
    for (const r of responses.filter((r) => r.status === 422)) expect(r.body.error.code).toBe('OVER_REFUND');
    const order = await request(app).get(`/api/orders/${orderId}`);
    expect(order.body).toMatchObject({ paid_cents: 0, outstanding_cents: 5000 });
    expect(order.body.payments[0]).toMatchObject({ refunded_cents: 5000, refundable_cents: 0 });
    await expectCountersMatchLedger(pool, orderId);
  });

  it('payments and refunds racing on the same order never break the invariants or deadlock', async () => {
    const { orderId, paymentId } = await capturedPayment();

    const responses = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        i % 2
          ? refund(app, orderId, { payment_id: paymentId, amount_cents: 1000 })
          : pay(app, orderId, { tender: 'cash', amount_cents: 1000 }),
      ),
    );

    // Which ones fit depends on arrival order; what matters is that every response
    // is a clean success or a clean rule rejection, never a 500 or a lock error.
    for (const r of responses) expect([201, 422]).toContain(r.status);
    const order = await request(app).get(`/api/orders/${orderId}`);
    expect(order.body.paid_cents).toBeGreaterThanOrEqual(0);
    expect(order.body.paid_cents).toBeLessThanOrEqual(5000);
    await expectCountersMatchLedger(pool, orderId);
  });
});