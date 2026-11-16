import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withTransaction } from './db.js';
import { ApiError, notFound, unprocessable } from './errors.js';
import { GatewayDeclined, GatewayTimeout, type Gateway } from './gateway.js';
import { centsFromDb } from './money.js';
import { lockOrder, OrderRow, type PaymentRow, type RefundRow } from './orders.js';
import type { PaymentHooks } from './payments.js';

export interface RefundRequest {
  orderId: string;
  paymentId: string;
  amountCents: number;
  idempotencyKey: string;
}

export interface RefundResult {
  refund: RefundRow;
  replayed: boolean;
}

function requestHash(req: RefundRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([req.paymentId, req.amountCents]))
    .digest('hex');
}

export async function applyRefund(
  pool: pg.Pool,
  gateway: Gateway,
  req: RefundRequest,
  hooks: PaymentHooks = {},
): Promise<RefundResult> {
  const hash = requestHash(req);

  const reserved = await withTransaction(pool, async (client) => {
    const order = await lockOrder(client, req.orderId);

    const {
      rows: [existing],
    } = await client.query<RefundRow>(
      'SELECT * FROM refunds WHERE order_id = $1 AND idempotency_key = $2',
      [req.orderId, req.idempotencyKey],
    );

    if (existing) {
      if (existing.request_hash !== hash) {
        throw unprocessable(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different refund',
        );
      }
      return {
        refund: existing,
        payment: null,
        currency: order.currency,
        replayed: true,
      };
    }

    const {
      rows: [payment],
    } = await client.query<PaymentRow>(
      'SELECT * FROM payments WHERE id = $1 AND order_id = $2',
      [req.paymentId, req.orderId],
    );
    if (!payment) throw notFound('Payment');
    if (payment.status !== 'captured') {
      throw unprocessable(
        'PAYMENT_NOT_REFUNDABLE',
        'Only captured payments can be refunded',
        {
          payment_status: payment.status,
        },
      );
    }

    const refundable =
      centsFromDb(payment.amount_cents) - centsFromDb(payment.refunded_cents);

    if (req.amountCents > refundable) {
      throw unprocessable(
        'OVER_REFUND',
        'Refund exceeds the refundable amount for this payment',
        {
          amount_cents: req.amountCents,
          refundable_cents: refundable,
        },
      );
    }

    await hooks.afterBalanceCheck?.();

    await client.query(
      'UPDATE payments SET refunded_cents = refunded_cents + $2, updated_at = now() WHERE id = $1',
      [payment.id, req.amountCents],
    );

    const isCash = payment.tender === 'cash';
    if (isCash) {
      await client.query('UPDATE orders SET paid_cents = paid_cents - $2 WHERE id = $1', [
        req.orderId,
        req.amountCents,
      ]);
    }
    const {
      rows: [refund],
    } = await client.query<RefundRow>(
      `INSERT INTO refunds (payment_id, order_id, amount_cents, status, idempotency_key, request_hash)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        payment.id,
        req.orderId,
        req.amountCents,
        isCash ? 'succeeded' : 'pending',
        req.idempotencyKey,
        hash,
      ],
    );

    return { refund, payment, currency: order.currency, replayed: false };
  });

  if (reserved.refund.status !== 'pending')
    return { refund: reserved.refund, replayed: reserved.replayed };

  const payment =
    reserved.payment ??
    (
      await pool.query<PaymentRow>('SELECT * FROM payments WHERE id = $1', [
        reserved.refund.payment_id,
      ])
    ).rows[0];

  const refund = await settleWithGateway(
    pool,
    gateway,
    reserved.refund,
    payment,
    reserved.currency,
  );
  return { refund, replayed: reserved.replayed };
}

async function settleWithGateway(
  pool: pg.Pool,
  gateway: Gateway,
  refund: RefundRow,
  payment: PaymentRow,
  currency: string,
): Promise<RefundRow> {
  try {
    const { ref } = await gateway.refund({
      idempotencyKey: `refund:${refund.id}`,
      chargeRef: payment.gateway_ref!, // captured card payments always have a gateway_ref
      amountCents: centsFromDb(refund.amount_cents),
      currency,
    });

    return await finalize(pool, refund, { status: 'succeeded', gateway_ref: ref });
  } catch (error) {
    if (error instanceof GatewayDeclined) {
      return await finalize(pool, refund, { status: 'failed', reason: error.message });
    }
    if (error instanceof GatewayTimeout) {
      throw new ApiError(
        504,
        'GATEWAY_TIMEOUT',
        'The card gateway did not answer. Retry with the same idempotency key',
        {
          refund_id: refund.id,
        },
      );
    }

    throw error;
  }
}
type Outcome =
  | { status: 'succeeded'; gateway_ref: string }
  | { status: 'failed'; reason: string };

async function finalize(
  pool: pg.Pool,
  refund: RefundRow,
  outcome: Outcome,
): Promise<RefundRow> {
  return withTransaction(pool, async (client) => {
    await lockOrder(client, refund.order_id);

    const {
      rows: [updated],
    } = await client.query<RefundRow>(
      `UPDATE refunds
          SET status = $2, gateway_ref = $3, failure_reason = $4, updated_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING *`,
      [
        refund.id,
        outcome.status,
        outcome.status === 'succeeded' ? outcome.gateway_ref : null,
        outcome.status === 'failed' ? outcome.reason : null,
      ],
    );

    if (updated) {
      const amount = centsFromDb(updated.amount_cents);

      if (updated.status === 'succeeded') {
        await client.query(
          'UPDATE orders SET paid_cents = paid_cents - $2 WHERE id = $1',
          [updated.order_id, amount],
        );
      } else {
        await client.query(
          'UPDATE payments SET refunded_cents = refunded_cents - $2, updated_at = now() WHERE id = $1',
          [updated.payment_id, amount],
        );
      }

      return updated;
    }

    const {
      rows: [current],
    } = await client.query<RefundRow>('SELECT * FROM refunds WHERE id = $1', [refund.id]);

    return current;
  });
}
