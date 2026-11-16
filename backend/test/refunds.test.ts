import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrder, expectCountersMatchLedger, pay, refund, resetDb, setupTestApp } from './helpers.js';

const { pool, app, gateway } = setupTestApp();

beforeEach(async () => {
  await resetDb(pool);
  gateway.latencyMs = 0;
});
afterAll(() => pool.end());

// An order of `total` fully paid by one payment of the given tender. Returns both ids.
async function paidOrder(total: number, tender: 'card' | 'cash' = 'card') {
  const orderId = await createOrder(app, total);
  const res = await pay(app, orderId, { tender, amount_cents: total });
  expect(res.status).toBe(201);
  return { orderId, paymentId: res.body.payment.id as string };
}

describe('POST /api/orders/:id/refunds: success paths', () => {
  it('refunds part of a card payment through the gateway and reopens that much balance', async () => {
    const { orderId, paymentId } = await paidOrder(10000);
    const before = gateway.refundCount;

    const res = await refund(app, orderId, { payment_id: paymentId, amount_cents: 1500 });

    expect(res.status).toBe(201);
    expect(res.body.refund).toMatchObject({ payment_id: paymentId, amount_cents: 1500, status: 'succeeded' });
    expect(res.body.refund.gateway_ref).toMatch(/^re_/);
    expect(res.body.order).toMatchObject({ paid_cents: 8500, outstanding_cents: 1500, status: 'partially_paid' });
    expect(res.body.order.payments[0]).toMatchObject({ refunded_cents: 1500, refundable_cents: 8500 });
    expect(gateway.refundCount).toBe(before + 1);
    await expectCountersMatchLedger(pool, orderId);
  });

  it('refunds cash on the spot without calling the gateway', async () => {
    const { orderId, paymentId } = await paidOrder(4000, 'cash');
    const before = gateway.refundCount;

    const res = await refund(app, orderId, { payment_id: paymentId, amount_cents: 4000 });

    expect(res.status).toBe(201);
    expect(res.body.refund).toMatchObject({ status: 'succeeded', gateway_ref: null });
    expect(res.body.order).toMatchObject({ paid_cents: 0, outstanding_cents: 4000 });
    expect(gateway.refundCount).toBe(before);
  });

  it('allows several partial refunds up to exactly the captured amount', async () => {
    const { orderId, paymentId } = await paidOrder(5000);

    expect((await refund(app, orderId, { payment_id: paymentId, amount_cents: 2000 })).status).toBe(201);
    expect((await refund(app, orderId, { payment_id: paymentId, amount_cents: 3000 })).status).toBe(201);

    const order = await request(app).get(`/api/orders/${orderId}`);
    expect(order.body.payments[0]).toMatchObject({ refunded_cents: 5000, refundable_cents: 0 });
    expect(order.body.refunds).toHaveLength(2);
    await expectCountersMatchLedger(pool, orderId);
  });

  it('lets the reopened balance be paid again with another tender (tender swap)', async () => {
    const { orderId, paymentId } = await paidOrder(10000);
    await refund(app, orderId, { payment_id: paymentId, amount_cents: 3000 });

    const res = await pay(app, orderId, { tender: 'cash', amount_cents: 3000 });

    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ paid_cents: 10000, outstanding_cents: 0, status: 'paid' });
    await expectCountersMatchLedger(pool, orderId);
  });
});

