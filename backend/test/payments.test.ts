// AI MADE
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrder, expectCountersMatchLedger, pay, resetDb, setupTestApp } from './helpers.js';

const { pool, app, gateway } = setupTestApp();

beforeEach(async () => {
  await resetDb(pool);
  gateway.latencyMs = 0;
});
afterAll(() => pool.end());

describe('POST /api/orders/:id/payments: success paths', () => {
  it('captures cash immediately without calling the gateway', async () => {
    const orderId = await createOrder(app, 10000);
    const before = gateway.chargeCount;

    const res = await pay(app, orderId, { tender: 'cash', amount_cents: 4000 });

    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({ tender: 'cash', amount_cents: 4000, status: 'captured', gateway_ref: null });
    expect(res.body.order).toMatchObject({ paid_cents: 4000, outstanding_cents: 6000, status: 'partially_paid' });
    expect(gateway.chargeCount).toBe(before);
  });

  it('captures a card through the gateway and stores its charge ref', async () => {
    const orderId = await createOrder(app, 10000);
    const before = gateway.chargeCount;

    const res = await pay(app, orderId, { tender: 'card', amount_cents: 2500 });

    expect(res.status).toBe(201);
    expect(res.body.payment.status).toBe('captured');
    expect(res.body.payment.gateway_ref).toMatch(/^ch_/);
    expect(gateway.chargeCount).toBe(before + 1);
  });

  it('marks the order paid when split tenders add up to exactly the total', async () => {
    const orderId = await createOrder(app, 10000);

    await pay(app, orderId, { tender: 'card', amount_cents: 6000 });
    const res = await pay(app, orderId, { tender: 'cash', amount_cents: 4000 });

    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ paid_cents: 10000, outstanding_cents: 0, status: 'paid' });
    expect(res.body.order.payments).toHaveLength(2);
    await expectCountersMatchLedger(pool, orderId);
  });
});

describe('POST /api/orders/:id/payments: error paths', () => {
  it('rejects a payment larger than the amount outstanding', async () => {
    const orderId = await createOrder(app, 10000);
    await pay(app, orderId, { tender: 'cash', amount_cents: 6000 });

    const res = await pay(app, orderId, { tender: 'cash', amount_cents: 5000 });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'OVERPAY', details: { amount_cents: 5000, outstanding_cents: 4000 } });
    const order = await request(app).get(`/api/orders/${orderId}`);
    expect(order.body.payments).toHaveLength(1); // nothing recorded for the rejected one
  });

  it('rejects any payment on a fully paid order', async () => {
    const orderId = await createOrder(app, 1000);
    await pay(app, orderId, { tender: 'cash', amount_cents: 1000 });

    const res = await pay(app, orderId, { tender: 'cash', amount_cents: 1 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OVERPAY');
  });

  it('requires an Idempotency-Key header', async () => {
    const orderId = await createOrder(app, 1000);
    const res = await request(app).post(`/api/orders/${orderId}/payments`).send({ tender: 'cash', amount_cents: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual({ field: 'Idempotency-Key' });
  });

  it.each([
    ['an unknown tender', { tender: 'crypto', amount_cents: 100 }, 'tender'],
    ['no tender', { amount_cents: 100 }, 'tender'],
    ['a zero amount', { tender: 'cash', amount_cents: 0 }, 'amount_cents'],
    ['a negative amount', { tender: 'cash', amount_cents: -5 }, 'amount_cents'],
    ['a fractional amount', { tender: 'cash', amount_cents: 10.5 }, 'amount_cents'],
    ['a string amount', { tender: 'cash', amount_cents: '100' }, 'amount_cents'],
  ])('rejects %s', async (_label, body, field) => {
    const orderId = await createOrder(app, 1000);
    const res = await pay(app, orderId, body);
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual({ field });
  });

  it('404s for an unknown order', async () => {
    const res = await pay(app, '00000000-0000-0000-0000-000000000000', { tender: 'cash', amount_cents: 100 });
    expect(res.status).toBe(404);
  });

  it('404s for an order id that is not a uuid', async () => {
    const res = await pay(app, 'nope', { tender: 'cash', amount_cents: 100 });
    expect(res.status).toBe(404);
  });

  it('records a declined card as failed and releases the reserved amount', async () => {
    const orderId = await createOrder(app, 10000);
    gateway.failNext('decline');

    const res = await pay(app, orderId, { tender: 'card', amount_cents: 3000 });

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('CARD_DECLINED');
    const order = await request(app).get(`/api/orders/${orderId}`);
    expect(order.body).toMatchObject({ paid_cents: 0, outstanding_cents: 10000, status: 'open' });
    expect(order.body.payments[0]).toMatchObject({ status: 'failed', failure_reason: 'card_declined' });
    await expectCountersMatchLedger(pool, orderId);
  });
});

describe('idempotency', () => {
  it('replays a successful payment instead of charging again', async () => {
    const orderId = await createOrder(app, 10000);
    const before = gateway.chargeCount;

    const first = await pay(app, orderId, { tender: 'card', amount_cents: 3000 }, 'key-1');
    const retry = await pay(app, orderId, { tender: 'card', amount_cents: 3000 }, 'key-1');

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.payment.id).toBe(first.body.payment.id);
    expect(retry.body.order.payments).toHaveLength(1);
    expect(gateway.chargeCount).toBe(before + 1);
  });

  it('rejects a key reused with a different body', async () => {
    const orderId = await createOrder(app, 10000);
    await pay(app, orderId, { tender: 'cash', amount_cents: 3000 }, 'key-1');

    const res = await pay(app, orderId, { tender: 'cash', amount_cents: 9999 }, 'key-1');

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('scopes keys per order: the same key on another order is a new payment', async () => {
    const a = await createOrder(app, 1000);
    const b = await createOrder(app, 1000);

    const resA = await pay(app, a, { tender: 'cash', amount_cents: 500 }, 'shared-key');
    const resB = await pay(app, b, { tender: 'cash', amount_cents: 500 }, 'shared-key');

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(resB.body.payment.id).not.toBe(resA.body.payment.id);
  });

  it('replays a declined payment as declined, without retrying the card', async () => {
    const orderId = await createOrder(app, 10000);
    gateway.failNext('decline');
    await pay(app, orderId, { tender: 'card', amount_cents: 3000 }, 'key-1');
    const before = gateway.chargeCount;

    const retry = await pay(app, orderId, { tender: 'card', amount_cents: 3000 }, 'key-1');

    expect(retry.status).toBe(402);
    expect(gateway.chargeCount).toBe(before);
  });

  it('gateway timeout (nothing charged): stays pending and reserved, a retry completes it', async () => {
    const orderId = await createOrder(app, 10000);
    gateway.failNext('timeout');

    const first = await pay(app, orderId, { tender: 'card', amount_cents: 3000 }, 'key-1');
    expect(first.status).toBe(504);
    expect(first.body.error.code).toBe('GATEWAY_TIMEOUT');

    const during = await request(app).get(`/api/orders/${orderId}`);
    expect(during.body).toMatchObject({ paid_cents: 3000, pending_cents: 3000, outstanding_cents: 7000, status: 'partially_paid' });
    expect(during.body.payments[0].status).toBe('pending');

    const retry = await pay(app, orderId, { tender: 'card', amount_cents: 3000 }, 'key-1');
    expect(retry.status).toBe(200);
    expect(retry.body.payment.status).toBe('captured');
    expect(retry.body.order).toMatchObject({ paid_cents: 3000, pending_cents: 0 });
  });

  it('LOST RESPONSE: the card was charged but we never heard back; a retry does not charge twice', async () => {
    const orderId = await createOrder(app, 10000);
    const before = gateway.chargeCount;
    gateway.failNext('lost-response');

    const first = await pay(app, orderId, { tender: 'card', amount_cents: 3000 }, 'key-1');
    expect(first.status).toBe(504);
    expect(gateway.chargeCount).toBe(before + 1); // the customer WAS charged

    const retry = await pay(app, orderId, { tender: 'card', amount_cents: 3000 }, 'key-1');

    expect(retry.status).toBe(200);
    expect(retry.body.payment).toMatchObject({ status: 'captured', amount_cents: 3000 });
    expect(gateway.chargeCount).toBe(before + 1); // ...exactly once
    expect(retry.body.order.payments).toHaveLength(1);
    await expectCountersMatchLedger(pool, orderId);
  });
});