describe('POST /api/orders/:id/refunds: error paths', () => {
  it('rejects a refund larger than what is still refundable', async () => {
    const { orderId, paymentId } = await paidOrder(5000);
    await refund(app, orderId, { payment_id: paymentId, amount_cents: 4000 });

    const res = await refund(app, orderId, { payment_id: paymentId, amount_cents: 1001 });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'OVER_REFUND', details: { amount_cents: 1001, refundable_cents: 1000 } });
  });

  it('rejects a single refund larger than the payment', async () => {
    const { orderId, paymentId } = await paidOrder(5000);
    const res = await refund(app, orderId, { payment_id: paymentId, amount_cents: 5001 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OVER_REFUND');
  });

  it('rejects refunding a payment that failed', async () => {
    const orderId = await createOrder(app, 5000);
    gateway.failNext('decline');
    const declined = await pay(app, orderId, { tender: 'card', amount_cents: 5000 });
    const paymentId = declined.body.error.details.payment_id;

    const res = await refund(app, orderId, { payment_id: paymentId, amount_cents: 100 });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'PAYMENT_NOT_REFUNDABLE', details: { payment_status: 'failed' } });
  });

  it('rejects refunding a payment still pending at the gateway', async () => {
    const orderId = await createOrder(app, 5000);
    gateway.failNext('timeout');
    const pending = await pay(app, orderId, { tender: 'card', amount_cents: 5000 });
    const paymentId = pending.body.error.details.payment_id;

    const res = await refund(app, orderId, { payment_id: paymentId, amount_cents: 100 });

    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual({ payment_status: 'pending' });
  });

  it('404s for a payment that belongs to another order', async () => {
    const a = await paidOrder(5000);
    const b = await paidOrder(5000);

    const res = await refund(app, a.orderId, { payment_id: b.paymentId, amount_cents: 100 });

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Payment not found');
  });

  it('404s for an unknown payment', async () => {
    const { orderId } = await paidOrder(5000);
    const res = await refund(app, orderId, { payment_id: '00000000-0000-0000-0000-000000000000', amount_cents: 100 });
    expect(res.status).toBe(404);
  });

  it('404s for an unknown order', async () => {
    const res = await refund(app, '00000000-0000-0000-0000-000000000000', {
      payment_id: '00000000-0000-0000-0000-000000000000',
      amount_cents: 100,
    });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Order not found');
  });

  it('requires an Idempotency-Key header', async () => {
    const { orderId, paymentId } = await paidOrder(5000);
    const res = await request(app).post(`/api/orders/${orderId}/refunds`).send({ payment_id: paymentId, amount_cents: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual({ field: 'Idempotency-Key' });
  });

  it.each([
    ['no payment_id', { payment_id: undefined, amount_cents: 100 }, 'payment_id'],
    ['a payment_id that is not a uuid', { payment_id: 'abc', amount_cents: 100 }, 'payment_id'],
    ['a zero amount', { amount_cents: 0 }, 'amount_cents'],
    ['a fractional amount', { amount_cents: 10.5 }, 'amount_cents'],
  ])('rejects %s', async (_label, body, field) => {
    const { orderId, paymentId } = await paidOrder(5000);
    const res = await refund(app, orderId, { payment_id: paymentId, ...body });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual({ field });
  });

  it('records a declined refund as failed and gives the refundable amount back', async () => {
    const { orderId, paymentId } = await paidOrder(5000);
    gateway.failNext('decline');

    const res = await refund(app, orderId, { payment_id: paymentId, amount_cents: 2000 });

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('REFUND_DECLINED');
    const order = await request(app).get(`/api/orders/${orderId}`);
    expect(order.body).toMatchObject({ paid_cents: 5000, status: 'paid' });
    expect(order.body.payments[0]).toMatchObject({ refunded_cents: 0, refundable_cents: 5000 });
    expect(order.body.refunds[0]).toMatchObject({ status: 'failed', failure_reason: 'refund_declined' });
    await expectCountersMatchLedger(pool, orderId);
  });
});

describe('refund idempotency', () => {
  it('replays a refund instead of refunding twice', async () => {
    const { orderId, paymentId } = await paidOrder(5000);
    const before = gateway.refundCount;

    const first = await refund(app, orderId, { payment_id: paymentId, amount_cents: 1000 }, 'r-1');
    const retry = await refund(app, orderId, { payment_id: paymentId, amount_cents: 1000 }, 'r-1');

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.refund.id).toBe(first.body.refund.id);
    expect(retry.body.order.payments[0].refunded_cents).toBe(1000);
    expect(gateway.refundCount).toBe(before + 1);
  });

  it('rejects a key reused with a different body', async () => {
    const { orderId, paymentId } = await paidOrder(5000);
    await refund(app, orderId, { payment_id: paymentId, amount_cents: 1000 }, 'r-1');

    const res = await refund(app, orderId, { payment_id: paymentId, amount_cents: 2000 }, 'r-1');

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('pending refund: holds the refundable room but does not reopen the balance until it succeeds', async () => {
    const { orderId, paymentId } = await paidOrder(5000);
    gateway.failNext('timeout');

    const first = await refund(app, orderId, { payment_id: paymentId, amount_cents: 2000 }, 'r-1');
    expect(first.status).toBe(504);

    const during = await request(app).get(`/api/orders/${orderId}`);
    expect(during.body).toMatchObject({ paid_cents: 5000, outstanding_cents: 0 }); // not reopened yet
    expect(during.body.payments[0]).toMatchObject({ refunded_cents: 2000, refundable_cents: 3000 }); // room taken
    expect(during.body.refunds[0].status).toBe('pending');

    const retry = await refund(app, orderId, { payment_id: paymentId, amount_cents: 2000 }, 'r-1');
    expect(retry.status).toBe(200);
    expect(retry.body.refund.status).toBe('succeeded');
    expect(retry.body.order).toMatchObject({ paid_cents: 3000, outstanding_cents: 2000 });
    await expectCountersMatchLedger(pool, orderId);
  });

  it('LOST RESPONSE: the refund went through but we never heard back; a retry does not refund twice', async () => {
    const { orderId, paymentId } = await paidOrder(5000);
    const before = gateway.refundCount;
    gateway.failNext('lost-response');

    const first = await refund(app, orderId, { payment_id: paymentId, amount_cents: 2000 }, 'r-1');
    expect(first.status).toBe(504);
    expect(gateway.refundCount).toBe(before + 1);

    const retry = await refund(app, orderId, { payment_id: paymentId, amount_cents: 2000 }, 'r-1');

    expect(retry.status).toBe(200);
    expect(retry.body.refund.status).toBe('succeeded');
    expect(gateway.refundCount).toBe(before + 1);
    expect(retry.body.order.refunds).toHaveLength(1);
    await expectCountersMatchLedger(pool, orderId);
  });
});